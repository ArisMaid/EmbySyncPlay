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

function extractBraceBlock(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, marker + " must exist");

    const openingBrace = source.indexOf("{", start);
    assert.notEqual(openingBrace, -1, marker + " must have a block");
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

    throw new Error("Unterminated block " + marker);
}

function findCssRuleBody(source, selector) {
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rulePattern.exec(source)) !== null) {
        const selectors = match[1].split(",").map(value => value.trim());
        if (selectors.includes(selector)) {
            return match[2];
        }
    }
    return null;
}

function findCssRuleBodyWithSelectorTokens(source, tokens) {
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rulePattern.exec(source)) !== null) {
        const selectors = match[1].split(",").map(value => value.trim());
        if (selectors.some(selector => tokens.every(token => selector.includes(token)))) {
            return match[2];
        }
    }
    return null;
}

test("player UI mount covers stale and active Emby views without repeat writes", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "mountPlayerUi");
    const selectorForContainer = new Map([
        [".videoOsdBottom-buttons-topright", ".syncPlay-osdButton"],
        [".videoOsdBottom-maincontrols", ".syncPlay-drawer"],
        [".nowPlayingBarRight", ".syncPlay-barButton"],
        [".nowPlayingBar", ".syncPlay-miniDrawer"]
    ]);

    function container(selector, viewName) {
        const mountedSelector = selectorForContainer.get(selector);
        const mountedSelectors = new Set();
        return {
            viewName,
            mountedSelectors,
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

    const containers = new Map(Array.from(selectorForContainer.keys(), selector => [
        selector,
        [container(selector, "hidden-old-view"), container(selector, "active-new-view")]
    ]));
    const document = {
        documentElement: { classList: { contains: () => false } },
        querySelector: selector => selector === "body > .syncPlay-headerPanel" ? {} : null,
        querySelectorAll: selector => containers.get(selector) || []
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
    containers.forEach((viewContainers, selector) => {
        const expectedChild = selectorForContainer.get(selector);
        assert.equal(viewContainers.length, 2);
        viewContainers.forEach(viewContainer => {
            assert.equal(
                viewContainer.mountedSelectors.has(expectedChild),
                true,
                viewContainer.viewName + " must receive " + expectedChild
            );
        });
    });

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
        "getDrawerElementForSource",
        "text",
        "return (" + functionSource + ");"
    )(
        state,
        document,
        (object, pascalName, camelName) => object[pascalName] !== undefined ? object[pascalName] : object[camelName],
        () => ({ kind: "good", label: "good" }),
        () => null,
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
    const fakeWindow = {
        addEventListener() {},
        cancelAnimationFrame() {},
        requestAnimationFrame(callback) {
            callback();
            return 1;
        }
    };
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
        "eventPathContains",
        "releaseSurfacePointerAfterClick",
        "releaseSurfacePointerNow",
        "scheduleHeaderPosition",
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
        (event, selector) => Boolean(event.target && event.target.closest && event.target.closest(selector)),
        () => { state.surfacePointerDown = false; },
        () => { state.surfacePointerDown = false; },
        () => {},
        () => { drawerResetCount += 1; },
        () => { headerResetCount += 1; }
    );

    startObservers();
    assert.ok(listeners.has("click"), "outside click handling must be registered");
    assert.ok(listeners.has("input"), "typing must extend the inactivity deadline");
    assert.ok(listeners.has("keydown"), "keyboard activity and Escape must be handled");
    ["wheel", "scroll", "touchmove", "focusin", "pointerdown"].forEach(name => {
        assert.ok(listeners.has(name), name + " inside a surface must extend the inactivity deadline");
    });

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

    function expectTimerRenewal(name, event, getCount, message) {
        const before = getCount();
        dispatch(name, event);
        assert.ok(getCount() > before, message);
    }

    state.drawerOpen = true;
    [
        ["click", {}],
        ["input", {}],
        ["keydown", { key: "ArrowRight" }],
        ["wheel", {}],
        ["scroll", {}],
        ["touchmove", {}],
        ["focusin", {}],
        ["pointerdown", { pointerId: 1 }]
    ].forEach(([name, event]) => {
        expectTimerRenewal(
            name,
            Object.assign({ target: target("drawer") }, event),
            () => drawerResetCount,
            name + " activity inside the drawer resets its timer"
        );
    });
    dispatch("pointerup", { pointerId: 1, target: target("drawer") });
    assert.equal(drawerCloseCalls.length, 1);

    state.drawerOpen = false;
    state.headerMenuOpen = true;
    [
        ["click", {}],
        ["input", {}],
        ["keydown", { key: "ArrowRight" }],
        ["wheel", {}],
        ["scroll", {}],
        ["touchmove", {}],
        ["focusin", {}],
        ["pointerdown", { pointerId: 2 }]
    ].forEach(([name, event]) => {
        expectTimerRenewal(
            name,
            Object.assign({ target: target("header") }, event),
            () => headerResetCount,
            name + " activity inside the header menu resets its timer"
        );
    });
    dispatch("pointerup", { pointerId: 2, target: target("header") });
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
    const isCommandObsolete = extractFunction(source, "isCommandObsolete");

    assert.doesNotMatch(bindCurrentVideo, /ended:\s*function\s*\(\)\s*\{\s*leaveRoom\(\)/);
    assert.match(sendMediaReady, /SyncPlayMediaReady/);
    assert.match(sendMediaReady, /MediaEpoch:\s*state\.mediaEpoch/);
    assert.match(sendMediaReady, /ItemId:\s*getEventItemId\(\)/);
    assert.match(isCommandObsolete, /commandEpoch\s*<\s*state\.mediaEpoch/);
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

test("HTTP room-state polling provides a WebSocket-independent sync fallback", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const startRealtime = extractFunction(source, "startRealtime");
    const pollRoomState = extractFunction(source, "pollRoomState");
    const getStatusPath = extractFunction(source, "getStatusPath");
    const applyRoomState = extractFunction(source, "applyRoomState");
    const sendSocket = extractFunction(source, "sendSocket");

    assert.match(startRealtime, /statusTimer/);
    assert.match(startRealtime, /pollRoomState\(\)/);
    assert.match(getStatusPath, /SyncPlay\/Status/);
    assert.match(pollRoomState, /recordClockSample/);
    assert.match(applyRoomState, /buildRoomCommand\(room, "Load"\)/);
    assert.match(applyRoomState, /reconcileRoomPlayback\(room/);
    assert.match(sendSocket, /applyRoomState\(room, "http-event"\)/);
    assert.match(sendSocket, /ServerReceiveUnixMs/);
});

test("HTTP fallback can issue controls after a stale media-loading banner", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const sendControl = extractFunction(source, "sendControl");
    const canControlDuringMediaLoad = extractFunction(source, "canControlDuringMediaLoad");

    assert.match(sendControl, /mediaLoadBlocked/);
    assert.match(sendControl, /canControlDuringMediaLoad\(video\)/);
    assert.match(canControlDuringMediaLoad, /readyState\s*<\s*2/);
    assert.match(canControlDuringMediaLoad, /isExpectedMedia\(video\)/);
});

test("playable media clears a stale loading barrier even without two buffered seconds", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const isVideoReady = extractFunction(source, "isVideoReady");
    const sendHeartbeat = extractFunction(source, "sendHeartbeat");
    const markReady = extractFunction(source, "markReadyAfterInitialLoad");

    assert.match(isVideoReady, /readyState\s*>=\s*3/);
    assert.match(isVideoReady, /bufferedAhead\(video\)/);
    assert.match(sendHeartbeat, /const mediaReady = isVideoReady\(video\)/);
    assert.match(markReady, /isVideoReady\(video\)/);
});

test("media events prefer the room item while Emby reports a stale NowPlayingItem", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const getEventItemId = extractFunction(source, "getEventItemId");
    const sendMediaReady = extractFunction(source, "sendMediaReady");
    const sendControl = extractFunction(source, "sendControl");
    const sendHeartbeat = extractFunction(source, "sendHeartbeat");

    assert.match(getEventItemId, /expectedItemId/);
    assert.match(getEventItemId, /currentItemId !== expectedItemId/);
    assert.match(sendMediaReady, /ItemId: getEventItemId\(\)/);
    assert.match(sendControl, /ItemId: getEventItemId\(\)/);
    assert.match(sendHeartbeat, /ItemId: getEventItemId\(\)/);
});

