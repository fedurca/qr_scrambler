(function () {
  "use strict";

  /**
   * Minimize modules that flip between consecutive seconds.
   *
   * Tuned config (visual % of modules at fixed display size):
   *   QR version 40 + ECC Q + long pad + dual-direction ECC stabilize
   *   + predictive prefetch (~0.27% modules/frame typical)
   *
   * Pipeline:
   * 1) Encode epoch into long fixed-length URL (fills capacity).
   * 2) Pick best mask / pad mutant vs previous displayed frame.
   * 3) Search matrices inside the new URL's ECC decoding basin that
   *    stay as close as possible to the previous frame (from-new +
   *    from-old binary search, mutations, polish).
   * 4) Prefetch the next second in the remaining wall-clock time.
   */

  var VERSION = 40;
  var ECC = "Q";
  var MARGIN = 2;
  var DRAW_SIZE = 320;
  var DECODE_SCALE = 1;
  var STABILIZE_BUDGET_MS = 900;
  var PREFETCH_BUDGET_MS = 1400;
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
  var canvas = null;

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
    lastError: null,
    busy: false,
    timer: null,
    simpleRenderer: null,
    prefetch: null
  };

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

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Script load failed: " + src)); };
      document.head.appendChild(s);
    });
  }

  function yieldToBrowser() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function ensureCanvas() {
    if (canvas && canvas.parentNode === qrHost) return canvas;
    while (qrHost.firstChild) qrHost.removeChild(qrHost.firstChild);
    canvas = document.createElement("canvas");
    qrHost.appendChild(canvas);
    return canvas;
  }

  function showPlaceholder(text) {
    canvas = null;
    while (qrHost.firstChild) qrHost.removeChild(qrHost.firstChild);
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
    return {
      size: size,
      data: data,
      get: function (row, col) { return this.data[row * this.size + col]; },
      set: function (row, col, value) { this.data[row * this.size + col] = value ? 1 : 0; }
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

  function buildUrl(epoch, pad) {
    return codec.encodePayload(epoch, pad);
  }

  function randomPad(len, basePad) {
    if (!basePad || basePad.length !== len) {
      return Array(len + 1).join("0").slice(0, len);
    }
    var chars = basePad.split("");
    var changes = 1 + ((Math.random() * 3) | 0);
    for (var i = 0; i < changes; i++) {
      chars[(Math.random() * len) | 0] = PAD_ALPHABET[(Math.random() * PAD_ALPHABET.length) | 0];
    }
    return chars.join("");
  }

  function computePadLen(api) {
    var probe = String(Math.floor(Date.now() / 1000)) + ".";
    var prefix = codec.BASE + probe;
    var lo = 0;
    var hi = 8000;
    var best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      try {
        var q = api.create(prefix + Array(mid + 1).join("A"), {
          version: VERSION,
          errorCorrectionLevel: ECC
        });
        if (q.version !== VERSION) {
          hi = mid - 1;
        } else {
          best = mid;
          lo = mid + 1;
        }
      } catch (e) {
        hi = mid - 1;
      }
    }
    return best;
  }

  function createModules(api, text, maskPattern) {
    return api.create(text, {
      version: VERSION,
      errorCorrectionLevel: ECC,
      maskPattern: maskPattern
    }).modules;
  }

  function paintToImageData(modules, scale, margin) {
    var size = moduleSize(modules);
    var n = size + margin * 2;
    var px = n * scale;
    var img = new ImageData(px, px);
    var data = img.data;
    for (var i = 0; i < data.length; i += 4) {
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
    var img = paintToImageData(modules, DECODE_SCALE, MARGIN);
    var result = state.decoder(img.data, img.width, img.height, {
      inversionAttempts: "dontInvert"
    });
    return result && result.data ? result.data : null;
  }

  function drawModules(modules) {
    var cnv = ensureCanvas();
    var size = moduleSize(modules);
    var n = size + MARGIN * 2;
    var scale = Math.max(1, Math.floor(DRAW_SIZE / n));
    var px = n * scale;
    cnv.width = px;
    cnv.height = px;
    var ctx = cnv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!moduleGet(modules, r, c)) continue;
        ctx.fillRect((c + MARGIN) * scale, (r + MARGIN) * scale, scale, scale);
      }
    }
  }

  function considerCandidate(best, modules, targetUrl, prev) {
    if (decodeModules(modules) !== targetUrl) return best;
    var flips = hamming(prev, modules);
    if (!best || flips < best.flips) {
      return { flips: flips, modules: copyModules(modules) };
    }
    return best;
  }

  /**
   * Dual-direction ECC-basin search with mutations.
   * Async so we can yield and support prefetch cancellation.
   */
  async function stabilize(prev, neu, targetUrl, budgetMs, shouldCancel) {
    var d = listDiffs(prev, neu);
    if (!state.decoder) {
      return { modules: neu, flips: d.length, raw: d.length, orders: 0, mode: "canonical" };
    }
    if (decodeModules(neu) !== targetUrl) {
      return { modules: neu, flips: d.length, raw: d.length, orders: 0, mode: "canonical-fallback" };
    }

    var started = Date.now();
    var deadline = started + budgetMs;
    var best = { flips: d.length, modules: copyModules(neu) };
    var orders = 0;

    best = considerCandidate(best, neu, targetUrl, prev);

    while (Date.now() < deadline) {
      if (shouldCancel && shouldCancel()) {
        break;
      }
      orders += 1;
      var order = d.slice();
      shuffleInPlace(order);

      // Path A: minimal flips from previous -> new basin.
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
        } else {
          lo = mid + 1;
        }
      }
      best = considerCandidate(best, ansOld, targetUrl, prev);

      // Path B: maximal revert from new -> previous.
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
        } else {
          hi = mid - 1;
        }
      }
      best = considerCandidate(best, ansNew, targetUrl, prev);

      // Mutations: pull a few diffs of the current best toward previous.
      var mut = copyModules(best.modules);
      var mcount = 1 + ((Math.random() * 3) | 0);
      var t;
      for (t = 0; t < mcount; t++) {
        var cell = d[(Math.random() * d.length) | 0];
        mut.set(cell[0], cell[1], moduleGet(prev, cell[0], cell[1]));
      }
      best = considerCandidate(best, mut, targetUrl, prev);

      if (orders % 2 === 0) {
        await yieldToBrowser();
      }
    }

    // Final polish: greedily pull leftovers toward previous.
    var polished = copyModules(best.modules);
    var leftovers = d.filter(function (rc) {
      return !!polished.get(rc[0], rc[1]) !== !!moduleGet(prev, rc[0], rc[1]);
    });
    shuffleInPlace(leftovers);
    var polishDeadline = Math.max(deadline, Date.now() + 120);
    for (t = 0; t < leftovers.length && Date.now() < polishDeadline; t++) {
      if (shouldCancel && shouldCancel()) break;
      cell = leftovers[t];
      var before = polished.get(cell[0], cell[1]);
      polished.set(cell[0], cell[1], moduleGet(prev, cell[0], cell[1]));
      if (decodeModules(polished) !== targetUrl) {
        polished.set(cell[0], cell[1], before);
      }
    }

    return {
      modules: polished,
      flips: hamming(prev, polished),
      raw: d.length,
      orders: orders,
      mode: "ecc-stabilize"
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

    var t;
    for (t = 0; t < 10; t++) {
      consider(randomPad(state.padLen, best.pad), best.mask);
    }

    return best;
  }

  async function buildFrame(api, epoch, prevModules, prevPad, budgetMs, shouldCancel) {
    var canonical = chooseCanonical(api, epoch, prevModules, prevPad || state.pad);
    if (!prevModules) {
      return {
        canonical: canonical,
        result: {
          modules: copyModules(canonical.modules),
          flips: 0,
          raw: 0,
          orders: 0,
          mode: "initial"
        }
      };
    }
    var result = await stabilize(
      prevModules,
      canonical.modules,
      canonical.url,
      budgetMs,
      shouldCancel
    );
    return { canonical: canonical, result: result };
  }

  function cancelPrefetch() {
    if (state.prefetch) state.prefetch.cancelled = true;
  }

  function startPrefetch(epochJustShown) {
    if (!state.api || !state.prevModules) return;
    cancelPrefetch();
    var nextEpoch = epochJustShown + 1;
    var token = { cancelled: false, epoch: nextEpoch, ready: null };
    state.prefetch = token;

    var msLeft = Math.max(200, 1000 - (Date.now() % 1000) - 30);
    var budget = Math.min(PREFETCH_BUDGET_MS, msLeft + 200);

    token.ready = buildFrame(
      state.api,
      nextEpoch,
      state.prevModules,
      state.pad,
      budget,
      function () { return token.cancelled; }
    ).then(function (frame) {
      if (token.cancelled) return null;
      token.frame = frame;
      return frame;
    }).catch(function (err) {
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
    return {
      id: "node-qrcode",
      source: sourceId,
      api: api,
      supportsStabilize: true
    };
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
        while (qrHost.firstChild) qrHost.removeChild(qrHost.firstChild);
        canvas = null;
        new window.QRCode(qrHost, {
          text: url,
          width: DRAW_SIZE,
          height: DRAW_SIZE,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: window.QRCode.CorrectLevel.Q
        });
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
    var i = 0;
    function next() {
      if (i >= DECODER_CANDIDATES.length) {
        return Promise.reject(new Error("jsQR failed to load"));
      }
      var cand = DECODER_CANDIDATES[i++];
      log("Trying decoder", cand.id);
      return loadScript(cand.src).then(function () {
        if (typeof window.jsQR !== "function") {
          throw new Error("jsQR global missing after " + cand.id);
        }
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
        attempt = import(cand.src).then(function (mod) {
          return adaptNodeQrcode(mod, cand.id);
        });
      } else if (cand.type === "qrcodejs") {
        attempt = loadScript(cand.src).then(function () {
          return adaptQrcodejs(cand.id);
        });
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
    }

    state.pad = canonical.pad;
    state.mask = canonical.mask;
    state.prevModules = copyModules(result.modules);
    state.lastUrl = canonical.url;

    drawModules(result.modules);
    urlEl.textContent = canonical.url;
    setMeta("d-url", canonical.url);
    setMeta("d-epoch", String(decodedEpoch));
    setMeta("d-opts", ECC + " / " + VERSION + " / mask " + canonical.mask);
    setMeta("d-pad", String(state.padLen));
    setMeta("d-flips", String(result.flips) + " (" + result.mode + (fromPrefetch ? ", prefetch" : "") + ")");
    setMeta("d-raw", String(result.raw));
    setMeta("d-orders", String(result.orders || 0));

    var total = moduleSize(result.modules) * moduleSize(result.modules);
    var pct = total ? ((100 * result.flips) / total).toFixed(3) : "0";
    setMeta("d-pct", pct + "%");

    state.renders += 1;
    setMeta("d-renders", String(state.renders));
    setMeta("d-tick", now());
    setMeta("d-error", "none");
    state.lastError = null;
    setStatus("ok", "ok");

    if (state.renders <= 5 || state.renders % 30 === 0) {
      log("Stabilized", {
        flips: result.flips,
        raw: result.raw,
        pct: pct + "%",
        epoch: decodedEpoch,
        orders: result.orders || 0,
        mask: canonical.mask,
        prefetch: !!fromPrefetch,
        ms: Date.now() - started
      });
    }

    startPrefetch(epoch);
  }

  function tick() {
    if (state.busy) return;
    var epoch = Math.floor(Date.now() / 1000);
    var epochKey = String(epoch);
    if (epochKey === state.lastEpoch) return;
    state.lastEpoch = epochKey;
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
          return;
        }

        // Prefer prefetched frame for this epoch.
        var pre = state.prefetch;
        if (pre && pre.epoch === epoch && pre.ready) {
          var pref = await pre.ready;
          if (pref && pref.canonical && pref.result) {
            applyFrame(epoch, pref.canonical, pref.result, started, true);
            return;
          }
        }

        cancelPrefetch();
        var budget = Math.max(200, Math.min(STABILIZE_BUDGET_MS, 1000 - (Date.now() % 1000) - 20));
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

  function start() {
    showPlaceholder("Načítám QR…");
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
            setMeta("d-opts", ECC + " / " + VERSION);
            log("Config", {
              version: VERSION,
              ecc: ECC,
              padLen: state.padLen,
              decodeScale: DECODE_SCALE,
              stabilizeMs: STABILIZE_BUDGET_MS,
              prefetchMs: PREFETCH_BUDGET_MS
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
      engine: state.engineId,
      source: state.source,
      decoder: state.decoderSource,
      version: VERSION,
      ecc: ECC,
      padLen: state.padLen,
      mask: state.mask,
      renders: state.renders,
      lastUrl: state.lastUrl,
      lastError: state.lastError,
      log: logEl.textContent,
      userAgent: navigator.userAgent,
      href: location.href
    };
    var text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        log("Debug copied to clipboard");
      }).catch(function (err) {
        fail(err, "clipboard");
      });
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

  log("Boot", location.href);
  start();
})();
