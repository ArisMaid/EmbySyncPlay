"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function extractFunction(source, name) {
    const marker = "function " + name + "(";
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, name + " must exist");

    const openingBrace = source.indexOf("{", start);
    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === "{") {
            depth += 1;
        } else if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error("Unterminated function " + name);
}

test("player UI mount renders only when it adds nodes", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "mountPlayerUi");
    const mountedSelectors = new Set();
    const selectorForContainer = new Map([
        [".videoOsdBottom-buttons-topright", ".syncPlay-osdButton"],
        [".videoOsdBottom-maincontrols", ".syncPlay-drawer"],
        [".nowPlayingBarRight", ".syncPlay-barButton"],
        [".nowPlayingBar", ".syncPlay-miniDrawer"]
    ]);

    function container(selector) {
        const mountedSelector = selectorForContainer.get(selector);
        return {
            firstElementChild: null,
            querySelector(childSelector) {
                if (childSelector === ".btnVideoOsdSettings") {
                    return null;
                }
                return mountedSelectors.has(childSelector) ? {} : null;
            },
            insertBefore() {
                mountedSelectors.add(mountedSelector);
            },
            appendChild() {
                mountedSelectors.add(mountedSelector);
            }
        };
    }

    const containers = new Map(Array.from(selectorForContainer.keys(), selector => [selector, container(selector)]));
    const document = {
        documentElement: { classList: { contains: () => false } },
        querySelector: selector => selector === "body > .syncPlay-headerPanel" ? {} : (containers.get(selector) || null)
    };
    let renderCount = 0;
    let updateCount = 0;
    const mountPlayerUi = new Function(
        "document",
        "createPlayerButton",
        "createDrawer",
        "updatePlayerButtons",
        "renderAll",
        "return (" + functionSource + ");"
    )(
        document,
        className => ({ className }),
        className => ({ className }),
        () => { updateCount += 1; },
        () => { renderCount += 1; }
    );

    assert.equal(mountPlayerUi(), true);
    assert.equal(renderCount, 1);
    assert.equal(mountedSelectors.size, 4);

    // This represents the observer callback caused by renderAll() changing panel.innerHTML.
    assert.equal(mountPlayerUi(), false);
    assert.equal(renderCount, 1, "the observer callback must not trigger another render");
    assert.equal(updateCount, 0, "an idempotent observer callback must not write to the DOM");
});

test("member badge text is not rewritten when the count is unchanged", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "updatePlayerButtons");
    let badgeText = "";
    let badgeWriteCount = 0;
    const badge = {
        classList: { toggle() {} },
        get textContent() { return badgeText; },
        set textContent(value) {
            badgeText = value;
            badgeWriteCount += 1;
        }
    };
    const button = {
        classList: { contains() { return false; }, toggle() {} },
        setAttribute() {},
        querySelector(selector) {
            if (selector === ".syncPlay-memberBadge") {
                return badge;
            }
            if (selector === ".syncPlay-statusDot") {
                return { className: "" };
            }
            if (selector === ".syncPlay-buttonIcon") {
                return { classList: { toggle() {} } };
            }
            return null;
        }
    };
    const state = {
        room: { MemberCount: 1, Members: [], State: "Paused" },
        drawerOpen: false
    };
    const document = {
        querySelectorAll: selector => selector === ".syncPlay-controlButton" ? [button] : []
    };
    const updatePlayerButtons = new Function(
        "state",
        "document",
        "getValue",
        "getRoomQuality",
        "text",
        "return (" + functionSource + ");"
    )(
        state,
        document,
        (object, pascalName, camelName) => object[pascalName] !== undefined ? object[pascalName] : object[camelName],
        () => ({ kind: "good", label: "good" }),
        { title: "SyncPlay" }
    );

    updatePlayerButtons();
    updatePlayerButtons();

    assert.equal(badgeText, "1");
    assert.equal(badgeWriteCount, 1, "the unchanged member count must not create another text node mutation");
});

test("sync drawer uses Emby action sheet menu rows", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");

    assert.match(source, /actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow/);
    assert.match(source, /listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue/);
    assert.doesNotMatch(source, /syncPlay-mediaCard|syncPlay-actionGrid|syncPlay-footerActions/);
});