test("HTTP status requests bypass intermediary caches", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const getStatusPath = extractFunction(source, "getStatusPath");
    const apiRequest = extractFunction(source, "apiRequest");

    assert.match(getStatusPath, /syncplayClientTime/);
    assert.match(apiRequest, /Cache-Control/);
    assert.match(apiRequest, /no-cache/);
});

test("stale media-switch commands cannot recreate the loading banner", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const applyCommand = extractFunction(source, "applyCommand");
    const isCommandObsolete = extractFunction(source, "isCommandObsolete");
    const revisionCheck = isCommandObsolete.indexOf("commandRevision && roomRevision && commandRevision < roomRevision");
    const mediaSwitchMutation = applyCommand.indexOf('state.mediaSwitchLoading = true');

    assert.ok(revisionCheck >= 0);
    assert.ok(mediaSwitchMutation >= 0);
    assert.match(applyCommand, /isCommandObsolete\(command\)/);
});

test("new playback commands cancel an older load-alignment loop", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const executeCommand = extractFunction(source, "executeCommand");
    const cancelLoadAlignment = extractFunction(source, "cancelLoadAlignment");

    assert.match(executeCommand, /kind !== "Load"/);
    assert.match(executeCommand, /preservesMediaSwitchLoad/);
    assert.match(executeCommand, /cancelLoadAlignment\(\)/);
    assert.match(cancelLoadAlignment, /loadAlignmentGeneration\s*\+=\s*1/);
    assert.match(cancelLoadAlignment, /lastLoadCommand\s*=\s*null/);
});

