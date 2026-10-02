const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/Emby.SyncPlay/Web/client.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for(let i = open; i < source.length; i++) {
    if(source[i] === '{') depth++;
    if(source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
}
function context(names, extra = {}) {
  const c = vm.createContext({state: {}, getValue: (o,a,b) => o && (o[a] ?? o[b]),
    performance: {now: () => 10000}, Date, Promise, console, ...extra});
  for(const name of names) vm.runInContext(extract(name), c);
  return c;
}
test('regression: old video cannot report new media ready', async () => {
  let sent;
  const c = context(['sendMediaReady','getEventItemId','isVideoReady','isExpectedMedia'], {
    state: {memberToken:'t', mediaEpoch:2, expectedItemId:200, room:{ItemId:200,MediaTransitionState:'LoadingMembers'}},
    getCurrentItemId: () => 100, isAwaitingMediaReady: () => true,
    getBestRtt: () => 0, TICKS_PER_SECOND:10000000,
    sendSocket: (type,payload) => {sent = payload; return Promise.resolve(true);}
  });
  c.state.video = {readyState:4,currentTime:120,paused:false,currentSrc:'/Videos/100/stream'};
  await c.sendMediaReady(c.state.video);
  assert.equal(sent,undefined);
  c.state.video.currentSrc='/Videos/200/stream';
  await c.sendMediaReady(c.state.video);
  assert.equal(sent.ItemId,200);
});
test('regression: new membership resets room epoch', () => {
  const c = context(['applyJoinResult','applyRoomState'], {
    state: {memberToken:'old',mediaEpoch:3,room:{Code:'111',MediaEpoch:3,Revision:9}},
    clearRoomState: function() { c.state.room=null;c.state.mediaEpoch=0; },
    reconcileRoomPlayback:()=>{},updateTransitionTicker:()=>{},renderAll:()=>{},
  });
  c.applyJoinResult({MemberToken:'new',Room:{Code:'222',MediaEpoch:1,Revision:1}});
  assert.equal(c.state.memberToken,'new');
  assert.equal(c.state.room.Code,'222');
});
test('regression: load alignment preserves local pause', () => {
  const queue = [];
  const video = {currentTime:10,readyState:4,paused:false,play(){this.paused=false;return Promise.resolve();}};
  const c = context(['scheduleLoadAlignment'], {
    state:{video,loadAlignmentGeneration:0},window:{setTimeout: fn => queue.push(fn)},
    getCommandTargetSeconds: () => 10,
  });
  c.scheduleLoadAlignment(video,{State:'Playing'});
  video.paused=true;
  queue.shift()();
  assert.equal(video.paused,true);
});
test('regression: old HTTP response is ignored after membership changes', async () => {
  let resolve, applied;
  const c = context(['sendSocket'], {
    state:{apiClient:{},memberToken:'old',room:{Code:'111'},connectionOnline:true},
    getClientInstanceId: () => 'page',apiRequest: () => new Promise(r => resolve=r),
    applyRoomState: room => applied=room,renderAll: () => {},
  });
  const pending=c.sendSocket('SyncPlayHeartbeat',{});
  c.state.memberToken='new';c.state.room={Code:'222'};
  resolve({Accepted:true,Room:{Code:'111',MediaEpoch:5}});
  await pending;
  assert.equal(applied,undefined);
});

test('media identity accepts matching metadata but rejects unknown or detached video', () => {
  const video = {currentSrc:'blob:stream'};
  let current = 200;
  const c = context(['isExpectedMedia'], {state:{video,expectedItemId:200},getCurrentItemId:()=>current});
  assert.equal(c.isExpectedMedia(video),true);
  current=0;
  assert.equal(c.isExpectedMedia(video),false);
  assert.equal(c.isExpectedMedia({currentSrc:'/Videos/200/stream'}),false);
});

test('control retry cannot cross room membership', async () => {
  const queue=[];
  let requests=0;
  const c=context(['sendControlEvent'],{state:{memberToken:'a'},
    sendSocket:()=>{requests++;return Promise.resolve(false);},
    window:{setTimeout:fn=>queue.push(fn)}});
  const pending=c.sendControlEvent({Kind:'Pause'});
  await Promise.resolve();
  c.state.memberToken='b';
  queue.shift()();
  assert.equal(await pending,false);
  assert.equal(requests,1);
});