test("room codes are restricted to three decimal digits", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");

    assert.match(source, /maxlength="3" inputmode="numeric" pattern="\[0-9\]\{3\}"/);
    assert.match(source, /\^\[0-9\]\{3\}\$/);
    assert.match(source, /syncplay=\(\[0-9\]\{3\}\)/);
    assert.doesNotMatch(source, /4 位房间码|8 位房间码|A-Z2-9/);
});

test("header quick join uses Emby playback module and item-route fallback", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");

    assert.match(source, /querySelector\("\.headerRight"\)/);
    assert.match(source, /headerButton headerSectionItem paper-icon-button-light syncPlay-controlButton syncPlay-headerButton/);
    assert.match(source, /Emby\.importModule\("\.\/modules\/common\/playback\/playbackmanager\.js"\)/);
    assert.match(source, /startPositionTicks: positionTicks/);
    assert.match(source, /#!\/item\?id=/);
    assert.match(source, /lastLoadCommand/);
    assert.match(source, /loadCommandExpiresAt/);
});

test("header menu escapes header clipping and header icon has no status dot", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const source = fs.readFileSync(clientPath, "utf8");
    const css = fs.readFileSync(cssPath, "utf8");
    const createHeaderButton = extractFunction(source, "createHeaderButton");

    assert.match(source, /document\.body\.appendChild\(createHeaderPanel\(\)\)/);
    assert.match(source, /function positionHeaderPanel\(\)/);
    assert.match(createHeaderButton, /&#xe7fb;/);
    assert.doesNotMatch(createHeaderButton, /syncPlay-statusDot/);
    assert.match(css, /\.syncPlay-headerPanel\s*\{[\s\S]*?position:\s*fixed;/);
});

test("player OSD uses a plain action icon with no toggle background or status dot", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const createPlayerButton = extractFunction(source, "createPlayerButton");

    assert.match(createPlayerButton, /&#xe7fb;/);
    assert.doesNotMatch(createPlayerButton, /toggleButton|toggleButtonIcon|syncPlay-statusDot/);
    assert.doesNotMatch(source, /toggleButton-active|toggleButtonIcon-active/);
});

test("sync menus auto-close after five seconds of inactivity", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const drawerResetSource = extractFunction(source, "resetDrawerAutoClose");
    const headerResetSource = extractFunction(source, "resetHeaderAutoClose");

    assert.match(source, /const MENU_AUTO_CLOSE_MS = 5000;/);
    assert.match(drawerResetSource, /MENU_AUTO_CLOSE_MS/);
    assert.match(headerResetSource, /MENU_AUTO_CLOSE_MS/);

    function exerciseReset(functionSource, openProperty, timerProperty, closeFunctionName) {
        const scheduled = [];
        const cleared = [];
        const closeCalls = [];
        const timerHandle = { name: timerProperty };
        const state = {
            [openProperty]: true,
            [timerProperty]: { name: "previous" }
        };
        const fakeWindow = {
            clearTimeout(handle) { cleared.push(handle); },
            setTimeout(callback, delay) {
                scheduled.push({ callback, delay });
                return timerHandle;
            }
        };
        const reset = new Function(
            "state",
            "window",
            closeFunctionName,
            "MENU_AUTO_CLOSE_MS",
            "return (" + functionSource + ");"
        )(
            state,
            fakeWindow,
            restoreFocus => closeCalls.push(restoreFocus),
            5000
        );

        const previousTimer = state[timerProperty];
        reset();

        assert.deepEqual(cleared, [previousTimer]);
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].delay, 5000);
        assert.equal(state[timerProperty], timerHandle);

        scheduled[0].callback();
        assert.deepEqual(closeCalls, [false], "inactivity close must not steal focus");
    }

    exerciseReset(drawerResetSource, "drawerOpen", "drawerAutoCloseTimer", "closeDrawer");
    exerciseReset(headerResetSource, "headerMenuOpen", "headerAutoCloseTimer", "closeHeaderMenu");
});