test("HTTP status exposes readiness for initial joins and retries MediaReady without a WebSocket", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const sendMediaReady = extractFunction(source, "sendMediaReady");
    const isAwaitingMediaReady = extractFunction(source, "isAwaitingMediaReady");
    const isLoadingNewMedia = extractFunction(source, "isLoadingNewMedia");
    const applyRoomState = extractFunction(source, "applyRoomState");

    assert.match(sendMediaReady, /isAwaitingMediaReady\(\)/);
    assert.match(sendMediaReady, /IsActive: isActive/);
    assert.match(isAwaitingMediaReady, /IsCurrentMemberMediaReady/);
    assert.match(isLoadingNewMedia, /IsCurrentMemberMediaLoading/);
    assert.match(isAwaitingMediaReady, /isLoadingNewMedia\(\)/);
    assert.match(applyRoomState, /IsCurrentMemberActive/);
});

test("HTTP reconciliation yields to a local play, pause, or seek request", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const sendControl = extractFunction(source, "sendControl");
    const sendControlEvent = extractFunction(source, "sendControlEvent");
    const reconcileRoomPlayback = extractFunction(source, "reconcileRoomPlayback");

    assert.match(sendControl, /localControlUntil/);
    assert.match(sendControl, /sendControlEvent\(payload\)/);
    assert.match(sendControlEvent, /same sequence and EventId/);
    assert.match(sendControlEvent, /setTimeout/);
    assert.match(reconcileRoomPlayback, /isLocalControlTransaction\(\)/);
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

test("Load commands keep the newest room anchor and ignore duplicate delivery", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "rememberLoadCommand");
    const isNewerSource = extractFunction(source, "isNewerLoadCommand");
    const getValue = (object, pascalName, camelName) => object[pascalName] !== undefined
        ? object[pascalName]
        : object[camelName];
    const isNewerLoadCommand = new Function("getValue", "return (" + isNewerSource + ");")(getValue);
    const current = { MediaEpoch: 2, RoomRevision: 9, PositionTicks: 100000000, ReferenceUnixMs: 5000 };
    assert.equal(isNewerLoadCommand({ MediaEpoch: 2, RoomRevision: 8, PositionTicks: 999999999, ReferenceUnixMs: 9000 }, current), false);
    assert.equal(isNewerLoadCommand({ MediaEpoch: 2, RoomRevision: 9, PositionTicks: 100000000, ReferenceUnixMs: 5000 }, current), false);
    assert.equal(isNewerLoadCommand({ MediaEpoch: 2, RoomRevision: 9, PositionTicks: 100000000, ReferenceUnixMs: 5100 }, current), true);
    assert.equal(isNewerLoadCommand({ MediaEpoch: 3, RoomRevision: 1, PositionTicks: 0, ReferenceUnixMs: 1 }, current), true);

    const state = { lastLoadCommand: null, loadCommandExpiresAt: 0 };
    let now = 100;
    const rememberLoadCommand = new Function(
        "state",
        "performance",
        "isNewerLoadCommand",
        "return (" + functionSource + ");"
    )(
        state,
        { now: () => now },
        isNewerLoadCommand
    );
    const first = { MediaEpoch: 2, RoomRevision: 9, PositionTicks: 100000000, ReferenceUnixMs: 5000 };
    assert.equal(rememberLoadCommand(first), true);
    assert.equal(rememberLoadCommand(first), false);
    now = 250;
    const newer = { MediaEpoch: 2, RoomRevision: 9, PositionTicks: 100000000, ReferenceUnixMs: 5100 };
    assert.equal(rememberLoadCommand(newer), true);
    assert.equal(state.lastLoadCommand, newer);
    assert.equal(state.loadCommandExpiresAt, 12250);
});

