using System;
using System.Threading;
using System.Threading.Tasks;
using Emby.SyncPlay.Core;
using Emby.SyncPlay;
using Xunit;
public class SynchronizationRegressionTests
{
    class Clock : ISyncPlayClock {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
        public long UnixTimeMilliseconds => UtcNow.ToUnixTimeMilliseconds();
    }
    class Sink : ISyncPlayCommandSink {
        public Task SendAsync(string s,string m,object d,CancellationToken c) => Task.CompletedTask;
    }
    [Fact]
    public async Task ReadyHeartbeatReleasesOrdinaryBufferingHold() {
        var manager = new RoomManager(new Clock(),new Sink(),() => new PluginConfiguration());
        var room = manager.CreateRoom(new SessionDescriptor {SessionId="host",UserId="1"},42,"Test",0,false,"Test");
        var ev = new SyncPlaySocketEnvelope {MemberToken=room.MemberToken,MediaEpoch=room.Room.MediaEpoch,ItemId=42,IsActive=true,IsBuffering=true};
        await manager.ProcessSocketMessageAsync("SyncPlayBuffering",ev,CancellationToken.None);
        Assert.Equal("Holding",manager.GetStatus("host").Room.State);
        ev.IsBuffering=false;ev.IsReady=true;
        for(var i=0;i<10;i++) await manager.ProcessSocketMessageAsync("SyncPlayHeartbeat",ev,CancellationToken.None);
        Assert.Equal("Playing",manager.GetStatus("host").Room.State);
        await manager.ProcessSocketMessageAsync("SyncPlayBuffering",ev,CancellationToken.None);
        Assert.Equal("Playing",manager.GetStatus("host").Room.State);
    }
    [Fact]
    public async Task RetiredPageCannotOverrideCurrentPage() {
        var manager = new RoomManager(new Clock(),new Sink(),() => new PluginConfiguration());
        var room = manager.CreateRoom(new SessionDescriptor {SessionId="host",UserId="1"},42,"Test",0,false,"Test");
        var ev = new SyncPlaySocketEnvelope {MemberToken=room.MemberToken,MediaEpoch=room.Room.MediaEpoch,ItemId=42,ClientInstanceId="old",ClientSequence=10,Kind="Pause",IsPaused=true};
        Assert.True(await manager.ProcessSocketMessageAsync("SyncPlayControl",ev,CancellationToken.None));
        ev.ClientInstanceId="new";ev.ClientSequence=1;ev.Kind="Play";ev.IsPaused=false;
        Assert.True(await manager.ProcessSocketMessageAsync("SyncPlayControl",ev,CancellationToken.None));
        ev.ClientInstanceId="old";ev.ClientSequence=9;ev.Kind="Pause";ev.IsPaused=true;
        Assert.False(await manager.ProcessSocketMessageAsync("SyncPlayControl",ev,CancellationToken.None));
        Assert.Equal("Playing",manager.GetStatus("host").Room.State);
    }
}