test("sync menu observers distinguish outside clicks, inside activity, and Escape", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "startObservers");
    const listeners = new Map();
    const drawerCloseCalls = [];
    const headerCloseCalls = [];
    let drawerResetCount = 0;
    let headerResetCount = 0;
    const state = {
        drawerOpen: false,
        headerMenuOpen: false,
        mutationObserver: null
    };
    const document = {
        body: {},
        addEventListener(name, listener) {
            if (!listeners.has(name)) {
                listeners.set(name, []);
            }
            listeners.get(name).push(listener);
        }
    };
    const fakeWindow = { addEventListener() {} };
    class FakeMutationObserver {
        constructor(callback) { this.callback = callback; }
        observe() {}
    }
    const closeDrawer = restoreFocus => {
        drawerCloseCalls.push(restoreFocus);
        state.drawerOpen = false;
    };
    const closeHeaderMenu = restoreFocus => {
        headerCloseCalls.push(restoreFocus);
        state.headerMenuOpen = false;
    };
    const startObservers = new Function(
        "state",
        "MutationObserver",
        "document",
        "window",
        "mountPlayerUi",
        "bindCurrentVideo",
        "closeDrawer",
        "closeHeaderMenu",
        "positionHeaderPanel",
        "resetDrawerAutoClose",
        "resetHeaderAutoClose",
        "return (" + functionSource + ");"
    )(
        state,
        FakeMutationObserver,
        document,
        fakeWindow,
        () => {},
        () => {},
        closeDrawer,
        closeHeaderMenu,
        () => {},
        () => { drawerResetCount += 1; },
        () => { headerResetCount += 1; }
    );

    startObservers();
    assert.ok(listeners.has("click"), "outside click handling must be registered");
    assert.ok(listeners.has("input"), "typing must extend the inactivity deadline");
    assert.ok(listeners.has("keydown"), "keyboard activity and Escape must be handled");

    const dispatch = (name, event) => {
        listeners.get(name).forEach(listener => listener(event));
    };
    const target = kind => ({
        closest(selector) {
            if (kind === "drawer" && /syncPlay-(?:panel|osdButton|barButton)/.test(selector)) {
                return {};
            }
            if (kind === "header" && /syncPlay-header(?:Panel|Button)/.test(selector)) {
                return {};
            }
            return null;
        }
    });

    state.drawerOpen = true;
    dispatch("click", { target: target("outside") });
    assert.deepEqual(drawerCloseCalls, [false], "an outside click closes the drawer without restoring focus");

    state.headerMenuOpen = true;
    dispatch("click", { target: target("outside") });
    assert.deepEqual(headerCloseCalls, [false], "an outside click closes the header menu without restoring focus");

    state.drawerOpen = true;
    dispatch("click", { target: target("drawer") });
    dispatch("input", { target: target("drawer") });
    dispatch("keydown", { key: "ArrowRight", target: target("drawer") });
    assert.equal(drawerResetCount, 3, "mouse, input, and keyboard activity inside the drawer reset its timer");
    assert.equal(drawerCloseCalls.length, 1);

    state.drawerOpen = false;
    state.headerMenuOpen = true;
    dispatch("click", { target: target("header") });
    dispatch("input", { target: target("header") });
    dispatch("keydown", { key: "ArrowRight", target: target("header") });
    assert.equal(headerResetCount, 3, "mouse, input, and keyboard activity inside the header menu reset its timer");
    assert.equal(headerCloseCalls.length, 1);

    state.headerMenuOpen = true;
    let headerEscapeStopped = false;
    dispatch("keydown", {
        key: "Escape",
        target: target("outside"),
        stopPropagation() { headerEscapeStopped = true; }
    });
    assert.equal(headerEscapeStopped, true);
    assert.equal(headerCloseCalls.at(-1), undefined, "Escape keeps the default header focus restoration");

    state.drawerOpen = true;
    let drawerEscapeStopped = false;
    dispatch("keydown", {
        key: "Escape",
        target: target("outside"),
        stopPropagation() { drawerEscapeStopped = true; }
    });
    assert.equal(drawerEscapeStopped, true);
    assert.equal(drawerCloseCalls.at(-1), undefined, "Escape keeps the default drawer focus restoration");
});