test("sync surfaces animate without display-none teardown", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const source = fs.readFileSync(clientPath, "utf8");
    const css = fs.readFileSync(cssPath, "utf8");
    const createHeaderPanel = extractFunction(source, "createHeaderPanel");
    const createDrawer = extractFunction(source, "createDrawer");
    const closeDrawer = extractFunction(source, "closeDrawer");
    const closeHeaderMenu = extractFunction(source, "closeHeaderMenu");
    const setSurfaceOpen = extractFunction(source, "setSurfaceOpen");

    assert.doesNotMatch(createHeaderPanel, /\bhide\b/);
    assert.doesNotMatch(createDrawer, /\bhide\b/);
    assert.match(setSurfaceOpen, /classList\.(?:add|toggle)\("syncPlay-surfaceOpen"/);
    assert.match(setSurfaceOpen, /classList\.(?:remove|toggle)\("syncPlay-surfaceOpen"/);
    assert.match(setSurfaceOpen, /setAttribute\("aria-hidden", "false"\)/);
    assert.match(setSurfaceOpen, /setAttribute\("aria-hidden", "true"\)/);
    assert.match(closeDrawer, /updateSurfaceVisibility\(\)/);
    assert.doesNotMatch(closeDrawer, /renderAll\(\)/);
    assert.match(closeHeaderMenu, /updateSurfaceVisibility\(\)/);
    assert.match(css, /\.syncPlay-headerPanel\.syncPlay-surfaceOpen,[\s\S]*?\.syncPlay-panel\.syncPlay-surfaceOpen/);
    assert.match(css, /visibility 0s linear 210ms/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.syncPlay-headerPanel/);
});

test("unchanged surface markup is not rebuilt or rebound", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const functionSource = extractFunction(source, "updateSurfaceMarkup");
    const surfaceMarkupCache = new WeakMap();
    let htmlWrites = 0;
    let bindCalls = 0;
    const surface = {
        set innerHTML(value) {
            this.value = value;
            htmlWrites += 1;
        }
    };
    const updateSurfaceMarkup = new Function(
        "surfaceMarkupCache",
        "return (" + functionSource + ");"
    )(surfaceMarkupCache);

    assert.equal(updateSurfaceMarkup(surface, "alpha", () => { bindCalls += 1; }), true);
    assert.equal(updateSurfaceMarkup(surface, "alpha", () => { bindCalls += 1; }), false);
    assert.equal(updateSurfaceMarkup(surface, "beta", () => { bindCalls += 1; }), true);
    assert.equal(htmlWrites, 2);
    assert.equal(bindCalls, 2);
});

test("room-state rendering is throttled and protects active pointer input", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const applyRoomState = extractFunction(source, "applyRoomState");
    const renderSurfaceContents = extractFunction(source, "renderSurfaceContents");
    const startObservers = extractFunction(source, "startObservers");

    assert.match(source, /const UI_CONTENT_RENDER_INTERVAL_MS = 500;/);
    assert.match(applyRoomState, /renderAll\(false\)/);
    assert.match(renderSurfaceContents, /state\.surfacePointerDown/);
    assert.match(renderSurfaceContents, /state\.contentRenderPendingWhileInteracting\s*=\s*true/);
    assert.doesNotMatch(renderSurfaceContents, /scheduleSurfaceContentRender\(80\)/);
    assert.match(startObservers, /syncPlay-panel, \.syncPlay-headerPanel, \.syncPlay-controlButton, \.syncPlay-toast/);
    assert.match(startObservers, /state\.observerFrame = window\.requestAnimationFrame/);
});

test("async actions and notices expose polished transition states", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const source = fs.readFileSync(clientPath, "utf8");
    const css = fs.readFileSync(cssPath, "utf8");
    const createRoom = extractFunction(source, "createRoom");
    const joinRoom = extractFunction(source, "joinRoom");
    const showNotice = extractFunction(source, "showNotice");
    const dismissNotice = extractFunction(source, "dismissNotice");

    assert.match(createRoom, /setActionPending\(source, true\)/);
    assert.match(createRoom, /finally[\s\S]*?setActionPending\(source, false\)/);
    assert.match(joinRoom, /setActionPending\(source, true\)/);
    assert.match(css, /\.syncPlay-menuButton-pending::after/);
    assert.match(showNotice, /syncPlay-toast-visible/);
    assert.match(showNotice, /dismissNotice\(toast\)/);
    assert.match(dismissNotice, /classList\.remove\("syncPlay-toast-visible"\)/);
    assert.match(css, /\.syncPlay-toast-visible/);
});

