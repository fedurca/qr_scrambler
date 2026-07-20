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
  // Measured avg flips over sequential epochs (vm harness, jsQR-verified):
  //   v3+L 28 (3.33%) · v4+Q 41 (3.76%) · v4+H 28 (2.57%) · v5+Q 30 (2.19%) · v5+H 35 (2.56%)
  // v4+H gives the fewest absolute flips at the same 33x33 density we already
  // ship, so it is the default. v5+Q has the lowest percentage if a denser
  // (37x37) symbol is acceptable — switch here and confirm cheap-phone reading.
  var VERSION = 4;
  var ECC = "H";
  var MARGIN = 2;
  var DRAW_SIZE = IS_MOBILE ? 260 : 300;
  var DECODE_SCALE = 4;
  /** Candidate profiles for the boot-time flip measurement (tuning aid only). */
  var GRID_PROFILES = [
    { version: 4, ecc: "H" },
    { version: 5, ecc: "Q" },
    { version: 5, ecc: "H" },
    { version: 3, ecc: "L" }
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
    epochIntervalSec: 5,
    maskBalls: null,
    maskFx: null,
    maskMethod: "crossfade",
    pendingDiffs: null,
    forecastHorizon: 8,
    lastPlanSnap: null
  };

  function getEpochIntervalSec() {
    var n = parseInt(state.epochIntervalSec, 10);
    if (!isFinite(n) || n < 1) return 1;
    if (n > 120) return 120;
    return n;
  }

  function currentSlot() {
    return Math.floor(Date.now() / 1000 / getEpochIntervalSec());
  }

  function slotChangeAtMs(slot) {
    // Wall-clock ms when this slot index begins.
    return slot * getEpochIntervalSec() * 1000;
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
    return { rect: rect, size: size, margin: MARGIN };
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
    if (!best || flips < best.flips) {
      return { flips: flips, modules: copyModules(modules), tag: tag || (best && best.tag) || "stabilize" };
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
    var best = { flips: listDiffs(prev, neu).length, modules: copyModules(neu), tag: "canonical" };
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
      if (!best || raw < best.raw) {
        best = { url: url, pad: pad, mask: mask, modules: modules, raw: raw };
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
   * Hill-climb the free pad to minimize the raw module distance to prev for a
   * fixed mask. The pad occupies free data codewords, so aligning it with the
   * previous frame directly shrinks the forced changes before RS sacrifice.
   * Objective is raw Hamming (cheap, strong proxy for post-sacrifice flips).
   */
  function optimizePad(api, epoch, prevModules, startPad, mask, deadline, shouldCancel) {
    var pad = startPad || "";
    var url = buildUrl(epoch, pad);
    var mods = createModules(api, url, mask);
    var bestRaw = listDiffs(prevModules, mods).length;
    var len = pad.length;
    if (len === 0) return { pad: pad, url: url, mask: mask, modules: mods, raw: bestRaw };
    var stale = 0;
    var cap = len * 4;
    while (Date.now() < deadline && stale < cap) {
      if (shouldCancel && shouldCancel()) break;
      var pos = (Math.random() * len) | 0;
      var ch = PAD_ALPHABET[(Math.random() * PAD_ALPHABET.length) | 0];
      if (ch === pad.charAt(pos)) continue;
      var trialPad = mutatePadAt(pad, pos, ch);
      var turl = buildUrl(epoch, trialPad);
      var tmods = createModules(api, turl, mask);
      var raw = listDiffs(prevModules, tmods).length;
      if (raw < bestRaw) {
        bestRaw = raw;
        pad = trialPad;
        url = turl;
        mods = tmods;
        stale = 0;
      } else {
        stale += 1;
      }
    }
    return { pad: pad, url: url, mask: mask, modules: mods, raw: bestRaw };
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
      all.push({ url: url, pad: pad, mask: mask, modules: modules, raw: listDiffs(prevModules, modules).length });
    }
    var mask;
    for (mask = 0; mask < 8; mask++) consider(startPad, mask);
    all.sort(function (a, b) { return a.raw - b.raw; });
    var m0 = all[0].mask;

    // Hill-climb the pad on the best starting mask for the bulk of the budget.
    var opt = optimizePad(api, epoch, prevModules, startPad, m0, deadline, shouldCancel);
    // Re-scan masks on the optimized pad (mask shifts the whole data pattern).
    for (mask = 0; mask < 8; mask++) consider(opt.pad, mask);

    all.sort(function (a, b) { return a.raw - b.raw; });
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
    for (var i = 0; i < cands.length; i++) {
      if (shouldCancel && shouldCancel()) break;
      var remaining = deadlineAll - Date.now();
      if (remaining <= 40 && bestRes) break;
      var b = Math.max(60, Math.min(perBudget, remaining));
      var res = await stabilize(prevModules, cands[i].modules, cands[i].url, b, shouldCancel);
      if (!bestRes || res.flips < bestRes.flips) {
        bestRes = res;
        bestCanon = cands[i];
      }
      if (bestRes.flips <= 2) break; // already near-optimal
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
    state.maskBalls.setForecast(events, { intervalMs: getEpochIntervalSec() * 1000 });
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
    var interval = getEpochIntervalSec();
    // With balls on: next flip is critical; 2–3 steps ahead is enough travel time
    var horizon = state.maskBalls && state.maskBalls.enabled
      ? Math.max(2, Math.min(3, state.forecastHorizon | 0))
      : 1;
    var nextSlot = slotJustShown + 1;
    var nextEpoch = nextSlot * interval;
    var token = {
      cancelled: false,
      slot: nextSlot,
      epoch: nextEpoch,
      ready: null,
      horizon: horizon
    };
    state.prefetch = token;

    var changeAt = slotChangeAtMs(nextSlot);
    var msLeft = Math.max(200, changeAt - Date.now() - 40);
    var budget1 = Math.min(PREFETCH_BUDGET_MS, Math.max(STABILIZE_BUDGET_MS, msLeft * 0.85));

    token.ready = (async function () {
      var mods = state.prevModules;
      var pad = state.pad;
      var events = [];
      var firstFrame = null;

      for (var step = 1; step <= horizon; step++) {
        if (token.cancelled) return null;
        var slot = slotJustShown + step;
        var epoch = slot * interval;
        // Keep later horizon steps useful — do not collapse budget to near-zero
        var budget = step === 1
          ? budget1
          : Math.min(
              IS_MOBILE ? 280 : 420,
              Math.max(IS_MOBILE ? 140 : 200, budget1 * Math.max(0.28, 0.72 - step * 0.05))
            );
        var frame = await buildFrame(
          state.api,
          epoch,
          mods,
          pad,
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
        // Push partial forecast early so balls can start aiming while later steps compute
        if (!token.cancelled && (step === 1 || step === 3 || step === horizon)) {
          if (events[0] && events[0].diffs) state.pendingDiffs = events[0].diffs;
          pushForecastToBalls(events.slice());
        }
        mods = frame.result.modules;
        pad = frame.canonical.pad;
        await yieldToBrowser();
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
    setMeta("d-interval", getEpochIntervalSec() + " s");

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
        interval: getEpochIntervalSec(),
        render: state.renderMode,
        prefetch: !!fromPrefetch,
        ms: Date.now() - started
      });
    }

    startPrefetch(currentSlot());
  }

  function tick() {
    if (state.busy) return;
    var interval = getEpochIntervalSec();
    var slot = currentSlot();
    var slotKey = String(slot) + "@" + interval;
    if (slotKey === state.lastSlot) return;
    state.lastSlot = slotKey;

    // Encode the unix epoch at the moment of the step (not the slot index).
    var epoch = Math.floor(Date.now() / 1000);
    state.lastEpoch = String(epoch);
    state.busy = true;
    var started = Date.now();

    Promise.resolve()
      .then(async function () {
        if (state.simpleRenderer && !state.api) {
          var simpleUrl = buildUrl(epoch, state.pad || "0");
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
        // For deferred-swap methods (crossfade) keep the previous frame on screen
        // so the change fades in from it instead of popping to the canonical.
        var deferSwap = state.prevModules && state.maskFx && state.maskFx.wantsDeferredSwap();
        if (!deferSwap) {
          var quick = chooseCanonical(state.api, epoch, state.prevModules, state.pad);
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
            var prefEpoch = codec.decodePayload(pref.canonical.url);
            if (prefEpoch === epoch) {
              applyFrame(epoch, pref.canonical, pref.result, started, true);
              return;
            }
            // Prediction drifted by a second — keep matrix search warm via rebuild.
            log("Prefetch epoch drift", { prefEpoch: prefEpoch, epoch: epoch });
          }
        }

        cancelPrefetch();
        var msIntoSlot = Date.now() - slotChangeAtMs(slot);
        var budget = Math.max(120, Math.min(STABILIZE_BUDGET_MS, interval * 1000 - msIntoSlot - 40));
        var frame = await buildFrame(state.api, epoch, state.prevModules, state.pad, budget, null);
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

  function applyMaskMethod(method, rebuild) {
    state.maskMethod = method;
    var ballsOn = method === "balls";
    if (state.maskBalls) state.maskBalls.setEnabled(ballsOn);
    if (state.maskFx) state.maskFx.setMethod(method);
    setMeta("d-mask", method);
    if (ballsOn && rebuild) {
      cancelPrefetch();
      startPrefetch(currentSlot());
    }
  }

  function bindControls() {
    var intervalInput = document.getElementById("epoch-interval");
    var methodSelect = document.getElementById("mask-method");

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
        onLog: function (msg, detail) { log(msg, detail); }
      });
    }

    if (intervalInput) {
      state.epochIntervalSec = parseInt(intervalInput.value, 10) || 5;
      setMeta("d-interval", getEpochIntervalSec() + " s");
      intervalInput.addEventListener("change", function () {
        state.epochIntervalSec = parseInt(intervalInput.value, 10) || 5;
        intervalInput.value = String(getEpochIntervalSec());
        setMeta("d-interval", getEpochIntervalSec() + " s");
        cancelPrefetch();
        state.lastSlot = "";
        // Drop stale timed jobs — slot clock changed with the interval
        if (state.maskBalls) state.maskBalls.clearAssignments();
        log("Epoch interval set", getEpochIntervalSec() + "s");
        tick();
      });
    }

    if (methodSelect) {
      state.maskMethod = methodSelect.value || "crossfade";
      applyMaskMethod(state.maskMethod, false);
      methodSelect.addEventListener("change", function () {
        var m = methodSelect.value || "crossfade";
        log("Mask method", m);
        applyMaskMethod(m, true);
      });
    } else {
      applyMaskMethod(state.maskMethod, false);
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
              intervalSec: getEpochIntervalSec()
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
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(tick, 100);
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
      epochIntervalSec: getEpochIntervalSec(),
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