test("media switching preserves membership and reports epoch-scoped readiness", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const bindCurrentVideo = extractFunction(source, "bindCurrentVideo");
    const sendMediaReady = extractFunction(source, "sendMediaReady");
    const applyCommand = extractFunction(source, "applyCommand");

    assert.doesNotMatch(bindCurrentVideo, /ended:\s*function\s*\(\)\s*\{\s*leaveRoom\(\)/);
    assert.match(sendMediaReady, /SyncPlayMediaReady/);
    assert.match(sendMediaReady, /MediaEpoch:\s*state\.mediaEpoch/);
    assert.match(sendMediaReady, /ItemId:\s*getCurrentItemId\(\)/);
    assert.match(applyCommand, /commandEpoch\s*<\s*state\.mediaEpoch/);
    assert.match(applyCommand, /state\.mediaSwitchLoading\s*=\s*true/);
});

test("media transition UI exposes host selection, loading progress, and viewer removal feedback", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const source = fs.readFileSync(clientPath, "utf8");
    const css = fs.readFileSync(cssPath, "utf8");
    const transitionSource = extractFunction(source, "getTransitionInfo");
    const serverMessageSource = extractFunction(source, "onServerMessage");

    assert.match(transitionSource, /AwaitingHostPlayback/);
    assert.match(transitionSource, /LoadingMembers/);
    assert.match(source, /房主正在切换媒体/);
    assert.match(source, /已离开同步房间：只有房主可以切换全房媒体/);
    assert.match(serverMessageSource, /SyncPlayMembershipEnded/);
    assert.match(css, /\.syncPlay-transitionBanner-switching/);
    assert.match(css, /\.syncPlay-toast/);
});

test("local seek transaction suppresses heartbeat and buffering races", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");

    assert.match(source, /seeking: function \(\) \{ beginLocalSeek\(video\); \}/);
    assert.match(source, /seeked: function \(\) \{ finishLocalSeek\(video\); \}/);
    assert.match(source, /sendControl\("Seek", true\)/);
    assert.match(source, /!video\.seeking && !isLocalSeekTransaction\(\)/);
    assert.match(source, /!state\.memberToken \|\| !video \|\| isLocalSeekTransaction\(\)/);
    assert.match(source, /state\.loadAlignmentGeneration \+= 1/);
});

test("Load command delegates to source-settling alignment", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "executeCommand");
    const scheduled = [];
    const video = { currentTime: 0 };
    const executeCommand = new Function(
        "state",
        "performance",
        "getValue",
        "getCommandTargetSeconds",
        "scheduleLoadAlignment",
        "alignVideo",
        "restorePlaybackRate",
        "nudgeVideo",
        "return (" + functionSource + ");"
    )(
        { suppressUntil: 0 },
        { now: () => 50 },
        (object, pascalName, camelName) => object[pascalName] !== undefined ? object[pascalName] : object[camelName],
        () => 12,
        (targetVideo, command) => scheduled.push({ targetVideo, command }),
        () => {},
        () => {},
        () => {}
    );

    executeCommand(video, {
        Kind: "Load",
        PositionTicks: 120000000,
        ReferenceUnixMs: 1000,
        State: "Playing"
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].targetVideo, video);
    assert.equal(scheduled[0].command.Kind, "Load");
});

test("Load alignment retries after Emby replaces the media source", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "scheduleLoadAlignment");
    const callbacks = [];
    const aligned = [];
    let now = 0;
    const video = {
        currentTime: 0,
        paused: true,
        readyState: 4,
        play() { this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; }
    };
    const state = { loadAlignmentGeneration: 0, suppressUntil: 0, video };
    const scheduleLoadAlignment = new Function(
        "state",
        "performance",
        "window",
        "getValue",
        "getCommandTargetSeconds",
        "alignVideo",
        "restorePlaybackRate",
        "return (" + functionSource + ");"
    )(
        state,
        { now: () => now },
        { setTimeout: callback => callbacks.push(callback) },
        (object, pascalName, camelName) => object[pascalName] !== undefined ? object[pascalName] : object[camelName],
        () => 12,
        (targetVideo, seconds) => { aligned.push(seconds); targetVideo.currentTime = seconds; },
        () => {}
    );

    scheduleLoadAlignment(video, { State: "Playing" });
    assert.deepEqual(aligned, [12]);
    assert.equal(callbacks.length, 1);

    // Emby can replace/reset the source after the first seek; the next retry must restore the room position.
    video.currentTime = 0;
    now = 250;
    callbacks.shift()();
    assert.deepEqual(aligned, [12, 12]);
});