test("only the player surface invoked by its button is active and expanded", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const toggleDrawerSource = extractFunction(source, "toggleDrawer");
    const drawerClassSource = extractFunction(source, "getDrawerClassForSource");
    const drawerElementSource = extractFunction(source, "getDrawerElementForSource");
    const defaultDrawerSource = extractFunction(source, "getDefaultDrawerElement");
    const visibilitySource = extractFunction(source, "updateSurfaceVisibility");
    const updatePlayerButtonsSource = extractFunction(source, "updatePlayerButtons");

    assert.match(source, /activeDrawerClass:\s*null/);
    assert.match(source, /activeDrawerElement:\s*null/);
    assert.match(toggleDrawerSource, /state\.activeDrawerElement\s*=\s*getDrawerElementForSource\(source\)/);
    assert.match(toggleDrawerSource, /state\.activeDrawerClass\s*=\s*getDrawerClassForSource\(source\)/);
    assert.match(drawerClassSource, /getDrawerElementForSource\(source\)/);
    assert.match(drawerClassSource, /syncPlay-miniDrawer/);
    assert.match(drawerClassSource, /syncPlay-drawer/);
    assert.match(drawerElementSource, /syncPlay-barButton/);
    assert.match(drawerElementSource, /syncPlay-miniDrawer/);
    assert.match(drawerElementSource, /videoOsdBottom/);
    assert.match(drawerElementSource, /syncPlay-drawer/);
    assert.match(visibilitySource, /panel === state\.activeDrawerElement/);
    assert.match(visibilitySource, /panel\.classList\.contains\(activeDrawerClass\)/);

    function createClassList(classNames) {
        const classes = new Set(classNames);
        return {
            contains(name) { return classes.has(name); },
            toggle(name, enabled) {
                if (enabled) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            }
        };
    }

    function createDrawer(className) {
        return {
            classList: createClassList(["syncPlay-panel", className]),
            isConnected: true
        };
    }

    function createButton(classNames, closestTargets) {
        const attributes = new Map();
        const badge = {
            textContent: "",
            classList: { toggle() {} }
        };
        return {
            attributes,
            classList: createClassList(classNames),
            closest(selector) { return closestTargets && closestTargets[selector] || null; },
            querySelector(selector) {
                if (selector === ".syncPlay-memberBadge") {
                    return badge;
                }
                if (selector === ".syncPlay-buttonIcon") {
                    return { classList: { toggle() {} } };
                }
                return null;
            },
            setAttribute(name, value) { attributes.set(name, value); }
        };
    }

    const hiddenDrawer = createDrawer("syncPlay-drawer");
    const activeDrawer = createDrawer("syncPlay-drawer");
    const miniDrawer = createDrawer("syncPlay-miniDrawer");
    const hiddenOsd = {
        querySelector: selector => selector === ".syncPlay-drawer" ? hiddenDrawer : null
    };
    const activeOsd = {
        querySelector: selector => selector === ".syncPlay-drawer" ? activeDrawer : null
    };
    const nowPlayingBar = {
        querySelector: selector => selector === ".syncPlay-miniDrawer" ? miniDrawer : null
    };
    const hiddenOsdButton = createButton(
        ["syncPlay-controlButton", "syncPlay-osdButton"],
        { ".videoOsdBottom": hiddenOsd }
    );
    const activeOsdButton = createButton(
        ["syncPlay-controlButton", "syncPlay-osdButton"],
        { ".videoOsdBottom": activeOsd }
    );
    const barButton = createButton(
        ["syncPlay-controlButton", "syncPlay-barButton"],
        { ".nowPlayingBar": nowPlayingBar }
    );
    const headerButton = createButton(["syncPlay-controlButton", "syncPlay-headerButton"]);
    const getDrawerElementForSource = new Function("return (" + drawerElementSource + ");")();

    assert.equal(getDrawerElementForSource(hiddenOsdButton), hiddenDrawer);
    assert.equal(getDrawerElementForSource(activeOsdButton), activeDrawer);
    assert.equal(getDrawerElementForSource(barButton), miniDrawer);

    const getDefaultDrawerElement = new Function(
        "document",
        "return (" + defaultDrawerSource + ");"
    )({
        querySelector(selector) {
            if (selector === ".view-videoosd-videoosd:not(.hide)") {
                return activeOsd;
            }
            if (selector === ".syncPlay-drawer, .syncPlay-miniDrawer") {
                return hiddenDrawer;
            }
            return null;
        },
        querySelectorAll() { return []; }
    });
    assert.equal(getDefaultDrawerElement(), activeDrawer, "fallback selection must ignore the hidden stale video view");

    const state = {
        room: null,
        drawerOpen: true,
        activeDrawerClass: "syncPlay-drawer",
        activeDrawerElement: activeDrawer,
        headerMenuOpen: false
    };
    const document = {
        querySelectorAll(selector) {
            return selector === ".syncPlay-controlButton"
                ? [hiddenOsdButton, activeOsdButton, barButton, headerButton]
                : [];
        }
    };
    const updatePlayerButtons = new Function(
        "state",
        "document",
        "getValue",
        "getRoomQuality",
        "getDrawerElementForSource",
        "text",
        "return (" + updatePlayerButtonsSource + ");"
    )(
        state,
        document,
        (object, pascalName, camelName) => object[pascalName] !== undefined ? object[pascalName] : object[camelName],
        () => ({ kind: "idle", label: "SyncPlay" }),
        getDrawerElementForSource,
        { title: "SyncPlay" }
    );

    updatePlayerButtons();
    assert.equal(hiddenOsdButton.attributes.get("aria-expanded"), "false");
    assert.equal(activeOsdButton.attributes.get("aria-expanded"), "true");
    assert.equal(barButton.attributes.get("aria-expanded"), "false");
    assert.equal(headerButton.attributes.get("aria-expanded"), "false");

    state.activeDrawerElement = hiddenDrawer;
    updatePlayerButtons();
    assert.equal(hiddenOsdButton.attributes.get("aria-expanded"), "true");
    assert.equal(activeOsdButton.attributes.get("aria-expanded"), "false");

    state.activeDrawerElement = null;
    state.activeDrawerClass = "syncPlay-miniDrawer";
    updatePlayerButtons();
    assert.equal(hiddenOsdButton.attributes.get("aria-expanded"), "false");
    assert.equal(activeOsdButton.attributes.get("aria-expanded"), "false");
    assert.equal(barButton.attributes.get("aria-expanded"), "true");

    state.drawerOpen = false;
    state.headerMenuOpen = true;
    updatePlayerButtons();
    assert.equal(hiddenOsdButton.attributes.get("aria-expanded"), "false");
    assert.equal(activeOsdButton.attributes.get("aria-expanded"), "false");
    assert.equal(barButton.attributes.get("aria-expanded"), "false");
    assert.equal(headerButton.attributes.get("aria-expanded"), "true");

    const openStates = new Map();
    const updateSurfaceVisibility = new Function(
        "state",
        "document",
        "getDrawerClassForSource",
        "getDefaultDrawerElement",
        "setSurfaceOpen",
        "setOsdInteractionLock",
        "scheduleHeaderPosition",
        "updatePlayerButtons",
        "return (" + visibilitySource + ");"
    )(
        state,
        {
            querySelectorAll(selector) {
                return selector === ".syncPlay-panel" ? [hiddenDrawer, activeDrawer, miniDrawer] : [];
            }
        },
        () => "syncPlay-drawer",
        () => activeDrawer,
        (panel, open) => { openStates.set(panel, open); return false; },
        () => {},
        () => {},
        () => {}
    );

    state.drawerOpen = true;
    state.headerMenuOpen = false;
    state.activeDrawerClass = "syncPlay-drawer";
    state.activeDrawerElement = activeDrawer;
    updateSurfaceVisibility();
    assert.equal(openStates.get(hiddenDrawer), false);
    assert.equal(openStates.get(activeDrawer), true);
    assert.equal(openStates.get(miniDrawer), false);
});

