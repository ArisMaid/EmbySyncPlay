(function syncPlayBootstrap() {
    "use strict";

    if (window.SyncPlayClientInitialized) {
        return;
    }
    window.SyncPlayClientInitialized = true;

    const TICKS_PER_SECOND = 10000000;
    const MENU_AUTO_CLOSE_MS = 5000;
    const UI_CONTENT_RENDER_INTERVAL_MS = 500;
    const surfaceMarkupCache = new WeakMap();
    const state = {
        apiClient: null,
        room: null,
        memberToken: null,
        heartbeatIntervalMs: 250,
        softDriftMs: 80,
        hardDriftMs: 500,
        readyBufferSeconds: 2,
        mediaEpoch: 0,
        mediaReadyEpoch: 0,
        mediaReadySentAt: 0,
        mediaSwitchLoading: false,
        expectedItemId: 0,
        playbackManager: null,
        playbackManagerPromise: null,
        mediaFallbackTimer: null,
        transitionTicker: null,
        clientSequence: 0,
        clientInstanceId: null,
        clockOffsetMs: 0,
        clockSamples: [],
        clockRequests: new Map(),
        video: null,
        videoCleanup: null,
        suppressUntil: 0,
        drawerOpen: false,
        activeDrawerClass: null,
        activeDrawerElement: null,
        lastFocused: null,
        drawerAutoCloseTimer: null,
        drawerFocusTimer: null,
        drawerFocusGeneration: 0,
        headerMenuOpen: false,
        headerLastFocused: null,
        headerAutoCloseTimer: null,
        headerFocusTimer: null,
        headerFocusGeneration: 0,
        headerPositionFrame: null,
        contentRenderTimer: null,
        lastContentRenderAt: 0,
        surfacePointerDown: false,
        pointerReleaseFrame: null,
        contentRenderPendingWhileInteracting: false,
        surfaceActionPending: 0,
        heartbeatTimer: null,
        clockTimer: null,
        statusTimer: null,
        statusPollInFlight: false,
        statusPollFailures: 0,
        pendingCommand: null,
        lastLoadCommand: null,
        loadCommandExpiresAt: 0,
        loadAlignmentGeneration: 0,
        localSeekInProgress: false,
        localSeekDeadline: 0,
        seekCommitUntil: 0,
        localControlUntil: 0,
        programmaticSeekTarget: null,
        programmaticSeekUntil: 0,
        originalPlaybackRate: 1,
        nudgeTimer: null,
        connectionOnline: true,
        websocketOnline: false,
        activeParticipant: false,
        mutationObserver: null,
        observerFrame: null
    };

    const text = {
        title: "多人同步",
        create: "创建同步房间",
        join: "加入房间",
        leave: "离开房间",
        close: "关闭房间",
        codePlaceholder: "输入 3 位数字房间码",
        noPlayback: "请先播放一个视频，然后创建房间。",
        copied: "邀请链接已复制",
        copy: "复制邀请链接",
        holding: "成员正在缓冲，已为全房暂停",
        good: "同步良好",
        unstable: "网络波动",
        offline: "同步连接已断开",
        joining: "正在加入房间…",
        emptyMembers: "正在等待其他成员加入",
        hostSwitching: "房主正在切换媒体",
        loadingMedia: "正在加载新媒体",
        membershipEnded: "已离开同步房间：只有房主可以切换全房媒体",
        creatorDisconnected: "房主已离开，房间已关闭",
        switchTimeout: "房主长时间未播放新媒体，房间已关闭"
    };

    function waitForEmby() {
        if (!window.ApiClient || !window.Events || !document.body ||
            !window.ApiClient.accessToken || !window.ApiClient.accessToken()) {
            window.setTimeout(waitForEmby, 250);
            return;
        }

        state.apiClient = window.ApiClient;
        getPlaybackManager().catch(function () {});
        ensureStylesheet();
        bindApiEvents();
        startObservers();
        refreshStatus().then(handleInviteFragment).catch(showError);
    }

    function ensureStylesheet() {
        if (document.getElementById("syncPlay-client-css")) {
            return;
        }
        const link = document.createElement("link");
        link.id = "syncPlay-client-css";
        link.rel = "stylesheet";
        link.href = "/web/configurationpage?name=syncplayclientcss&v=1.5.6";
        document.head.appendChild(link);
    }

    function bindApiEvents() {
        window.Events.on(state.apiClient, "message", onServerMessage);
        window.Events.on(state.apiClient, "websocketopen", function () {
            state.websocketOnline = true;
            state.connectionOnline = true;
            renderAll();
            if (state.memberToken) {
                runInitialClockSync();
            }
        });
        window.Events.on(state.apiClient, "websocketclose", function () {
            // The plugin events use HTTP.  A missing Emby WebSocket must not
            // disable the HTTP polling/control fallback used by NAS proxies.
            state.websocketOnline = false;
            renderAll();
        });
    }

    function eventPathContains(event, selector) {
        const path = event && typeof event.composedPath === "function" ? event.composedPath() : [];
        if (path.some(function (node) {
            return node && node.matches && node.matches(selector);
        })) {
            return true;
        }
        const target = event && event.target;
        return Boolean(target && target.closest && target.closest(selector));
    }

    function releaseSurfacePointerAfterClick() {
        window.cancelAnimationFrame(state.pointerReleaseFrame);
        state.pointerReleaseFrame = window.requestAnimationFrame(function () {
            state.pointerReleaseFrame = null;
            releaseSurfacePointerNow();
        });
    }

    function releaseSurfacePointerNow() {
        window.cancelAnimationFrame(state.pointerReleaseFrame);
        state.pointerReleaseFrame = null;
        state.surfacePointerDown = false;
        if (state.contentRenderPendingWhileInteracting && !state.surfaceActionPending) {
            state.contentRenderPendingWhileInteracting = false;
            renderSurfaceContents();
        }
    }

    function startObservers() {
        state.mutationObserver = new MutationObserver(function (mutations) {
            const hasExternalMutation = !mutations || mutations.some(function (mutation) {
                const target = mutation && mutation.target;
                return !target || !target.closest ||
                    !target.closest(".syncPlay-panel, .syncPlay-headerPanel, .syncPlay-controlButton, .syncPlay-toast");
            });
            if (!hasExternalMutation) {
                return;
            }
            if (state.observerFrame) {
                return;
            }
            state.observerFrame = window.requestAnimationFrame(function () {
                state.observerFrame = null;
                mountPlayerUi();
                bindCurrentVideo();
            });
        });
        state.mutationObserver.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("viewbeforeshow", mountPlayerUi);
        document.addEventListener("viewbeforehide", function (event) {
            if (event.target && event.target.querySelector && event.target.querySelector(".videoOsdBottom")) {
                closeDrawer(false);
            }
        });
        document.addEventListener("click", function (event) {
            const insideHeader = eventPathContains(event, ".syncPlay-headerPanel, .syncPlay-headerButton");
            const insideDrawer = eventPathContains(event, ".syncPlay-panel, .syncPlay-osdButton, .syncPlay-barButton");

            if (state.headerMenuOpen) {
                if (insideHeader) {
                    resetHeaderAutoClose();
                } else {
                    closeHeaderMenu(false);
                }
            }
            if (state.drawerOpen) {
                if (insideDrawer) {
                    resetDrawerAutoClose();
                } else {
                    closeDrawer(false);
                }
            }
        }, true);
        document.addEventListener("input", function (event) {
            const target = event.target;
            if (state.headerMenuOpen && target && target.closest && target.closest(".syncPlay-headerPanel")) {
                resetHeaderAutoClose();
            }
            if (state.drawerOpen && target && target.closest && target.closest(".syncPlay-panel")) {
                resetDrawerAutoClose();
            }
        }, true);
        document.addEventListener("pointerdown", function (event) {
            window.cancelAnimationFrame(state.pointerReleaseFrame);
            state.pointerReleaseFrame = null;
            const insideHeader = eventPathContains(event, ".syncPlay-headerPanel");
            const insideDrawer = eventPathContains(event, ".syncPlay-panel");
            state.surfacePointerDown = Boolean(insideHeader || insideDrawer);
            if (insideHeader) {
                resetHeaderAutoClose();
            }
            if (insideDrawer) {
                resetDrawerAutoClose();
            }
        }, true);
        document.addEventListener("pointerup", releaseSurfacePointerAfterClick, true);
        document.addEventListener("pointercancel", releaseSurfacePointerAfterClick, true);
        window.addEventListener("blur", releaseSurfacePointerNow);
        ["wheel", "touchmove", "focusin"].forEach(function (eventName) {
            document.addEventListener(eventName, function (event) {
                if (eventPathContains(event, ".syncPlay-headerPanel")) {
                    resetHeaderAutoClose();
                }
                if (eventPathContains(event, ".syncPlay-panel")) {
                    resetDrawerAutoClose();
                }
            }, true);
        });
        window.addEventListener("resize", scheduleHeaderPosition);
        document.addEventListener("scroll", function (event) {
            const target = event.target;
            if (target && target.closest && target.closest(".syncPlay-headerPanel")) {
                resetHeaderAutoClose();
                return;
            }
            if (target && target.closest && target.closest(".syncPlay-panel")) {
                resetDrawerAutoClose();
                return;
            }
            scheduleHeaderPosition();
        }, true);
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                if (state.headerMenuOpen) {
                    event.stopPropagation();
                    closeHeaderMenu();
                } else if (state.drawerOpen) {
                    event.stopPropagation();
                    closeDrawer();
                }
                return;
            }
            const target = event.target;
            if (state.headerMenuOpen && target && target.closest && target.closest(".syncPlay-headerPanel")) {
                resetHeaderAutoClose();
            }
            if (state.drawerOpen && target && target.closest && target.closest(".syncPlay-panel")) {
                resetDrawerAutoClose();
            }
        }, true);
        mountPlayerUi();
        bindCurrentVideo();
    }

    function mountPlayerUi() {
        if (document.documentElement.classList.contains("layout-tv")) {
            return false;
        }

        let mounted = false;

        const headerRight = document.querySelector(".headerRight");
        if (headerRight && !headerRight.querySelector(".syncPlay-headerButton")) {
            const headerButton = createHeaderButton();
            const userButton = headerRight.querySelector(".headerUserButton");
            headerRight.insertBefore(headerButton, userButton || null);
            mounted = true;
        }
        if (!document.querySelector("body > .syncPlay-headerPanel")) {
            document.body.appendChild(createHeaderPanel());
            mounted = true;
        }

        document.querySelectorAll(".videoOsdBottom-buttons-topright").forEach(function (topRight) {
            if (!topRight.querySelector(".syncPlay-osdButton")) {
                const button = createPlayerButton("syncPlay-osdButton");
                const settings = topRight.querySelector(".btnVideoOsdSettings");
                topRight.insertBefore(button, settings || null);
                mounted = true;
            }
        });

        document.querySelectorAll(".videoOsdBottom-maincontrols").forEach(function (mainControls) {
            if (!mainControls.querySelector(".syncPlay-drawer")) {
                const drawer = createDrawer("syncPlay-drawer");
                mainControls.insertBefore(drawer, mainControls.firstElementChild);
                mounted = true;
            }
        });

        document.querySelectorAll(".nowPlayingBarRight").forEach(function (nowPlayingRight) {
            if (!nowPlayingRight.querySelector(".syncPlay-barButton")) {
                nowPlayingRight.insertBefore(createPlayerButton("syncPlay-barButton"), nowPlayingRight.firstElementChild);
                mounted = true;
            }
        });

        document.querySelectorAll(".nowPlayingBar").forEach(function (nowPlayingBar) {
            if (!nowPlayingBar.querySelector(".syncPlay-miniDrawer")) {
                nowPlayingBar.appendChild(createDrawer("syncPlay-miniDrawer"));
                mounted = true;
            }
        });
        if (mounted) {
            renderAll(true);
        }
        return mounted;
    }

    function createPaperIconButton() {
        let button;
        try {
            button = document.createElement("button", { is: "paper-icon-button-light" });
        } catch (error) {
            button = document.createElement("button");
        }
        button.setAttribute("is", "paper-icon-button-light");
        return button;
    }

    function createPlayerButton(extraClass) {
        const button = createPaperIconButton();
        button.type = "button";
        button.className = "osdIconButton paper-icon-button-light syncPlay-controlButton " + extraClass;
        button.innerHTML = [
            '<i class="md-icon osdIconButton-icon syncPlay-buttonIcon">&#xe7fb;</i>',
            '<span class="syncPlay-memberBadge" aria-hidden="true"></span>'
        ].join("");
        button.addEventListener("click", function (event) {
            event.preventDefault();
            toggleDrawer(button, event.detail === 0);
        });
        return button;
    }

    function createHeaderButton() {
        const button = createPaperIconButton();
        button.type = "button";
        button.className = "headerButton headerSectionItem paper-icon-button-light syncPlay-controlButton syncPlay-headerButton";
        button.innerHTML = [
            '<i class="md-icon syncPlay-buttonIcon">&#xe7fb;</i>',
            '<span class="syncPlay-memberBadge" aria-hidden="true"></span>'
        ].join("");
        button.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            toggleHeaderMenu(button, event.detail === 0);
        });
        return button;
    }

    function createHeaderPanel() {
        const panel = document.createElement("section");
        panel.className = "syncPlay-headerPanel";
        panel.setAttribute("aria-label", "快速加入同步房间");
        panel.setAttribute("aria-hidden", "true");
        panel.inert = true;
        return panel;
    }

    function createDrawer(extraClass) {
        const drawer = document.createElement("section");
        drawer.className = "syncPlay-panel osdContentSection " + extraClass;
        drawer.setAttribute("aria-label", text.title);
        drawer.setAttribute("aria-hidden", "true");
        drawer.inert = true;
        return drawer;
    }

    function toggleDrawer(source, focusOnOpen) {
        if (state.drawerOpen) {
            closeDrawer();
            return;
        }
        if (state.headerMenuOpen) {
            closeHeaderMenu(false);
        }
        window.clearTimeout(state.drawerFocusTimer);
        state.drawerFocusTimer = null;
        state.drawerFocusGeneration += 1;
        const focusGeneration = state.drawerFocusGeneration;
        state.activeDrawerElement = getDrawerElementForSource(source) || getDefaultDrawerElement();
        state.activeDrawerClass = getDrawerClassForSource(source);
        state.drawerOpen = true;
        state.lastFocused = source;
        setOsdInteractionLock(state.activeDrawerClass === "syncPlay-drawer");
        renderAll(true);
        resetDrawerAutoClose();
        if (!focusOnOpen) {
            return;
        }
        state.drawerFocusTimer = window.setTimeout(function () {
            state.drawerFocusTimer = null;
            if (!state.drawerOpen || focusGeneration !== state.drawerFocusGeneration) {
                return;
            }
            const target = getVisibleDrawer();
            const focusable = target && target.querySelector("button, input");
            if (focusable) {
                focusable.focus();
            }
        }, getSurfaceFocusDelay());
    }

    function closeDrawer(restoreFocus) {
        window.clearTimeout(state.drawerAutoCloseTimer);
        state.drawerAutoCloseTimer = null;
        window.clearTimeout(state.drawerFocusTimer);
        state.drawerFocusTimer = null;
        state.drawerFocusGeneration += 1;
        moveFocusBeforeClose(".syncPlay-panel", state.lastFocused, restoreFocus);
        state.drawerOpen = false;
        setOsdInteractionLock(false);
        updateSurfaceVisibility();
        state.lastFocused = null;
        state.activeDrawerClass = null;
        state.activeDrawerElement = null;
    }

    function resetDrawerAutoClose() {
        window.clearTimeout(state.drawerAutoCloseTimer);
        state.drawerAutoCloseTimer = null;
        if (state.drawerOpen) {
            state.drawerAutoCloseTimer = window.setTimeout(function () {
                state.drawerAutoCloseTimer = null;
                if (state.surfacePointerDown || state.surfaceActionPending) {
                    resetDrawerAutoClose();
                    return;
                }
                closeDrawer(false);
            }, MENU_AUTO_CLOSE_MS);
        }
    }

    function toggleHeaderMenu(source, focusOnOpen) {
        if (state.headerMenuOpen) {
            closeHeaderMenu();
            return;
        }
        if (state.drawerOpen) {
            closeDrawer(false);
        }
        window.clearTimeout(state.headerFocusTimer);
        state.headerFocusTimer = null;
        state.headerFocusGeneration += 1;
        const focusGeneration = state.headerFocusGeneration;
        state.headerMenuOpen = true;
        state.headerLastFocused = source;
        renderAll(true);
        resetHeaderAutoClose();
        if (!focusOnOpen) {
            return;
        }
        state.headerFocusTimer = window.setTimeout(function () {
            state.headerFocusTimer = null;
            if (!state.headerMenuOpen || focusGeneration !== state.headerFocusGeneration) {
                return;
            }
            const input = document.querySelector(".syncPlay-headerPanel.syncPlay-surfaceOpen input");
            if (input) {
                input.focus();
            }
        }, getSurfaceFocusDelay());
    }

    function closeHeaderMenu(restoreFocus) {
        window.clearTimeout(state.headerAutoCloseTimer);
        state.headerAutoCloseTimer = null;
        window.clearTimeout(state.headerFocusTimer);
        state.headerFocusTimer = null;
        state.headerFocusGeneration += 1;
        moveFocusBeforeClose(".syncPlay-headerPanel", state.headerLastFocused, restoreFocus);
        state.headerMenuOpen = false;
        updateSurfaceVisibility();
        state.headerLastFocused = null;
    }

    function resetHeaderAutoClose() {
        window.clearTimeout(state.headerAutoCloseTimer);
        state.headerAutoCloseTimer = null;
        if (state.headerMenuOpen) {
            state.headerAutoCloseTimer = window.setTimeout(function () {
                state.headerAutoCloseTimer = null;
                if (state.surfacePointerDown || state.surfaceActionPending) {
                    resetHeaderAutoClose();
                    return;
                }
                closeHeaderMenu(false);
            }, MENU_AUTO_CLOSE_MS);
        }
    }

    function getSurfaceFocusDelay() {
        return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
    }

    function moveFocusBeforeClose(surfaceSelector, returnTarget, restoreFocus) {
        const activeElement = document.activeElement;
        const activeInside = activeElement && activeElement.closest && activeElement.closest(surfaceSelector);
        if (restoreFocus !== false && returnTarget && document.contains(returnTarget)) {
            returnTarget.focus();
            return;
        }
        if (activeInside && activeElement.blur) {
            activeElement.blur();
        }
    }

    function getDrawerClassForSource(source) {
        const drawer = getDrawerElementForSource(source) || getDefaultDrawerElement();
        return drawer && drawer.classList.contains("syncPlay-miniDrawer")
            ? "syncPlay-miniDrawer"
            : "syncPlay-drawer";
    }

    function getDrawerElementForSource(source) {
        if (!source || !source.closest) {
            return null;
        }
        if (source.classList.contains("syncPlay-barButton")) {
            const bar = source.closest(".nowPlayingBar");
            return bar && bar.querySelector(".syncPlay-miniDrawer");
        }
        const osd = source.closest(".videoOsdBottom");
        return osd && osd.querySelector(".syncPlay-drawer");
    }

    function getDefaultDrawerElement() {
        const activeVideoView = document.querySelector(".view-videoosd-videoosd:not(.hide)");
        const activeOsdDrawer = activeVideoView && activeVideoView.querySelector(".syncPlay-drawer");
        if (activeOsdDrawer) {
            return activeOsdDrawer;
        }
        const visibleBar = Array.prototype.find.call(document.querySelectorAll(".nowPlayingBar"), function (bar) {
            return bar.offsetParent !== null && !bar.classList.contains("hide");
        });
        if (visibleBar) {
            return visibleBar.querySelector(".syncPlay-miniDrawer");
        }
        return document.querySelector(".syncPlay-drawer, .syncPlay-miniDrawer");
    }

    function setOsdInteractionLock(locked) {
        const activeOsd = state.activeDrawerElement && state.activeDrawerElement.closest
            ? state.activeDrawerElement.closest(".videoOsdBottom")
            : null;
        document.querySelectorAll(".videoOsdBottom").forEach(function (osd) {
            osd.classList.toggle("syncPlay-osdLocked", Boolean(locked && osd === activeOsd));
        });
    }

    function scheduleHeaderPosition() {
        if (!state.headerMenuOpen || state.headerPositionFrame) {
            return;
        }
        state.headerPositionFrame = window.requestAnimationFrame(function () {
            state.headerPositionFrame = null;
            positionHeaderPanel();
        });
    }

    function positionHeaderPanel() {
        if (!state.headerMenuOpen) {
            return;
        }
        const button = document.querySelector(".syncPlay-headerButton");
        const panel = document.querySelector("body > .syncPlay-headerPanel.syncPlay-surfaceOpen");
        if (!button || !panel) {
            return;
        }
        const buttonRect = button.getBoundingClientRect();
        const gap = 8;
        const edge = 8;
        const top = Math.min(
            buttonRect.bottom + gap,
            Math.max(edge, window.innerHeight - panel.offsetHeight - edge)
        );
        panel.style.top = Math.max(edge, top) + "px";
        panel.style.insetInlineEnd = Math.max(edge, window.innerWidth - buttonRect.right) + "px";
    }

    function getVisibleDrawer() {
        if (state.activeDrawerElement && state.activeDrawerElement.isConnected &&
            state.activeDrawerElement.classList.contains("syncPlay-surfaceOpen")) {
            return state.activeDrawerElement;
        }
        const activeClass = state.activeDrawerClass || "syncPlay-drawer";
        return document.querySelector("." + activeClass + ".syncPlay-surfaceOpen");
    }

    function setSurfaceOpen(surface, open) {
        const changed = surface.classList.contains("syncPlay-surfaceOpen") !== open;
        if (open) {
            surface.inert = false;
            surface.setAttribute("aria-hidden", "false");
            surface.classList.add("syncPlay-surfaceOpen");
        } else {
            surface.inert = true;
            surface.setAttribute("aria-hidden", "true");
            surface.classList.remove("syncPlay-surfaceOpen");
        }
        return changed;
    }

    function updateSurfaceVisibility() {
        const activeDrawerClass = state.activeDrawerClass || getDrawerClassForSource(null);
        if (state.drawerOpen && (!state.activeDrawerElement || !state.activeDrawerElement.isConnected)) {
            state.activeDrawerElement = getDefaultDrawerElement();
        }
        document.querySelectorAll(".syncPlay-panel").forEach(function (panel) {
            const isActiveDrawer = state.activeDrawerElement
                ? panel === state.activeDrawerElement
                : panel.classList.contains(activeDrawerClass);
            setSurfaceOpen(panel, state.drawerOpen && isActiveDrawer);
        });
        let headerVisibilityChanged = false;
        document.querySelectorAll(".syncPlay-headerPanel").forEach(function (panel) {
            headerVisibilityChanged = setSurfaceOpen(panel, state.headerMenuOpen) || headerVisibilityChanged;
        });
        const osdDrawerActive = state.activeDrawerElement
            ? state.activeDrawerElement.classList.contains("syncPlay-drawer")
            : activeDrawerClass === "syncPlay-drawer";
        setOsdInteractionLock(state.drawerOpen && osdDrawerActive);
        if (state.headerMenuOpen && headerVisibilityChanged) {
            scheduleHeaderPosition();
        }
        updatePlayerButtons();
    }

    function updateSurfaceMarkup(surface, markup, bindActions) {
        if (surfaceMarkupCache.get(surface) === markup) {
            return false;
        }
        const scrollTop = surface.scrollTop;
        surface.innerHTML = markup;
        surfaceMarkupCache.set(surface, markup);
        bindActions(surface);
        surface.scrollTop = scrollTop;
        return true;
    }

    function renderSurfaceContents() {
        if (state.surfacePointerDown || state.surfaceActionPending) {
            state.contentRenderPendingWhileInteracting = true;
            return;
        }
        state.contentRenderPendingWhileInteracting = false;
        if (state.drawerOpen) {
            const drawerMarkup = state.room ? renderRoom() : renderLobby();
            const drawer = getVisibleDrawer();
            if (drawer) {
                updateSurfaceMarkup(drawer, drawerMarkup, bindPanelActions);
            }
        }
        if (state.headerMenuOpen) {
            const headerMarkup = renderHeaderMenu();
            let headerChanged = false;
            document.querySelectorAll(".syncPlay-headerPanel").forEach(function (panel) {
                headerChanged = updateSurfaceMarkup(panel, headerMarkup, bindHeaderActions) || headerChanged;
            });
            if (headerChanged) {
                scheduleHeaderPosition();
            }
        }
        state.lastContentRenderAt = performance.now();
    }

    function scheduleSurfaceContentRender(delay) {
        if (state.contentRenderTimer) {
            return;
        }
        state.contentRenderTimer = window.setTimeout(function () {
            state.contentRenderTimer = null;
            renderSurfaceContents();
        }, Math.max(0, delay));
    }

    function renderAll(immediateContent) {
        updateSurfaceVisibility();
        if (!state.drawerOpen && !state.headerMenuOpen) {
            window.clearTimeout(state.contentRenderTimer);
            state.contentRenderTimer = null;
            return;
        }
        if (immediateContent !== false) {
            window.clearTimeout(state.contentRenderTimer);
            state.contentRenderTimer = null;
            renderSurfaceContents();
            return;
        }
        const elapsed = performance.now() - state.lastContentRenderAt;
        scheduleSurfaceContentRender(UI_CONTENT_RENDER_INTERVAL_MS - elapsed);
    }

    function renderLobby() {
        const pendingCode = getInviteCode();
        const mediaName = getCurrentMediaName();
        return [
            '<div class="syncPlay-menuHeader">',
            '  <h2 class="syncPlay-menuTitle">' + text.title + '</h2>',
            '  <div class="syncPlay-menuHeaderEnd"><span class="syncPlay-menuHeaderState">未加入</span><button type="button" class="paper-icon-button-light syncPlay-closeButton" aria-label="关闭"><i class="md-icon">&#xe5cd;</i></button></div>',
            '</div>',
            '<div class="syncPlay-menuList">',
            '  <div class="syncPlay-menuRow syncPlay-menuRow-static">',
            '    <div class="syncPlay-menuRowContent"><div class="syncPlay-menuLabel">当前媒体</div><div class="syncPlay-menuValue syncPlay-menuValue-ellipsis" title="' + escapeHtml(mediaName || text.noPlayback) + '">' + escapeHtml(mediaName || "未检测到") + '</div></div>',
            '  </div>',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-createButton" ' + (mediaName ? "" : "disabled") + '>',
            '    <div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">创建房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">开始同步</div></div>',
            '  </button>',
            '  <label class="syncPlay-menuRow syncPlay-inputRow">',
            '    <span class="syncPlay-menuLabel">房间码</span><input class="syncPlay-codeInput" maxlength="3" inputmode="numeric" pattern="[0-9]{3}" autocomplete="off" spellcheck="false" aria-label="房间码" placeholder="3 位数字" value="' + escapeHtml(pendingCode || "") + '">',
            '  </label>',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-joinButton">',
            '    <div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">加入房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">进入</div></div>',
            '  </button>',
            '</div>',
            '<div class="syncPlay-message" role="status"></div>'
        ].join("");
    }

    function renderRoom() {
        const room = state.room;
        const members = getValue(room, "Members", "members") || [];
        const code = getValue(room, "Code", "code") || "";
        const roomState = getValue(room, "State", "state") || "Paused";
        const transition = getTransitionInfo(room, members);
        const quality = getRoomQuality(members, roomState);
        const banner = transition
            ? '<div class="syncPlay-holdBanner syncPlay-transitionBanner syncPlay-transitionBanner-' + transition.kind + '"><i class="md-icon">' + transition.icon + '</i><span>' + escapeHtml(transition.label) + '</span></div>'
            : roomState === "Holding"
            ? '<div class="syncPlay-holdBanner"><i class="md-icon">&#xe034;</i><span>' + text.holding + '</span></div>'
            : "";
        const memberCards = members.length
            ? members.map(renderMember).join("")
            : '<div class="syncPlay-empty">' + text.emptyMembers + '</div>';
        const closeButton = getValue(room, "IsCreator", "isCreator")
            ? '<button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-closeRoomButton syncPlay-menuButton-danger"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">关闭房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">结束同步</div></div></button>'
            : "";
        return [
            '<div class="syncPlay-menuHeader">',
            '  <h2 class="syncPlay-menuTitle">' + text.title + '</h2>',
            '  <div class="syncPlay-menuHeaderEnd"><span class="syncPlay-menuHeaderState syncPlay-quality-' + quality.kind + '">' + quality.label + '</span><button type="button" class="paper-icon-button-light syncPlay-closeButton" aria-label="关闭"><i class="md-icon">&#xe5cd;</i></button></div>',
            '</div>',
            banner,
            '<div class="syncPlay-menuList">',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-copyButton" title="' + text.copy + '"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">房间码</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue syncPlay-roomCode"><span>' + escapeHtml(code) + '</span><i class="md-icon">&#xe14d;</i></div></div></button>',
            '  <div class="syncPlay-menuRow syncPlay-menuRow-static"><div class="syncPlay-menuRowContent"><div class="syncPlay-menuLabel">房间名称</div><div class="syncPlay-menuValue syncPlay-menuValue-ellipsis">' + escapeHtml(getValue(room, "Name", "name") || text.title) + '</div></div></div>',
            '  <div class="syncPlay-menuRow syncPlay-menuRow-static"><div class="syncPlay-menuRowContent"><div class="syncPlay-menuLabel">同步状态</div><div class="syncPlay-menuValue syncPlay-quality syncPlay-quality-' + quality.kind + '"><span class="syncPlay-qualityDot"></span><span>' + quality.label + '</span></div></div></div>',
            '  <div class="syncPlay-menuSection"><span>成员</span><span>' + members.length + ' 人</span></div>',
            '  <div class="syncPlay-members">' + memberCards + '</div>',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-leaveButton"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">离开房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">退出</div></div></button>',
            closeButton,
            '</div>',
            '<div class="syncPlay-message" role="status"></div>'
        ].join("");
    }

    function renderMember(member) {
        const name = getValue(member, "Name", "name") || "Emby User";
        const device = getValue(member, "Device", "device") || "Web";
        const rtt = Number(getValue(member, "RoundTripTimeMs", "roundTripTimeMs") || 0);
        const drift = Number(getValue(member, "DriftMs", "driftMs") || 0);
        const buffering = Boolean(getValue(member, "IsBuffering", "isBuffering"));
        const loading = Boolean(getValue(member, "IsMediaLoading", "isMediaLoading"));
        const mediaReady = Boolean(getValue(member, "IsMediaReady", "isMediaReady"));
        const loadTimedOut = Boolean(getValue(member, "MediaLoadTimedOut", "mediaLoadTimedOut"));
        const creator = Boolean(getValue(member, "IsCreator", "isCreator"));
        const mediaStatus = loadTimedOut
            ? "稍后追赶"
            : mediaReady
                ? "已就绪"
                : loading
                    ? "加载中"
                    : "";
        return [
            '<article class="syncPlay-menuRow syncPlay-member ' + (buffering || loading ? "syncPlay-member-buffering" : "") + '">',
            '  <div class="syncPlay-menuRowContent"><div class="syncPlay-memberText"><div class="syncPlay-memberName">' + escapeHtml(name) + (creator ? '<span class="syncPlay-hostTag">房主</span>' : "") + '</div><div class="syncPlay-rowSubtext">' + escapeHtml(device) + '</div></div><div class="syncPlay-memberMetrics"><span>' + escapeHtml(mediaStatus || (buffering ? "缓冲中" : rtt + "ms")) + '</span><span>' + (drift >= 0 ? "+" : "") + drift + 'ms</span></div></div>',
            '</article>'
        ].join("");
    }

    function getTransitionInfo(room, members) {
        const transitionState = getValue(room, "MediaTransitionState", "mediaTransitionState") || "None";
        if (transitionState === "AwaitingHostPlayback") {
            const deadline = Number(getValue(room, "TransitionDeadlineUnixMs", "transitionDeadlineUnixMs") || 0);
            const remainingSeconds = deadline ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : 0;
            const countdown = deadline
                ? " · " + Math.floor(remainingSeconds / 60) + ":" + String(remainingSeconds % 60).padStart(2, "0")
                : "";
            return { kind: "switching", icon: "&#xe042;", label: text.hostSwitching + countdown };
        }
        if (transitionState === "LoadingMembers") {
            const ready = Number(getValue(room, "ReadyMemberCount", "readyMemberCount") || 0);
            const target = members.filter(function (member) {
                return !Boolean(getValue(member, "MediaLoadTimedOut", "mediaLoadTimedOut"));
            }).length;
            return {
                kind: "loading",
                icon: "&#xe627;",
                label: text.loadingMedia + (target ? " · " + ready + "/" + target + " 已就绪" : "")
            };
        }
        return null;
    }

    function renderHeaderMenu() {
        const room = state.room;
        if (!room) {
            return [
                '<div class="syncPlay-menuHeader">',
                '  <h2 class="syncPlay-menuTitle">快速加入</h2>',
                '  <div class="syncPlay-menuHeaderEnd"><span class="syncPlay-menuHeaderState">多人同步</span><button type="button" class="paper-icon-button-light syncPlay-closeButton syncPlay-headerCloseButton" aria-label="关闭"><i class="md-icon">&#xe5cd;</i></button></div>',
                '</div>',
                '<div class="syncPlay-menuList">',
                '  <label class="syncPlay-menuRow syncPlay-inputRow">',
                '    <span class="syncPlay-menuLabel">房间码</span><input class="syncPlay-codeInput syncPlay-headerCodeInput" maxlength="3" inputmode="numeric" pattern="[0-9]{3}" autocomplete="off" spellcheck="false" aria-label="房间码" placeholder="3 位数字">',
                '  </label>',
                '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-headerJoinButton"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">进入房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">打开并同步</div></div></button>',
                '  <p class="syncPlay-headerHint">加入后将自动打开房间绑定的媒体，并跳转到当前播放进度。</p>',
                '</div>',
                '<div class="syncPlay-message" role="status"></div>'
            ].join("");
        }

        const members = getValue(room, "Members", "members") || [];
        const roomState = getValue(room, "State", "state") || "Paused";
        const quality = getRoomQuality(members, roomState);
        const code = getValue(room, "Code", "code") || "";
        const positionTicks = getRoomTargetTicks(room);
        return [
            '<div class="syncPlay-menuHeader">',
            '  <h2 class="syncPlay-menuTitle">同步房间</h2>',
            '  <div class="syncPlay-menuHeaderEnd"><span class="syncPlay-menuHeaderState syncPlay-quality-' + quality.kind + '">' + escapeHtml(code) + '</span><button type="button" class="paper-icon-button-light syncPlay-closeButton syncPlay-headerCloseButton" aria-label="关闭"><i class="md-icon">&#xe5cd;</i></button></div>',
            '</div>',
            '<div class="syncPlay-menuList">',
            '  <div class="syncPlay-menuRow syncPlay-menuRow-static"><div class="syncPlay-menuRowContent"><div class="syncPlay-menuLabel">当前媒体</div><div class="syncPlay-menuValue syncPlay-menuValue-ellipsis">' + escapeHtml(getValue(room, "ItemName", "itemName") || "媒体 " + getValue(room, "ItemId", "itemId")) + '</div></div></div>',
            '  <div class="syncPlay-menuRow syncPlay-menuRow-static"><div class="syncPlay-menuRowContent"><div class="syncPlay-menuLabel">房间状态</div><div class="syncPlay-menuValue syncPlay-quality syncPlay-quality-' + quality.kind + '"><span class="syncPlay-qualityDot"></span><span>' + quality.label + '</span></div></div></div>',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-headerOpenButton"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">进入播放</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">' + formatPositionTicks(positionTicks) + '</div></div></button>',
            '  <button type="button" class="listItem listItem-autoactive listItemCursor listItem-hoverable actionSheetMenuItem actionSheetMenuItem-noicon syncPlay-menuRow syncPlay-menuButton syncPlay-headerLeaveButton"><div class="listItem-content listItem-content-bg listItemContent-touchzoom listItem-border actionsheet-noborder syncPlay-menuRowContent"><div class="actionsheetListItemBody listItemBody listItemBody-noleftpadding listItemBody-1-lines syncPlay-menuLabel">离开房间</div><div class="listItemAside actionSheetItemAsideText secondaryText syncPlay-menuValue">退出</div></div></button>',
            '</div>',
            '<div class="syncPlay-message" role="status"></div>'
        ].join("");
    }

    function bindHeaderActions(panel) {
        bindClick(panel, ".syncPlay-headerCloseButton", closeHeaderMenu);
        bindClick(panel, ".syncPlay-headerJoinButton", function (source) {
            const input = panel.querySelector(".syncPlay-headerCodeInput");
            joinRoom(input ? input.value : "", { openPlayback: true }, source);
        });
        bindClick(panel, ".syncPlay-headerOpenButton", function () {
            openRoomPlayback(state.room);
        });
        bindClick(panel, ".syncPlay-headerLeaveButton", function () {
            closeHeaderMenu(false);
            leaveRoom();
        });
        const input = panel.querySelector(".syncPlay-headerCodeInput");
        if (input) {
            input.addEventListener("input", function () {
                input.value = input.value.replace(/[^0-9]/g, "").slice(0, 3);
            });
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter") {
                    joinRoom(input.value, { openPlayback: true }, panel.querySelector(".syncPlay-headerJoinButton"));
                }
            });
        }
    }

    function bindPanelActions(panel) {
        bindClick(panel, ".syncPlay-closeButton", closeDrawer);
        bindClick(panel, ".syncPlay-createButton", createRoom);
        bindClick(panel, ".syncPlay-joinButton", function (source) {
            const input = panel.querySelector(".syncPlay-codeInput");
            joinRoom(input ? input.value : "", null, source);
        });
        bindClick(panel, ".syncPlay-leaveButton", leaveRoom);
        bindClick(panel, ".syncPlay-closeRoomButton", closeRoom);
        bindClick(panel, ".syncPlay-copyButton", copyInviteLink);
        const input = panel.querySelector(".syncPlay-codeInput");
        if (input) {
            input.addEventListener("input", function () {
                input.value = input.value.replace(/[^0-9]/g, "").slice(0, 3);
            });
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter") {
                    joinRoom(input.value, null, panel.querySelector(".syncPlay-joinButton"));
                }
            });
        }
    }

    function bindClick(root, selector, handler) {
        const element = root.querySelector(selector);
        if (element) {
            element.addEventListener("click", function (event) {
                event.preventDefault();
                handler(element, event);
            });
        }
    }

    function setActionPending(element, pending) {
        if (!element) {
            return;
        }
        const wasPending = element.getAttribute("aria-busy") === "true";
        if (pending && !wasPending) {
            state.surfaceActionPending += 1;
        } else if (!pending && wasPending) {
            state.surfaceActionPending = Math.max(0, state.surfaceActionPending - 1);
        }
        element.disabled = pending;
        element.classList.toggle("syncPlay-menuButton-pending", pending);
        if (pending) {
            element.setAttribute("aria-busy", "true");
        } else {
            element.removeAttribute("aria-busy");
        }
        if (element.closest && element.closest(".syncPlay-headerPanel")) {
            resetHeaderAutoClose();
        }
        if (element.closest && element.closest(".syncPlay-panel")) {
            resetDrawerAutoClose();
        }
        if (!pending && !state.surfaceActionPending &&
            (state.contentRenderPendingWhileInteracting || state.contentRenderTimer)) {
            window.clearTimeout(state.contentRenderTimer);
            state.contentRenderTimer = null;
            state.contentRenderPendingWhileInteracting = false;
            renderAll(true);
        }
    }

    async function createRoom(source) {
        setActionPending(source, true);
        setPanelMessage("正在创建房间…");
        try {
            const video = state.video;
            applyJoinResult(await apiRequest("SyncPlay/Rooms", "POST", {
                PositionTicks: video ? Math.round(video.currentTime * TICKS_PER_SECOND) : null,
                IsPaused: video ? video.paused : null
            }));
            state.activeParticipant = true;
            startRealtime();
        } catch (error) {
            showError(error);
        } finally {
            setActionPending(source, false);
        }
    }

    async function joinRoom(code, options, source) {
        code = String(code || "").trim();
        if (!/^[0-9]{3}$/.test(code)) {
            setPanelMessage("请输入完整的 3 位数字房间码。", true);
            return;
        }
        setActionPending(source, true);
        setPanelMessage(text.joining);
        try {
            const result = await apiRequest("SyncPlay/Rooms/" + encodeURIComponent(code) + "/Join", "POST", {});
            applyJoinResult(result);
            state.activeParticipant = false;
            clearInviteFragment();
            startRealtime();
            if (options && options.openPlayback) {
                await openRoomPlayback(getValue(result, "Room", "room"));
            }
        } catch (error) {
            showError(error);
        } finally {
            setActionPending(source, false);
        }
    }

    async function openRoomPlayback(room) {
        const itemId = Number(getValue(room, "ItemId", "itemId") || 0);
        if (!itemId || !state.apiClient) {
            setPanelMessage("房间没有可播放的媒体。", true);
            return;
        }

        const serverId = state.apiClient.serverId();
        const positionTicks = getRoomTargetTicks(room);
        const roomPositionTicks = Math.max(0, Math.round(Number(getValue(room, "PositionTicks", "positionTicks") || 0)));
        const roomReferenceUnixMs = Number(getValue(room, "ReferenceUnixMs", "referenceUnixMs") || serverNow());
        const roomState = getValue(room, "State", "state") || "Paused";
        const loadCommand = {
            Kind: "Load",
            ItemId: itemId,
            MediaEpoch: Number(getValue(room, "MediaEpoch", "mediaEpoch") || state.mediaEpoch),
            RoomRevision: Number(getValue(room, "Revision", "revision") || 0),
            PositionTicks: roomPositionTicks,
            ReferenceUnixMs: roomReferenceUnixMs,
            State: roomState
        };
        if (rememberLoadCommand(loadCommand)) {
            state.pendingCommand = loadCommand;
        } else if (!state.pendingCommand) {
            state.pendingCommand = state.lastLoadCommand;
        }
        closeHeaderMenu(false);

        try {
            const currentItemId = getCurrentItemId();
            if (state.video && currentItemId && currentItemId === itemId) {
                // A server Load can arrive while the join request is still
                // resolving. Replaying the same item would reset its source and
                // reintroduce a seek offset.
                const activeLoad = state.pendingCommand || state.lastLoadCommand || loadCommand;
                state.pendingCommand = null;
                executeCommand(state.video, activeLoad);
                return;
            }
            const item = await state.apiClient.getItem(state.apiClient.getCurrentUserId(), String(itemId));
            const playbackManager = await getPlaybackManager();
            if (!playbackManager || !playbackManager.play) {
                throw new Error("Emby playback modules are unavailable.");
            }
            await playbackManager.play({
                items: [item],
                startPositionTicks: positionTicks,
                fullscreen: true,
                enableRemotePlayers: false
            });
        } catch (error) {
            console.warn("[SyncPlay] Falling back to item page playback", error);
            navigateToRoomMediaFallback(itemId, serverId);
        }
    }

    function navigateToRoomMediaFallback(itemId, serverId) {
        window.location.hash = "#!/item?id=" + encodeURIComponent(itemId) +
            "&serverId=" + encodeURIComponent(serverId) + "&context=syncplay";
        const deadline = Date.now() + 12000;
        const tryPlay = function () {
            const button = document.querySelector(
                ".itemView:not(.hide) .btnResume:not(.hide), .itemView:not(.hide) .btnPlay:not(.hide)"
            );
            if (button) {
                button.click();
                return;
            }
            if (Date.now() < deadline) {
                window.setTimeout(tryPlay, 150);
            } else {
                showError("已打开媒体页面，但无法自动开始播放。请手动点击播放。");
            }
        };
        window.setTimeout(tryPlay, 150);
    }

    function getRoomTargetTicks(room) {
        let positionTicks = Number(getValue(room, "PositionTicks", "positionTicks") || 0);
        const referenceUnixMs = Number(getValue(room, "ReferenceUnixMs", "referenceUnixMs") || serverNow());
        if (getValue(room, "State", "state") === "Playing") {
            positionTicks += Math.max(0, serverNow() - referenceUnixMs) * 10000;
        }
        return Math.max(0, Math.round(positionTicks));
    }

    function formatPositionTicks(positionTicks) {
        const totalSeconds = Math.max(0, Math.floor(Number(positionTicks || 0) / TICKS_PER_SECOND));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return hours > 0
            ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
            : minutes + ":" + String(seconds).padStart(2, "0");
    }

    async function leaveRoom() {
        try {
            await apiRequest("SyncPlay/Rooms/Leave", "POST", {});
        } catch (error) {
            showError(error);
        }
        clearRoomState();
    }

    async function closeRoom() {
        const code = state.room && getValue(state.room, "Code", "code");
        if (!code) {
            return;
        }
        try {
            await apiRequest("SyncPlay/Rooms/" + encodeURIComponent(code), "DELETE");
            clearRoomState();
        } catch (error) {
            showError(error);
        }
    }

    function copyInviteLink() {
        const code = state.room && getValue(state.room, "Code", "code");
        if (!code) {
            return;
        }
        const url = window.location.origin + window.location.pathname + "#syncplay=" + encodeURIComponent(code);
        navigator.clipboard.writeText(url).then(function () {
            setPanelMessage(text.copied);
        }).catch(function () {
            setPanelMessage(url);
        });
    }

    async function refreshStatus() {
        try {
            const result = await apiRequest(getStatusPath(), "GET");
            if (result && getValue(result, "Room", "room")) {
                applyJoinResult(result);
                startRealtime();
            }
        } catch (error) {
            console.debug("[SyncPlay] No active room", error);
        }
        renderAll();
    }

    function applyJoinResult(result) {
        const nextToken = getValue(result, "MemberToken", "memberToken");
        if (nextToken && nextToken !== state.memberToken) {
            state.clientSequence = 0;
            state.clientInstanceId = null;
        }
        state.memberToken = nextToken;
        state.heartbeatIntervalMs = Number(getValue(result, "HeartbeatIntervalMs", "heartbeatIntervalMs") || 250);
        state.softDriftMs = Number(getValue(result, "SoftDriftThresholdMs", "softDriftThresholdMs") || 80);
        state.hardDriftMs = Number(getValue(result, "HardDriftThresholdMs", "hardDriftThresholdMs") || 500);
        state.readyBufferSeconds = Number(getValue(result, "ReadyBufferSeconds", "readyBufferSeconds") || 2);
        applyRoomState(getValue(result, "Room", "room"));
    }

    function clearRoomState() {
        state.room = null;
        state.memberToken = null;
        state.clientSequence = 0;
        state.activeParticipant = false;
        state.mediaEpoch = 0;
        state.mediaReadyEpoch = 0;
        state.mediaReadySentAt = 0;
        state.mediaSwitchLoading = false;
        state.expectedItemId = 0;
        state.pendingCommand = null;
        state.lastLoadCommand = null;
        state.loadCommandExpiresAt = 0;
        state.loadAlignmentGeneration += 1;
        state.localSeekInProgress = false;
        state.localSeekDeadline = 0;
        state.seekCommitUntil = 0;
        state.localControlUntil = 0;
        state.clientInstanceId = null;
        state.programmaticSeekTarget = null;
        state.programmaticSeekUntil = 0;
        window.clearTimeout(state.mediaFallbackTimer);
        state.mediaFallbackTimer = null;
        window.clearInterval(state.transitionTicker);
        state.transitionTicker = null;
        stopRealtime();
        restorePlaybackRate();
        renderAll();
    }

    function updateTransitionTicker() {
        window.clearInterval(state.transitionTicker);
        state.transitionTicker = null;
        const transition = getValue(state.room, "MediaTransitionState", "mediaTransitionState") || "None";
        if (transition === "AwaitingHostPlayback") {
            state.transitionTicker = window.setInterval(function () {
                renderAll(false);
            }, 1000);
        }
    }

    function startRealtime() {
        stopRealtime();
        if (!state.memberToken) {
            return;
        }
        state.heartbeatTimer = window.setInterval(sendHeartbeat, Math.max(100, state.heartbeatIntervalMs));
        state.clockTimer = window.setInterval(sendClockPing, 5000);
        state.statusTimer = window.setInterval(
            pollRoomState,
            Math.max(500, state.heartbeatIntervalMs * 2)
        );
        runInitialClockSync();
        sendHeartbeat();
        pollRoomState();
    }

    function stopRealtime() {
        window.clearInterval(state.heartbeatTimer);
        window.clearInterval(state.clockTimer);
        window.clearInterval(state.statusTimer);
        state.heartbeatTimer = null;
        state.clockTimer = null;
        state.statusTimer = null;
        state.statusPollInFlight = false;
        state.statusPollFailures = 0;
        state.clockRequests.clear();
    }

    async function pollRoomState() {
        const token = state.memberToken;
        if (!token || state.statusPollInFlight) {
            return;
        }

        state.statusPollInFlight = true;
        const startedMono = performance.now();
        const startedUnix = Date.now();
        try {
            const result = await apiRequest(getStatusPath(), "GET");
            if (token !== state.memberToken) {
                return;
            }

            const room = getValue(result, "Room", "room");
            if (!room) {
                state.statusPollFailures += 1;
                if (state.statusPollFailures >= 3) {
                    clearRoomState();
                }
                return;
            }

            state.statusPollFailures = 0;
            state.connectionOnline = true;
            const receivedUnix = Date.now();
            const rtt = Math.max(0, Math.round(performance.now() - startedMono));
            const serverReference = Number(getValue(room, "ReferenceUnixMs", "referenceUnixMs") || 0);
            if (serverReference > 0) {
                recordClockSample(rtt, serverReference - ((startedUnix + receivedUnix) / 2));
            }
            applyRoomState(room, "http");
        } catch (error) {
            if (token !== state.memberToken) {
                return;
            }
            state.statusPollFailures += 1;
            state.connectionOnline = false;
            console.warn("[SyncPlay] HTTP room-state poll failed", error);
            renderAll();
        } finally {
            state.statusPollInFlight = false;
        }
    }

    function runInitialClockSync() {
        for (let index = 0; index < 5; index += 1) {
            window.setTimeout(sendClockPing, index * 120);
        }
    }

    function sendClockPing() {
        if (!state.memberToken) {
            return;
        }
        const eventId = createEventId();
        state.clockRequests.set(eventId, { mono: performance.now(), unix: Date.now() });
        sendSocket("SyncPlayClockPing", {
            EventId: eventId,
            ClientUnixMs: Date.now(),
            ClientMonotonicMs: Math.round(performance.now())
        });
    }

    function sendHeartbeat() {
        const video = state.video;
        if (!state.memberToken || !video || isLocalSeekTransaction()) {
            return;
        }
        const mediaReady = isVideoReady(video);
        if (isLoadingNewMedia() && mediaReady) {
            return sendMediaReady(video);
        }
        return sendSocket("SyncPlayHeartbeat", {
            ClientSequence: ++state.clientSequence,
            MediaEpoch: state.mediaEpoch,
            ItemId: getEventItemId(),
            PositionTicks: Math.round(video.currentTime * TICKS_PER_SECOND),
            IsPaused: video.paused,
            IsBuffering: !mediaReady,
            IsReady: mediaReady,
            IsActive: state.activeParticipant,
            RoundTripTimeMs: getBestRtt(),
            ClientUnixMs: Date.now(),
            ClientMonotonicMs: Math.round(performance.now())
        });
    }

    function sendControl(kind, force) {
        const video = state.video;
        const mediaLoadBlocked = isLoadingNewMedia() && !canControlDuringMediaLoad(video);
        if (!state.memberToken || !video || mediaLoadBlocked || (!force && performance.now() < state.suppressUntil)) {
            return Promise.resolve(false);
        }
        state.localControlUntil = Math.max(state.localControlUntil, performance.now() + 3500);
        const payload = {
            EventId: createEventId(),
            ClientSequence: ++state.clientSequence,
            MediaEpoch: state.mediaEpoch,
            ItemId: getEventItemId(),
            Kind: kind,
            PositionTicks: Math.round(video.currentTime * TICKS_PER_SECOND),
            IsPaused: video.paused,
            ClientUnixMs: Math.round(serverNow()),
            ClientMonotonicMs: Math.round(performance.now())
        };
        return sendControlEvent(payload).then(function (accepted) {
            state.localControlUntil = Math.max(state.localControlUntil, performance.now() + 500);
            return accepted;
        });
    }

    function sendControlEvent(payload) {
        return sendSocket("SyncPlayControl", payload).then(function (accepted) {
            if (accepted) {
                return true;
            }
            // A reverse proxy can drop a response even after Emby processed the
            // request. Reusing the same sequence and EventId is idempotent: a
            // duplicate is rejected without changing the room, while its
            // response still carries the authoritative room snapshot.
            return new Promise(function (resolve) {
                window.setTimeout(function () {
                    sendSocket("SyncPlayControl", payload).then(resolve);
                }, 150);
            });
        });
    }

    function sendBuffering(isBuffering) {
        const video = state.video;
        if (!state.memberToken || !video || isLocalSeekTransaction() || isLocalControlTransaction() || performance.now() < state.suppressUntil) {
            return Promise.resolve(false);
        }
        if (isLoadingNewMedia()) {
            return isBuffering ? Promise.resolve(false) : sendMediaReady(video);
        }
        return sendSocket("SyncPlayBuffering", {
            ClientSequence: ++state.clientSequence,
            MediaEpoch: state.mediaEpoch,
            ItemId: getEventItemId(),
            PositionTicks: Math.round(video.currentTime * TICKS_PER_SECOND),
            IsPaused: video.paused,
            IsBuffering: isBuffering,
            IsReady: !isBuffering && isVideoReady(video),
            IsActive: state.activeParticipant,
            RoundTripTimeMs: getBestRtt(),
            ClientUnixMs: Date.now()
        });
    }

    function sendMediaReady(video) {
        if (!state.memberToken || !video || !isAwaitingMediaReady()) {
            return Promise.resolve(false);
        }
        if (!isVideoReady(video)) {
            return Promise.resolve(false);
        }
        const now = performance.now();
        if (state.mediaReadyEpoch === state.mediaEpoch && now - state.mediaReadySentAt < 1000) {
            return Promise.resolve(false);
        }
        state.mediaReadyEpoch = state.mediaEpoch;
        state.mediaReadySentAt = now;
        const transition = getValue(state.room, "MediaTransitionState", "mediaTransitionState") || "None";
        // The room transition is authoritative. An initial join can retain a
        // stale per-member loading flag even after the media is buffered; in
        // that case a Ready event must be allowed to activate the member.
        const isActive = transition === "None";
        if (isActive) {
            state.activeParticipant = true;
        }
        return sendSocket("SyncPlayMediaReady", {
            ClientSequence: ++state.clientSequence,
            MediaEpoch: state.mediaEpoch,
            ItemId: getEventItemId(),
            PositionTicks: Math.round(video.currentTime * TICKS_PER_SECOND),
            IsPaused: video.paused,
            IsReady: true,
            IsActive: isActive,
            RoundTripTimeMs: getBestRtt(),
            ClientUnixMs: Date.now()
        });
    }

    function isLoadingNewMedia() {
        return state.mediaSwitchLoading ||
            (getValue(state.room, "MediaTransitionState", "mediaTransitionState") || "None") === "LoadingMembers" ||
            getValue(state.room, "IsCurrentMemberMediaLoading", "isCurrentMemberMediaLoading") === true;
    }

    function isAwaitingMediaReady() {
        const currentReady = getValue(state.room, "IsCurrentMemberMediaReady", "isCurrentMemberMediaReady");
        if (currentReady === true) {
            return false;
        }
        if (isLoadingNewMedia()) {
            return true;
        }
        const pending = state.pendingCommand || state.lastLoadCommand;
        return Boolean(pending &&
            getValue(pending, "Kind", "kind") === "Load" &&
            performance.now() < state.loadCommandExpiresAt);
    }

    function canControlDuringMediaLoad(video) {
        if (!video || video.readyState < 2) {
            return false;
        }
        const expectedItemId = Number(getValue(state.room, "ItemId", "itemId") || state.expectedItemId || 0);
        const currentItemId = getCurrentItemId();
        // Emby's playback manager can keep exposing the previous item after
        // the new video element already has current data. The room item is the
        // authoritative event stamp, so a stale NowPlayingItem must not block
        // local pause, play, or seek controls.
        return expectedItemId > 0 || currentItemId > 0;
    }

    function isVideoReady(video) {
        if (!video) {
            return false;
        }
        // Some Emby playback paths expose no useful TimeRanges even though the
        // media element has future data and is already playing. readyState is
        // therefore a valid readiness signal alongside the configured buffer.
        return video.readyState >= 3 || bufferedAhead(video) >= state.readyBufferSeconds;
    }

    function getEventItemId() {
        const expectedItemId = Number(
            state.expectedItemId || getValue(state.room, "ItemId", "itemId") || 0
        );
        const currentItemId = getCurrentItemId();
        // Emby may expose the previous NowPlayingItem for a short interval
        // while the new source is already active. Prefer the room's expected
        // item in that window so the server can match the media epoch.
        if (expectedItemId > 0 && (!currentItemId || currentItemId !== expectedItemId)) {
            return expectedItemId;
        }
        return currentItemId || expectedItemId;
    }

    function sendSocket(messageType, payload) {
        if (!state.apiClient) {
            state.connectionOnline = false;
            renderAll();
            return Promise.resolve(false);
        }
        const eventPayload = Object.assign({}, payload, {
            MemberToken: state.memberToken,
            RoomCode: state.room && getValue(state.room, "Code", "code"),
            ClientInstanceId: getClientInstanceId()
        });
        const started = performance.now();
        const startedUnix = Date.now();
        return apiRequest("SyncPlay/Events", "POST", { MessageType: messageType, Data: eventPayload })
            .then(function (result) {
                const serverReceive = Number(getValue(result, "ServerReceiveUnixMs", "serverReceiveUnixMs") || 0);
                const serverSend = Number(getValue(result, "ServerSendUnixMs", "serverSendUnixMs") || 0);
                if (serverReceive > 0 && serverSend > 0) {
                    const receivedUnix = Date.now();
                    recordClockSample(
                        Math.max(0, Math.round(performance.now() - started)),
                        ((serverReceive + serverSend) / 2) - ((startedUnix + receivedUnix) / 2)
                    );
                }
                const room = getValue(result, "Room", "room");
                if (room) {
                    applyRoomState(room, "http-event");
                }
                if (!state.connectionOnline) {
                    state.connectionOnline = true;
                    renderAll();
                }
                const accepted = getValue(result, "Accepted", "accepted");
                if (accepted === false) {
                    console.warn("[SyncPlay] Server rejected HTTP event", messageType);
                    pollRoomState();
                }
                return accepted !== false;
            })
            .catch(function (error) {
                state.connectionOnline = false;
                console.warn("[SyncPlay] HTTP event failed", messageType, {
                    elapsedMs: Math.round(performance.now() - started),
                    error: error
                });
                renderAll();
                return false;
            });
    }

    function getClientInstanceId() {
        if (!state.clientInstanceId) {
            state.clientInstanceId = createEventId();
        }
        return state.clientInstanceId;
    }

    function getStatusPath() {
        // Avoid a stale snapshot from a reverse proxy or NAS cache while the
        // HTTP transport is acting as the room's realtime channel.
        return "SyncPlay/Status?syncplayClientTime=" + encodeURIComponent(Date.now());
    }

    function isLocalSeekTransaction() {
        const now = performance.now();
        if (state.localSeekInProgress && now >= state.localSeekDeadline) {
            state.localSeekInProgress = false;
        }
        return state.localSeekInProgress || now < state.seekCommitUntil;
    }

    function isLocalControlTransaction() {
        return performance.now() < state.localControlUntil;
    }

    function onServerMessage(event, message) {
        message = message || event;
        if (!message || !message.MessageType) {
            return;
        }
        const data = normalizeData(message.Data);
        switch (message.MessageType) {
            case "SyncPlayCommand":
                applyCommand(data);
                break;
            case "SyncPlayClockPong":
                handleClockPong(data);
                break;
            case "SyncPlayRoomState":
                applyRoomState(data);
                break;
            case "SyncPlayRoomClosed":
                const closeReason = getValue(data, "Reason", "reason");
                clearRoomState();
                showNotice(closeReason === "CreatorDisconnected" || closeReason === "CreatorLeft"
                    ? text.creatorDisconnected
                    : closeReason === "HostMediaSwitchTimeout"
                        ? text.switchTimeout
                        : "房间已关闭。", true);
                break;
            case "SyncPlayMembershipEnded":
                clearRoomState();
                showNotice(text.membershipEnded, true);
                break;
        }
    }

    function applyRoomState(room, source) {
        if (!room) {
            return;
        }
        const previousRoom = state.room;
        const previousEpoch = Number(getValue(previousRoom, "MediaEpoch", "mediaEpoch") || state.mediaEpoch);
        const previousItemId = Number(getValue(previousRoom, "ItemId", "itemId") || state.expectedItemId);
        const previousRevision = Number(getValue(previousRoom, "Revision", "revision") || 0);
        const incomingEpoch = Number(getValue(room, "MediaEpoch", "mediaEpoch") || 0);
        if (incomingEpoch < state.mediaEpoch) {
            return;
        }
        const incomingRevision = Number(getValue(room, "Revision", "revision") || 0);
        if (incomingEpoch === previousEpoch && previousRevision && incomingRevision && incomingRevision < previousRevision) {
            return;
        }
        const incomingReference = Number(getValue(room, "ReferenceUnixMs", "referenceUnixMs") || 0);
        const previousReference = Number(getValue(previousRoom, "ReferenceUnixMs", "referenceUnixMs") || 0);
        if (incomingEpoch === previousEpoch && incomingRevision === previousRevision &&
            incomingReference && previousReference && incomingReference < previousReference) {
            return;
        }
        if (incomingEpoch > state.mediaEpoch) {
            state.mediaReadyEpoch = 0;
        }
        const previousTransition = getValue(state.room, "MediaTransitionState", "mediaTransitionState") || "None";
        state.room = room;
        state.mediaEpoch = incomingEpoch;
        state.expectedItemId = Number(getValue(room, "ItemId", "itemId") || 0);
        const transition = getValue(room, "MediaTransitionState", "mediaTransitionState") || "None";
        if (transition === "LoadingMembers") {
            state.mediaSwitchLoading = true;
            state.activeParticipant = false;
        } else if (previousTransition === "LoadingMembers" && transition === "None" && state.video) {
            state.mediaSwitchLoading = false;
            state.activeParticipant = true;
        } else if (transition === "None") {
            state.mediaSwitchLoading = false;
        }
        const currentMemberLoading = getValue(room, "IsCurrentMemberMediaLoading", "isCurrentMemberMediaLoading");
        const currentMemberReady = getValue(room, "IsCurrentMemberMediaReady", "isCurrentMemberMediaReady");
        const currentMemberActive = getValue(room, "IsCurrentMemberActive", "isCurrentMemberActive");
        if (currentMemberLoading === true && currentMemberReady !== true) {
            state.activeParticipant = false;
        } else if (currentMemberReady === true && transition === "None") {
            state.activeParticipant = currentMemberActive !== false;
        }
        const mediaChanged = Boolean(previousRoom) &&
            (incomingEpoch > previousEpoch || state.expectedItemId !== previousItemId);
        if (mediaChanged && state.memberToken) {
            // If the Emby WebSocket is unavailable, reconstruct the Load
            // command from the authoritative room state and use the normal
            // source-settling path.
            applyCommand(buildRoomCommand(room, "Load"));
        }
        reconcileRoomPlayback(room, previousRoom, source);
        updateTransitionTicker();
        renderAll(false);
    }

    function buildRoomCommand(room, kind) {
        const referenceUnixMs = Number(getValue(room, "ReferenceUnixMs", "referenceUnixMs") || serverNow());
        return {
            EventId: "http-room-state-" + String(getValue(room, "Revision", "revision") || 0),
            Kind: kind,
            RoomRevision: Number(getValue(room, "Revision", "revision") || 0),
            MediaEpoch: Number(getValue(room, "MediaEpoch", "mediaEpoch") || state.mediaEpoch),
            ItemId: Number(getValue(room, "ItemId", "itemId") || state.expectedItemId),
            PositionTicks: Math.max(0, Math.round(Number(getValue(room, "PositionTicks", "positionTicks") || 0))),
            ReferenceUnixMs: referenceUnixMs,
            ExecuteAtUnixMs: serverNow(),
            State: getValue(room, "State", "state") || "Paused",
            Reason: getValue(room, "HoldReason", "holdReason") || "HttpRoomState"
        };
    }

    function reconcileRoomPlayback(room, previousRoom, source) {
        const video = state.video;
        if (!video || !state.memberToken || isLocalSeekTransaction() || isLocalControlTransaction()) {
            return;
        }

        const transition = getValue(room, "MediaTransitionState", "mediaTransitionState") || "None";
        if (transition !== "None" && video.readyState < 2) {
            return;
        }

        const roomState = getValue(room, "State", "state") || "Paused";
        const targetSeconds = getRoomTargetTicks(room) / TICKS_PER_SECOND;
        const driftMs = (targetSeconds - video.currentTime) * 1000;
        const previousRevision = Number(getValue(previousRoom, "Revision", "revision") || 0);
        const currentRevision = Number(getValue(room, "Revision", "revision") || 0);
        const revisionChanged = currentRevision > previousRevision;

        if (roomState === "Holding") {
            if (!video.paused || Math.abs(driftMs) > 250) {
                executeCommand(video, buildRoomCommand(room, "Hold"));
            }
            return;
        }

        if (roomState === "Paused") {
            if (!video.paused || Math.abs(driftMs) > 250) {
                executeCommand(video, buildRoomCommand(room, "Pause"));
            }
            state.activeParticipant = true;
            return;
        }

        if (roomState !== "Playing" || video.readyState < 2) {
            return;
        }

        state.activeParticipant = true;
        if (video.paused) {
            executeCommand(video, buildRoomCommand(room, "Play"));
        } else if (Math.abs(driftMs) >= state.hardDriftMs || (revisionChanged && Math.abs(driftMs) > 250)) {
            executeCommand(video, buildRoomCommand(room, "Correct"));
        } else if (Math.abs(driftMs) >= state.softDriftMs && !video.seeking && video.readyState >= 3) {
            nudgeVideo(video, targetSeconds);
        }
    }

    function normalizeData(data) {
        if (typeof data !== "string") {
            return data || {};
        }
        try {
            return JSON.parse(data);
        } catch (error) {
            return {};
        }
    }

    function handleClockPong(pong) {
        const eventId = getValue(pong, "EventId", "eventId");
        const request = state.clockRequests.get(eventId);
        if (!request) {
            return;
        }
        state.clockRequests.delete(eventId);
        const receivedUnix = Date.now();
        const rtt = Math.max(0, Math.round(performance.now() - request.mono));
        const serverMid = (Number(getValue(pong, "ServerReceiveUnixMs", "serverReceiveUnixMs")) + Number(getValue(pong, "ServerSendUnixMs", "serverSendUnixMs"))) / 2;
        recordClockSample(rtt, serverMid - ((request.unix + receivedUnix) / 2));
    }

    function recordClockSample(rtt, offset) {
        if (!Number.isFinite(rtt) || !Number.isFinite(offset)) {
            return;
        }
        state.clockSamples.push({ rtt: Math.max(0, rtt), offset: offset });
        state.clockSamples = state.clockSamples
            .sort(function (a, b) { return a.rtt - b.rtt; })
            .slice(0, 8);
        if (state.clockSamples.length) {
            state.clockOffsetMs = state.clockSamples[0].offset;
        }
    }

    function applyCommand(command) {
        const kind = getValue(command, "Kind", "kind");
        const commandEpoch = Number(getValue(command, "MediaEpoch", "mediaEpoch") || 0);
        if (isCommandObsolete(command)) {
            return;
        }
        if (commandEpoch > state.mediaEpoch) {
            state.mediaEpoch = commandEpoch;
            state.mediaReadyEpoch = 0;
        }
        if (getValue(command, "Reason", "reason") === "MediaSwitch") {
            state.mediaSwitchLoading = true;
            state.expectedItemId = Number(getValue(command, "ItemId", "itemId") || state.expectedItemId);
        }
        if (isLocalSeekTransaction() && (kind === "Correct" || kind === "Nudge" || kind === "Hold" || kind === "Resume")) {
            return;
        }
        if (kind === "Load") {
            if (!rememberLoadCommand(command)) {
                return;
            }
            state.expectedItemId = Number(getValue(command, "ItemId", "itemId") || 0);
            state.activeParticipant = false;
            state.pendingCommand = command;
            ensureExpectedMedia(command);
            const currentItemId = getCurrentItemId();
            const isMediaSwitchLoad = getValue(command, "Reason", "reason") === "MediaSwitch" ||
                getValue(command, "Reason", "reason") === "MediaSwitchRetry";
            if (!isMediaSwitchLoad && state.video &&
                (!currentItemId || !state.expectedItemId || currentItemId === state.expectedItemId)) {
                executeCommand(state.video, command);
            }
            return;
        }
        const video = state.video;
        if (!video) {
            state.pendingCommand = command;
            return;
        }

        const executeAt = Number(getValue(command, "ExecuteAtUnixMs", "executeAtUnixMs") || 0);
        const delay = Math.max(0, executeAt - serverNow());
        window.setTimeout(function () {
            if (isCommandObsolete(command)) {
                return;
            }
            if (video !== state.video) {
                state.pendingCommand = command;
                return;
            }
            executeCommand(video, command);
        }, delay);
    }

    function isCommandObsolete(command) {
        const commandEpoch = Number(getValue(command, "MediaEpoch", "mediaEpoch") || 0);
        if (commandEpoch && commandEpoch < state.mediaEpoch) {
            return true;
        }
        const commandRevision = Number(getValue(command, "RoomRevision", "roomRevision") || 0);
        const roomRevision = Number(getValue(state.room, "Revision", "revision") || 0);
        return Boolean(commandRevision && roomRevision && commandRevision < roomRevision);
    }

    function executeCommand(video, command) {
        const kind = getValue(command, "Kind", "kind");
        const targetSeconds = getCommandTargetSeconds(command);
        const roomState = getValue(command, "State", "state");

        const preservesMediaSwitchLoad = kind === "Hold" &&
            getValue(command, "Reason", "reason") === "MediaSwitch";
        if (kind !== "Load" && !preservesMediaSwitchLoad) {
            cancelLoadAlignment();
        }
        if (kind !== "Nudge") {
            state.suppressUntil = performance.now() + 800;
        }
        if (kind === "Load") {
            scheduleLoadAlignment(video, command);
        } else if (kind === "Pause" || kind === "Hold") {
            if (getValue(command, "Reason", "reason") === "MediaSwitch") {
                state.activeParticipant = false;
            }
            alignVideo(video, targetSeconds, true);
            video.pause();
            restorePlaybackRate();
            if (getValue(command, "Reason", "reason") === "MediaSwitch") {
                window.setTimeout(function () { sendMediaReady(video); }, 100);
            }
        } else if (kind === "Play" || kind === "Resume") {
            state.mediaSwitchLoading = false;
            state.activeParticipant = true;
            alignVideo(video, targetSeconds, true);
            const playPromise = video.play();
            if (playPromise && playPromise.catch) {
                playPromise.catch(function () {});
            }
        } else if (kind === "Seek" || kind === "Correct") {
            alignVideo(video, targetSeconds, true);
            restorePlaybackRate();
        } else if (kind === "Nudge") {
            nudgeVideo(video, targetSeconds);
        }
    }

    function rememberLoadCommand(command) {
        if (!isNewerLoadCommand(command, state.lastLoadCommand)) {
            return false;
        }
        state.lastLoadCommand = command;
        state.loadCommandExpiresAt = performance.now() + 12000;
        return true;
    }

    function cancelLoadAlignment() {
        state.loadAlignmentGeneration += 1;
        state.pendingCommand = null;
        state.lastLoadCommand = null;
        state.loadCommandExpiresAt = 0;
        window.clearTimeout(state.mediaFallbackTimer);
        state.mediaFallbackTimer = null;
    }

    function isNewerLoadCommand(incoming, current) {
        if (!current) {
            return true;
        }

        const incomingEpoch = Number(getValue(incoming, "MediaEpoch", "mediaEpoch") || 0);
        const currentEpoch = Number(getValue(current, "MediaEpoch", "mediaEpoch") || 0);
        if (incomingEpoch !== currentEpoch) {
            return incomingEpoch > currentEpoch;
        }

        const incomingRevision = Number(getValue(incoming, "RoomRevision", "roomRevision") || 0);
        const currentRevision = Number(getValue(current, "RoomRevision", "roomRevision") || 0);
        if (incomingRevision !== currentRevision) {
            return incomingRevision > currentRevision;
        }

        const incomingReference = Number(getValue(incoming, "ReferenceUnixMs", "referenceUnixMs") || 0);
        const currentReference = Number(getValue(current, "ReferenceUnixMs", "referenceUnixMs") || 0);
        if (incomingReference !== currentReference) {
            return incomingReference > currentReference;
        }

        return Number(getValue(incoming, "PositionTicks", "positionTicks") || 0) >
            Number(getValue(current, "PositionTicks", "positionTicks") || 0);
    }

    function ensureExpectedMedia(command) {
        const expectedItemId = Number(getValue(command, "ItemId", "itemId") || 0);
        const expectedEpoch = Number(getValue(command, "MediaEpoch", "mediaEpoch") || state.mediaEpoch);
        window.clearTimeout(state.mediaFallbackTimer);
        state.mediaFallbackTimer = window.setTimeout(function () {
            if (!state.memberToken || expectedEpoch !== state.mediaEpoch || !expectedItemId) {
                return;
            }
            if (state.pendingCommand !== command) {
                return;
            }
            const currentItemId = getCurrentItemId();
            if (currentItemId && currentItemId === expectedItemId) {
                return;
            }
            playExpectedMedia(command).catch(function (error) {
                console.warn("[SyncPlay] Media switch fallback failed", error);
            });
        }, 1200);
    }

    async function playExpectedMedia(command) {
        const itemId = Number(getValue(command, "ItemId", "itemId") || 0);
        if (!itemId || !state.apiClient) {
            return;
        }
        const item = await state.apiClient.getItem(state.apiClient.getCurrentUserId(), String(itemId));
        const playbackManager = await getPlaybackManager();
        if (!playbackManager || !playbackManager.play) {
            throw new Error("Emby playback modules are unavailable.");
        }
        await playbackManager.play({
            items: [item],
            startPositionTicks: getCommandTargetTicks(command),
            fullscreen: true,
            enableRemotePlayers: false
        });
    }

    function getPlaybackManager() {
        if (state.playbackManager) {
            return Promise.resolve(state.playbackManager);
        }
        if (!state.playbackManagerPromise) {
            if (!window.Emby || !window.Emby.importModule) {
                return Promise.reject(new Error("Emby module loader is unavailable."));
            }
            state.playbackManagerPromise = window.Emby.importModule("./modules/common/playback/playbackmanager.js")
                .then(function (module) {
                    state.playbackManager = module && (module.default || module);
                    return state.playbackManager;
                })
                .catch(function (error) {
                    state.playbackManagerPromise = null;
                    throw error;
                });
        }
        return state.playbackManagerPromise;
    }

    function getCurrentItemId() {
        try {
            const info = state.playbackManager && state.playbackManager.getPlayerInfo
                ? state.playbackManager.getPlayerInfo()
                : null;
            const item = info && (info.nowPlayingItem || info.item);
            return Number(getValue(item, "Id", "id") || 0);
        } catch (error) {
            return 0;
        }
    }

    function getCommandTargetSeconds(command) {
        const kind = getValue(command, "Kind", "kind");
        const referenceMs = Number(getValue(command, "ReferenceUnixMs", "referenceUnixMs") || serverNow());
        let targetSeconds = Number(getValue(command, "PositionTicks", "positionTicks") || 0) / TICKS_PER_SECOND;
        if (getValue(command, "State", "state") === "Playing" && kind !== "Pause" && kind !== "Hold") {
            targetSeconds += Math.max(0, serverNow() - referenceMs) / 1000;
        }
        return targetSeconds;
    }

    function getCommandTargetTicks(command) {
        return Math.max(0, Math.round(getCommandTargetSeconds(command) * TICKS_PER_SECOND));
    }

    function scheduleLoadAlignment(video, command) {
        const generation = ++state.loadAlignmentGeneration;
        const startedAt = performance.now();
        let stableChecks = 0;
        const alignAfterSourceSettles = function () {
            if (generation !== state.loadAlignmentGeneration || video !== state.video) {
                return;
            }

            const targetSeconds = getCommandTargetSeconds(command);
            const driftSeconds = targetSeconds - video.currentTime;
            if (video.readyState < 1 || Math.abs(driftSeconds) > .4) {
                stableChecks = 0;
                state.suppressUntil = performance.now() + 800;
                alignVideo(video, targetSeconds, true);
            } else {
                stableChecks += 1;
            }

            if (getValue(command, "State", "state") === "Playing") {
                if (video.paused) {
                    state.suppressUntil = performance.now() + 800;
                    const playPromise = video.play();
                    if (playPromise && playPromise.catch) {
                        playPromise.catch(function () {});
                    }
                }
            } else if (!video.paused) {
                state.suppressUntil = performance.now() + 800;
                video.pause();
                restorePlaybackRate();
            }

            if (stableChecks < 4 && performance.now() - startedAt < 10000) {
                window.setTimeout(alignAfterSourceSettles, 250);
            }
        };
        alignAfterSourceSettles();
    }

    function alignVideo(video, targetSeconds, force) {
        const drift = targetSeconds - video.currentTime;
        if (force || Math.abs(drift * 1000) >= state.hardDriftMs) {
            try {
                const clampedTarget = Math.max(0, Math.min(targetSeconds, Number.isFinite(video.duration) ? video.duration : targetSeconds));
                state.programmaticSeekTarget = clampedTarget;
                state.programmaticSeekUntil = performance.now() + 1200;
                video.currentTime = clampedTarget;
            } catch (error) {
                console.debug("[SyncPlay] Seek deferred", error);
            }
        }
    }

    function nudgeVideo(video, targetSeconds) {
        const driftMs = (targetSeconds - video.currentTime) * 1000;
        if (Math.abs(driftMs) < state.softDriftMs || video.paused) {
            restorePlaybackRate();
            return;
        }
        if (!state.nudgeTimer) {
            state.originalPlaybackRate = video.playbackRate || 1;
        }
        video.playbackRate = state.originalPlaybackRate * (driftMs > 0 ? 1.02 : 0.98);
        window.clearTimeout(state.nudgeTimer);
        state.nudgeTimer = window.setTimeout(restorePlaybackRate, Math.min(4000, Math.max(750, Math.abs(driftMs) / 0.02)));
    }

    function restorePlaybackRate() {
        window.clearTimeout(state.nudgeTimer);
        state.nudgeTimer = null;
        if (state.video && state.video.playbackRate !== state.originalPlaybackRate) {
            state.video.playbackRate = state.originalPlaybackRate || 1;
        }
    }

    function isExpectedProgrammaticSeek(video) {
        return state.programmaticSeekTarget !== null &&
            performance.now() < state.programmaticSeekUntil &&
            Math.abs(video.currentTime - state.programmaticSeekTarget) < .75;
    }

    function beginLocalSeek(video) {
        if (!state.memberToken || isExpectedProgrammaticSeek(video)) {
            return;
        }
        const now = performance.now();
        state.localSeekInProgress = true;
        state.localSeekDeadline = now + 15000;
        state.seekCommitUntil = now + 15000;
        state.loadAlignmentGeneration += 1;
        state.pendingCommand = null;
        state.lastLoadCommand = null;
        state.loadCommandExpiresAt = 0;
        restorePlaybackRate();
    }

    function finishLocalSeek(video) {
        if (!state.localSeekInProgress) {
            if (isExpectedProgrammaticSeek(video)) {
                state.programmaticSeekTarget = null;
                state.programmaticSeekUntil = 0;
            }
            return;
        }

        state.localSeekInProgress = false;
        state.localSeekDeadline = 0;
        state.seekCommitUntil = performance.now() + 5000;
        state.programmaticSeekTarget = null;
        state.programmaticSeekUntil = 0;
        sendControl("Seek", true).then(function () {
            state.seekCommitUntil = performance.now() + 600;
            window.setTimeout(function () {
                if (video !== state.video || state.localSeekInProgress) {
                    return;
                }
                state.seekCommitUntil = 0;
                if (video.readyState < 3) {
                    sendBuffering(true);
                } else {
                    sendBuffering(false);
                }
                sendHeartbeat();
            }, 650);
        });
    }

    function bindCurrentVideo() {
        const candidates = Array.from(document.querySelectorAll("video"));
        const video = candidates.find(function (item) {
            return item.offsetParent !== null && !item.classList.contains("syncPlay-ignore");
        }) || candidates[0] || null;
        if (video === state.video) {
            return;
        }
        if (state.videoCleanup) {
            state.videoCleanup();
        }
        state.video = video;
        state.videoCleanup = null;
        if (!video) {
            renderAll();
            return;
        }

        state.originalPlaybackRate = video.playbackRate || 1;
        const handlers = {
            play: function () { sendControl("Play"); },
            pause: function () { if (!video.ended) { sendControl("Pause"); } },
            seeking: function () { beginLocalSeek(video); },
            seeked: function () { finishLocalSeek(video); },
            waiting: function () { if (!video.seeking && !isLocalSeekTransaction() && !isLocalControlTransaction()) { sendBuffering(true); } },
            stalled: function () { if (!video.seeking && !isLocalSeekTransaction() && !isLocalControlTransaction()) { sendBuffering(true); } },
            loadedmetadata: markReadyAfterInitialLoad,
            canplay: markReadyAfterInitialLoad,
            playing: markReadyAfterInitialLoad,
            ended: function () { sendHeartbeat(); }
        };
        Object.keys(handlers).forEach(function (name) { video.addEventListener(name, handlers[name]); });
        state.videoCleanup = function () {
            Object.keys(handlers).forEach(function (name) { video.removeEventListener(name, handlers[name]); });
        };
        const recentLoad = state.lastLoadCommand && performance.now() < state.loadCommandExpiresAt
            ? state.lastLoadCommand
            : null;
        if (state.pendingCommand || recentLoad) {
            const pending = state.pendingCommand || recentLoad;
            state.pendingCommand = null;
            window.setTimeout(function () { executeCommand(video, pending); }, 200);
        }
        renderAll();

        function markReadyAfterInitialLoad() {
            applyPendingLoadToVideo(video);
            if (!isVideoReady(video)) {
                return;
            }
            if (isAwaitingMediaReady()) {
                sendMediaReady(video).then(function () {
                    if (!isAwaitingMediaReady() && getValue(state.room, "MediaTransitionState", "mediaTransitionState") === "None") {
                        state.activeParticipant = true;
                        sendHeartbeat();
                    }
                });
                return;
            }
            if (!state.activeParticipant) {
                state.activeParticipant = true;
            }
            sendBuffering(false);
        }
    }

    function applyPendingLoadToVideo(video) {
        const pending = state.pendingCommand;
        if (!pending || getValue(pending, "Kind", "kind") !== "Load") {
            return;
        }
        const expectedItemId = Number(getValue(pending, "ItemId", "itemId") || 0);
        const currentItemId = getCurrentItemId();
        if (expectedItemId && currentItemId && expectedItemId !== currentItemId) {
            return;
        }
        state.pendingCommand = null;
        executeCommand(video, pending);
    }

    function bufferedAhead(video) {
        try {
            for (let index = 0; index < video.buffered.length; index += 1) {
                if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
                    return Math.max(0, video.buffered.end(index) - video.currentTime);
                }
            }
        } catch (error) {
            return 0;
        }
        return 0;
    }

    function updatePlayerButtons() {
        const members = state.room ? (getValue(state.room, "MemberCount", "memberCount") || 0) : 0;
        const quality = state.room ? getRoomQuality(getValue(state.room, "Members", "members") || [], getValue(state.room, "State", "state")) : { kind: "idle", label: text.title };
        document.querySelectorAll(".syncPlay-controlButton").forEach(function (button) {
            const isHeaderButton = button.classList.contains("syncPlay-headerButton");
            const badge = button.querySelector(".syncPlay-memberBadge");
            const dot = button.querySelector(".syncPlay-statusDot");
            const badgeText = members > 0 ? String(members) : "";
            if (badge.textContent !== badgeText) {
                badge.textContent = badgeText;
            }
            badge.classList.toggle("syncPlay-memberBadge-visible", members > 0);
            if (dot) {
                dot.className = "syncPlay-statusDot syncPlay-statusDot-" + quality.kind;
            }
            if (isHeaderButton) {
                button.classList.toggle("syncPlay-headerButton-active", Boolean(state.room));
            } else {
                button.classList.toggle("syncPlay-playerButton-active", Boolean(state.room));
            }
            const label = state.room
                ? text.title + "，" + members + " 人，" + quality.label
                : (isHeaderButton ? "快速加入同步房间" : text.title);
            button.title = label;
            button.setAttribute("aria-label", label);
            const buttonDrawerClass = button.classList.contains("syncPlay-barButton")
                ? "syncPlay-miniDrawer"
                : "syncPlay-drawer";
            const buttonDrawer = isHeaderButton ? null : getDrawerElementForSource(button);
            const expanded = isHeaderButton
                ? state.headerMenuOpen
                : state.drawerOpen && (state.activeDrawerElement
                    ? state.activeDrawerElement === buttonDrawer
                    : state.activeDrawerClass === buttonDrawerClass);
            button.setAttribute("aria-expanded", expanded ? "true" : "false");
        });
    }

    function getRoomQuality(members, roomState) {
        if (!state.connectionOnline) {
            return { kind: "offline", label: text.offline };
        }
        const transition = getTransitionInfo(state.room, members);
        if (transition) {
            return { kind: transition.kind === "loading" ? "holding" : "warning", label: transition.label };
        }
        if (roomState === "Holding") {
            return { kind: "holding", label: "等待缓冲" };
        }
        const worstRtt = members.reduce(function (max, member) {
            return Math.max(max, Number(getValue(member, "RoundTripTimeMs", "roundTripTimeMs") || 0));
        }, 0);
        const worstDrift = members.reduce(function (max, member) {
            return Math.max(max, Math.abs(Number(getValue(member, "DriftMs", "driftMs") || 0)));
        }, 0);
        return worstRtt > 100 || worstDrift > 150
            ? { kind: "warning", label: text.unstable }
            : { kind: "good", label: text.good };
    }

    function getCurrentMediaName() {
        const title = document.querySelector(".videoOsdTitle");
        if (title && title.textContent.trim()) {
            return title.textContent.trim();
        }
        return state.video && (state.video.getAttribute("title") || document.title.replace(/\s*-\s*Emby.*$/i, ""));
    }

    function getInviteCode() {
        const match = window.location.hash.match(/(?:^#|[&#])syncplay=([0-9]{3})(?:$|[&#])/);
        return match ? match[1] : "";
    }

    async function handleInviteFragment() {
        const code = getInviteCode();
        if (code && !state.room) {
            state.activeDrawerElement = getDefaultDrawerElement();
            state.activeDrawerClass = getDrawerClassForSource(null);
            state.drawerOpen = true;
            setOsdInteractionLock(state.activeDrawerClass === "syncPlay-drawer");
            renderAll();
            resetDrawerAutoClose();
            await joinRoom(code);
        }
    }

    function clearInviteFragment() {
        if (!getInviteCode()) {
            return;
        }
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
    }

    function serverNow() {
        return Date.now() + state.clockOffsetMs;
    }

    function getBestRtt() {
        return state.clockSamples.length ? state.clockSamples[0].rtt : 0;
    }

    function createEventId() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID().replace(/-/g, "");
        }
        return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    async function apiRequest(path, method, body) {
        const options = {
            type: method,
            url: state.apiClient.getUrl(path),
            dataType: "json",
            headers: { Accept: "application/json" }
        };
        if (method === "GET") {
            options.headers["Cache-Control"] = "no-cache, no-store";
            options.headers.Pragma = "no-cache";
        }
        if (body !== undefined && method !== "GET") {
            options.data = JSON.stringify(body);
            options.contentType = "application/json";
        }
        return state.apiClient.ajax(options);
    }

    function setPanelMessage(message, isError) {
        document.querySelectorAll(".syncPlay-message").forEach(function (element) {
            element.textContent = message || "";
            element.classList.toggle("syncPlay-message-error", Boolean(isError));
        });
    }

    function showNotice(message, isError) {
        setPanelMessage(message, isError);
        const previous = document.querySelector(".syncPlay-toast");
        if (previous) {
            dismissNotice(previous);
        }
        const toast = document.createElement("div");
        toast.className = "syncPlay-toast" + (isError ? " syncPlay-toast-error" : "");
        toast.setAttribute("role", "status");
        toast.textContent = message;
        document.body.appendChild(toast);
        window.requestAnimationFrame(function () {
            window.requestAnimationFrame(function () {
                if (toast.parentNode) {
                    toast.classList.add("syncPlay-toast-visible");
                }
            });
        });
        window.setTimeout(function () {
            dismissNotice(toast);
        }, 4500);
    }

    function dismissNotice(toast) {
        if (!toast || !toast.parentNode || toast.classList.contains("syncPlay-toast-dismissing")) {
            return;
        }
        toast.classList.add("syncPlay-toast-dismissing");
        toast.classList.remove("syncPlay-toast-visible");
        const remove = function () {
            toast.removeEventListener("transitionend", onTransitionEnd);
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        };
        const onTransitionEnd = function (event) {
            if (event.target === toast && event.propertyName === "transform") {
                remove();
            }
        };
        toast.addEventListener("transitionend", onTransitionEnd);
        window.setTimeout(remove, 240);
    }

    function showError(error) {
        console.error("[SyncPlay]", error);
        let message = "操作失败，请稍后重试。";
        if (error && typeof error === "string") {
            message = error;
        } else if (error && error.statusText) {
            message = error.statusText;
        }
        setPanelMessage(message, true);
    }

    function getValue(object, pascalName, camelName) {
        if (!object) {
            return undefined;
        }
        return object[pascalName] !== undefined ? object[pascalName] : object[camelName];
    }

    function escapeHtml(value) {
        const node = document.createElement("div");
        node.textContent = String(value == null ? "" : value);
        return node.innerHTML;
    }

    waitForEmby();
})();
