(function () {
  "use strict";

  /**
   * Min-change QR generator with structure-aware search + mobile-safe render.
   *
   * Encoding: https://het68.cz/?qr=<epoch>.<pad>
   * Render: canvas -> SVG -> PNG data URL (fallback chain)
   * Search: pad-suffix mutations (end of QR data bitstream), mask search,
   *         dual-direction ECC-basin stabilize with reserved-aware ordering.
   */

  var IS_MOBILE = (function () {
    try {
      return /Android|iPhone|iPad|iPod|Mobile|IEMobile/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
    } catch (e) {
      return false;
    }
  })();

  // Grid profile. The dominant lever for minimal change is the Reed-Solomon
  // budget: the stabilizer may keep prev's modules in up to floor(EC/2)
  // codewords per block, so more EC codewords = fewer flips. The pad auto-fills
  // to capacity (see computePadLen), so payload never overflows — the only cost
  // of higher EC/version is module density, offset by a larger DRAW_SIZE.
  //
  // Default masking is the "snow" glitch overlay, which inks black modules over
  // the code. Those overlaid cells are errors the reader must correct, so the
  // symbol needs Reed-Solomon headroom to stay scannable in EVERY frame — hence
  // ECC "H" (v3+H does not fit the payload, so v4 is the smallest ECC-H option).
  // Snow only inks NON-reserved data modules (see mask-arcade), which keeps
  // decoding at ~100%. The snow flicker also camouflages the per-second change,
  // so it "looks like the code is just faultily rendering".
  var VERSION = 4;
  var ECC = "H";
  var MARGIN = 2;
  var DRAW_SIZE = IS_MOBILE ? 260 : 300;
  var DECODE_SCALE = 4;
  /** Candidate profiles for the boot-time flip measurement (tuning aid only). */
  var GRID_PROFILES = [
    { version: 4, ecc: "H" },
    { version: 5, ecc: "Q" },
    { version: 6, ecc: "M" },
    { version: 2, ecc: "L" }
  ];
  var STABILIZE_BUDGET_MS = IS_MOBILE ? 350 : 500;
  var PREFETCH_BUDGET_MS = IS_MOBILE ? 550 : 800;
  var PAD_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  var SCRIPT_CANDIDATES = [
    { id: "local-qrcode", src: "vendor/qrcode.min.js", type: "classic" },
    { id: "local-qrcodejs", src: "vendor/qrcodejs.min.js", type: "qrcodejs" },
    { id: "cdn-jsdelivr-esm", src: "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm", type: "esm" },
    { id: "cdn-esm-sh", src: "https://esm.sh/qrcode@1.5.4", type: "esm" },
    { id: "cdn-qrcodejs-cdnjs", src: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js", type: "qrcodejs" },
    { id: "cdn-qrcodejs-jsdelivr", src: "https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@gh-pages/qrcode.min.js", type: "qrcodejs" }
  ];

  var DECODER_CANDIDATES = [
    { id: "local-jsqr", src: "vendor/jsQR.js" },
    { id: "cdn-jsqr", src: "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js" }
  ];

  var codec = window.Het68Codec;
  if (!codec) {
    throw new Error("Het68Codec missing — load js/codec.js first");
  }

  var qrHost = document.getElementById("qr");
  var urlEl = document.getElementById("url");
  var debugEl = document.getElementById("debug");
  var statusEl = document.getElementById("debug-status");
  var logEl = document.getElementById("d-log");

  var state = {
    api: null,
    engineId: null,
    source: null,
    decoder: null,
    decoderSource: null,
    padLen: 0,
    pad: "",
    mask: 0,
    prevModules: null,
    renders: 0,
    lastUrl: "",
    lastEpoch: "",
    lastSlot: "",
    lastError: null,
    busy: false,
    timer: null,
    simpleRenderer: null,
    prefetch: null,
    renderMode: "none",
    paintEl: null,
    changesPerSec: 1,
    maskBalls: null,
    maskFx: null,
    maskMethod: "snow3",
    genGoal: "min",
    forecastSteps: 6,
    lookupSteps: 6,
    noiseAmount: 0.5,
    changeAmount: 0.7,
    fadeMs: 0, // 0 = auto from slot interval
    recSeconds: 5,
    futureDiffs: [],
    gentleMode: false,
    gentleCells: [],
    _gentleAt: 0,
    pendingDiffs: null,
    forecastHorizon: 8,
    lastPlanSnap: null,
    fpsSamples: [],
    fpsLastPaint: 0,
    recording: null,
    _urlSyncReady: false
  };

  var FPS_WINDOW = 60;
  var MASK_URL_OPTIONS = [
    "snow1", "snow2", "snow3", "snow4", "snow5", "snow6", "snow7", "snow8",
    "chg", "chg1", "chg2", "chg3", "chg4", "chg5", "chg6", "chgmin", "none",
    "fade", "morph", "balls", "crossfade", "shimmer", "softpatch",
    "snake", "tetris", "life", "snow"
  ];

  function clampInt(v, lo, hi, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function getLookupSteps() {
    var n = parseInt(state.lookupSteps, 10);
    if (!isFinite(n) || n < 1) return 1;
    if (n > 30) return 30;
    return n;
  }

  function getNoiseAmount() {
    var a = state.noiseAmount;
    if (!isFinite(a)) return 0.5;
    if (a < 0) return 0;
    if (a > 1) return 1;
    return a;
  }

  /** Fraction (0..1) of next-iteration change cells randomly used in the mask. */
  function getChangeAmount() {
    var a = state.changeAmount;
    if (!isFinite(a)) return 0.7;
    if (a < 0) return 0;
    if (a > 1) return 1;
    return a;
  }

  function getRecSeconds() {
    var n = parseInt(state.recSeconds, 10);
    if (!isFinite(n) || n < 1) return 1;
    if (n > 120) return 120;
    return n;
  }

  /** Morph duration for fade mask. 0 in state → auto (~75% of slot, 80–900 ms). */
  function getFadeMs() {
    var n = parseInt(state.fadeMs, 10);
    if (isFinite(n) && n > 0) {
      if (n < 40) return 40;
      if (n > 2000) return 2000;
      return n;
    }
    return Math.max(80, Math.min(900, Math.round(getStepMs() * 0.75)));
  }

  function isFadeMask(method) {
    method = method || state.maskMethod;
    return method === "fade" || method === "morph" || method === "crossfade";
  }

  /** Read settings from the page URL (?rate=&lookup=&noise=&mask=&rec=&debug=). */
  function readUrlSettings() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return {}; }
    function first(keys) {
      for (var i = 0; i < keys.length; i++) {
        if (q.has(keys[i])) return q.get(keys[i]);
      }
      return null;
    }
    var out = {};
    var rate = first(["rate", "cps", "changes"]);
    if (rate != null) out.rate = clampInt(rate, 1, 1000, 1);
    var lookup = first(["lookup", "forecast", "steps"]);
    if (lookup != null) out.lookup = clampInt(lookup, 1, 30, 6);
    var noise = first(["noise"]);
    if (noise != null) out.noise = clampInt(noise, 0, 100, 50);
    var preview = first(["preview", "chgPct", "changepct", "next"]);
    if (preview != null) out.preview = clampInt(preview, 0, 100, 70);
    var goal = first(["goal", "objective"]);
    if (goal != null) {
      goal = String(goal).trim().toLowerCase();
      if (goal === "balance" || goal === "bw" || goal === "density") out.goal = "balance";
      else if (goal === "min" || goal === "minchange" || goal === "flips") out.goal = "min";
    }
    var mask = first(["mask", "method"]);
    if (mask != null) {
      mask = String(mask).trim().toLowerCase();
      if (mask === "morph" || mask === "crossfade") mask = "fade";
      if (MASK_URL_OPTIONS.indexOf(mask) >= 0) out.mask = mask;
    }
    // Optional: morph=1 enables the fade variant without setting mask= explicitly.
    var morph = first(["morph", "fade"]);
    if (morph != null && out.mask == null) {
      var mv = String(morph).toLowerCase();
      if (mv === "1" || mv === "true" || mv === "yes" || mv === "on") out.mask = "fade";
      else if (mv === "0" || mv === "false" || mv === "off") { /* ignore */ }
      else if (/^\d+$/.test(mv)) {
        // morph=300 means enable fade with 300 ms duration
        out.mask = "fade";
        out.fadeMs = clampInt(mv, 0, 2000, 0);
      }
    }
    var fadeMs = first(["fadeMs", "fadems", "morphMs", "morphms"]);
    if (fadeMs != null) out.fadeMs = clampInt(fadeMs, 0, 2000, 0);
    var rec = first(["rec", "duration", "record"]);
    if (rec != null) out.rec = clampInt(rec, 1, 120, 5);
    var dbg = first(["debug"]);
    if (dbg != null) {
      dbg = String(dbg).toLowerCase();
      out.debug = dbg === "1" || dbg === "true" || dbg === "yes" || dbg === "open";
    }
    return out;
  }

  function buildSettingsQuery() {
    var q = new URLSearchParams();
    q.set("rate", String(getRate()));
    q.set("lookup", String(getLookupSteps()));
    q.set("noise", String(Math.round(getNoiseAmount() * 100)));
    q.set("preview", String(Math.round(getChangeAmount() * 100)));
    q.set("goal", isBalanceGoal() ? "balance" : "min");
    q.set("mask", state.maskMethod || "snow3");
    if (isFadeMask() || (state.fadeMs | 0) > 0) {
      q.set("fadeMs", String(state.fadeMs | 0));
    }
    q.set("rec", String(getRecSeconds()));
    if (debugEl && debugEl.classList.contains("open")) q.set("debug", "1");
    return q;
  }

  function settingsUrlString() {
    try {
      var u = new URL(location.href);
      u.search = buildSettingsQuery().toString();
      return u.toString();
    } catch (e) {
      return "?" + buildSettingsQuery().toString();
    }
  }

  /** Push current controls into the address bar (shareable, no reload). */
  function syncSettingsUrl() {
    if (!state._urlSyncReady) return;
    try {
      var u = new URL(location.href);
      var next = buildSettingsQuery().toString();
      if (u.search.replace(/^\?/, "") === next) {
        setMeta("d-settings", u.pathname + (next ? "?" + next : ""));
        return;
      }
      u.search = next;
      history.replaceState(null, "", u.toString());
      setMeta("d-settings", u.pathname + (next ? "?" + next : ""));
    } catch (e) {
      // ignore (file:// / restricted)
    }
  }

  function pickRecorderMime() {
    var types = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4;codecs=avc1",
      "video/mp4"
    ];
    if (typeof MediaRecorder === "undefined") return "";
    for (var i = 0; i < types.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
      } catch (e) { /* ignore */ }
    }
    return "";
  }

  /** Draw QR modules into a canvas context (export path — independent of DOM paint mode). */
  function drawModulesToCtx(ctx, modules, x, y, sidePx) {
    var size = moduleSize(modules);
    var n = size + MARGIN * 2;
    var cell = sidePx / n;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, sidePx, sidePx);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!moduleGet(modules, r, c)) continue;
        ctx.fillRect(
          x + (c + MARGIN) * cell,
          y + (r + MARGIN) * cell,
          Math.ceil(cell),
          Math.ceil(cell)
        );
      }
    }
  }

  function drawOverlayCrop(ctx, el, area, scale) {
    if (!el || el.width < 1 || el.height < 1) return;
    if (el.style && el.style.display === "none") return;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    var left = Math.max(area.left, r.left);
    var top = Math.max(area.top, r.top);
    var right = Math.min(area.right, r.right);
    var bottom = Math.min(area.bottom, r.bottom);
    if (right <= left || bottom <= top) return;
    var sx = (left - r.left) * (el.width / r.width);
    var sy = (top - r.top) * (el.height / r.height);
    var sw = (right - left) * (el.width / r.width);
    var sh = (bottom - top) * (el.height / r.height);
    var dx = (left - area.left) * scale;
    var dy = (top - area.top) * scale;
    var dw = (right - left) * scale;
    var dh = (bottom - top) * scale;
    try {
      ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh);
    } catch (e) { /* tainted / not ready */ }
  }

  /** Composite the on-screen QR host (+ mask overlays) into `canvas` for recording. */
  function composeExportFrame(canvas) {
    var area = qrHost.getBoundingClientRect();
    if (!area.width || !area.height) return false;
    var scale = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(2, Math.round(area.width * scale));
    var h = Math.max(2, Math.round(area.height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    var paint = state.paintEl;
    var pr = paint ? paint.getBoundingClientRect() : null;
    if (state.prevModules && pr && pr.width > 0) {
      var side = Math.min(pr.width, pr.height) * scale;
      var dx = (pr.left - area.left) * scale;
      var dy = (pr.top - area.top) * scale;
      drawModulesToCtx(ctx, state.prevModules, dx, dy, side);
    } else if (paint) {
      var tag = (paint.tagName || "").toLowerCase();
      if ((tag === "canvas" || tag === "img") && pr) {
        try {
          ctx.drawImage(
            paint,
            (pr.left - area.left) * scale,
            (pr.top - area.top) * scale,
            pr.width * scale,
            pr.height * scale
          );
        } catch (e) { /* ignore */ }
      }
    }

    drawOverlayCrop(ctx, document.getElementById("mask-arcade-canvas"), area, scale);
    drawOverlayCrop(ctx, document.getElementById("mask-fx-canvas"), area, scale);
    drawOverlayCrop(ctx, document.getElementById("ball-canvas-cmyk"), area, scale);
    drawOverlayCrop(ctx, document.getElementById("ball-canvas-rgb"), area, scale);
    return true;
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement("a");
    var href = URL.createObjectURL(blob);
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  }

  function stopVideoExport() {
    var rec = state.recording;
    if (!rec) return;
    state.recording = null;
    if (rec.raf) cancelAnimationFrame(rec.raf);
    if (rec.timer) clearInterval(rec.timer);
    try {
      if (rec.media && rec.media.state !== "inactive") rec.media.stop();
    } catch (e) { /* ignore */ }
    var btn = document.getElementById("btn-record");
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("recording");
      btn.textContent = "Export videa";
    }
    setMeta("d-rec", getRecSeconds() + " s");
  }

  function startVideoExport() {
    if (state.recording) return;
    if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined") {
      fail(new Error("MediaRecorder není v tomto prohlížeči k dispozici"), "video");
      return;
    }
    if (!state.prevModules && !state.paintEl) {
      fail(new Error("QR ještě není vykreslené"), "video");
      return;
    }
    var mime = pickRecorderMime();
    var canvas = document.createElement("canvas");
    if (!composeExportFrame(canvas)) {
      fail(new Error("Nelze zachytit QR oblast"), "video");
      return;
    }
    var fps = 30;
    var stream;
    try {
      stream = canvas.captureStream(fps);
    } catch (e) {
      fail(e, "video.captureStream");
      return;
    }
    var opts = mime ? { mimeType: mime, videoBitsPerSecond: 4e6 } : { videoBitsPerSecond: 4e6 };
    var media;
    try {
      media = new MediaRecorder(stream, opts);
    } catch (e1) {
      try {
        media = new MediaRecorder(stream);
        mime = media.mimeType || "";
      } catch (e2) {
        fail(e2, "video.MediaRecorder");
        return;
      }
    }

    var chunks = [];
    var durationMs = getRecSeconds() * 1000;
    var startedAt = performance.now();
    var btn = document.getElementById("btn-record");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("recording");
    }

    var session = {
      canvas: canvas,
      stream: stream,
      media: media,
      chunks: chunks,
      raf: 0,
      timer: 0,
      mime: mime || media.mimeType || "video/webm"
    };
    state.recording = session;

    media.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    media.onerror = function (ev) {
      fail((ev && ev.error) || new Error("MediaRecorder error"), "video");
      stopVideoExport();
    };
    media.onstop = function () {
      var ext = (session.mime.indexOf("mp4") >= 0) ? "mp4" : "webm";
      var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      var name = "het68-qr-" + stamp + "-r" + getRate() + "-" + (state.maskMethod || "mask") + "." + ext;
      var blob = new Blob(chunks, { type: session.mime || "video/webm" });
      downloadBlob(blob, name);
      log("Video export saved", { bytes: blob.size, mime: session.mime, seconds: getRecSeconds(), file: name });
      // tracks stop
      try {
        stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { /* ignore */ }
      if (state.recording === session) state.recording = null;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("recording");
        btn.textContent = "Export videa";
      }
      setMeta("d-rec", getRecSeconds() + " s");
    };

    function tickFrame() {
      if (state.recording !== session) return;
      composeExportFrame(canvas);
      // Some browsers need requestFrame on the capture track for canvas streams.
      var tracks = stream.getVideoTracks();
      if (tracks[0] && typeof tracks[0].requestFrame === "function") {
        try { tracks[0].requestFrame(); } catch (e) { /* ignore */ }
      }
      var left = Math.max(0, durationMs - (performance.now() - startedAt));
      if (btn) btn.textContent = "Nahrávám " + Math.ceil(left / 1000) + "s";
      setMeta("d-rec", "REC " + (left / 1000).toFixed(1) + "s");
      if (left <= 0) {
        try { if (media.state !== "inactive") media.stop(); } catch (e) { /* ignore */ }
        return;
      }
      session.raf = requestAnimationFrame(tickFrame);
    }

    try {
      media.start(200);
    } catch (e) {
      fail(e, "video.start");
      stopVideoExport();
      return;
    }
    log("Video export start", { seconds: getRecSeconds(), mime: session.mime, fps: fps });
    session.raf = requestAnimationFrame(tickFrame);
  }

  /** Record QR paint timing → rolling min / avg / max FPS in debug. */
  function notePaintFps() {
    var t = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();
    if (state.fpsLastPaint > 0) {
      var dt = t - state.fpsLastPaint;
      // Ignore huge gaps (tab hidden / first frames after pause).
      if (dt > 2 && dt < 8000) {
        state.fpsSamples.push(1000 / dt);
        if (state.fpsSamples.length > FPS_WINDOW) state.fpsSamples.shift();
        var s = state.fpsSamples;
        var min = s[0], max = s[0], sum = 0;
        for (var i = 0; i < s.length; i++) {
          if (s[i] < min) min = s[i];
          if (s[i] > max) max = s[i];
          sum += s[i];
        }
        var avg = sum / s.length;
        setMeta(
          "d-fps",
          min.toFixed(1) + " / " + avg.toFixed(1) + " / " + max.toFixed(1) +
            " (n=" + s.length + ")"
        );
      }
    }
    state.fpsLastPaint = t;
  }

  // Updates per second (1..1000). >1 means the QR re-scrambles multiple times per
  // second: the numeric epoch stays in whole seconds (so a scanner reads the right
  // time), while a per-slot token in the pad forces a fresh minimal-change frame.
  function getRate() {
    var n = parseInt(state.changesPerSec, 10);
    if (!isFinite(n) || n < 1) return 1;
    if (n > 1000) return 1000;
    return n;
  }

  /** Milliseconds per update slot. */
  function getStepMs() {
    return 1000 / getRate();
  }

  function currentSlot() {
    return Math.floor(Date.now() / getStepMs());
  }

  function slotChangeAtMs(slot) {
    return slot * getStepMs();
  }

  /** Receiver-facing epoch (whole unix seconds) for a slot. */
  function epochForSlot(slot) {
    return Math.floor(slotChangeAtMs(slot) / 1000);
  }

  /** Deterministic pad for a slot so consecutive frames differ (forces a change)
   *  even within the same second; low-order chars vary fastest for minimal churn. */
  function padForSlot(slot) {
    var P = state.padLen | 0;
    if (P <= 0) return "";
    var tok = (slot >>> 0).toString(36).toUpperCase();
    if (tok.length > P) return tok.slice(-P);
    return new Array(P - tok.length + 1).join("0") + tok;
  }

  function estimateCssPx(flips, modules) {
    var size = moduleSize(modules);
    var n = size + MARGIN * 2;
    var host = qrHost.getBoundingClientRect();
    var side = Math.max(host.width, 1);
    var pxPer = side / n;
    return Math.round(flips * pxPer * pxPer);
  }

  function getQrContentRect() {
    var el = state.paintEl || qrHost.querySelector("canvas,svg,img");
    if (!el) return null;
    return el.getBoundingClientRect();
  }

  /** QR geometry for module-aligned overlays (arcade masking draws inside this grid). */
  function getQrInfo() {
    var rect = getQrContentRect();
    if (!rect) return null;
    var size = state.prevModules ? moduleSize(state.prevModules) : (17 + 4 * VERSION);
    var mods = state.prevModules;
    return {
      rect: rect,
      size: size,
      margin: MARGIN,
      ecc: ECC,
      reserved: mods ? function (r, c) { return moduleReserved(mods, r, c); } : null
    };
  }

  function now() {
    return new Date().toISOString().slice(11, 23);
  }

  function setStatus(kind, text) {
    statusEl.className = "status-pill " + kind;
    statusEl.textContent = text;
  }

  function setMeta(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function log(msg, detail) {
    var line = "[" + now() + "] " + msg;
    if (typeof detail !== "undefined") {
      try {
        line += " " + (typeof detail === "string" ? detail : JSON.stringify(detail));
      } catch (e) {
        line += " " + String(detail);
      }
    }
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
    if (window.console && console.log) console.log(line);
  }

  function fail(err, context) {
    var message = err && err.message ? err.message : String(err);
    state.lastError = (context ? context + ": " : "") + message;
    setMeta("d-error", state.lastError);
    setStatus("err", "error");
    log("ERROR", state.lastError);
  }

  function resolveAsset(src) {
    try {
      return new URL(src, document.baseURI || location.href).href;
    } catch (e) {
      return src;
    }
  }

  function loadScript(src) {
    var href = resolveAsset(src);
    return new Promise(function (resolve, reject) {
      // Reuse if already present (sync <script> tags in index.html)
      var existing = document.querySelector('script[src="' + src + '"], script[src="' + href + '"]');
      if (existing && existing.dataset && existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      var s = document.createElement("script");
      s.src = href;
      s.async = true;
      s.onload = function () {
        s.dataset.loaded = "1";
        resolve();
      };
      s.onerror = function () { reject(new Error("Script load failed: " + href)); };
      document.head.appendChild(s);
    });
  }

  function yieldToBrowser() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function clearQrHost() {
    while (qrHost.firstChild) qrHost.removeChild(qrHost.firstChild);
    state.paintEl = null;
  }

  function showPlaceholder(text) {
    clearQrHost();
    var div = document.createElement("div");
    div.className = "placeholder";
    div.textContent = text;
    qrHost.appendChild(div);
  }

  function moduleSize(modules) {
    return modules.size || Math.sqrt(modules.data.length);
  }

  function moduleGet(modules, row, col) {
    if (typeof modules.get === "function") return modules.get(row, col);
    return modules.data[row * moduleSize(modules) + col];
  }

  function moduleReserved(modules, row, col) {
    if (typeof modules.isReserved === "function") return !!modules.isReserved(row, col);
    if (modules.reservedBit) {
      return !!modules.reservedBit[row * moduleSize(modules) + col];
    }
    return false;
  }

  function copyModules(src) {
    var size = moduleSize(src);
    var data = src.data
      ? Uint8Array.from(src.data)
      : (function () {
          var out = new Uint8Array(size * size);
          for (var r = 0; r < size; r++) {
            for (var c = 0; c < size; c++) out[r * size + c] = moduleGet(src, r, c) ? 1 : 0;
          }
          return out;
        })();
    var reservedBit = src.reservedBit ? Uint8Array.from(src.reservedBit) : null;
    return {
      size: size,
      data: data,
      reservedBit: reservedBit,
      get: function (row, col) { return this.data[row * this.size + col]; },
      set: function (row, col, value) { this.data[row * this.size + col] = value ? 1 : 0; },
      isReserved: function (row, col) {
        return this.reservedBit ? !!this.reservedBit[row * this.size + col] : false;
      }
    };
  }

  function listDiffs(a, b) {
    var size = moduleSize(a);
    var diffs = [];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!!moduleGet(a, r, c) !== !!moduleGet(b, r, c)) diffs.push([r, c]);
      }
    }
    return diffs;
  }

  function hamming(a, b) {
    return listDiffs(a, b).length;
  }

  /** Generation objective: "min" (fewest flips) or "balance" (regional B/W). */
  function isBalanceGoal() {
    return state.genGoal === "balance";
  }

  /**
   * Per-tile black fraction over NON-reserved data modules.
   * Used by the "balance" goal to keep every region near 50/50 and to
   * minimize proportional density drift between consecutive frames.
   */
  var BALANCE_TILES = 3;

  function regionalDensity(modules, tiles) {
    tiles = tiles || BALANCE_TILES;
    var size = moduleSize(modules);
    var n = tiles * tiles;
    var black = new Float64Array(n);
    var total = new Float64Array(n);
    var cell = size / tiles;
    var r, c, tr, tc, idx;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (moduleReserved(modules, r, c)) continue;
        tr = Math.min(tiles - 1, (r / cell) | 0);
        tc = Math.min(tiles - 1, (c / cell) | 0);
        idx = tr * tiles + tc;
        total[idx] += 1;
        if (moduleGet(modules, r, c)) black[idx] += 1;
      }
    }
    var fracs = new Float64Array(n);
    for (idx = 0; idx < n; idx++) {
      fracs[idx] = total[idx] > 0 ? black[idx] / total[idx] : 0.5;
    }
    return { fracs: fracs, n: n };
  }

  /** Lower is better. evenness→0.5, spread→uniform across tiles, change→small Δ. */
  function scoreRegionalBalance(modules, prevModules) {
    var cur = regionalDensity(modules, BALANCE_TILES);
    var evenness = 0;
    var spread = 0;
    var change = 0;
    var mean = 0;
    var i, f;
    for (i = 0; i < cur.n; i++) mean += cur.fracs[i];
    mean /= Math.max(1, cur.n);
    for (i = 0; i < cur.n; i++) {
      f = cur.fracs[i];
      evenness += Math.abs(f - 0.5);
      spread += Math.abs(f - mean);
    }
    if (prevModules) {
      var prev = regionalDensity(prevModules, BALANCE_TILES);
      for (i = 0; i < cur.n; i++) {
        var pf = prev.fracs[i];
        var df = Math.abs(cur.fracs[i] - pf);
        // Proportional to how filled the previous region was (and its complement).
        var denom = Math.max(0.08, Math.min(pf, 1 - pf) * 2 + 0.08);
        change += df / denom;
      }
    }
    evenness /= Math.max(1, cur.n);
    spread /= Math.max(1, cur.n);
    change /= Math.max(1, cur.n);
    return {
      evenness: evenness,
      spread: spread,
      change: change,
      total: evenness * 1.0 + spread * 0.85 + change * 1.4
    };
  }

  /** Compare two search candidates. Returns true if `a` should replace `best`. */
  function isBetterSearch(raw, balTotal, bestRaw, bestBal) {
    if (bestRaw == null) return true;
    if (isBalanceGoal()) {
      if (balTotal < bestBal - 1e-9) return true;
      if (Math.abs(balTotal - bestBal) <= 1e-9 && raw < bestRaw) return true;
      return false;
    }
    if (raw < bestRaw) return true;
    if (raw === bestRaw && balTotal < bestBal - 1e-9) return true;
    return false;
  }

  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Structure-aware ordering: QR data is placed in a bottom-right zigzag.
   * Prefer trying diffs in that region first (often tied to trailing pad bytes).
   */
  function structureSortDiffs(diffs, size) {
    return diffs.slice().sort(function (a, b) {
      var scoreA = a[0] + a[1] * 3 + (a[0] > size / 2 ? 0 : 40);
      var scoreB = b[0] + b[1] * 3 + (b[0] > size / 2 ? 0 : 40);
      return scoreB - scoreA;
    });
  }

  function buildUrl(epoch, pad) {
    return codec.encodePayload(epoch, pad);
  }

  /** Mutate trailing pad chars (end of QR data codewords / padding bitstream). */
  function mutatePadSuffix(basePad, len) {
    if (!basePad || basePad.length !== len) {
      return Array(len + 1).join("0").slice(0, len);
    }
    var chars = basePad.split("");
    var tail = Math.max(8, Math.min(64, (len / 8) | 0));
    var changes = 1 + ((Math.random() * 4) | 0);
    for (var i = 0; i < changes; i++) {
      var idx = len - 1 - ((Math.random() * tail) | 0);
      chars[idx] = PAD_ALPHABET[(Math.random() * PAD_ALPHABET.length) | 0];
    }
    return chars.join("");
  }

  function computePadLen(api, version, ecc) {
    version = version || VERSION;
    ecc = ecc || ECC;
    var probe = String(Math.floor(Date.now() / 1000)) + ".";
    var prefix = codec.BASE + probe;
    var lo = 0;
    var hi = 8000;
    var best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      try {
        var q = api.create(prefix + Array(mid + 1).join("A"), {
          version: version,
          errorCorrectionLevel: ecc
        });
        if (q.version !== version) hi = mid - 1;
        else {
          best = mid;
          lo = mid + 1;
        }
      } catch (e) {
        hi = mid - 1;
      }
    }
    return best;
  }

  function createModules(api, text, maskPattern, version, ecc) {
    return api.create(text, {
      version: version || VERSION,
      errorCorrectionLevel: ecc || ECC,
      maskPattern: maskPattern
    }).modules;
  }

  function createImageDataSafe(width, height) {
    try {
      if (typeof ImageData === "function") {
        return new ImageData(width, height);
      }
    } catch (e) { /* older WebKit */ }
    var c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c.getContext("2d").createImageData(width, height);
  }

  function paintToImageData(modules, scale, margin) {
    var size = moduleSize(modules);
    var n = size + margin * 2;
    var px = n * scale;
    var img = createImageDataSafe(px, px);
    var data = img.data;
    var i;
    for (i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!moduleGet(modules, r, c)) continue;
        for (var dy = 0; dy < scale; dy++) {
          for (var dx = 0; dx < scale; dx++) {
            var idx = (((r + margin) * scale + dy) * px + ((c + margin) * scale + dx)) * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
          }
        }
      }
    }
    return img;
  }

  function decodeModules(modules) {
    if (!state.decoder) return null;
    try {
      var img = paintToImageData(modules, DECODE_SCALE, MARGIN);
      var result = state.decoder(img.data, img.width, img.height, {
        inversionAttempts: "dontInvert"
      });
      return result && result.data ? result.data : null;
    } catch (e) {
      return null;
    }
  }

  function modulesToSvgMarkup(modules, margin) {
    var size = moduleSize(modules);
    var n = size + margin * 2;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n + '" shape-rendering="crispEdges" width="100%" height="100%">');
    parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!moduleGet(modules, r, c)) continue;
        parts.push('<rect x="' + (c + margin) + '" y="' + (r + margin) + '" width="1" height="1" fill="#000000"/>');
      }
    }
    parts.push("</svg>");
    return parts.join("");
  }

  function canvasHasInk(cnv) {
    try {
      var ctx = cnv.getContext("2d");
      var w = Math.min(cnv.width, 64);
      var h = Math.min(cnv.height, 64);
      if (w < 2 || h < 2) return false;
      var sample = ctx.getImageData(0, 0, w, h).data;
      for (var i = 0; i < sample.length; i += 16) {
        if (sample[i] < 250 || sample[i + 1] < 250 || sample[i + 2] < 250) return true;
      }
      return false;
    } catch (e) {
      // tainted / restricted — assume ok
      return true;
    }
  }

  function drawCanvas(modules) {
    clearQrHost();
    var cnv = document.createElement("canvas");
    var size = moduleSize(modules);
    var n = size + MARGIN * 2;
    var scale = Math.max(2, Math.floor(DRAW_SIZE / n));
    var px = n * scale;
    cnv.width = px;
    cnv.height = px;
    cnv.setAttribute("role", "img");
    cnv.setAttribute("aria-label", "QR kód");
    var ctx = cnv.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!moduleGet(modules, r, c)) continue;
        ctx.fillRect((c + MARGIN) * scale, (r + MARGIN) * scale, scale, scale);
      }
    }
    qrHost.appendChild(cnv);
    state.paintEl = cnv;
    if (!canvasHasInk(cnv)) throw new Error("canvas appears blank");
    state.renderMode = "canvas";
  }

  function drawSvg(modules) {
    clearQrHost();
    var wrap = document.createElement("div");
    wrap.innerHTML = modulesToSvgMarkup(modules, MARGIN);
    var svg = wrap.firstChild;
    if (!svg) throw new Error("svg empty");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR kód");
    qrHost.appendChild(svg);
    state.paintEl = svg;
    state.renderMode = "svg";
  }

  function drawImg(modules) {
    clearQrHost();
    var svg = modulesToSvgMarkup(modules, MARGIN);
    var uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    var img = document.createElement("img");
    img.alt = "QR kód";
    img.width = DRAW_SIZE;
    img.height = DRAW_SIZE;
    img.src = uri;
    qrHost.appendChild(img);
    state.paintEl = img;
    state.renderMode = "img-svg";
  }

  function drawModules(modules) {
    var errors = [];
    // On mobile prefer SVG first (more reliable than canvas sizing).
    var chain = IS_MOBILE
      ? [drawSvg, drawImg, drawCanvas]
      : [drawCanvas, drawSvg, drawImg];

    // If previous mode worked, try it first.
    if (state.renderMode === "svg") chain = [drawSvg, drawImg, drawCanvas];
    if (state.renderMode === "img-svg") chain = [drawImg, drawSvg, drawCanvas];
    if (state.renderMode === "canvas") chain = [drawCanvas, drawSvg, drawImg];

    for (var i = 0; i < chain.length; i++) {
      try {
        chain[i](modules);
        setMeta("d-render", state.renderMode);
        notePaintFps();
        return;
      } catch (e) {
        errors.push((chain[i].name || "draw") + ": " + (e && e.message ? e.message : e));
      }
    }
    throw new Error("All render methods failed: " + errors.join(" | "));
  }

  function considerCandidate(best, modules, targetUrl, prev, tag) {
    if (decodeModules(modules) !== targetUrl) return best;
    var flips = hamming(prev, modules);
    var bal = scoreRegionalBalance(modules, prev).total;
    if (!best) {
      return {
        flips: flips,
        bal: bal,
        modules: copyModules(modules),
        tag: tag || "stabilize"
      };
    }
    if (isBalanceGoal()) {
      if (bal < best.bal - 1e-9 || (Math.abs(bal - best.bal) <= 1e-9 && flips < best.flips)) {
        return {
          flips: flips,
          bal: bal,
          modules: copyModules(modules),
          tag: tag || (best.tag) || "stabilize"
        };
      }
      return best;
    }
    if (flips < best.flips || (flips === best.flips && bal < (best.bal != null ? best.bal : 1e9))) {
      return {
        flips: flips,
        bal: bal,
        modules: copyModules(modules),
        tag: tag || (best.tag) || "stabilize"
      };
    }
    return best;
  }

  function setGroupCells(work, group, src) {
    for (var i = 0; i < group.cells.length; i++) {
      var rc = group.cells[i];
      work.set(rc[0], rc[1], moduleGet(src, rc[0], rc[1]));
    }
  }

  /**
   * Analytic codeword stabilizer: keep the previous frame's modules in the
   * codewords where prev and target diverge the most, take target elsewhere.
   * Groups diffs by owning codeword, biases selection toward one contiguous
   * region (fewer, tighter flips), then verifies with the decoder — a fast
   * "sacrifice all" path first, else greedy accept-if-still-decodes. The
   * returned matrix always decodes to the target (each step is verified).
   */
  function analyticStabilize(prev, neu, targetUrl, d, deadline, shouldCancel) {
    if (!window.QRStructure) return null;
    var cwMap = window.QRStructure.buildCodewordMap(neu);
    var size = cwMap.size;
    var groups = {};
    var i, rc, cw, g;
    for (i = 0; i < d.length; i++) {
      rc = d[i];
      cw = cwMap.cwIndex[rc[0] * size + rc[1]];
      if (cw < 0) continue;
      g = groups[cw];
      if (!g) { g = { cw: cw, cells: [], sx: 0, sy: 0 }; groups[cw] = g; }
      g.cells.push(rc);
      g.sx += rc[1];
      g.sy += rc[0];
    }
    var list = [];
    for (var k in groups) {
      if (!groups.hasOwnProperty(k)) continue;
      g = groups[k];
      g.save = g.cells.length;
      g.cx = g.sx / g.save;
      g.cy = g.sy / g.save;
      list.push(g);
    }
    if (!list.length) return null;

    // Phase D: cluster flips. Savings dominate (integer module counts); the
    // distance-to-centroid term is < 1 module, so it only breaks ties toward a
    // single contiguous region that a mask can cover more easily.
    var tsx = 0, tsy = 0, tw = 0;
    for (i = 0; i < list.length; i++) { tsx += list[i].cx * list[i].save; tsy += list[i].cy * list[i].save; tw += list[i].save; }
    var mcx = tw ? tsx / tw : 0;
    var mcy = tw ? tsy / tw : 0;
    var diag = Math.max(1, size * 1.4142);
    list.sort(function (a, b) {
      var da = Math.sqrt((a.cx - mcx) * (a.cx - mcx) + (a.cy - mcy) * (a.cy - mcy));
      var db = Math.sqrt((b.cx - mcx) * (b.cx - mcx) + (b.cy - mcy) * (b.cy - mcy));
      return (b.save - 0.6 * (db / diag)) - (a.save - 0.6 * (da / diag));
    });

    // Fast path: sacrifice every diverging codeword at once.
    var work = copyModules(neu);
    for (i = 0; i < list.length; i++) setGroupCells(work, list[i], prev);
    if (decodeModules(work) === targetUrl) return work;

    // Greedy + verify: accept each codeword's sacrifice only if it still decodes.
    work = copyModules(neu);
    for (var j = 0; j < list.length; j++) {
      if (Date.now() >= deadline || (shouldCancel && shouldCancel())) break;
      setGroupCells(work, list[j], prev);
      if (decodeModules(work) !== targetUrl) setGroupCells(work, list[j], neu);
    }
    return work;
  }

  async function stabilize(prev, neu, targetUrl, budgetMs, shouldCancel) {
    var d = listDiffs(prev, neu);
    // Prefer non-reserved diffs (should be all of them for same version).
    d = d.filter(function (rc) {
      return !moduleReserved(neu, rc[0], rc[1]);
    });
    if (!d.length) d = listDiffs(prev, neu);

    if (!state.decoder) {
      return { modules: neu, flips: d.length, raw: d.length, orders: 0, mode: "canonical" };
    }
    if (decodeModules(neu) !== targetUrl) {
      return { modules: neu, flips: listDiffs(prev, neu).length, raw: listDiffs(prev, neu).length, orders: 0, mode: "canonical-fallback" };
    }

    var started = Date.now();
    var deadline = started + budgetMs;
    var best = {
      flips: listDiffs(prev, neu).length,
      bal: scoreRegionalBalance(neu, prev).total,
      modules: copyModules(neu),
      tag: "canonical"
    };
    var orders = 0;
    var size = moduleSize(neu);

    best = considerCandidate(best, neu, targetUrl, prev, "canonical");

    // Primary: analytic codeword pass (near-optimal in one shot, verified).
    try {
      var analytic = analyticStabilize(prev, neu, targetUrl, d, deadline, shouldCancel);
      if (analytic) best = considerCandidate(best, analytic, targetUrl, prev, "analytic");
    } catch (e) {
      log("Analytic stabilize skipped", String(e && e.message ? e.message : e));
    }

    // Refinement/fallback: heuristic dual-direction search with remaining budget.
    while (Date.now() < deadline) {
      if (shouldCancel && shouldCancel()) break;
      orders += 1;

      var order;
      if (orders === 1) {
        order = structureSortDiffs(d, size);
      } else if (orders === 2) {
        order = structureSortDiffs(d, size).reverse();
      } else {
        order = d.slice();
        shuffleInPlace(order);
      }

      // from-old
      var lo = 1;
      var hi = order.length;
      var ansOld = neu;
      while (lo <= hi && Date.now() < deadline) {
        var mid = (lo + hi) >> 1;
        var trialOld = copyModules(prev);
        for (var i = 0; i < mid; i++) {
          trialOld.set(order[i][0], order[i][1], moduleGet(neu, order[i][0], order[i][1]));
        }
        if (decodeModules(trialOld) === targetUrl) {
          ansOld = trialOld;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      best = considerCandidate(best, ansOld, targetUrl, prev, "heuristic");

      // from-new
      lo = 0;
      hi = order.length;
      var ansNew = neu;
      while (lo <= hi && Date.now() < deadline) {
        mid = (lo + hi) >> 1;
        var trialNew = copyModules(neu);
        for (i = 0; i < mid; i++) {
          trialNew.set(order[i][0], order[i][1], moduleGet(prev, order[i][0], order[i][1]));
        }
        if (decodeModules(trialNew) === targetUrl) {
          ansNew = trialNew;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      best = considerCandidate(best, ansNew, targetUrl, prev, "heuristic");

      var mut = copyModules(best.modules);
      var mcount = 1 + ((Math.random() * 3) | 0);
      for (var t = 0; t < mcount; t++) {
        var cell = d[(Math.random() * d.length) | 0];
        mut.set(cell[0], cell[1], moduleGet(prev, cell[0], cell[1]));
      }
      best = considerCandidate(best, mut, targetUrl, prev, "heuristic");

      if (orders % 2 === 0) await yieldToBrowser();
    }

    var polished = copyModules(best.modules);
    var leftovers = d.filter(function (rc) {
      return !!polished.get(rc[0], rc[1]) !== !!moduleGet(prev, rc[0], rc[1]);
    });
    leftovers = structureSortDiffs(leftovers, size);
    var polishDeadline = Math.max(deadline, Date.now() + 100);
    for (t = 0; t < leftovers.length && Date.now() < polishDeadline; t++) {
      if (shouldCancel && shouldCancel()) break;
      cell = leftovers[t];
      var before = polished.get(cell[0], cell[1]);
      polished.set(cell[0], cell[1], moduleGet(prev, cell[0], cell[1]));
      if (decodeModules(polished) !== targetUrl) polished.set(cell[0], cell[1], before);
    }

    return {
      modules: polished,
      flips: hamming(prev, polished),
      raw: listDiffs(prev, neu).length,
      orders: orders,
      mode: "ecc-" + (best.tag || "stabilize")
    };
  }

  function chooseCanonical(api, epoch, prevModules, prevPad) {
    var best = null;

    function consider(pad, mask) {
      var url = buildUrl(epoch, pad);
      var modules = createModules(api, url, mask);
      var raw = prevModules ? listDiffs(prevModules, modules).length : 0;
      var bal = scoreRegionalBalance(modules, prevModules).total;
      if (!best || isBetterSearch(raw, bal, best.raw, best.bal)) {
        best = { url: url, pad: pad, mask: mask, modules: modules, raw: raw, bal: bal };
      }
    }

    var mask;
    for (mask = 0; mask < 8; mask++) consider(prevPad, mask);

    // Structure-aware: mutate pad suffix (trailing data/padding codewords).
    var t;
    for (t = 0; t < 12; t++) {
      consider(mutatePadSuffix(best.pad, state.padLen), best.mask);
    }

    return best;
  }

  function mutatePadAt(pad, pos, ch) {
    return pad.substring(0, pos) + ch + pad.substring(pos + 1);
  }

  /**
   * Hill-climb the free pad for a fixed QR mask.
   * Default goal: minimize raw Hamming to prev (proxy for post-sacrifice flips).
   * Balance goal: minimize regional B/W imbalance + proportional density drift
   * (raw Hamming is the tie-breaker).
   */
  function optimizePad(api, epoch, prevModules, startPad, mask, deadline, shouldCancel) {
    var pad = startPad || "";
    var url = buildUrl(epoch, pad);
    var mods = createModules(api, url, mask);
    var bestRaw = listDiffs(prevModules, mods).length;
    var bestBal = scoreRegionalBalance(mods, prevModules).total;
    var len = pad.length;
    if (len === 0) {
      return { pad: pad, url: url, mask: mask, modules: mods, raw: bestRaw, bal: bestBal };
    }
    var stale = 0;
    // Balance needs more exploration — density landscape is less locally smooth.
    var cap = len * (isBalanceGoal() ? 7 : 4);
    while (Date.now() < deadline && stale < cap) {
      if (shouldCancel && shouldCancel()) break;
      var pos = (Math.random() * len) | 0;
      var ch = PAD_ALPHABET[(Math.random() * PAD_ALPHABET.length) | 0];
      if (ch === pad.charAt(pos)) continue;
      var trialPad = mutatePadAt(pad, pos, ch);
      var turl = buildUrl(epoch, trialPad);
      var tmods = createModules(api, turl, mask);
      var raw = listDiffs(prevModules, tmods).length;
      var bal = scoreRegionalBalance(tmods, prevModules).total;
      if (isBetterSearch(raw, bal, bestRaw, bestBal)) {
        bestRaw = raw;
        bestBal = bal;
        pad = trialPad;
        url = turl;
        mods = tmods;
        stale = 0;
      } else {
        stale += 1;
      }
    }
    return { pad: pad, url: url, mask: mask, modules: mods, raw: bestRaw, bal: bestBal };
  }

  /**
   * Candidate set for minimal change: scan masks, hill-climb the pad on the best
   * mask, re-scan masks on the optimized pad, and return the top-N lowest-raw
   * distinct candidates. Each is then RS-stabilized; the global minimum wins.
   */
  function buildCandidates(api, epoch, prevModules, prevPad, deadline, shouldCancel, topN) {
    var startPad = prevPad || "";
    var all = [];
    function consider(pad, mask) {
      var url = buildUrl(epoch, pad);
      var modules = createModules(api, url, mask);
      var raw = listDiffs(prevModules, modules).length;
      var bal = scoreRegionalBalance(modules, prevModules).total;
      all.push({ url: url, pad: pad, mask: mask, modules: modules, raw: raw, bal: bal });
    }
    function rank(a, b) {
      return isBalanceGoal()
        ? (a.bal - b.bal) || (a.raw - b.raw)
        : (a.raw - b.raw) || (a.bal - b.bal);
    }
    var mask;
    for (mask = 0; mask < 8; mask++) consider(startPad, mask);
    all.sort(rank);
    var m0 = all[0].mask;

    // Hill-climb the pad on the best starting mask for the bulk of the budget.
    var opt = optimizePad(api, epoch, prevModules, startPad, m0, deadline, shouldCancel);
    // Re-scan masks on the optimized pad (mask shifts the whole data pattern).
    for (mask = 0; mask < 8; mask++) consider(opt.pad, mask);

    all.sort(rank);
    var seen = {};
    var out = [];
    for (var i = 0; i < all.length && out.length < (topN || 3); i++) {
      var key = all[i].mask + "|" + all[i].url;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(all[i]);
    }
    return out;
  }

  /** Best mask for a FIXED pad (no pad mutation) — used by sub-second frames. */
  function scanMask(api, epoch, pad, prevModules) {
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var url = buildUrl(epoch, pad);
      var modules = createModules(api, url, mask);
      var raw = prevModules ? listDiffs(prevModules, modules).length : 0;
      var bal = scoreRegionalBalance(modules, prevModules).total;
      if (!best || isBetterSearch(raw, bal, best.raw, best.bal)) {
        best = { url: url, pad: pad, mask: mask, modules: modules, raw: raw, bal: bal };
      }
    }
    return best;
  }

  /** Build a minimal-change frame for a fixed (slot-derived) pad. */
  async function buildFrameFixedPad(api, epoch, pad, prevModules, budgetMs, shouldCancel) {
    var canon = scanMask(api, epoch, pad, prevModules);
    if (!prevModules) {
      return {
        canonical: canon,
        result: { modules: copyModules(canon.modules), flips: 0, raw: 0, orders: 0, mode: "initial" }
      };
    }
    var result = await stabilize(prevModules, canon.modules, canon.url, budgetMs, shouldCancel);
    return { canonical: canon, result: result };
  }

  async function buildFrame(api, epoch, prevModules, prevPad, budgetMs, shouldCancel) {
    if (!prevModules) {
      var first = chooseCanonical(api, epoch, prevModules, prevPad || state.pad);
      return {
        canonical: first,
        result: {
          modules: copyModules(first.modules),
          flips: 0,
          raw: 0,
          orders: 0,
          mode: "initial"
        }
      };
    }

    var deadlineAll = Date.now() + budgetMs;
    // Spend up to ~55% of the budget searching the free pad/mask space, the rest
    // on RS stabilization of the best candidates.
    var searchDeadline = Date.now() + Math.max(60, Math.floor(budgetMs * 0.55));
    var cands = buildCandidates(
      api, epoch, prevModules, prevPad || state.pad,
      Math.min(searchDeadline, deadlineAll), shouldCancel, 3
    );
    var perBudget = Math.max(80, Math.floor((deadlineAll - Date.now()) / cands.length));
    var bestCanon = null;
    var bestRes = null;
    var bestBal = null;
    for (var i = 0; i < cands.length; i++) {
      if (shouldCancel && shouldCancel()) break;
      var remaining = deadlineAll - Date.now();
      if (remaining <= 40 && bestRes) break;
      var b = Math.max(60, Math.min(perBudget, remaining));
      var res = await stabilize(prevModules, cands[i].modules, cands[i].url, b, shouldCancel);
      var bal = scoreRegionalBalance(res.modules, prevModules).total;
      res.bal = bal;
      if (!bestRes || isBetterSearch(res.flips, bal, bestRes.flips, bestBal)) {
        bestRes = res;
        bestCanon = cands[i];
        bestBal = bal;
      }
      // Early exit: min-flip near-optimal, or balance already very even with few flips.
      if (!isBalanceGoal() && bestRes.flips <= 2) break;
      if (isBalanceGoal() && bestBal < 0.04 && bestRes.flips <= 8) break;
    }
    if (!bestRes) {
      bestCanon = cands[0];
      bestRes = {
        modules: copyModules(cands[0].modules),
        flips: cands[0].raw,
        raw: cands[0].raw,
        orders: 0,
        mode: "canonical"
      };
    }
    return { canonical: bestCanon, result: bestRes };
  }

  function zeroPad(len) {
    return len > 0 ? Array(len + 1).join("0") : "";
  }

  /** Canonical (min raw-diff) frame for an explicit profile — used by measureGrid. */
  function canonicalForProfile(api, epoch, prevModules, prevPad, padLen, version, ecc) {
    var best = null;
    function consider(pad, mask) {
      var url = buildUrl(epoch, pad);
      var modules = createModules(api, url, mask, version, ecc);
      var raw = prevModules ? listDiffs(prevModules, modules).length : 0;
      if (!best || raw < best.raw) best = { url: url, pad: pad, mask: mask, modules: modules, raw: raw };
    }
    for (var mask = 0; mask < 8; mask++) consider(prevPad, mask);
    for (var t = 0; t < 10; t++) consider(mutatePadSuffix(best.pad, padLen), best.mask);
    return best;
  }

  /**
   * Boot-time tuning aid: for each candidate grid profile, measure average
   * stabilized flips over a few synthetic sequential epochs. Read-only w.r.t.
   * live state; logged as "Grid measure" so a profile can be chosen after a
   * real cheap-phone readability check. Never blocks the live tick.
   */
  async function measureGrid(api, steps) {
    if (!api || !state.decoder) return;
    steps = steps || 4;
    var baseEpoch = Math.floor(Date.now() / 1000);
    var results = [];
    for (var pi = 0; pi < GRID_PROFILES.length; pi++) {
      var prof = GRID_PROFILES[pi];
      var padLen, prev = null, pad;
      try {
        padLen = computePadLen(api, prof.version, prof.ecc);
        pad = zeroPad(padLen);
      } catch (e) { continue; }
      var flips = [];
      var raws = [];
      var size = 0;
      for (var s = 0; s < steps; s++) {
        var epoch = baseEpoch + 1000 + pi * 100 + s; // off live epochs
        var canon = canonicalForProfile(api, epoch, prev, pad, padLen, prof.version, prof.ecc);
        size = moduleSize(canon.modules);
        if (prev) {
          var res = await stabilize(prev, canon.modules, canon.url, 140, null);
          flips.push(res.flips);
          raws.push(res.raw);
          prev = res.modules;
        } else {
          prev = canon.modules;
        }
        pad = canon.pad;
        await yieldToBrowser();
      }
      var avg = function (a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : 0; };
      var total = size * size;
      results.push({
        v: prof.version,
        ecc: prof.ecc,
        modules: size,
        avgRaw: avg(raws),
        avgFlips: avg(flips),
        pct: total ? +((100 * avg(flips)) / total).toFixed(3) : 0,
        active: prof.version === VERSION && prof.ecc === ECC
      });
    }
    log("Grid measure", { steps: steps, profiles: results });
    return results;
  }

  function cancelPrefetch() {
    if (state.prefetch) state.prefetch.cancelled = true;
  }

  /**
   * Cheap N-iteration outlook for the "gentlest transition" mask (chgmin):
   * walk N future canonical (min-raw, no stabilize) frames and count, per module,
   * in how many of them it differs from the CURRENT code. Cells that differ the
   * LEAST are ranked first — pre-blinking only those keeps the transition subtle.
   * Only data modules change, so the ranked list is inherently non-reserved.
   */
  async function computeGentleForecast(steps, shouldCancel) {
    if (!state.api || !state.prevModules) return;
    var cur = state.prevModules;
    var size = moduleSize(cur);
    var freq = new Uint16Array(size * size);
    var baseSlot = currentSlot();
    var mods = cur;
    for (var step = 1; step <= steps; step++) {
      if (shouldCancel && shouldCancel()) return;
      var slot = baseSlot + step;
      var canon = scanMask(state.api, epochForSlot(slot), padForSlot(slot), mods);
      var f = canon.modules;
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (!!moduleGet(cur, r, c) !== !!moduleGet(f, r, c)) freq[r * size + c] += 1;
        }
      }
      mods = f;
      if (step % 4 === 0) await yieldToBrowser();
    }
    var cells = [];
    for (var i = 0; i < freq.length; i++) {
      if (freq[i] > 0) cells.push([(i / size) | 0, i % size, freq[i]]);
    }
    cells.sort(function (a, b) { return a[2] - b[2]; }); // least-differing first
    state.gentleCells = cells.map(function (x) { return [x[0], x[1]]; });
  }

  function formatPlanMeta(snap) {
    if (!snap) return "—";
    var qrParts = (snap.qr || []).map(function (e) {
      return "s" + e.slot + "@" + e.inMs + "ms Δ" + e.diffs +
        "[" + (e.cells || []).slice(0, 6).join(" ") + "]";
    });
    var ballParts = (snap.balls || []).map(function (b) {
      var q0 = b.q && b.q[0] ? ("→s" + b.q[0].slot + "@" + b.q[0].inMs) : "";
      var pred = b.pred ? (" pred=" + b.pred.x + "," + b.pred.y + " miss=" + b.pred.miss) : "";
      return b.id + "@" + b.x + "," + b.y + " v" + b.sp + q0 + pred + (b.cover ? " COVER" : "");
    });
    return "QR: " + (qrParts.join(" | ") || "none") + " || Balls: " + ballParts.join(" · ");
  }

  function onMaskPlanDebug(snap) {
    state.lastPlanSnap = snap;
    setMeta("d-forecast", formatPlanMeta(snap));
    var shortBalls = (snap.balls || []).map(function (b) {
      return b.id + ":" + b.x + "," + b.y +
        (b.pred && b.pred.miss != null ? "/m" + b.pred.miss : "") +
        (b.cover ? "*" : "");
    }).join(" ");
    setMeta("d-ballpos", shortBalls || "—");
    var near = (snap.qr || []).filter(function (e) { return e.inMs > -80 && e.inMs < 1200; });
    var nowMs = Date.now();
    // Keep continuous plan noise low — flip-moment FLIP COVER is the tuning signal
    if (near.length && (!state._lastPlanLogMs || nowMs - state._lastPlanLogMs > 1500)) {
      state._lastPlanLogMs = nowMs;
      log("Plan tick", {
        qr: near.map(function (e) {
          return { slot: e.slot, inMs: e.inMs, diffs: e.diffs, cells: (e.cells || []).slice(0, 8) };
        }),
        balls: (snap.balls || []).map(function (b) {
          return {
            id: b.id,
            xy: [b.x, b.y],
            sp: b.sp,
            pred: b.pred,
            cover: b.cover
          };
        })
      });
    }
  }

  function pushForecastToBalls(events) {
    if (!state.maskBalls || !state.maskBalls.enabled) return;
    state.maskBalls.setForecast(events, { intervalMs: getStepMs() });
    var n = 0;
    var flips = [];
    for (var i = 0; i < events.length; i++) {
      var d = events[i].diffs ? events[i].diffs.length : 0;
      if (d) n++;
      flips.push(d);
    }
    setMeta("d-mask", "balls (H" + events.length + "/" + n + ")");
    log("QR forecast diffs", {
      horizon: events.length,
      flips: flips,
      slots: events.map(function (e) {
        return {
          slot: e.slot,
          inMs: Math.round(e.changeAtMs - Date.now()),
          cells: (e.diffs || []).slice(0, 24).map(function (c) { return c[0] + "," + c[1]; })
        };
      })
    });
  }

  function planMaskBallsFromFrame(frame, changeAtMs) {
    if (!state.maskBalls || !state.maskBalls.enabled || !frame || !state.prevModules) return;
    var nextMods = frame.result.modules;
    var diffs = listDiffs(state.prevModules, nextMods);
    state.pendingDiffs = diffs;
    pushForecastToBalls([{
      slot: currentSlot() + 1,
      changeAtMs: changeAtMs,
      moduleSize: moduleSize(nextMods),
      margin: MARGIN,
      diffs: diffs
    }]);
  }

  function startPrefetch(slotJustShown) {
    if (!state.api || !state.prevModules) return;
    cancelPrefetch();
    var stepMs = getStepMs();
    // With balls on: next flip is critical; 2–3 steps ahead is enough travel time
    var horizon = state.maskBalls && state.maskBalls.enabled
      ? Math.max(2, Math.min(3, state.forecastHorizon | 0))
      : Math.max(1, Math.min(30, getLookupSteps()));
    var nextSlot = slotJustShown + 1;
    var token = {
      cancelled: false,
      slot: nextSlot,
      epoch: epochForSlot(nextSlot),
      ready: null,
      horizon: horizon
    };
    state.prefetch = token;

    var changeAt = slotChangeAtMs(nextSlot);
    var msLeft = Math.max(80, changeAt - Date.now() - 20);
    var budget1 = Math.min(PREFETCH_BUDGET_MS, Math.max(60, Math.min(STABILIZE_BUDGET_MS, msLeft * 0.85)));

    token.ready = (async function () {
      var mods = state.prevModules;
      var events = [];
      var firstFrame = null;

      for (var step = 1; step <= horizon; step++) {
        if (token.cancelled) return null;
        var slot = slotJustShown + step;
        var epoch = epochForSlot(slot);
        var pad = padForSlot(slot);
        // Keep later horizon steps useful — do not collapse budget to near-zero
        var budget = step === 1
          ? budget1
          : Math.min(
              IS_MOBILE ? 280 : 420,
              Math.max(IS_MOBILE ? 120 : 160, budget1 * Math.max(0.28, 0.72 - step * 0.05))
            );
        var frame = await buildFrameFixedPad(
          state.api,
          epoch,
          pad,
          mods,
          budget,
          function () { return token.cancelled; }
        );
        if (token.cancelled || !frame) break;
        if (step === 1) {
          firstFrame = frame;
          token.frame = frame;
        }
        var diffs = listDiffs(mods, frame.result.modules);
        events.push({
          slot: slot,
          changeAtMs: slotChangeAtMs(slot),
          moduleSize: moduleSize(frame.result.modules),
          margin: MARGIN,
          diffs: diffs
        });
        // Expose the multi-step change sets to the mask each step (progressive).
        state.futureDiffs = events.map(function (e) { return e.diffs || []; });
        if (events[0] && events[0].diffs) state.pendingDiffs = events[0].diffs;
        // Push partial forecast early so balls can start aiming while later steps compute
        if (!token.cancelled && (step === 1 || step === 3 || step === horizon)) {
          if (events[0] && events[0].diffs) state.pendingDiffs = events[0].diffs;
          pushForecastToBalls(events.slice());
        }
        mods = frame.result.modules;
        await yieldToBrowser();
      }

      // Gentlest-transition outlook (throttled — the ranking drifts slowly).
      // Lookup steps come from the UI control (default 6, up to 30).
      if (!token.cancelled && state.gentleMode && Date.now() - state._gentleAt > 2000) {
        state._gentleAt = Date.now();
        await computeGentleForecast(getLookupSteps(), function () { return token.cancelled; });
      }

      if (!token.cancelled && events.length) {
        if (events[0] && events[0].diffs) state.pendingDiffs = events[0].diffs;
        pushForecastToBalls(events);
        log("Prefetch horizon", {
          steps: events.length,
          flips: events.map(function (e) { return e.diffs ? e.diffs.length : 0; }),
          budgets: "step1=" + Math.round(budget1) + "ms"
        });
      }
      return firstFrame;
    })().catch(function (err) {
      if (!token.cancelled) log("Prefetch error", String(err && err.message ? err.message : err));
      return null;
    });
  }

  function adaptNodeQrcode(mod, sourceId) {
    var api = mod && (mod.create || mod.toCanvas || mod.default)
      ? (mod.create ? mod : mod.default)
      : null;
    if (!api || typeof api.create !== "function") {
      throw new Error("QR api missing create()");
    }
    return { id: "node-qrcode", source: sourceId, api: api, supportsStabilize: true };
  }

  function adaptQrcodejs(sourceId) {
    if (typeof window.QRCode !== "function" || !window.QRCode.CorrectLevel) {
      throw new Error("qrcodejs global missing");
    }
    return {
      id: "qrcodejs",
      source: sourceId,
      api: null,
      supportsStabilize: false,
      renderSimple: function (url) {
        clearQrHost();
        new window.QRCode(qrHost, {
          text: url,
          width: DRAW_SIZE,
          height: DRAW_SIZE,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: window.QRCode.CorrectLevel.L
        });
        state.renderMode = "qrcodejs-dom";
        setMeta("d-render", state.renderMode);
      }
    };
  }

  function pickGlobalNodeQrcode(sourceId) {
    if (window.QRCode && typeof window.QRCode.create === "function") {
      return adaptNodeQrcode(window.QRCode, sourceId);
    }
    return null;
  }

  function loadDecoder() {
    if (typeof window.jsQR === "function") {
      state.decoder = window.jsQR;
      state.decoderSource = "preloaded";
      setMeta("d-decoder", "preloaded");
      log("Decoder ready", "preloaded");
      return Promise.resolve();
    }
    var i = 0;
    function next() {
      if (i >= DECODER_CANDIDATES.length) {
        return Promise.reject(new Error("jsQR failed to load"));
      }
      var cand = DECODER_CANDIDATES[i++];
      log("Trying decoder", cand.id);
      return loadScript(cand.src).then(function () {
        if (typeof window.jsQR !== "function") throw new Error("jsQR global missing after " + cand.id);
        state.decoder = window.jsQR;
        state.decoderSource = cand.id;
        setMeta("d-decoder", cand.id);
        log("Decoder ready", cand.id);
      }).catch(function (err) {
        fail(err, cand.id);
        return next();
      });
    }
    return next();
  }

  function loadEngine() {
    // Prefer sync-preloaded vendor/qrcode.min.js (index.html)
    var pre = pickGlobalNodeQrcode("preloaded");
    if (pre) {
      state.engineId = pre.id;
      state.source = pre.source;
      state.api = pre.api;
      state.simpleRenderer = null;
      setMeta("d-engine", pre.id);
      setMeta("d-source", pre.source);
      log("Engine ready", pre.id + " via " + pre.source);
      return Promise.resolve(pre);
    }

    var i = 0;
    function next() {
      if (i >= SCRIPT_CANDIDATES.length) {
        return Promise.reject(new Error("All QR engines failed to load"));
      }
      var cand = SCRIPT_CANDIDATES[i++];
      log("Trying engine source", cand.id + " (" + cand.type + ")");
      setMeta("d-source", "loading " + cand.id);
      setStatus("warn", "loading");

      var attempt;
      if (cand.type === "esm") {
        attempt = import(resolveAsset(cand.src)).then(function (mod) { return adaptNodeQrcode(mod, cand.id); });
      } else if (cand.type === "qrcodejs") {
        attempt = loadScript(cand.src).then(function () { return adaptQrcodejs(cand.id); });
      } else {
        attempt = loadScript(cand.src).then(function () {
          var eng = pickGlobalNodeQrcode(cand.id);
          if (!eng) throw new Error("Global QRCode.create not found after " + cand.id);
          return eng;
        });
      }

      return attempt.then(function (engine) {
        state.engineId = engine.id;
        state.source = engine.source;
        state.api = engine.api;
        state.simpleRenderer = engine.renderSimple || null;
        setMeta("d-engine", engine.id);
        setMeta("d-source", engine.source);
        log("Engine ready", engine.id + " via " + engine.source);
        return engine;
      }).catch(function (err) {
        fail(err, cand.id);
        return next();
      });
    }
    return next();
  }

  function applyFrame(epoch, canonical, result, started, fromPrefetch) {
    var flipAtMs = Date.now();
    var prevForDiff = state.prevModules;
    var flipDiffs = prevForDiff ? listDiffs(prevForDiff, result.modules) : [];

    var decodedText = state.decoder ? decodeModules(result.modules) : canonical.url;
    var decodedEpoch = codec.decodePayload(decodedText || canonical.url);
    if (decodedEpoch !== epoch) {
      result = {
        modules: copyModules(canonical.modules),
        flips: canonical.raw,
        raw: canonical.raw,
        orders: result.orders || 0,
        mode: "canonical-safe"
      };
      decodedEpoch = epoch;
      flipDiffs = prevForDiff ? listDiffs(prevForDiff, result.modules) : [];
    }

    state.pad = canonical.pad;
    state.mask = canonical.mask;
    state.prevModules = copyModules(result.modules);
    state.lastUrl = canonical.url;

    // Route the visual swap through the active masking method. crossfade/softpatch
    // animate the changed cells (crossfade defers the swap behind the overlay);
    // balls/shimmer/none commit immediately.
    var newModules = result.modules;
    var commit = function () { drawModules(newModules); };
    if (state.maskFx && !state.maskFx.usesBalls() && flipDiffs.length) {
      var cells = flipDiffs.map(function (rc) {
        return [rc[0], rc[1], moduleGet(newModules, rc[0], rc[1]) ? 1 : 0];
      });
      state.maskFx.present(cells, moduleSize(newModules), MARGIN, commit);
    } else {
      commit();
    }
    urlEl.textContent = canonical.url;
    setMeta("d-url", canonical.url);
    setMeta("d-epoch", String(decodedEpoch));
    setMeta("d-opts", ECC + " / " + VERSION + " / mask " + canonical.mask + (IS_MOBILE ? " / mobile" : ""));
    setMeta("d-pad", String(state.padLen));
    setMeta("d-flips", String(result.flips) + " (" + result.mode + (fromPrefetch ? ", prefetch" : "") + ")");
    setMeta("d-raw", String(result.raw));
    setMeta("d-orders", String(result.orders || 0));
    setMeta("d-render", state.renderMode);

    var total = moduleSize(result.modules) * moduleSize(result.modules);
    var pct = total ? ((100 * result.flips) / total).toFixed(3) : "0";
    setMeta("d-pct", pct + "%");
    setMeta("d-csspx", String(estimateCssPx(result.flips, result.modules)));
    setMeta("d-interval", getRate() + " /s");
    setMeta("d-goal", isBalanceGoal() ? "balance" : "min");
    var balScore = scoreRegionalBalance(result.modules, prevForDiff);
    setMeta(
      "d-balance",
      "e" + balScore.evenness.toFixed(3) +
        " s" + balScore.spread.toFixed(3) +
        " Δ" + balScore.change.toFixed(3) +
        " Σ" + balScore.total.toFixed(3)
    );

    state.renders += 1;
    setMeta("d-renders", String(state.renders));
    setMeta("d-tick", now());
    setMeta("d-error", "none");
    state.lastError = null;
    setStatus("ok", "ok");

    if (state.maskBalls && state.maskBalls.enabled) {
      // Prefer the slot this frame was built for (paint can lag wall-clock)
      var paintSlot = (fromPrefetch && state.prefetch && state.prefetch.slot != null)
        ? state.prefetch.slot
        : currentSlot();
      var flipReport = state.maskBalls.reportFlipCover({
        flipAtMs: flipAtMs,
        slot: paintSlot,
        epoch: decodedEpoch,
        diffs: flipDiffs,
        moduleSize: moduleSize(result.modules),
        margin: MARGIN
      });
      state.maskBalls.notifyChanged({ slot: paintSlot, flipAtMs: flipAtMs });
      state.lastFlipReport = flipReport;
      setMeta(
        "d-flip",
        flipReport.t.slice(11, 23) +
          " cover " + flipReport.covered + "/" + flipReport.diffs +
          " (" + flipReport.pct + "%)" +
          (flipReport.miss ? " miss[" + flipReport.uncovered.slice(0, 8).join(" ") + "]" : " OK")
      );
      log("FLIP COVER", flipReport);
    } else {
      setMeta("d-flip", state.maskMethod + " (" + flipDiffs.length + " cells)");
    }

    if (state.renders <= 5 || state.renders % 30 === 0) {
      log("Stabilized", {
        flips: result.flips,
        raw: result.raw,
        pct: pct + "%",
        cssPx: estimateCssPx(result.flips, result.modules),
        epoch: decodedEpoch,
        rate: getRate(),
        render: state.renderMode,
        prefetch: !!fromPrefetch,
        ms: Date.now() - started
      });
    }

    startPrefetch(currentSlot());
  }

  function tick() {
    if (state.busy) return;
    var stepMs = getStepMs();
    var slot = currentSlot();
    var slotKey = String(slot);
    if (slotKey === state.lastSlot) return;
    state.lastSlot = slotKey;

    var epoch = epochForSlot(slot);
    var pad = padForSlot(slot);
    state.lastEpoch = String(epoch);
    state.busy = true;
    var started = Date.now();

    Promise.resolve()
      .then(async function () {
        if (state.simpleRenderer && !state.api) {
          var simpleUrl = buildUrl(epoch, pad || "0");
          state.simpleRenderer(simpleUrl);
          state.lastUrl = simpleUrl;
          urlEl.textContent = simpleUrl;
          setMeta("d-url", simpleUrl);
          setMeta("d-epoch", String(codec.decodePayload(simpleUrl) || epoch));
          setMeta("d-opts", ECC + " / auto");
          setMeta("d-flips", "n/a");
          setMeta("d-raw", "n/a");
          setMeta("d-render", state.renderMode);
          return;
        }

        // Immediate canonical paint so mobile never stays blank during search.
        // For deferred-swap methods (crossfade) keep the previous frame on screen.
        var deferSwap = state.prevModules && state.maskFx && state.maskFx.wantsDeferredSwap();
        if (!deferSwap) {
          var quick = scanMask(state.api, epoch, pad, state.prevModules);
          drawModules(quick.modules);
          urlEl.textContent = quick.url;
          setMeta("d-url", quick.url);
        }
        setMeta("d-epoch", String(epoch));
        setMeta("d-render", state.renderMode);
        setStatus("warn", "refine");

        var pre = state.prefetch;
        if (pre && pre.slot === slot && pre.ready) {
          var pref = await pre.ready;
          if (pref && pref.canonical && pref.result) {
            if (codec.decodePayload(pref.canonical.url) === epoch) {
              applyFrame(epoch, pref.canonical, pref.result, started, true);
              return;
            }
          }
        }

        cancelPrefetch();
        var msIntoSlot = Date.now() - slotChangeAtMs(slot);
        var budget = Math.max(8, Math.min(STABILIZE_BUDGET_MS, stepMs - msIntoSlot - 5));
        var frame = await buildFrameFixedPad(state.api, epoch, pad, state.prevModules, budget, null);
        applyFrame(epoch, frame.canonical, frame.result, started, false);
      })
      .catch(function (err) {
        fail(err, "tick");
        showPlaceholder("QR render failed — viz Debug");
      })
      .then(function () {
        state.busy = false;
      });
  }

  /** Union of the first n forecast iterations' diff cells (module [row,col]). */
  function unionFutureDiffs(n) {
    var fd = state.futureDiffs || [];
    var lim = Math.min(n, fd.length);
    if (lim <= 1) return fd[0] || state.pendingDiffs || [];
    var seen = {};
    var out = [];
    for (var i = 0; i < lim; i++) {
      var arr = fd[i] || [];
      for (var j = 0; j < arr.length; j++) {
        var rc = arr[j];
        var k = rc[0] + "," + rc[1];
        if (seen[k]) continue;
        seen[k] = 1;
        out.push(rc);
      }
    }
    return out;
  }

  function applyMaskMethod(method, rebuild) {
    if (method === "morph" || method === "crossfade") method = "fade";
    state.maskMethod = method;
    var ballsOn = method === "balls";
    // Legacy chg1–chg6 presets sync the lookup control; "chg" uses the control as-is.
    var chg = /^chg([1-6])$/.exec(method);
    if (chg) {
      state.lookupSteps = parseInt(chg[1], 10);
      var fs = document.getElementById("forecast-steps");
      if (fs) fs.value = String(state.lookupSteps);
    }
    state.forecastSteps = (method === "chg" || chg || method === "chgmin")
      ? getLookupSteps()
      : 1;
    // "chgmin": preview only the least-differing cells from an N-iteration outlook.
    state.gentleMode = method === "chgmin";
    if (state.gentleMode) state._gentleAt = 0; // force recompute on switch
    if (state.maskBalls) state.maskBalls.setEnabled(ballsOn);
    if (state.maskFx) state.maskFx.setMethod(method);
    setMeta("d-mask", method);
    setMeta("d-lookup", String(getLookupSteps()));
    setMeta("d-fadems", isFadeMask(method)
      ? ((state.fadeMs | 0) > 0 ? (state.fadeMs + " ms") : ("auto " + getFadeMs() + " ms"))
      : "—");
    syncSettingsUrl();
    if (rebuild) {
      cancelPrefetch();
      startPrefetch(currentSlot());
    }
  }

  // Keep the QR clear of the fixed controls bar (it wraps to 2+ rows on mobile).
  function adjustLayout() {
    var c = document.getElementById("controls");
    if (c) document.body.style.paddingTop = (c.offsetHeight + 20) + "px";
  }

  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    // Fire fast enough for the rate; the busy-gate + slot dedup prevent overlap.
    var period = Math.max(5, Math.min(250, Math.round(getStepMs())));
    state.timer = setInterval(tick, period);
  }

  function bindControls() {
    var rateInput = document.getElementById("changes-per-sec");
    var methodSelect = document.getElementById("mask-method");
    var goalSelect = document.getElementById("gen-goal");
    var lookupInput = document.getElementById("forecast-steps");
    var noiseInput = document.getElementById("noise-amount");
    var changePctInput = document.getElementById("change-pct");
    var fadeMsInput = document.getElementById("fade-ms");
    var recInput = document.getElementById("rec-seconds");
    var recordBtn = document.getElementById("btn-record");

    // Apply shareable URL settings before reading controls.
    var fromUrl = readUrlSettings();
    if (fromUrl.rate != null && rateInput) rateInput.value = String(fromUrl.rate);
    if (fromUrl.lookup != null && lookupInput) lookupInput.value = String(fromUrl.lookup);
    if (fromUrl.noise != null && noiseInput) noiseInput.value = String(fromUrl.noise);
    if (fromUrl.preview != null && changePctInput) changePctInput.value = String(fromUrl.preview);
    if (fromUrl.goal != null && goalSelect) goalSelect.value = fromUrl.goal;
    if (fromUrl.fadeMs != null && fadeMsInput) fadeMsInput.value = String(fromUrl.fadeMs);
    if (fromUrl.rec != null && recInput) recInput.value = String(fromUrl.rec);
    if (fromUrl.mask != null && methodSelect) {
      var opt = methodSelect.querySelector('option[value="' + fromUrl.mask + '"]');
      if (opt) methodSelect.value = fromUrl.mask;
      else if (MASK_URL_OPTIONS.indexOf(fromUrl.mask) >= 0) {
        // Legacy / hidden methods: still apply even if not listed in the select.
        state.maskMethod = fromUrl.mask;
      }
    }
    if (fromUrl.debug && debugEl) debugEl.classList.add("open");

    adjustLayout();
    window.addEventListener("resize", adjustLayout);
    window.addEventListener("orientationchange", adjustLayout);
    // Re-measure once fonts/layout settle (bar height can grow after load).
    setTimeout(adjustLayout, 300);
    setTimeout(adjustLayout, 1200);

    if (typeof MaskBalls === "function") {
      state.maskBalls = new MaskBalls({
        getQrRect: getQrContentRect,
        onLog: function (msg, detail) { log(msg, detail); },
        onPlanDebug: onMaskPlanDebug
      });
    }
    if (typeof MaskFx === "function") {
      state.maskFx = new MaskFx({
        getQrRect: getQrContentRect,
        getQrInfo: getQrInfo,
        // Union of module [row,col] cells that will flip over the next `n`
        // iterations (from the multi-step forecast). Snow variants pre-blink
        // these so the real change blends into the flicker.
        getChangingCells: function (n) { return unionFutureDiffs(n || getLookupSteps()); },
        // Cells (ranked least-differing-first) for the "gentlest transition" variant.
        getGentleCells: function () { return state.gentleCells || []; },
        getHorizon: function () { return getLookupSteps(); },
        getNoiseAmount: function () { return getNoiseAmount(); },
        getChangeAmount: function () { return getChangeAmount(); },
        getFadeMs: function () { return getFadeMs(); },
        onLog: function (msg, detail) { log(msg, detail); }
      });
    }

    if (rateInput) {
      state.changesPerSec = parseInt(rateInput.value, 10) || 1;
      rateInput.value = String(getRate());
      setMeta("d-interval", getRate() + " /s");
      rateInput.addEventListener("change", function () {
        state.changesPerSec = parseInt(rateInput.value, 10) || 1;
        rateInput.value = String(getRate());
        setMeta("d-interval", getRate() + " /s");
        cancelPrefetch();
        state.lastSlot = "";
        if (state.maskBalls) state.maskBalls.clearAssignments();
        log("Changes per second set", getRate());
        syncSettingsUrl();
        restartTimer();
        tick();
      });
    }

    if (lookupInput) {
      state.lookupSteps = parseInt(lookupInput.value, 10) || 6;
      lookupInput.value = String(getLookupSteps());
      setMeta("d-lookup", String(getLookupSteps()));
      lookupInput.addEventListener("change", function () {
        state.lookupSteps = parseInt(lookupInput.value, 10) || 6;
        lookupInput.value = String(getLookupSteps());
        state.forecastSteps = getLookupSteps();
        setMeta("d-lookup", String(getLookupSteps()));
        if (state.gentleMode) state._gentleAt = 0;
        cancelPrefetch();
        startPrefetch(currentSlot());
        log("Lookup steps set", getLookupSteps());
        syncSettingsUrl();
        adjustLayout();
      });
    }

    if (noiseInput) {
      var pct = parseInt(noiseInput.value, 10);
      if (!isFinite(pct)) pct = 50;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      state.noiseAmount = pct / 100;
      noiseInput.value = String(pct);
      setMeta("d-noise", pct + "%");
      noiseInput.addEventListener("change", function () {
        var p = parseInt(noiseInput.value, 10);
        if (!isFinite(p)) p = 50;
        if (p < 0) p = 0;
        if (p > 100) p = 100;
        state.noiseAmount = p / 100;
        noiseInput.value = String(p);
        setMeta("d-noise", p + "%");
        log("Noise amount set", p + "%");
        syncSettingsUrl();
        adjustLayout();
      });
    }

    if (changePctInput) {
      var cp = clampInt(changePctInput.value, 0, 100, 70);
      state.changeAmount = cp / 100;
      changePctInput.value = String(cp);
      setMeta("d-changepct", cp + "%");
      changePctInput.addEventListener("change", function () {
        var c = clampInt(changePctInput.value, 0, 100, 70);
        state.changeAmount = c / 100;
        changePctInput.value = String(c);
        setMeta("d-changepct", c + "%");
        log("Change preview % set", c + "%");
        syncSettingsUrl();
        adjustLayout();
      });
    }

    if (goalSelect) {
      state.genGoal = goalSelect.value === "balance" ? "balance" : "min";
      goalSelect.value = state.genGoal;
      setMeta("d-goal", state.genGoal);
      goalSelect.addEventListener("change", function () {
        state.genGoal = goalSelect.value === "balance" ? "balance" : "min";
        goalSelect.value = state.genGoal;
        setMeta("d-goal", state.genGoal);
        cancelPrefetch();
        state.lastSlot = "";
        log("Generation goal set", state.genGoal);
        syncSettingsUrl();
        adjustLayout();
        tick();
      });
    }

    if (fadeMsInput) {
      state.fadeMs = clampInt(fadeMsInput.value, 0, 2000, 0);
      fadeMsInput.value = String(state.fadeMs | 0);
      setMeta("d-fadems", (state.fadeMs | 0) > 0 ? (state.fadeMs + " ms") : ("auto " + getFadeMs() + " ms"));
      fadeMsInput.addEventListener("change", function () {
        state.fadeMs = clampInt(fadeMsInput.value, 0, 2000, 0);
        fadeMsInput.value = String(state.fadeMs | 0);
        setMeta("d-fadems", (state.fadeMs | 0) > 0 ? (state.fadeMs + " ms") : ("auto " + getFadeMs() + " ms"));
        log("Fade ms set", (state.fadeMs | 0) > 0 ? state.fadeMs : ("auto→" + getFadeMs()));
        syncSettingsUrl();
        adjustLayout();
      });
    }

    if (recInput) {
      state.recSeconds = clampInt(recInput.value, 1, 120, 5);
      recInput.value = String(getRecSeconds());
      setMeta("d-rec", getRecSeconds() + " s");
      recInput.addEventListener("change", function () {
        state.recSeconds = clampInt(recInput.value, 1, 120, 5);
        recInput.value = String(getRecSeconds());
        setMeta("d-rec", getRecSeconds() + " s");
        log("Record length set", getRecSeconds() + "s");
        syncSettingsUrl();
        adjustLayout();
      });
    }

    if (recordBtn) {
      recordBtn.addEventListener("click", function () {
        if (state.recording) return;
        startVideoExport();
      });
    }

    if (methodSelect) {
      if (!state.maskMethod || state.maskMethod === "snow3") {
        state.maskMethod = methodSelect.value || "snow3";
      } else if (methodSelect.querySelector('option[value="' + state.maskMethod + '"]')) {
        methodSelect.value = state.maskMethod;
      }
      applyMaskMethod(state.maskMethod, false);
      methodSelect.addEventListener("change", function () {
        var m = methodSelect.value || "snow3";
        log("Mask method", m);
        applyMaskMethod(m, true);
        adjustLayout();
      });
    } else {
      applyMaskMethod(state.maskMethod, false);
    }

    // Enable URL sync after initial apply (avoid clobbering typed deep-links mid-boot).
    state._urlSyncReady = true;
    syncSettingsUrl();
    if (Object.keys(fromUrl).length) {
      log("URL settings", fromUrl);
    }
  }

  function start() {
    showPlaceholder("Načítám QR…");
    setMeta("d-render", "—");
    bindControls();
    loadEngine()
      .then(function (engine) {
        if (engine.supportsStabilize) {
          return loadDecoder().catch(function (err) {
            log("Decoder unavailable, using canonical QR only", String(err && err.message ? err.message : err));
            setMeta("d-decoder", "none");
          }).then(function () {
            state.padLen = computePadLen(engine.api);
            state.pad = Array(state.padLen + 1).join("0").slice(0, state.padLen);
            setMeta("d-pad", String(state.padLen));
            setMeta("d-opts", ECC + " / " + VERSION + (IS_MOBILE ? " / mobile" : ""));
            log("Config", {
              version: VERSION,
              ecc: ECC,
              padLen: state.padLen,
              mobile: IS_MOBILE,
              decodeScale: DECODE_SCALE,
              stabilizeMs: STABILIZE_BUDGET_MS,
              changesPerSec: getRate()
            });
          });
        }
        state.padLen = 0;
        state.pad = "0";
        setMeta("d-pad", "0");
        setMeta("d-decoder", "n/a");
        setMeta("d-opts", ECC + " / auto");
      })
      .then(function () {
        tick();
        restartTimer();
        // Non-blocking tuning aid: compare grid profiles a few seconds after boot.
        if (state.api && state.decoder) {
          setTimeout(function () {
            measureGrid(state.api, 4).catch(function (err) {
              log("Grid measure error", String(err && err.message ? err.message : err));
            });
          }, 4000);
        }
      })
      .catch(function (err) {
        fail(err, "boot");
        showPlaceholder("QR knihovna se nenačetla — viz Debug");
      });
  }

  document.getElementById("debug-toggle").addEventListener("click", function () {
    debugEl.classList.toggle("open");
    syncSettingsUrl();
  });

  document.getElementById("btn-retry").addEventListener("click", function () {
    cancelPrefetch();
    state.lastEpoch = "";
    state.lastSlot = "";
    state.prevModules = null;
    log("Manual retry");
    if (!state.engineId) start();
    else tick();
  });

  document.getElementById("btn-clear").addEventListener("click", function () {
    logEl.textContent = "";
  });

  document.getElementById("btn-copy").addEventListener("click", function () {
    var payload = {
      appVersion: window.APP_VERSION || null,
      engine: state.engineId,
      source: state.source,
      decoder: state.decoderSource,
      render: state.renderMode,
      mobile: IS_MOBILE,
      version: VERSION,
      ecc: ECC,
      changesPerSec: getRate(),
      lookupSteps: getLookupSteps(),
      noiseAmount: Math.round(getNoiseAmount() * 100),
      changePct: Math.round(getChangeAmount() * 100),
      genGoal: state.genGoal,
      fadeMs: state.fadeMs | 0,
      fadeMsEffective: getFadeMs(),
      recSeconds: getRecSeconds(),
      settingsUrl: settingsUrlString(),
      fps: (document.getElementById("d-fps") || {}).textContent || null,
      maskMethod: state.maskMethod,
      maskBalls: !!(state.maskBalls && state.maskBalls.enabled),
      padLen: state.padLen,
      mask: state.mask,
      renders: state.renders,
      lastUrl: state.lastUrl,
      lastError: state.lastError,
      lastFlip: state.lastFlipReport || null,
      log: logEl.textContent,
      userAgent: navigator.userAgent,
      href: location.href
    };
    var text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        log("Debug copied to clipboard");
      }).catch(function (err) { fail(err, "clipboard"); });
    } else {
      log("Clipboard unavailable", text);
    }
  });

  window.addEventListener("error", function (ev) {
    fail(ev.error || ev.message, "window.error");
  });
  window.addEventListener("unhandledrejection", function (ev) {
    fail(ev.reason, "unhandledrejection");
  });

  if (window.APP_VERSION) {
    document.title = "v" + window.APP_VERSION + " het68 QR";
    var verEl = document.getElementById("d-version");
    if (verEl) verEl.textContent = window.APP_VERSION;
  }

  log("Boot", "v" + (window.APP_VERSION || "?") + " " + location.href + (IS_MOBILE ? " [mobile]" : " [desktop]"));
  start();
})();