test("an open OSD drawer locks the native OSD until the drawer closes", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const source = fs.readFileSync(clientPath, "utf8");
    const css = fs.readFileSync(cssPath, "utf8");
    const visibilitySource = extractFunction(source, "updateSurfaceVisibility");
    const lockSource = extractFunction(source, "setOsdInteractionLock");
    const closeDrawerSource = extractFunction(source, "closeDrawer");

    assert.match(lockSource, /videoOsdBottom/);
    assert.match(lockSource, /syncPlay-osdLocked/);
    assert.match(visibilitySource, /state\.drawerOpen/);
    assert.match(visibilitySource, /state\.activeDrawerClass/);
    assert.match(visibilitySource, /setOsdInteractionLock\(state\.drawerOpen/);
    assert.match(closeDrawerSource, /state\.drawerOpen\s*=\s*false[\s\S]*?updateSurfaceVisibility\(\)/);
    assert.match(closeDrawerSource, /setOsdInteractionLock\(false\)/);

    const hiddenLockRule = findCssRuleBodyWithSelectorTokens(css, [
        ".videoOsdBottom",
        ".videoOsdBottom-hidden",
        ".syncPlay-osdLocked"
    ]);
    assert.notEqual(hiddenLockRule, null, "the lock must override Emby's hidden OSD class");
    assert.match(hiddenLockRule, /opacity:\s*1\s*!important/);
});

