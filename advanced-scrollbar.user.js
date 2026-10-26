// ==UserScript==
// @name         MTechno Absolute Control & Glass UI
// @namespace    http://tampermonkey.net/
// @version      21.1
// @description  Windows-style stable scrollbar (vertical + horizontal) with smooth scrolling, section markers, selection markers, your own pins, "resume where you left off", a "back to where you were" chip, auto light/dark glass theme, lite mode for slow machines, high-contrast support, fail-open safety net and diagnostics.
// @author       Metehan
// @match        *://*/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/MeTheHan/advanced-scrollbar/main/advanced-scrollbar.user.js
// @downloadURL  https://raw.githubusercontent.com/MeTheHan/advanced-scrollbar/main/advanced-scrollbar.user.js
// ==/UserScript==

(function boot() {
    'use strict';

    // Some userscript managers (notably in Firefox) can run document-start code before <html> exists.
    // Wait for it instead of giving up silently.
    if (!document.documentElement) {
        const wait = new MutationObserver(() => { if (document.documentElement) { wait.disconnect(); boot(); } });
        wait.observe(document, { childList: true });
        return;
    }

    /* -----------------------------------------------------------------------
       PRE-FLIGHT CHECKS
    ----------------------------------------------------------------------- */
    if (window.top !== window.self) return;                       // never run inside iframes
    const de = document.documentElement;
    if (!de || de.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;   // skip XML/SVG documents
    if (window.__mtechnoSB) return;                               // double-injection guard
    window.__mtechnoSB = true;

    /* Per-site on/off switch (Tampermonkey menu) */
    const OFF_KEY = 'off:' + location.hostname;
    let siteOff = false;
    try { siteOff = GM_getValue(OFF_KEY, false) === true; } catch (_) {}
    try {
        GM_registerMenuCommand(siteOff ? 'MTechno: enable on this site' : 'MTechno: disable on this site', () => {
            try { GM_setValue(OFF_KEY, !siteOff); } catch (_) {}
            location.reload();
        });
    } catch (_) {}
    if (siteOff) return;

    /* -----------------------------------------------------------------------
       SETTINGS
    ----------------------------------------------------------------------- */
    const CFG = {
        // Physics
        LERP: 0.13,
        MOM_BASE: 1.0, MOM_MAX: 2.5, MOM_DECAY: 0.993,
        LINE_PX: 33,                 // deltaMode=1 (Firefox) lines -> px
        KEY_LINE: 80, KEY_PAGE: 0.88,

        // Scrollbar
        ALWAYS_VISIBLE: false,       // true = always visible, like classic Windows
        HIDE_DELAY: 900,
        TRACK_W: 14,                 // fixed edge-flush hit area (keeps clear of site UI at the edge)
        THUMB_W: 10, THUMB_W_HOT: 14,
        MIN_THUMB: 40, PAD: 2,
        REPEAT_DELAY: 380, REPEAT_RATE: 90,   // hold-to-repeat on the track (page by page)

        // Section markers
        TICK_HIT: 16                 // px - how close the pointer must be to "grab" a marker
    };
    // Changeable from the Tampermonkey menu, persisted
    const SPEEDS = {
        soft:     { name: 'Soft',            LERP: 0.09, MOM_MAX: 2.0 },
        balanced: { name: 'Balanced',        LERP: 0.13, MOM_MAX: 2.5 },
        fast:     { name: 'Fast',            LERP: 0.20, MOM_MAX: 3.2 },
        off:      { name: 'Off (instant)',   LERP: 1,    MOM_MAX: 1, instant: true }   // no animation, scrollbar stays
    };
    function loadPref(k, d) { try { const v = GM_getValue(k, d); return v === undefined ? d : v; } catch (_) { return d; } }
    function savePref(k, v) { try { GM_setValue(k, v); } catch (_) {} }
    let speedKey = loadPref('speed', 'balanced');
    if (!SPEEDS[speedKey]) speedKey = 'balanced';
    function applySpeed(k) { speedKey = k; CFG.LERP = SPEEDS[k].LERP; CFG.MOM_MAX = SPEEDS[k].MOM_MAX; CFG.INSTANT = !!SPEEDS[k].instant; }
    applySpeed(speedKey);
    CFG.ALWAYS_VISIBLE = loadPref('always', false) === true;
    CFG.SECTIONS = loadPref('sections', true) !== false;
    CFG.SELMARKS = loadPref('selmarks', true) !== false;
    CFG.RESUME = loadPref('resume_on', true) !== false;
    CFG.INNER = loadPref('inner', false) === true;          // experimental: smooth inner scroll areas, off by default
    // Visual effects: 'auto' switches to lite on slow machines, 'lite' always, 'full' never
    let perfMode = loadPref('perf', 'auto');
    if (perfMode !== 'auto' && perfMode !== 'lite' && perfMode !== 'full') perfMode = 'auto';
    let liteOn = false, fN = 0, fSlow = 0;

    const TOL = 2.5;                 // px - separates browser rounding from "someone else moved the page"
    const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* -----------------------------------------------------------------------
       CSS
    ----------------------------------------------------------------------- */
    // The page's own scrollbar - only the main (viewport) one
    const PAGE_CSS =
        'html::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
        'html{scrollbar-width:none!important;-ms-overflow-style:none!important}';

    // Lives inside a Shadow DOM: site CSS cannot touch any of this
    const SHADOW_CSS = `
:host{all:initial!important;position:fixed!important;top:0!important;right:0!important;bottom:0!important;
  width:${CFG.TRACK_W}px!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;
  visibility:visible!important;opacity:1!important;transform:none!important;filter:none!important;
  margin:0!important;padding:0!important;border:0!important;overflow:visible!important;
  --ease:cubic-bezier(.2,.8,.2,1)}
@media print{:host{display:none!important}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important}}

/* MOTION PRINCIPLE: respond instantly when the pointer arrives or presses (transition-duration:0s on the
   hover/active state), settle softly when it leaves (the base state carries the eased transition).
   Colour tokens live on .t so dark/light variants only swap variables. */
.t{--bg:linear-gradient(135deg,rgba(255,255,255,.35) 0%,rgba(255,255,255,.1) 100%);
  --bg-hot:linear-gradient(135deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.2) 100%);
  --bd:rgba(255,255,255,.45);--bd-hot:rgba(255,255,255,.7);
  --sh-rest:inset 0 0 6px rgba(255,255,255,.5),0 2px 4px rgba(0,0,0,.1),0 0 0 1px rgba(0,0,0,.12);
  --sh-lift:inset 0 0 6px rgba(255,255,255,.5),0 4px 10px rgba(0,0,0,.2),0 0 0 1px rgba(0,0,0,.14);
  --sh-press:inset 0 1px 4px rgba(0,0,0,.3),0 0 0 0 rgba(0,0,0,0),0 0 0 1px rgba(0,0,0,.18);
  --kb:rgba(255,255,255,.55);--kbd:rgba(255,255,255,.7);--ksh:0 1px 3px rgba(0,0,0,.35);
  --kh:#fff;--khsh:0 0 0 3px rgba(255,255,255,.22),0 1px 4px rgba(0,0,0,.4);
  pointer-events:auto;cursor:default;touch-action:none;user-select:none;-webkit-user-select:none;
  transition:background .24s var(--ease)}
@media (prefers-color-scheme:dark){
  .t{--bg:linear-gradient(135deg,rgba(255,255,255,.2) 0%,rgba(255,255,255,.05) 100%);
    --bg-hot:linear-gradient(135deg,rgba(255,255,255,.34) 0%,rgba(255,255,255,.12) 100%);
    --bd:rgba(255,255,255,.2);--bd-hot:rgba(255,255,255,.35);
    --sh-rest:inset 0 0 6px rgba(255,255,255,.15),0 2px 4px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.25);
    --sh-lift:inset 0 0 6px rgba(255,255,255,.15),0 4px 12px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.3);
    --sh-press:inset 0 1px 4px rgba(0,0,0,.45),0 0 0 0 rgba(0,0,0,0),0 0 0 1px rgba(0,0,0,.35)}
}
/* light pages: darker glass so everything stays visible */
.t.lt{--bg:linear-gradient(135deg,rgba(30,32,38,.45) 0%,rgba(30,32,38,.24) 100%);
  --bg-hot:linear-gradient(135deg,rgba(30,32,38,.66) 0%,rgba(30,32,38,.4) 100%);
  --bd:rgba(255,255,255,.4);--bd-hot:rgba(255,255,255,.55);
  --sh-rest:inset 0 0 6px rgba(255,255,255,.28),0 2px 4px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,0);
  --sh-lift:inset 0 0 6px rgba(255,255,255,.28),0 4px 10px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,0);
  --sh-press:inset 0 1px 4px rgba(0,0,0,.4),0 0 0 0 rgba(0,0,0,0),0 0 0 1px rgba(0,0,0,0);
  --kb:rgba(30,32,38,.55);--kbd:rgba(255,255,255,.6);--ksh:0 1px 3px rgba(0,0,0,.25);
  --kh:rgb(30,32,38);--khsh:0 0 0 3px rgba(30,32,38,.2),0 1px 4px rgba(0,0,0,.35)}

.t.off{display:none}
.t:hover,.t.drag{background:rgba(128,128,128,.14);transition-duration:0s}
.t.pt{cursor:pointer}
#t{position:absolute;top:0;right:0;bottom:0;left:0}
#t.hz{bottom:${CFG.TRACK_W}px}
#h{position:fixed;left:0;bottom:0;right:${CFG.TRACK_W}px;height:${CFG.TRACK_W}px}

/* read-progress shading: the part of the track above the thumb is slightly darker on hover */
.t::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;background:rgba(128,128,128,.12);opacity:0;
  pointer-events:none;will-change:transform;transform-origin:0 0;transition:opacity .24s var(--ease)}
.t:hover::before,.t.drag::before{opacity:1;transition-duration:0s}
#t::before{transform:scaleY(var(--f,0))}
#h::before{transform:scaleX(var(--f,0))}

/* thumb: rests flat, lifts on hover, presses in while dragging */
.b{position:absolute;box-sizing:border-box;border-radius:10px;opacity:0;pointer-events:none;will-change:transform;
  background:var(--bg);border:1px solid var(--bd);box-shadow:var(--sh-rest);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:width .24s var(--ease),height .24s var(--ease),opacity .35s var(--ease),border-color .24s ease,box-shadow .24s var(--ease)}
.b::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:inherit;background:var(--bg-hot);
  opacity:0;transition:opacity .24s ease}
#b{top:0;right:0;width:${CFG.THUMB_W}px}
#hb{left:0;bottom:0;height:${CFG.THUMB_W}px}
.t.show .b,.t:hover .b,.t.drag .b{opacity:1}
.t:hover .b,.t.drag .b{box-shadow:var(--sh-lift);transition-duration:0s}
.t.hot .b,.t.drag .b{border-color:var(--bd-hot)}
.t.hot .b::after,.t.drag .b::after{opacity:1;transition-duration:0s}
.t.drag .b{box-shadow:var(--sh-press)}
#t:hover #b,#t.drag #b{width:${CFG.THUMB_W_HOT}px}
#h:hover #hb,#h.drag #hb{height:${CFG.THUMB_W_HOT}px}

/* section markers: small glass pills under the thumb that "magnetise" instantly on hover */
.k{position:absolute;left:1px;top:-2px;width:6px;height:4px;box-sizing:border-box;border-radius:4px;opacity:0;
  pointer-events:none;will-change:transform;background:var(--kb);border:1px solid var(--kbd);box-shadow:var(--ksh);
  transition:opacity .24s var(--ease),width .24s var(--ease),height .24s var(--ease),top .24s var(--ease),background .24s ease,box-shadow .24s ease}
.t:hover .k,.t.drag .k{opacity:1;transition-duration:.09s}
.k.l1{width:9px}
.t:hover .k.hv{width:12px;height:6px;top:-3px;background:var(--kh);box-shadow:var(--khsh);transition-duration:0s}

/* floating label (section name, percentage, notifications): slides in 6px, appears fast, leaves softly */
#p{position:absolute;right:22px;top:0;display:flex;align-items:baseline;gap:9px;max-width:min(340px,60vw);box-sizing:border-box;
  padding:6px 12px;border-radius:12px;opacity:0;margin-right:-6px;pointer-events:none;will-change:transform;
  font:600 12.5px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;
  background:rgba(18,20,26,.78);border:1px solid rgba(255,255,255,.16);
  backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
  box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.08);
  transition:opacity .2s ease,margin-right .2s var(--ease)}
#p.on{opacity:1;margin-right:0;transition-duration:.07s}
#p .m{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#p .s{flex:none;font-weight:500;opacity:.6;font-variant-numeric:tabular-nums}
#p.ar::after{content:"";position:absolute;right:-5px;top:50%;margin-top:-5px;width:0;height:0;
  border:5px solid transparent;border-right-width:0;border-left-color:rgba(18,20,26,.78)}

/* "back to where you were" chip: springs in, lifts on hover, presses on click, a thin ring follows the pointer */
#r,#q{position:fixed;right:24px;bottom:24px;display:flex;align-items:center;gap:9px;box-sizing:border-box;padding:7px 15px 7px 12px;
  border-radius:999px;font:600 12.5px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;cursor:pointer;
  background:rgba(18,20,26,.78);border:1px solid rgba(255,255,255,.16);
  backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
  box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.08);
  opacity:0;pointer-events:none;transform:translate3d(0,8px,0);user-select:none;-webkit-user-select:none;
  transition:opacity .18s ease,transform .22s ease-in,background .22s ease,box-shadow .22s var(--ease)}
#r.on,#q.on{opacity:1;pointer-events:auto;transform:none;
  transition:opacity .2s ease,transform .42s cubic-bezier(.34,1.56,.64,1),background .22s ease,box-shadow .22s var(--ease)}
#r.on:hover,#q.on:hover{transform:translate3d(0,-1px,0);background:rgba(34,38,48,.92);
  box-shadow:0 12px 30px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.1);transition-duration:0s}
#r.on:active,#q.on:active{transform:translate3d(0,0,0) scale(.97);box-shadow:0 2px 8px rgba(0,0,0,.35),inset 0 1px 2px rgba(0,0,0,.3);transition-duration:0s}
#r::after,#q::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:inherit;pointer-events:none;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.5);opacity:0;transition:opacity .26s var(--ease)}
#r.on:hover::after,#q.on:hover::after{opacity:1;transition-duration:0s}
#r.hz,#q.hz{bottom:38px}
#r::before,#q::before{content:"";flex:none;width:6px;height:6px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(45deg);margin-left:3px;opacity:.85}

/* selection occurrences: amber like the browser's own find highlights; visible while a selection is active */
.mk{position:absolute;left:7px;top:-1.5px;width:5px;height:3px;box-sizing:border-box;border-radius:2px;opacity:0;
  pointer-events:none;will-change:transform;background:#f6c23e;border:1px solid rgba(0,0,0,.4);
  transition:opacity .24s var(--ease),width .24s var(--ease),height .24s var(--ease),top .24s var(--ease),left .24s var(--ease),background .24s ease,box-shadow .24s ease}
.t.sel .mk,.t:hover .mk,.t.drag .mk{opacity:1}
.t:hover .mk.hv{left:5px;top:-3px;width:9px;height:6px;background:#ffd45e;box-shadow:0 0 0 3px rgba(246,194,62,.32)}

/* pins: blue flags that stick out to the left of the track */
.pn{position:absolute;left:-6px;top:-2px;width:11px;height:4px;box-sizing:border-box;border-radius:3px;opacity:0;
  pointer-events:none;will-change:transform;background:#4c8dff;border:1px solid rgba(255,255,255,.9);box-shadow:0 1px 3px rgba(0,0,0,.35);
  transition:opacity .24s var(--ease),width .24s var(--ease),height .24s var(--ease),top .24s var(--ease),left .24s var(--ease),box-shadow .24s ease}
.t.show .pn,.t:hover .pn,.t.drag .pn{opacity:1}
.t:hover .pn.hv{left:-10px;top:-3px;width:17px;height:6px;box-shadow:0 0 0 3px rgba(76,141,255,.3),0 1px 4px rgba(0,0,0,.4)}

/* "resume where you left off" chip: same glass family as the back chip, with a dismiss button */
#q{padding:7px 8px 7px 12px;max-width:calc(100vw - 48px)}
#q::before{transform:rotate(-45deg)}
#q .m{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#q .s{flex:none;font-weight:500;opacity:.6;font-variant-numeric:tabular-nums}
#q .x{flex:none;position:relative;width:18px;height:18px;margin-left:2px;border-radius:50%;transition:background .15s ease}
#q .x::before,#q .x::after{content:"";position:absolute;left:50%;top:50%;width:8px;height:1.5px;border-radius:1px;background:currentColor;opacity:.7}
#q .x::before{transform:translate(-50%,-50%) rotate(45deg)}
#q .x::after{transform:translate(-50%,-50%) rotate(-45deg)}
#q .x:hover{background:rgba(255,255,255,.16)}

/* keyboard shortcuts card */
#hp{position:fixed;right:24px;bottom:24px;box-sizing:border-box;width:min(310px,calc(100vw - 48px));padding:14px 16px 10px;border-radius:14px;
  font:500 12.5px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;
  background:rgba(18,20,26,.86);border:1px solid rgba(255,255,255,.16);
  backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
  box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.08);
  opacity:0;pointer-events:none;transform:translate3d(0,8px,0);transition:opacity .2s ease,transform .3s var(--ease)}
#hp.on{opacity:1;pointer-events:auto;transform:none}
#hp .h{font-weight:600;margin-bottom:6px}
#hp .row{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:7px 0;border-top:1px solid rgba(255,255,255,.08)}
#hp .keys{display:flex;gap:4px;flex:none}
#hp kbd{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 6px;border-radius:5px;
  background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.14);white-space:nowrap}
#hp .d{opacity:.75;text-align:right}

/* lite mode (slow machines): no blur, flatter surfaces */
:host(.lite) .b,:host(.lite) #p,:host(.lite) #r,:host(.lite) #q,:host(.lite) #hp{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
:host(.lite) #p,:host(.lite) #r,:host(.lite) #q,:host(.lite) #hp{background:rgba(18,20,26,.94)}
:host(.lite) .t::before{display:none}

/* Windows high-contrast / forced-colors: use the system palette so nothing becomes invisible */
@media (forced-colors:active){
  .t::before{display:none}
  .t:hover,.t.drag{background:Canvas;outline:1px solid CanvasText;outline-offset:-1px}
  .b{forced-color-adjust:none;background:ButtonText;border-color:ButtonFace;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
  .b::before,.b::after{display:none}
  .t.hot .b,.t.drag .b{background:Highlight;border-color:HighlightText}
  .k,.mk,.pn{forced-color-adjust:none;box-shadow:none}
  .k{background:CanvasText;border-color:Canvas}
  .k.hv,.t:hover .k.hv{background:Highlight}
  .mk{background:Mark;border-color:MarkText}
  .pn{background:Highlight;border-color:HighlightText}
  #p,#r,#q,#hp{forced-color-adjust:none;background:Canvas;color:CanvasText;border:1px solid CanvasText;box-shadow:none;
    backdrop-filter:none;-webkit-backdrop-filter:none}
  #p.ar::after{border-left-color:CanvasText}
  #q .x:hover{background:Highlight;color:HighlightText}
}
`;

    /* -----------------------------------------------------------------------
       STATE
    ----------------------------------------------------------------------- */
    let host, track, thumb, label, labelMain, labelSub, hTrack, hThumb, chipQ, qSub, qX, help, helpT = 0;
    let ready = false;

    // Physics
    let anim = false, rafId = 0, lastTs = 0, lastFrameT = 0, deadline = 0;
    let pos = 0, target = 0, lastSet = 0;
    let mom = 0, lastWheelT = 0, lastDir = 0, latchUntil = 0;

    // Scrollbar interaction
    let dragging = false, pressed = false;
    let dragY0 = 0, dragS0 = 0, ptrY = 0, repDir = 0, repT = 0, repI = 0, capId = null;
    let thumbTop = 0, thumbH = 0, travel = 0, lastH = -1;
    let hbId = 0, gmStyleEl = null, failed = false, errCount = 0;
    let sections = [], marks = [], pins = [], ticksDirty = false, hov = null;
    const lane = { sec: { els: [], ys: [], idx: [], cls: 'k' }, mark: { els: [], ys: [], idx: [], cls: 'mk' }, pin: { els: [], ys: [], idx: [], cls: 'pn' } };
    const LANES = ['pin', 'mark', 'sec'];                      // hit-test priority when markers overlap
    let lastScan = -1e9, lastSig = -1, lastTickH = -1, lastTickTravel = -1;
    let bypassUntil = 0, bypassWhy = '', deadHits = 0, deadT = 0, animStartY = 0, libSmooth = false;
    let hVisible = false, hLeft = 0, hW = 0, hTravel = 0, hLastW = -1, hDrag = false, hX0 = 0, hS0 = 0, hCap = null;
    let hideT = 0, renderQueued = false, toastT = 0;
    let chip = null, backY = null, backT = 0, backLeft = false, lastF = '', lastFx = '';

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const scrollY = () => window.scrollY || window.pageYOffset || 0;

    /* -----------------------------------------------------------------------
       PAGE MEASUREMENT - single source of truth: the browser's real scroll range
       (older versions mixed body.offsetHeight etc., which overestimated the
        limit and caused the "endless loop" bug)
    ----------------------------------------------------------------------- */
    const _ax = { overflowX: { t: -1e9, v: true }, overflowY: { t: -1e9, v: true } };
    function axisScrollable(prop) {
        // Is scrolling locked? (modal open, overflow-x:hidden, ...)
        // 80ms cache so an animation frame doesn't trigger dozens of style lookups
        const now = performance.now(), c = _ax[prop];
        if (now - c.t < 80) return c.v;
        let o = getComputedStyle(de)[prop];
        if (o === 'visible' && document.body) o = getComputedStyle(document.body)[prop];
        c.v = o !== 'hidden' && o !== 'clip';
        c.t = now;
        return c.v;
    }
    const userScrollable = () => axisScrollable('overflowY');
    function rawMax() {
        const se = document.scrollingElement || de;
        return Math.max(0, se.scrollHeight - (se.clientHeight || window.innerHeight));
    }
    function scrollMax() { return userScrollable() ? rawMax() : 0; }
    function scrollMaxX() {
        if (!axisScrollable('overflowX')) return 0;
        const se = document.scrollingElement || de;
        return Math.max(0, se.scrollWidth - (se.clientWidth || window.innerWidth));
    }

    function snapActive() {
        const t = getComputedStyle(de).scrollSnapType;
        return !!t && t !== 'none';
    }

    function setScroll(y) {
        lastSet = y;
        try { window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' }); }
        catch (_) { window.scrollTo(window.scrollX, y); }
    }

    /* Nested scroll areas - also sees into Shadow DOM (composedPath) */
    const _sc = new WeakMap();
    function isScrollerStyle(n, now) {                 // overflow class rarely changes -> 1.5s cache
        const c = _sc.get(n);
        if (c && now - c.t < 1500) return c.v;
        const oy = getComputedStyle(n).overflowY;
        const v = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        _sc.set(n, { t: now, v: v });
        return v;
    }
    function findInner(path, dir) {
        const now = performance.now();
        for (let i = 0; i < path.length; i++) {
            const n = path[i];
            if (n === de || n === document.body || n === document || n === window) break;
            if (!n || n.nodeType !== 1 || n === host) continue;
            if (!isScrollerStyle(n, now)) continue;
            const room = n.scrollHeight - n.clientHeight;
            if (room <= 1) continue;
            if (dir < 0 ? n.scrollTop > 0 : n.scrollTop < room - 1) return n;
        }
        return null;
    }
    const canInnerScroll = (path, dir) => !!findInner(path, dir);


    /* -- Experimental: smooth inner scroll areas (off by default) ------------------------
       Many app-style sites (mail, chat, docs) scroll inside a panel instead of the window.
       With the experimental switch on, wheel events over such a panel get the same smoothing as the page.
       Safety: panels that ignore our scroll calls, or that move on their own, are left to the browser;
       text fields, selects and scroll-snap panels are never touched. */
    const deadInner = new WeakSet();
    let inEl = null, inPos = 0, inTarget = 0, inLast = 0, inRaf = 0, inLastTs = 0, inDeadline = 0, inStart = 0, inDead = 0;
    function deltaPx(e) {
        let d = e.deltaY;
        if (e.deltaMode === 1) d *= CFG.LINE_PX;
        else if (e.deltaMode === 2) d *= window.innerHeight;
        return d;
    }
    function innerSafe(el) {
        if (deadInner.has(el)) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT' || el.isContentEditable) return false;
        const t = getComputedStyle(el).scrollSnapType;
        return !t || t === 'none';
    }
    function innerStop() {
        if (inRaf) { cancelAnimationFrame(inRaf); inRaf = 0; }
        inEl = null; inLastTs = 0;
    }
    function innerSet(el, y) {
        inLast = y;
        try { el.scrollTo({ top: y, behavior: 'instant' }); } catch (_) { el.scrollTop = y; }
    }
    function innerFrame(ts) {
        inRaf = 0;
        const el = inEl;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0 || !el.isConnected) { innerStop(); return; }
        if (Math.abs(el.scrollTop - inLast) > TOL) {                       // someone else moved it
            if (Math.abs(el.scrollTop - inStart) < 1 && ++inDead >= 3) deadInner.add(el);   // ignores us completely: native from now on
            innerStop();
            return;
        }
        const dt = inLastTs ? Math.min(Math.max(ts - inLastTs, 0), 50) : 16.667;
        inLastTs = ts;
        inTarget = clamp(inTarget, 0, max);
        if (REDUCED || CFG.INSTANT || ts > inDeadline) inPos = inTarget;
        else {
            inPos += (inTarget - inPos) * (1 - Math.pow(1 - CFG.LERP, dt / 16.667));
            if (Math.abs(inTarget - inPos) < 0.4) inPos = inTarget;
        }
        inPos = clamp(inPos, 0, max);
        innerSet(el, inPos);
        if (inPos === inTarget) { if (Math.abs(el.scrollTop - inPos) <= TOL) inDead = 0; innerStop(); }
        else inRaf = requestAnimationFrame(innerTick);
    }
    const innerTick = (ts) => { try { innerFrame(ts); } catch (err) { innerStop(); noteError(err); } };
    function smoothInner(e, el, d, now) {
        const max = el.scrollHeight - el.clientHeight;
        if (inEl !== el || !inRaf || Math.abs(el.scrollTop - inLast) > TOL) {   // start from the panel's real position
            innerStop(); inEl = el; inPos = inTarget = inLast = el.scrollTop;
        }
        if (inRaf && (inTarget - inPos) * d < 0 && Math.abs(inTarget - inPos) > 1) inTarget = inPos;   // direction changed
        inTarget = clamp(inTarget + d * momentum(e, d, now), 0, max);
        e.preventDefault();
        inStart = el.scrollTop;
        inDeadline = now + 2500;
        if (!inRaf) { inLastTs = 0; inRaf = requestAnimationFrame(innerTick); }
    }

    const INTERACTIVE =
        'input,textarea,select,button,summary,iframe,embed,object,video,audio,' +
        '[contenteditable]:not([contenteditable="false"]),' +
        '[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="slider"],[role="spinbutton"],' +
        '[role="menu"],[role="menubar"],[role="menuitem"],[role="option"],[role="tab"],[role="tablist"],' +
        '[role="tree"],[role="treeitem"],[role="grid"],[role="application"],[role="button"],' +
        '[role="radio"],[role="checkbox"],[role="switch"]';
    function isInteractive(t) {
        if (!t || t.nodeType !== 1) return false;
        if (t.isContentEditable) return true;
        try { return !!t.closest(INTERACTIVE); } catch (_) { return false; }
    }

    /* -----------------------------------------------------------------------
       UI
    ----------------------------------------------------------------------- */
    function showLabel(main, y, sub, arrow) {
        if (!label) return;
        labelMain.textContent = main;
        labelSub.textContent = sub || '';
        labelSub.style.display = sub ? '' : 'none';
        label.classList.toggle('ar', !!arrow);
        label.style.transform = 'translate3d(0,' + clamp(y, 4, window.innerHeight - 36) + 'px,0)';
        label.classList.add('on');
    }
    function hideLabel() { if (label) label.classList.remove('on'); }
    function toast(msg, ms) {
        showLabel(msg, 16, '', false);
        clearTimeout(toastT);
        toastT = setTimeout(() => { if (!dragging && !hov) hideLabel(); }, ms || 1500);
    }

    // Is the page behind the scrollbar light or dark? -> pick the thumb tint accordingly
    function parseColor(str) {
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?\s*\)/.exec(str || '');
        if (!m) return null;
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (m[5] === '%') a /= 100;
        return { r: +m[1], g: +m[2], b: +m[3], a: a };
    }
    const lum = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    function backdropBrightness() {
        let el = null;
        try { el = document.elementFromPoint(Math.max(0, window.innerWidth - 24), Math.floor(window.innerHeight / 2)); } catch (_) {}
        for (let n = el, i = 0; n && n.nodeType === 1 && i < 14; n = n.parentElement, i++) {
            const c = parseColor(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0.6) return lum(c);
        }
        const t = parseColor(getComputedStyle(document.body || de).color);   // no background found -> look at the text colour
        return t ? 1 - lum(t) : null;
    }
    function updateTint() {
        if (!track) return;
        const v = backdropBrightness();
        if (v === null) return;
        const wasLight = track.classList.contains('lt');
        const light = wasLight ? v > 0.45 : v > 0.58;                           // hysteresis: no flicker
        track.classList.toggle('lt', light);
        if (hTrack) hTrack.classList.toggle('lt', light);
    }

    /* -- Section markers: h1/h2 positions become small ticks on the scrollbar - */
    /* -- Saved data helpers (reading positions, pins) ----------------------------- */
    function pageKey() {                   // URL without hash and tracking parameters
        try {
            const u = new URL(location.href);
            u.hash = '';
            [...u.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k); });
            return u.origin + u.pathname + u.search;
        } catch (_) { return String(location.href).split('#')[0]; }
    }
    function loadMap(key) {
        try {
            const v = loadPref(key, '');
            const o = typeof v === 'string' && v ? JSON.parse(v) : (v && typeof v === 'object' ? v : {});
            return o && typeof o === 'object' ? o : {};
        } catch (_) { return {}; }
    }
    function saveMap(key, o) { savePref(key, JSON.stringify(o)); }
    function pruneMap(o, maxEntries, maxAgeMs) {
        const now = Date.now();
        for (const k of Object.keys(o)) { if (now - ((o[k] && o[k].t) || 0) > maxAgeMs) delete o[k]; }
        const keys = Object.keys(o);
        if (keys.length > maxEntries) {
            keys.sort((x, y) => (o[x].t || 0) - (o[y].t || 0));
            for (let i = 0; i < keys.length - maxEntries; i++) delete o[keys[i]];
        }
    }

    /* -- Markers: three kinds share one lane system on the track -------------------
       sec  - section headings (h1/h2)            class .k
       mark - occurrences of the selected text    class .mk  (amber, like the browser's find highlights)
       pin  - your own pins (Alt+M)               class .pn  (blue flags sticking out to the left)
       Every item has an absolute scroll position; itemTarget() says where a jump to it lands. */
    const sameSections = (a, b) => a.length === b.length && a.every((s, i) => s.text === b[i].text && s.off === b[i].off && Math.abs(s.y - b[i].y) < 2);

    // Height of a sticky/fixed bar stuck to the top of the viewport, so jumps never hide a heading under it
    let insetNow = 0;
    function topInset() {
        try {
            if (!document.elementsFromPoint) return 0;
            const vw = window.innerWidth, vh = window.innerHeight;
            let best = 0;
            for (const fx of [0.5, 0.25, 0.75]) {
                const stack = document.elementsFromPoint(Math.round(vw * fx), 4);
                for (let i = 0; i < stack.length && i < 10; i++) {
                    if (stack[i] === host) continue;
                    for (let n = stack[i], d = 0; n && n !== de && n !== document.body && d < 6; n = n.parentElement, d++) {
                        const pos = getComputedStyle(n).position;
                        if (pos !== 'fixed' && pos !== 'sticky') continue;
                        const r = n.getBoundingClientRect();
                        if (r.top <= 6 && r.bottom > 8 && r.height < vh * 0.4 && r.width >= vw * 0.5) best = Math.max(best, r.bottom);
                        break;
                    }
                }
            }
            return Math.round(best);
        } catch (_) { return 0; }
    }

    function scanSections(force) {
        if (!CFG.SECTIONS || failed || !track) return;
        const now = performance.now();
        try {
            const max = scrollMax();
            const sig = Math.round(max / 60);
            if (!force && (now - lastScan < 1500 || (now - lastScan < 6000 && sig === lastSig))) return;
            lastScan = now; lastSig = sig;
            if (max < window.innerHeight * 0.5) {                               // short page: markers are pointless
                if (sections.length) { sections = []; ticksDirty = true; }
                return;
            }
            insetNow = topInset();
            const list = document.querySelectorAll('h1,h2');
            const sy = scrollY(), out = [];
            for (let i = 0; i < list.length && i < 250; i++) {
                const el = list[i];
                if (el.closest('nav,footer,[aria-hidden="true"],[hidden]')) continue;
                const r = el.getBoundingClientRect();
                if (!r.height || !r.width) continue;
                const cs = getComputedStyle(el);
                if (cs.position === 'fixed' || cs.position === 'sticky') continue;
                const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
                if (!text) continue;
                const sm = parseFloat(cs.scrollMarginTop) || 0;                // the site's own anchor offset, if any
                out.push({ y: r.top + sy, text: text, lv: el.tagName === 'H1' ? 1 : 2, off: Math.round(Math.max(sm, insetNow ? insetNow + 12 : 16)) });
            }
            out.sort((a, b) => a.y - b.y);
            const clean = [];
            for (const o of out) if (!clean.length || o.y - clean[clean.length - 1].y > 24) clean.push(o);
            const next = clean.length >= 2 && clean.length <= 40 ? clean : [];  // too crowded = meaningless
            if (!sameSections(next, sections)) { sections = next; ticksDirty = true; }
        } catch (_) {                      // if this feature breaks it only disables itself; scrolling is unaffected
            CFG.SECTIONS = false; sections = []; ticksDirty = true;
        }
    }

    const itemsOf = (k) => (k === 'sec' ? sections : k === 'mark' ? marks : pins);
    const laneOn = (k) => (k === 'sec' ? CFG.SECTIONS : k === 'mark' ? CFG.SELMARKS : true);
    function itemTarget(k, it) {           // the scroll position a jump to this item should land on
        if (k === 'sec') return it.y - it.off;
        if (k === 'mark') return it.y - Math.max(window.innerHeight * 0.3, insetNow + 20);
        return it.y;
    }

    function setHover(h) {
        if ((!h && !hov) || (h && hov && h.k === hov.k && h.j === hov.j)) return;
        if (hov) { const old = lane[hov.k].els[hov.j]; if (old) old.classList.remove('hv'); }
        hov = h;
        track.classList.toggle('pt', !!h);
        if (h) {
            const L = lane[h.k], it = itemsOf(h.k)[L.idx[h.j]], el = L.els[h.j];
            if (el && it) {
                el.classList.add('hv');
                const max = scrollMax();
                let main = it.text, sub = max > 0 ? Math.round((clamp(itemTarget(h.k, it), 0, max) / max) * 100) + '%' : '';
                if (h.k === 'mark') sub = (L.idx[h.j] + 1) + ' / ' + marks.length;
                if (h.k === 'pin') { const n = pins.indexOf(it) + 1; main = it.text ? 'Pin ' + n + ': ' + it.text : 'Pin ' + n; }
                showLabel(main, L.ys[h.j] - 15, sub, true);
                return;
            }
        }
        if (!dragging) hideLabel();
    }

    function drawMarkers() {
        ticksDirty = false;
        setHover(null);                                                         // indices may have changed
        const max = scrollMax();
        for (const k of LANES) {
            const L = lane[k], arr = itemsOf(k);
            const on = laneOn(k) && max > 0 && arr.length >= (k === 'pin' ? 1 : 2);
            let n = 0, lastTy = -99;
            if (on) {
                for (let i = 0; i < arr.length; i++) {
                    const ty = CFG.PAD + (clamp(itemTarget(k, arr[i]), 0, max) / max) * travel + thumbH / 2;
                    if (k === 'mark' && n > 0 && ty - lastTy < 3) continue;     // merge occurrences that land on the same pixels
                    while (L.els.length <= n) {
                        const d = document.createElement('div'); d.className = L.cls;
                        track.insertBefore(d, thumb);                           // underneath the thumb
                        L.els.push(d);
                    }
                    const el = L.els[n];
                    L.ys[n] = ty; L.idx[n] = i;
                    if (k === 'sec') el.classList.toggle('l1', arr[i].lv === 1);
                    el.style.display = '';
                    el.style.transform = 'translate3d(0,' + ty + 'px,0)';
                    lastTy = ty; n++;
                }
            }
            for (let j = n; j < L.els.length; j++) L.els[j].style.display = 'none';
            L.ys.length = n; L.idx.length = n;
        }
    }

    function nearestItem(y) {              // closest marker of any kind within reach of the pointer
        let best = null, bd = CFG.TICK_HIT;
        for (const k of LANES) {           // pin > mark > sec: only a strictly closer marker beats an earlier kind
            const ys = lane[k].ys;
            for (let j = 0; j < ys.length; j++) {
                const d = Math.abs(ys[j] - y);
                if (d < bd || (best === null && d <= bd)) { bd = d; best = { k: k, j: j }; }
            }
        }
        return best;
    }
    function curIndex(sp) {                // the section we are "inside" at a given scroll position
        let c = -1;
        for (let i = 0; i < sections.length; i++) { if (sections[i].y <= sp + 80) c = i; else break; }
        return c;
    }
    function stepSection(dir) {            // next (+1) / previous (-1) section relative to where we're heading
        const ref = anim ? target : scrollY();
        if (dir > 0) { for (const s of sections) if (s.y - s.off > ref + 8) return s; }
        else { for (let i = sections.length - 1; i >= 0; i--) if (sections[i].y - sections[i].off < ref - 8) return sections[i]; }
        return null;
    }
    function stepPin(dir) {
        const ref = anim ? target : scrollY();
        if (dir > 0) { for (const p of pins) if (p.y > ref + 8) return p; }
        else { for (let i = pins.length - 1; i >= 0; i--) if (pins[i].y < ref - 8) return pins[i]; }
        return null;
    }


    /* -- Selection markers: where else does the selected text appear? --------------
       Select a word and amber marks show up on the scrollbar for every other place it occurs
       (just like the browser's find highlights). Hover a mark to read the surrounding text,
       click it to jump there. The page is scanned in small slices so it never blocks scrolling. */
    const SKIP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TEMPLATE|SVG|CANVAS|IFRAME)$/i;
    let selText = '', selTok = 0, selT = 0;
    const isWordCh = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
    function clearSel() {
        selTok++; selText = '';
        if (marks.length) { marks = []; ticksDirty = true; }
        if (track) track.classList.remove('sel');
    }
    function snippet(v, i, end) {
        const before = v.slice(Math.max(0, i - 26), i), after = v.slice(end, end + 26);
        return ((i > 26 ? '...' : '') + before + v.slice(i, end) + after + (end + 26 < v.length ? '...' : '')).replace(/\s+/g, ' ').trim();
    }
    function finishSel(tok, out) {
        if (tok !== selTok) return;
        if (!out || out.length < 2) { marks = []; track.classList.remove('sel'); }
        else { out.sort((a, b) => a.y - b.y); marks = out; track.classList.add('sel'); }
        ticksDirty = true; render();
    }
    function runSelScan(q, tok) {
        const needle = q.toLowerCase();
        const wordLike = /^[\p{L}\p{N}_-]+$/u.test(q);             // whole words only, so "art" does not light up "party"
        const walker = document.createTreeWalker(document.body || de, NodeFilter.SHOW_TEXT, null);
        const range = document.createRange();
        const out = [], t0 = performance.now();
        const slice = () => {
            if (tok !== selTok || failed) return;
            const start = performance.now();
            try {
                let n;
                while ((n = walker.nextNode())) {
                    const parent = n.parentElement;
                    if (!parent || SKIP_TAG.test(parent.tagName)) continue;
                    const v = n.nodeValue;
                    if (!v || v.length < needle.length) continue;
                    const hay = v.toLowerCase();
                    if (hay.length !== v.length) continue;         // exotic case folding would shift offsets
                    let i = hay.indexOf(needle);
                    while (i !== -1) {
                        const end = i + needle.length;
                        if (!wordLike || (!isWordCh(hay[i - 1]) && !isWordCh(hay[end]))) {
                            range.setStart(n, i); range.setEnd(n, end);
                            const r = range.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {     // skips hidden text
                                out.push({ y: r.top + scrollY(), text: snippet(v, i, end) });
                                if (out.length > 400) { finishSel(tok, null); return; }   // far too common to be useful
                            }
                        }
                        i = hay.indexOf(needle, end);
                    }
                    if (performance.now() - start > 8) {           // yield so the page stays responsive
                        if (performance.now() - t0 > 2500) { finishSel(tok, null); return; }
                        setTimeout(slice, 0);
                        return;
                    }
                }
                finishSel(tok, out);
            } catch (_) { CFG.SELMARKS = false; clearSel(); render(); }
        };
        slice();
    }
    function scanSelection() {
        if (failed || !track) return;
        if (!CFG.SELMARKS) { if (marks.length || selText) { clearSel(); render(); } return; }
        try {
            const sel = window.getSelection ? window.getSelection() : null;
            const t = sel && !sel.isCollapsed ? String(sel).trim() : '';
            const ae = document.activeElement;
            const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
            if (t.length < 2 || t.length > 80 || /[\r\n]/.test(t) || typing || scrollMax() <= 0) {
                if (marks.length || selText) { clearSel(); render(); }
                return;
            }
            const q = t.replace(/\s+/g, ' ');
            if (q === selText && marks.length) return;            // same selection, nothing to redo
            selText = q;
            runSelScan(q, ++selTok);
        } catch (_) { CFG.SELMARKS = false; clearSel(); }
    }
    function onSelChange() { clearTimeout(selT); selT = setTimeout(guard(scanSelection), 220); }


    /* -- Resume where you left off ----------------------------------------------------
       Long pages remember how far you read. When you open the same page from the top again, a small
       chip offers to take you back. Stored locally (Tampermonkey storage), per page, for 30 days, at most
       200 pages. Forgotten once you finish the page or dismiss the chip. Never shown on short pages, on
       links with a #hash, or when the browser already restored your position. */
    let rsState = 'idle', rsEntry = null, rsStartT = 0, rsShownT = 0, lastSavedY = -1, saveT = 0;
    const DAY = 864e5;
    function saveResume(force) {
        if (!CFG.RESUME || failed) return;
        const vh = window.innerHeight, max = scrollMax(), y = scrollY();
        if (max < vh * 3) return;                                       // only long pages are worth remembering
        const m = loadMap('resume'), k = pageKey();
        if (y > max - vh * 0.6) {                                       // finished reading: forget this page
            if (m[k]) { delete m[k]; saveMap('resume', m); }
            lastSavedY = -1;
            return;
        }
        if (y < vh) return;                                             // still on the first screen: keep any older entry
        if (!force && Math.abs(y - lastSavedY) < vh * 0.25) return;
        m[k] = { y: Math.round(y), r: +(y / max).toFixed(4), h: Math.round(max), t: Date.now() };
        pruneMap(m, 200, 30 * DAY);
        saveMap('resume', m);
        lastSavedY = y;
    }
    function schedSave() { clearTimeout(saveT); saveT = setTimeout(guard(() => saveResume(false)), 1500); }
    function forgetResume() { const m = loadMap('resume'), k = pageKey(); if (m[k]) { delete m[k]; saveMap('resume', m); } }
    function hideResume(forget) {
        if (chipQ) chipQ.classList.remove('on');
        if (forget) forgetResume();
        rsState = 'done';
    }
    function showResume() {
        if (!chipQ || !rsEntry) return;
        if (backY !== null) { rsState = 'done'; return; }              // a "back" chip is already up; do not compete with it
        qSub.textContent = rsEntry.pct + '%';
        chipQ.classList.add('on');
        rsState = 'shown'; rsShownT = performance.now();
    }
    function resumeInit() {
        hideResume(false);
        rsState = CFG.RESUME ? 'pending' : 'done';
        rsEntry = null; rsStartT = performance.now(); lastSavedY = -1;
    }
    function resumeTick() {                                             // runs once a second from the heartbeat
        if (!CFG.RESUME || failed) return;
        const now = performance.now(), vh = window.innerHeight, y = scrollY();
        if (rsState === 'shown') { if (now - rsShownT > 14000) hideResume(false); return; }
        if (rsState !== 'pending') return;
        const age = now - rsStartT;
        if (age < 900) return;                                          // let the page settle first
        if (age > 9000 || y > vh * 0.5 || (location.hash && location.hash.length > 1) || bypassed()) { rsState = 'done'; return; }
        const max = scrollMax();
        if (max < vh * 3) return;                                       // not long enough (yet): content may still be loading
        const e = loadMap('resume')[pageKey()];
        if (!e || !isFinite(e.y) || Date.now() - (e.t || 0) > 30 * DAY) { rsState = 'done'; return; }
        if (e.h && max < e.h * 0.8 && age < 6000) return;               // the page is still growing: wait until the saved spot exists
        const ty = e.y <= max ? e.y : Math.round((e.r || 0) * max);
        if (ty < vh * 1.2 || ty > max - vh * 0.6) { rsState = 'done'; return; }
        rsEntry = { y: ty, pct: Math.round((ty / max) * 100) };
        showResume();
    }


    /* -- Keyboard shortcuts card ------------------------------------------------------ */
    function buildHelp(root) {
        help = document.createElement('div'); help.id = 'hp';
        const h = document.createElement('div'); h.className = 'h'; h.textContent = 'Keyboard shortcuts'; help.appendChild(h);
        const rows = [
            [['Alt', 'Up / Down'], 'Previous / next section'],
            [['Alt', 'M'], 'Add or remove a pin here'],
            [['Alt', 'Shift', 'Up / Down'], 'Previous / next pin'],
            [['Home', 'End'], 'Top / bottom of the page']
        ];
        for (const r of rows) {
            const row = document.createElement('div'); row.className = 'row';
            const keys = document.createElement('span'); keys.className = 'keys';
            for (const k of r[0]) { const kb = document.createElement('kbd'); kb.textContent = k; keys.appendChild(kb); }
            const d = document.createElement('span'); d.className = 'd'; d.textContent = r[1];
            row.appendChild(keys); row.appendChild(d); help.appendChild(row);
        }
        help.addEventListener('click', hideHelp);
        root.appendChild(help);
    }
    function showHelp() { if (!help) return; help.classList.add('on'); clearTimeout(helpT); helpT = setTimeout(hideHelp, 12000); }
    function hideHelp() { if (help) help.classList.remove('on'); clearTimeout(helpT); }

    /* -- Pins: your own bookmarks on this page (Alt+M), remembered per page --------- */
    function loadPins() {
        const e = loadMap('pins')[pageKey()];
        pins = e && Array.isArray(e.p)
            ? e.p.filter((p) => p && isFinite(p.y)).slice(0, 30).map((p) => ({ y: +p.y, text: String(p.text || '').slice(0, 60) }))
            : [];
        pins.sort((a, b) => a.y - b.y);
        ticksDirty = true;
    }
    function savePins() {
        const m = loadMap('pins'), k = pageKey();
        if (pins.length) m[k] = { t: Date.now(), p: pins.map((p) => ({ y: Math.round(p.y), text: p.text })) };
        else delete m[k];
        pruneMap(m, 150, 365 * 864e5);
        saveMap('pins', m);
    }
    function togglePin() {
        const max = scrollMax();
        if (max <= 0) return;
        const y = Math.round(scrollY()), vh = window.innerHeight;
        const near = pins.findIndex((p) => Math.abs(p.y - y) < vh * 0.2);
        if (near >= 0) {
            pins.splice(near, 1);
            toast('Pin removed');
        } else {
            if (pins.length >= 30) { toast('Pin limit reached (30 per page)'); return; }
            const ci = curIndex(y);
            pins.push({ y: y, text: ci >= 0 ? sections[ci].text : '' });
            pins.sort((a, b) => a.y - b.y);
            toast('Pin ' + (pins.findIndex((p) => p.y === y) + 1) + ' added');
        }
        savePins(); ticksDirty = true; reveal(); render();
    }

    // "Back to previous position": offered after a long jump (marker click, Home/End, far thumb drag)
    function hideBack() {
        backY = null; backLeft = false;
        clearTimeout(backT);
        if (chip) chip.classList.remove('on');
    }
    function offerBack(y) {
        if (!chip || failed) return;
        if (rsState === 'shown') hideResume(false);
        backY = y; backLeft = false;
        chip.classList.add('on');
        clearTimeout(backT);
        backT = setTimeout(hideBack, 7000);
    }
    function maybeOfferBack(from, to) {
        if (Math.abs(to - from) > window.innerHeight * 1.2) offerBack(from);
    }
    function jumpTo(y, noOffer) {
        const max = scrollMax();
        if (max <= 0) return;
        syncState();
        if (bypassed()) return;
        const to = clamp(y, 0, max);
        if (!noOffer) maybeOfferBack(target, to);
        target = to;
        reveal(); go();
    }

    function jumpToItem(h) {
        const it = itemsOf(h.k)[lane[h.k].idx[h.j]];
        if (it) jumpTo(itemTarget(h.k, it));
    }

    function renderV() {
        if (!track) return;
        const max = scrollMax();
        if (max <= 0) { track.classList.add('off'); return; }
        track.classList.remove('off');
        track.classList.toggle('hz', hVisible);               // leave the corner free when the horizontal bar is visible
        if (CFG.ALWAYS_VISIBLE) track.classList.add('show');

        const vh = window.innerHeight;
        const inner = vh - CFG.PAD * 2 - (hVisible ? CFG.TRACK_W : 0);
        const h = Math.min(inner, Math.max(CFG.MIN_THUMB, Math.round(inner * vh / (vh + max))));
        travel = Math.max(0, inner - h);
        thumbH = h;
        thumbTop = CFG.PAD + (clamp(scrollY(), 0, max) / max) * travel;

        if (h !== lastH) { thumb.style.height = h + 'px'; lastH = h; }
        thumb.style.transform = 'translate3d(0,' + thumbTop + 'px,0)';
        const f = ((thumbTop + thumbH / 2) / vh).toFixed(3);
        if (f !== lastF) { track.style.setProperty('--f', f); lastF = f; }
        if (chip) {
            chip.classList.toggle('hz', hVisible);
            if (chipQ) chipQ.classList.toggle('hz', hVisible);
            if (backY !== null) {                                  // hide once the user is back where they started
                const dd = Math.abs(scrollY() - backY);
                if (dd > vh * 0.8) backLeft = true;
                else if (backLeft && dd < vh * 0.4) hideBack();
            }
        }
        if (h !== lastTickH || travel !== lastTickTravel) { lastTickH = h; lastTickTravel = travel; ticksDirty = true; }
        if (ticksDirty) drawMarkers();
        if (dragging) {
            const sy = clamp(scrollY(), 0, max), pct = Math.round((sy / max) * 100) + '%';
            const ci = CFG.SECTIONS ? curIndex(sy) : -1;
            showLabel(ci >= 0 ? sections[ci].text : pct, thumbTop + thumbH / 2 - 15, ci >= 0 ? pct : '', true);
        }
    }

    function renderH() {
        if (!hTrack) return;
        const max = scrollMaxX();
        hVisible = max > 2;
        if (!hVisible) { hTrack.classList.add('off'); return; }
        hTrack.classList.remove('off');
        if (CFG.ALWAYS_VISIBLE) hTrack.classList.add('show');

        const vw = window.innerWidth;
        const inner = vw - CFG.PAD * 2 - CFG.TRACK_W;
        const w = Math.min(inner, Math.max(CFG.MIN_THUMB, Math.round(inner * vw / (vw + max))));
        hTravel = Math.max(0, inner - w);
        hW = w;
        hLeft = CFG.PAD + (clamp(window.scrollX || 0, 0, max) / max) * hTravel;
        if (w !== hLastW) { hThumb.style.width = w + 'px'; hLastW = w; }
        hThumb.style.transform = 'translate3d(' + hLeft + 'px,0,0)';
        const fx = ((hLeft + hW / 2) / vw).toFixed(3);
        if (fx !== lastFx) { hTrack.style.setProperty('--f', fx); lastFx = fx; }
    }

    function render() { renderH(); renderV(); }

    function schedRender() {
        if (renderQueued || anim) return;       // while animating, every frame already renders
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; render(); });
    }

    function reveal() {
        if (!track) return;
        track.classList.add('show');
        if (hTrack) hTrack.classList.add('show');
        clearTimeout(hideT);
        if (CFG.ALWAYS_VISIBLE) return;
        hideT = setTimeout(() => {
            if (dragging || pressed) { reveal(); return; }
            track.classList.remove('show');
            if (hTrack) hTrack.classList.remove('show');
        }, CFG.HIDE_DELAY);
    }

    /* -----------------------------------------------------------------------
       PHYSICS
       Rules:
        1) Every animation starts from the REAL scroll position -> no stale state.
        2) The max is read fresh every frame -> no wrong "end of page" limit.
        3) If the browser is somewhere other than where we put it (site
           interference, lock, boundary) the animation is dropped -> loops and
           oscillation are impossible.
        4) Hard time limit -> no endless animation.
    ----------------------------------------------------------------------- */
    function stopAnim() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        anim = false; lastTs = 0;
    }
    function adopt() { pos = target = lastSet = scrollY(); }
    function setLite(on) { liteOn = on; if (host) host.classList.toggle('lite', on); }

    // If the browser ignores our scrollTo calls (site neutralised scrollTo / keeps resetting it)
    // and the page did not move AT ALL, count it; after 3 hits go native for 60s -> the user is never stuck
    function noteInterference() {
        const now = performance.now();
        if (Math.abs(scrollY() - animStartY) >= 1) return;          // page moved -> a site took it elsewhere, not dead
        if (now - deadT > 5000) deadHits = 0;
        deadT = now;
        if (++deadHits >= 3) {
            deadHits = 0;
            bypassUntil = now + 60000;
            bypassWhy = 'page ignores scrollTo calls';
            toast('Smooth scrolling temporarily off on this page', 2200);
        }
    }
    const bypassed = () => libSmooth || performance.now() < bypassUntil;

    function frame(ts) {
        rafId = 0;
        if (!anim) return;
        const raw = lastTs ? ts - lastTs : 0;
        const dt = lastTs ? Math.min(Math.max(raw, 0), 50) : 16.667;
        lastTs = ts; lastFrameT = ts;
        if (perfMode === 'auto' && !liteOn && raw > 0 && raw < 250) {       // judge only real animation frames, not pauses
            fN++; if (raw > 28) fSlow++;                                     // 28ms is slower than ~35fps
            if (fN >= 40) {
                const slow = fSlow / fN > 0.35;
                fN = 0; fSlow = 0;
                if (slow) { setLite(true); toast('Lite visuals on (slow frames detected)', 2600); }
            }
        }

        const max = scrollMax();
        if (max <= 0 || dragging) { stopAnim(); adopt(); render(); return; }
        if (Math.abs(scrollY() - lastSet) > TOL) { noteInterference(); stopAnim(); adopt(); render(); return; }

        target = clamp(target, 0, max);
        if (REDUCED || CFG.INSTANT || ts > deadline) {
            pos = target;
        } else {
            pos += (target - pos) * (1 - Math.pow(1 - CFG.LERP, dt / 16.667));
            if (Math.abs(target - pos) < 0.4) pos = target;
        }
        pos = clamp(pos, 0, max);
        setScroll(pos);
        render();

        if (pos === target) { if (Math.abs(scrollY() - pos) <= TOL) deadHits = 0; stopAnim(); }
        else rafId = requestAnimationFrame(tick);
    }
    const tick = (ts) => { try { frame(ts); } catch (err) { stopAnim(); noteError(err); } };

    function go() {
        deadline = performance.now() + 2500;
        if (anim) return;
        anim = true; lastTs = 0; lastFrameT = performance.now(); animStartY = scrollY();
        rafId = requestAnimationFrame(tick);
    }

    // Prepare the animation from the "real position"; drop it if someone interfered
    function syncState() {
        if (anim && Math.abs(scrollY() - lastSet) > TOL) { noteInterference(); stopAnim(); }
        if (!anim) adopt();
    }

    /* -----------------------------------------------------------------------
       WHEEL
    ----------------------------------------------------------------------- */
    function momentum(e, d, now) {
        const isWheel = e.deltaMode === 1 || Math.abs(e.deltaY) > 30;   // mouse wheel
        if (!isWheel) { mom = 1; return 1; }                              // trackpad: 1:1
        const dir = Math.sign(d);
        mom *= Math.pow(CFG.MOM_DECAY, now - lastWheelT);
        if (lastDir && dir !== lastDir) mom = 0;
        mom = Math.min(mom + CFG.MOM_BASE, CFG.MOM_MAX);
        lastWheelT = now; lastDir = dir;
        return mom;
    }

    function onWheel(e) {
        if (!ready || e.defaultPrevented || bypassed()) return;
        if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;          // zoom / horizontal / shortcuts
        const dy = e.deltaY;
        if (!dy || Math.abs(e.deltaX) > Math.abs(dy)) return;                  // horizontal gesture
        if (dragging || hDrag) { e.preventDefault(); return; }

        const max = scrollMax();
        if (max <= 0 || snapActive()) {                                        // the window itself is not scrolling
            if (CFG.INNER) {                                                   // experimental: smooth the panel instead
                const inner = findInner(e.composedPath(), dy);
                if (inner && innerSafe(inner)) smoothInner(e, inner, deltaPx(e), performance.now());
            }
            return;                                                            // otherwise stay out of the way
        }

        const now = performance.now();
        const inner = findInner(e.composedPath(), dy);
        if (inner) {
            latchUntil = now + 350;
            if (CFG.INNER && innerSafe(inner)) smoothInner(e, inner, deltaPx(e), now);
            return;
        }
        if (now < latchUntil) return;                                          // inner list -> page hand-over delay

        const d = deltaPx(e);

        syncState();
        if (bypassed()) return;
        if (anim && (target - pos) * d < 0 && Math.abs(target - pos) > 1) target = pos;   // direction changed -> drop the old target
        const next = clamp(target + d * momentum(e, d, now), 0, max);
        if (!anim && Math.abs(next - scrollY()) < 0.5) return;                 // already at the edge -> let the browser handle it

        e.preventDefault();
        target = next;
        reveal();
        go();
    }

    /* -----------------------------------------------------------------------
       KEYBOARD
       Arrows / PageUp / PageDown / Space / Home / End  +  Alt+Up / Alt+Down = previous / next section
    ----------------------------------------------------------------------- */
    function onKey(e) {
        if (!ready || e.defaultPrevented || bypassed()) return;
        if (e.key === 'Escape') { if (rsState === 'shown') hideResume(false); hideHelp(); }
        if (e.ctrlKey || e.metaKey) return;
        const k = e.key, vh = window.innerHeight;
        let dir = 0, amt = 0, abs = null, sec = 0, pinNav = 0, pinKey = false;

        if (e.altKey) {
            if (e.code === 'KeyM' && !e.shiftKey) pinKey = true;               // Alt+M: add / remove a pin here
            else if (k === 'ArrowDown' || k === 'ArrowUp') {
                const d = k === 'ArrowDown' ? 1 : -1;
                if (e.shiftKey) pinNav = d; else sec = d;                      // Alt+Up/Down sections, Alt+Shift+Up/Down pins
            } else return;
            if (sec && (!CFG.SECTIONS || !sections.length)) return;
            if (pinNav && !pins.length) return;
            dir = sec || pinNav;
        } else {
            switch (k) {
                case 'ArrowDown': dir = 1;  amt = CFG.KEY_LINE; break;
                case 'ArrowUp':   dir = -1; amt = CFG.KEY_LINE; break;
                case 'PageDown':  dir = 1;  amt = vh * CFG.KEY_PAGE; break;
                case 'PageUp':    dir = -1; amt = vh * CFG.KEY_PAGE; break;
                case ' ': case 'Spacebar': dir = e.shiftKey ? -1 : 1; amt = vh * CFG.KEY_PAGE; break;
                case 'Home': dir = -1; abs = 0; break;
                case 'End':  dir = 1;  abs = Infinity; break;
                default: return;
            }
            if (e.shiftKey && k !== ' ' && k !== 'Spacebar') return;           // Shift+arrow = text selection
        }

        const path = e.composedPath();
        if (isInteractive(path[0])) return;                                    // inputs / buttons / video... keep their keys
        const max = scrollMax();
        if (max <= 0 || snapActive()) return;
        if (!pinKey && canInnerScroll(path, dir)) return;

        if (pinKey) { e.preventDefault(); togglePin(); return; }

        syncState();
        if (bypassed()) return;
        let next, hit = null;
        if (sec) {
            hit = stepSection(sec);
            if (!hit) return;
            next = clamp(itemTarget('sec', hit), 0, max);
        } else if (pinNav) {
            hit = stepPin(pinNav);
            if (!hit) return;
            next = clamp(hit.y, 0, max);
        } else {
            if (anim && abs === null && (target - pos) * dir < 0 && Math.abs(target - pos) > 1) target = pos;
            next = abs === null ? clamp(target + dir * amt, 0, max) : (abs === 0 ? 0 : max);
        }
        if (!anim && Math.abs(next - scrollY()) < 0.5) return;

        e.preventDefault();
        maybeOfferBack(target, next);
        target = next;
        if (hit) toast(pinNav ? 'Pin ' + (pins.indexOf(hit) + 1) + ' of ' + pins.length + (hit.text ? ': ' + hit.text : '') : hit.text, 1200);
        reveal();
        go();
    }

    /* -----------------------------------------------------------------------
       SCROLLBAR INTERACTION (Pointer Events + pointer capture)
       The thumb is not part of hit-testing; the hover area is the fixed-size
       track -> no hover flicker.
    ----------------------------------------------------------------------- */
    const overThumb = (y) => y >= thumbTop && y <= thumbTop + thumbH;

    function endPress() {
        endH();
        if (dragging && Math.abs(scrollY() - dragS0) > window.innerHeight * 1.5) offerBack(dragS0);
        dragging = false; pressed = false;
        clearTimeout(repT); clearInterval(repI); repT = repI = 0;
        if (track) track.classList.remove('drag');
        hideLabel();
        if (capId !== null) { try { track.releasePointerCapture(capId); } catch (_) {} capId = null; }
        reveal();
    }

    // Windows behaviour: press the track -> scroll page by page, stop when the thumb reaches the pointer
    function pageStep(dir, first) {
        const max = scrollMax();
        if (max <= 0) return false;
        syncState();
        if (!first) {
            const tt = CFG.PAD + (target / max) * travel;
            const keep = dir > 0 ? ptrY > tt + thumbH : ptrY < tt;
            if (!keep) return false;
        }
        target = clamp(target + dir * window.innerHeight * CFG.KEY_PAGE, 0, max);
        reveal(); go();
        return true;
    }

    function onPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        endPress();
        stopAnim(); adopt();
        ptrY = e.clientY;
        try { track.setPointerCapture(e.pointerId); capId = e.pointerId; } catch (_) {}

        if (scrollMax() <= 0) return;
        const hit = overThumb(e.clientY) ? null : nearestItem(e.clientY);
        if (overThumb(e.clientY)) {
            dragging = true; dragY0 = e.clientY; dragS0 = scrollY();
            track.classList.add('drag');
        } else if (hit) {
            jumpToItem(hit);                                                    // click a marker -> glide to it
        } else {
            pressed = true;
            repDir = e.clientY < thumbTop ? -1 : 1;
            pageStep(repDir, true);
            repT = setTimeout(() => {
                repI = setInterval(() => {
                    if (!pressed) { endPress(); return; }
                    pageStep(repDir, false);
                }, CFG.REPEAT_RATE);
            }, CFG.REPEAT_DELAY);
        }
        reveal();
    }

    function onPointerMove(e) {
        ptrY = e.clientY;
        if ((dragging || pressed) && e.buttons === 0) { endPress(); return; }   // missed button release -> never stay stuck
        if (dragging) {
            const max = scrollMax();
            if (max <= 0 || travel <= 0) return;
            const y = clamp(dragS0 + ((e.clientY - dragY0) / travel) * max, 0, max);
            setScroll(y); pos = target = y;
            render();
            return;
        }
        if (!pressed) {
            const onThumb = overThumb(e.clientY);
            track.classList.toggle('hot', onThumb);
            setHover(onThumb ? null : nearestItem(e.clientY));
        }
    }

    /* -- Horizontal bar: drag + click the track to move one page width ------- */
    function setScrollX(x) {
        try { window.scrollTo({ top: window.scrollY, left: x, behavior: 'instant' }); }
        catch (_) { window.scrollTo(x, window.scrollY); }
    }
    function endH() {
        hDrag = false;
        if (hTrack) hTrack.classList.remove('drag');
        if (hCap !== null) { try { hTrack.releasePointerCapture(hCap); } catch (_) {} hCap = null; }
    }
    function onHDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        endH();
        const max = scrollMaxX();
        if (max <= 0) return;
        try { hTrack.setPointerCapture(e.pointerId); hCap = e.pointerId; } catch (_) {}
        if (e.clientX >= hLeft && e.clientX <= hLeft + hW) {
            hDrag = true; hX0 = e.clientX; hS0 = window.scrollX || 0;
            hTrack.classList.add('drag');
        } else {
            const dx = (e.clientX < hLeft ? -1 : 1) * window.innerWidth * CFG.KEY_PAGE;
            try { window.scrollBy({ left: dx, top: 0, behavior: 'smooth' }); } catch (_) { window.scrollBy(dx, 0); }
        }
        reveal();
    }
    function onHMove(e) {
        if (hDrag && e.buttons === 0) { endH(); reveal(); return; }
        if (hDrag) {
            const max = scrollMaxX();
            if (max <= 0 || hTravel <= 0) return;
            setScrollX(clamp(hS0 + ((e.clientX - hX0) / hTravel) * max, 0, max));
            renderH();
            return;
        }
        hTrack.classList.toggle('hot', e.clientX >= hLeft && e.clientX <= hLeft + hW);
    }

    /* -----------------------------------------------------------------------
       SAFETY NET - if the script breaks it never locks the page; it switches itself off (fail-open)
    ----------------------------------------------------------------------- */
    function failOpen(err) {
        if (failed) return;
        failed = true; ready = false;
        try { stopAnim(); } catch (_) {}
        try { clearInterval(hbId); mo.disconnect(); if (ro) ro.disconnect(); } catch (_) {}
        try { host.remove(); } catch (_) {}
        try { if (pageSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== pageSheet); } catch (_) {}
        try { if (gmStyleEl && gmStyleEl.remove) gmStyleEl.remove(); } catch (_) {}
        try { console.warn('[MTechno] Repeated errors: disabled on this page, native scrollbar restored.', err); } catch (_) {}
    }
    function noteError(err) { if (++errCount >= 5) failOpen(err); }
    function guard(fn) {
        return function () { try { return fn.apply(this, arguments); } catch (err) { noteError(err); } };
    }

    // If the page ships its own smooth-scroll engine (Lenis, Locomotive, fullPage...) stay out -> no double scrolling
    const LIB_CLASS = /^(lenis(-.+)?|has-scroll-(smooth|init)|locomotive.*|fp-enabled|pp-enabled|scrollsmoother.*)$/i;
    function detectLib() {
        const lists = [de.classList, document.body && document.body.classList];
        for (const l of lists) if (l) for (const c of l) if (LIB_CLASS.test(c)) return true;
        try { return !!document.querySelector('[data-scroll-container],#smooth-wrapper,[data-lenis-root]'); } catch (_) { return false; }
    }

    function status() {
        if (failed) return 'disabled after repeated errors';
        if (libSmooth) return 'page has its own smooth-scroll library, using native scrolling';
        if (performance.now() < bypassUntil) return bypassWhy + ', temporarily native scrolling';
        if (!axisScrollable('overflowY')) return 'page scrolling is locked (overflow:hidden)';
        if (rawMax() <= 0) return CFG.INNER ? 'window cannot scroll (content scrolls in an inner area), smoothing inner areas (experimental)' : 'window cannot scroll (content scrolls in an inner area), using native scrolling';
        if (snapActive()) return 'scroll-snap in use, using native scrolling';
        return 'working (' + Math.round(scrollMax()) + 'px, ' + SPEEDS[speedKey].name + (sections.length ? ', ' + sections.length + ' sections' : '') +
            (pins.length ? ', ' + pins.length + ' pins' : '') + ', ' + (liteOn ? 'lite' : 'full') + ' effects' + (CFG.INNER ? ', inner smoothing on' : '') + ')';
    }

    /* -----------------------------------------------------------------------
       INJECTION + HEALTH (guardian)
    ----------------------------------------------------------------------- */
    let pageSheet = null, gmStyled = false;
    function installPageStyle() {
        try {
            if (!pageSheet) { pageSheet = new CSSStyleSheet(); pageSheet.replaceSync(PAGE_CSS); }
            if (!document.adoptedStyleSheets.includes(pageSheet))
                document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
        } catch (_) { pageSheet = null; }
        if (!gmStyled) {                                  // fallback if adopting fails or CSP interferes
            gmStyled = true;
            try { if (typeof GM_addStyle === 'function') gmStyleEl = GM_addStyle(PAGE_CSS); } catch (_) {}
        }
    }

    const mo = new MutationObserver(() => { if (!host.isConnected) ensureAttached(true); });
    function observe() {
        try { mo.observe(document, { childList: true }); } catch (_) {}
        try { mo.observe(document.documentElement, { childList: true }); } catch (_) {}
    }

    let burst = 0, burstT = 0;
    function ensureAttached(fromMO) {
        if (failed || host.isConnected) return;
        const now = performance.now();
        if (now - burstT > 2000) { burstT = now; burst = 0; }
        if (fromMO && ++burst > 6) return;               // don't ping-pong with the site; the heartbeat retries
        const root = document.documentElement;
        if (!root) return;
        root.appendChild(host);
        observe();
        render();
    }

    let ro = null, lastHref = location.href;
    function observeSizes() {
        if (!window.ResizeObserver) return;
        if (!ro) ro = new ResizeObserver(schedRender);
        try { ro.observe(document.documentElement); } catch (_) {}
        if (document.body) { try { ro.observe(document.body); } catch (_) {} }
    }

    function heartbeat() {
        if (failed) return;
        libSmooth = detectLib();
        ensureAttached(false);
        installPageStyle();
        observeSizes();
        updateTint();
        scanSections(false);
        resumeTick();
        if (anim && performance.now() - lastFrameT > 600) { stopAnim(); adopt(); }   // stuck animation
        if (location.href !== lastHref) { lastHref = location.href; if (!anim) adopt(); loadPins(); resumeInit(); }
        render();
    }

    function registerMenus() {
        const reg = (name, fn) => { try { GM_registerMenuCommand(name, fn); } catch (_) {} };
        Object.keys(SPEEDS).forEach((k) => {
            reg('Scrolling speed: ' + SPEEDS[k].name, () => { applySpeed(k); savePref('speed', k); toast('Scrolling speed: ' + SPEEDS[k].name); });
        });
        reg('Section markers: toggle on/off', () => {
            CFG.SECTIONS = !CFG.SECTIONS;
            savePref('sections', CFG.SECTIONS);
            if (CFG.SECTIONS) scanSections(true); else { setHover(null); sections = []; }
            ticksDirty = true; render();
            toast(CFG.SECTIONS ? 'Section markers: on' : 'Section markers: off');
        });
        reg('Selection markers: toggle on/off', () => {
            CFG.SELMARKS = !CFG.SELMARKS;
            savePref('selmarks', CFG.SELMARKS);
            if (CFG.SELMARKS) scanSelection(); else { clearSel(); ticksDirty = true; render(); }
            toast(CFG.SELMARKS ? 'Selection markers: on' : 'Selection markers: off');
        });
        reg('Resume chip: toggle on/off', () => {
            CFG.RESUME = !CFG.RESUME;
            savePref('resume_on', CFG.RESUME);
            if (CFG.RESUME) resumeInit(); else hideResume(false);
            toast(CFG.RESUME ? 'Resume chip: on' : 'Resume chip: off');
        });
        reg('Saved data: clear reading positions and pins', () => {
            saveMap('resume', {}); saveMap('pins', {});
            pins = []; ticksDirty = true; render();
            hideResume(false);
            toast('Cleared saved reading positions and pins');
        });
        reg('Visual effects: cycle auto / lite / full', () => {
            perfMode = perfMode === 'auto' ? 'lite' : perfMode === 'lite' ? 'full' : 'auto';
            savePref('perf', perfMode);
            fN = 0; fSlow = 0;
            setLite(perfMode === 'lite');
            toast('Visual effects: ' + (perfMode === 'auto' ? 'Auto (lite if slow)' : perfMode === 'lite' ? 'Lite' : 'Full'));
        });
        reg('Experimental: smooth inner scroll areas, toggle on/off', () => {
            CFG.INNER = !CFG.INNER;
            savePref('inner', CFG.INNER);
            if (!CFG.INNER) innerStop();
            toast(CFG.INNER ? 'Experimental inner smoothing: on' : 'Experimental inner smoothing: off');
        });
        reg('Keyboard shortcuts: show', showHelp);
        reg('Scrollbar: toggle always visible / auto-hide', () => {
            CFG.ALWAYS_VISIBLE = !CFG.ALWAYS_VISIBLE;
            savePref('always', CFG.ALWAYS_VISIBLE);
            if (!CFG.ALWAYS_VISIBLE) { track.classList.remove('show'); if (hTrack) hTrack.classList.remove('show'); }
            reveal(); render();
            toast(CFG.ALWAYS_VISIBLE ? 'Scrollbar: always visible' : 'Scrollbar: auto-hide');
        });
        reg('Diagnostics: show status of this page', () => {
            const msg = 'MTechno: ' + status();
            try { console.info('[MTechno] ' + msg); } catch (_) {}
            toast(msg, 4500);
        });
    }

    /* -----------------------------------------------------------------------
       INIT (runs synchronously at document-start)
    ----------------------------------------------------------------------- */
    function init() {
        installPageStyle();

        host = document.createElement('div');
        host.id = 'mtechno-sb-host';
        host.setAttribute('aria-hidden', 'true');
        const root = host.attachShadow({ mode: 'closed' });
        setLite(perfMode === 'lite');

        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(SHADOW_CSS);
            root.adoptedStyleSheets = [sheet];
        } catch (_) {
            const st = document.createElement('style');
            st.textContent = SHADOW_CSS;
            root.appendChild(st);
        }

        track = document.createElement('div'); track.id = 't'; track.className = 't';
        thumb = document.createElement('div'); thumb.id = 'b'; thumb.className = 'b';
        track.appendChild(thumb);
        hTrack = document.createElement('div'); hTrack.id = 'h'; hTrack.className = 't off';
        hThumb = document.createElement('div'); hThumb.id = 'hb'; hThumb.className = 'b';
        hTrack.appendChild(hThumb);
        label = document.createElement('div'); label.id = 'p';
        labelMain = document.createElement('span'); labelMain.className = 'm';
        labelSub = document.createElement('span'); labelSub.className = 's';
        label.appendChild(labelMain); label.appendChild(labelSub);
        chip = document.createElement('div'); chip.id = 'r';
        chip.textContent = 'Back to previous position';
        chip.setAttribute('role', 'button');
        chip.addEventListener('mousedown', (e) => e.preventDefault());        // don't steal focus/selection
        chip.addEventListener('click', guard(() => {
            if (backY === null) return;
            const y = backY;
            hideBack();
            jumpTo(y, true);                                                   // returning must not offer another "back"
        }));
        root.appendChild(track);
        root.appendChild(hTrack);
        root.appendChild(label);
        root.appendChild(chip);
        chipQ = document.createElement('div'); chipQ.id = 'q'; chipQ.setAttribute('role', 'button');
        const qMain = document.createElement('span'); qMain.className = 'm'; qMain.textContent = 'Resume where you left off';
        qSub = document.createElement('span'); qSub.className = 's';
        qX = document.createElement('span'); qX.className = 'x'; qX.setAttribute('aria-label', 'Dismiss');
        chipQ.appendChild(qMain); chipQ.appendChild(qSub); chipQ.appendChild(qX);
        chipQ.addEventListener('mousedown', (e) => e.preventDefault());       // don't steal focus/selection
        chipQ.addEventListener('click', guard((ev) => {
            if (!rsEntry) return;
            if (qX.contains(ev.target)) { hideResume(true); return; }          // the x = dismiss and forget this page
            const y = rsEntry.y;
            hideResume(false);
            jumpTo(y);                                                         // offers a "back" chip to return to the top
        }));
        root.appendChild(chipQ);
        buildHelp(root);

        track.addEventListener('pointerdown', guard(onPointerDown));
        track.addEventListener('pointermove', guard(onPointerMove));
        track.addEventListener('pointerleave', () => { track.classList.remove('hot'); setHover(null); });
        track.addEventListener('mousedown', (e) => e.preventDefault());     // don't steal selection/focus
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => track.addEventListener(t, endPress));
        hTrack.addEventListener('pointerdown', guard(onHDown));
        hTrack.addEventListener('pointermove', guard(onHMove));
        hTrack.addEventListener('pointerleave', () => hTrack.classList.remove('hot'));
        hTrack.addEventListener('mousedown', (e) => e.preventDefault());
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => hTrack.addEventListener(t, () => { endH(); reveal(); }));
        window.addEventListener('blur', endPress);
        document.addEventListener('pointerdown', () => { if (help && help.classList.contains('on')) hideHelp(); }, true);

        // Wheel: capture + non-passive -> runs before any site listener
        window.addEventListener('wheel', guard(onWheel), { passive: false, capture: true });
        window.addEventListener('keydown', guard(onKey));
        window.addEventListener('scroll', () => {
            reveal(); schedRender();
            if (CFG.RESUME) schedSave();
            if (rsState === 'shown' && scrollY() > window.innerHeight * 0.35) hideResume(false);   // you chose to read from the top
        }, { passive: true });
        window.addEventListener('pagehide', () => saveResume(true));
        window.addEventListener('resize', schedRender);
        document.addEventListener('selectionchange', onSelChange);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { stopAnim(); adopt(); endPress(); saveResume(true); }
        });

        adopt();
        ready = true;
        loadPins();
        ensureAttached(false);
        observe();

        resumeInit();
        registerMenus();

        const afterLoad = () => {
            ensureAttached(false); installPageStyle(); observeSizes(); updateTint(); scanSections(true); render();
            setTimeout(() => { if (scrollMax() > 0) reveal(); }, 400);       // brief "I'm active" flash
        };
        document.addEventListener('DOMContentLoaded', afterLoad, { once: true });
        window.addEventListener('load', afterLoad, { once: true });

        hbId = setInterval(guard(heartbeat), 1000);
        render();
    }

    init();
})();