test("auto-close expiry renews while a surface is pressed or an action is pending", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const drawerResetSource = extractFunction(source, "resetDrawerAutoClose");
    const headerResetSource = extractFunction(source, "resetHeaderAutoClose");
    const autoCloseRegion = source.slice(
        source.indexOf("function resetDrawerAutoClose"),
        source.indexOf("function positionHeaderPanel")
    );

    assert.match(autoCloseRegion, /surfacePointerDown/);
    assert.match(autoCloseRegion, /surfaceActionPending/);
    assert.ok(
        (drawerResetSource.match(/resetDrawerAutoClose\(\)/g) || []).length >= 2,
        "drawer expiry must reschedule instead of closing during an active interaction"
    );
    assert.ok(
        (headerResetSource.match(/resetHeaderAutoClose\(\)/g) || []).length >= 2,
        "header expiry must reschedule instead of closing during an active interaction"
    );

    function verifyDeferredExpiry(functionSource, openProperty, timerProperty, closeFunctionName) {
        const scheduled = [];
        const closeCalls = [];
        const state = {
            [openProperty]: true,
            [timerProperty]: null,
            surfacePointerDown: true,
            surfaceActionPending: 0
        };
        const fakeWindow = {
            clearTimeout() {},
            setTimeout(callback, delay) {
                scheduled.push({ callback, delay });
                return { callback, delay };
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

        reset();
        assert.equal(scheduled.length, 1);
        scheduled.shift().callback();
        assert.equal(closeCalls.length, 0, "a held pointer must defer expiry");
        assert.equal(scheduled.length, 1, "a held pointer receives a fresh five-second deadline");

        state.surfacePointerDown = false;
        state.surfaceActionPending = 1;
        scheduled.shift().callback();
        assert.equal(closeCalls.length, 0, "an async action must defer expiry");
        assert.equal(scheduled.length, 1, "a pending action receives a fresh five-second deadline");

        state.surfaceActionPending = 0;
        scheduled.shift().callback();
        assert.deepEqual(closeCalls, [false]);
    }

    verifyDeferredExpiry(drawerResetSource, "drawerOpen", "drawerAutoCloseTimer", "closeDrawer");
    verifyDeferredExpiry(headerResetSource, "headerMenuOpen", "headerAutoCloseTimer", "closeHeaderMenu");
});

test("keyboard focus timers are cancelable and skip animation delay for reduced motion", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const toggleDrawerSource = extractFunction(source, "toggleDrawer");
    const closeDrawerSource = extractFunction(source, "closeDrawer");
    const toggleHeaderSource = extractFunction(source, "toggleHeaderMenu");
    const closeHeaderSource = extractFunction(source, "closeHeaderMenu");
    const focusDelaySource = extractFunction(source, "getSurfaceFocusDelay");

    assert.match(source, /drawerFocusTimer:\s*null/);
    assert.match(source, /headerFocusTimer:\s*null/);
    assert.match(toggleDrawerSource, /state\.drawerFocusTimer\s*=\s*window\.setTimeout/);
    assert.match(closeDrawerSource, /window\.clearTimeout\(state\.drawerFocusTimer\)/);
    assert.match(toggleHeaderSource, /state\.headerFocusTimer\s*=\s*window\.setTimeout/);
    assert.match(closeHeaderSource, /window\.clearTimeout\(state\.headerFocusTimer\)/);
    assert.match(source, /matchMedia\(["']\(prefers-reduced-motion:\s*reduce\)["']\)/);
    assert.match(source, /\.matches\s*\?\s*0\s*:\s*220/);

    const getReducedMotionDelay = new Function("window", "return (" + focusDelaySource + ");")({
        matchMedia: () => ({ matches: true })
    });
    const getAnimatedDelay = new Function("window", "return (" + focusDelaySource + ");")({
        matchMedia: () => ({ matches: false })
    });
    assert.equal(getReducedMotionDelay(), 0);
    assert.equal(getAnimatedDelay(), 220);
});

test("toast entrance gets its own frame and removal waits for transform", () => {
    const clientPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.js");
    const source = fs.readFileSync(clientPath, "utf8");
    const showNoticeSource = extractFunction(source, "showNotice");
    const dismissNoticeSource = extractFunction(source, "dismissNotice");

    function createClassList(initialClasses) {
        const classes = new Set(initialClasses || []);
        return {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); }
        };
    }

    const animationFrames = [];
    const timeouts = [];
    const toast = {
        classList: createClassList(),
        parentNode: null,
        setAttribute() {}
    };
    const document = {
        querySelector() { return null; },
        createElement() { return toast; },
        body: {
            appendChild(element) { element.parentNode = this; }
        }
    };
    const fakeWindow = {
        requestAnimationFrame(callback) {
            animationFrames.push(callback);
            return animationFrames.length;
        },
        setTimeout(callback, delay) {
            timeouts.push({ callback, delay });
            return timeouts.length;
        }
    };
    const showNotice = new Function(
        "document",
        "window",
        "setPanelMessage",
        "dismissNotice",
        "return (" + showNoticeSource + ");"
    )(document, fakeWindow, () => {}, () => {});

    showNotice("ready", false);
    assert.equal(toast.classList.contains("syncPlay-toast-visible"), false);
    assert.equal(animationFrames.length, 1);
    animationFrames.shift()();
    assert.equal(toast.classList.contains("syncPlay-toast-visible"), false, "the first frame commits the initial style");
    assert.equal(animationFrames.length, 1, "a second frame starts the entrance transition");
    animationFrames.shift()();
    assert.equal(toast.classList.contains("syncPlay-toast-visible"), true);

    let transitionListener = null;
    let removeCount = 0;
    const dismissingToast = {
        classList: createClassList(["syncPlay-toast-visible"]),
        parentNode: {
            removeChild(element) {
                assert.equal(element, dismissingToast);
                removeCount += 1;
                dismissingToast.parentNode = null;
            }
        },
        addEventListener(name, listener) {
            assert.equal(name, "transitionend");
            transitionListener = listener;
        },
        removeEventListener() {}
    };
    const dismissNotice = new Function(
        "window",
        "return (" + dismissNoticeSource + ");"
    )(fakeWindow);

    dismissNotice(dismissingToast);
    assert.equal(typeof transitionListener, "function");
    transitionListener({ propertyName: "opacity", target: dismissingToast });
    assert.equal(removeCount, 0, "the shorter opacity transition must not truncate movement");
    transitionListener({ propertyName: "transform", target: dismissingToast });
    assert.equal(removeCount, 1);
});

test("reduced motion neutralizes active and expanded transforms", () => {
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const css = fs.readFileSync(cssPath, "utf8");
    const reducedMotion = extractBraceBlock(css, "@media (prefers-reduced-motion: reduce)");
    const selectors = [
        ".syncPlay-controlButton:active",
        '.syncPlay-controlButton[aria-expanded="true"] .syncPlay-buttonIcon',
        ".syncPlay-closeButton:active",
        ".syncPlay-closeButton:active > .md-icon",
        ".syncPlay-menuButton:active:not(:disabled) .syncPlay-menuRowContent"
    ];

    selectors.forEach(selector => {
        const body = findCssRuleBody(reducedMotion, selector);
        assert.notEqual(body, null, selector + " must have a reduced-motion override");
        assert.match(body, /transform:\s*none\s*!important/);
    });
});

test("mobile player keeps its entry visible and drawer clear of native controls", () => {
    const cssPath = path.join(__dirname, "..", "src", "Emby.SyncPlay", "Web", "client.css");
    const css = fs.readFileSync(cssPath, "utf8");
    const mobile = extractBraceBlock(css, "@media (max-width: 42rem)");
    const narrow = extractBraceBlock(css, "@media (max-width: 28rem)");
    const drawerRule = findCssRuleBody(mobile, ".syncPlay-panel");
    const entryRule = findCssRuleBody(narrow, ".syncPlay-osdButton");

    assert.notEqual(drawerRule, null, "mobile drawer positioning must be explicit");
    assert.match(drawerRule, /bottom:\s*calc\(env\(safe-area-inset-bottom\) \+ 13\.25rem\)/);
    assert.match(drawerRule, /max-height:\s*min\(34rem, calc\(100vh - 14\.75rem\)\)\s*!important/);
    assert.doesNotMatch(drawerRule, /\+\s*(?:5\.4|10)rem|67vh|100vh\s*-\s*11\.5rem/);

    assert.notEqual(entryRule, null, "narrow players must retain the SyncPlay entry");
    assert.match(entryRule, /display:\s*flex\s*!important/);
    assert.match(entryRule, /order:\s*0/);
    assert.doesNotMatch(entryRule, /display:\s*none/);
});
