(function () {
  "use strict";

  var QR_OPTS = {
    errorCorrectionLevel: "H",
    version: 10,
    margin: 2,
    width: 320,
    color: { dark: "#000000", light: "#ffffff" }
  };

  /**
   * Local first, CDN only as fallback.
   * 1) vendor/qrcode.min.js  (node-qrcode, ECC H + fixed version 10)
   * 2) vendor/qrcodejs.min.js (qrcodejs, ECC H)
   * 3+) CDN mirrors of the same libraries
   */
  var SCRIPT_CANDIDATES = [
    { id: "local-qrcode", src: "vendor/qrcode.min.js", type: "classic" },
    { id: "local-qrcodejs", src: "vendor/qrcodejs.min.js", type: "qrcodejs" },
    { id: "cdn-jsdelivr-esm", src: "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm", type: "esm" },
    { id: "cdn-esm-sh", src: "https://esm.sh/qrcode@1.5.4", type: "esm" },
    { id: "cdn-qrcodejs-cdnjs", src: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js", type: "qrcodejs" },
    { id: "cdn-qrcodejs-jsdelivr", src: "https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@gh-pages/qrcode.min.js", type: "qrcodejs" }
  ];

  var qrHost = document.getElementById("qr");
  var urlEl = document.getElementById("url");
  var debugEl = document.getElementById("debug");
  var statusEl = document.getElementById("debug-status");
  var logEl = document.getElementById("d-log");

  var state = {
    engine: null,
    source: null,
    renders: 0,
    lastUrl: "",
    lastError: null,
    timer: null
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

  function buildUrl(epoch) {
    return "https://het68.cz/?qr=" + epoch;
  }

  function clearQr() {
    while (qrHost.firstChild) qrHost.removeChild(qrHost.firstChild);
  }

  function showPlaceholder(text) {
    clearQr();
    var div = document.createElement("div");
    div.className = "placeholder";
    div.textContent = text;
    qrHost.appendChild(div);
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

  function loadEsm(src) {
    return import(src);
  }

  function adaptNodeQrcode(mod, sourceId) {
    var api = mod && (mod.toCanvas || mod.default) ? (mod.toCanvas ? mod : mod.default) : null;
    if (!api || typeof api.toCanvas !== "function") {
      throw new Error("Module missing toCanvas");
    }
    return {
      id: "node-qrcode",
      source: sourceId,
      render: function (url) {
        clearQr();
        var canvas = document.createElement("canvas");
        qrHost.appendChild(canvas);
        return api.toCanvas(canvas, url, QR_OPTS).then(function () {
          return { engine: "node-qrcode", mode: "canvas" };
        });
      }
    };
  }

  function adaptQrcodejs(sourceId) {
    if (typeof window.QRCode !== "function" || !window.QRCode.CorrectLevel) {
      throw new Error("qrcodejs global missing");
    }
    return {
      id: "qrcodejs",
      source: sourceId,
      render: function (url) {
        clearQr();
        new window.QRCode(qrHost, {
          text: url,
          width: 320,
          height: 320,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: window.QRCode.CorrectLevel.H
        });
        return Promise.resolve({ engine: "qrcodejs", mode: "dom" });
      }
    };
  }

  function pickGlobalNodeQrcode(sourceId) {
    if (window.QRCode && typeof window.QRCode.toCanvas === "function") {
      return adaptNodeQrcode(window.QRCode, sourceId);
    }
    return null;
  }

  function loadEngine() {
    var i = 0;

    function tryNext() {
      if (i >= SCRIPT_CANDIDATES.length) {
        return Promise.reject(new Error("All QR engines failed to load"));
      }
      var cand = SCRIPT_CANDIDATES[i++];
      log("Trying engine source", cand.id + " (" + cand.type + ")");
      setMeta("d-source", "loading " + cand.id);
      setStatus("warn", "loading");

      var attempt;
      if (cand.type === "esm") {
        attempt = loadEsm(cand.src).then(function (mod) {
          return adaptNodeQrcode(mod, cand.id);
        });
      } else if (cand.type === "qrcodejs") {
        attempt = loadScript(cand.src).then(function () {
          return adaptQrcodejs(cand.id);
        });
      } else {
        attempt = loadScript(cand.src).then(function () {
          var eng = pickGlobalNodeQrcode(cand.id);
          if (!eng) throw new Error("Global QRCode.toCanvas not found after " + cand.id);
          return eng;
        });
      }

      return attempt.then(function (engine) {
        state.engine = engine;
        setMeta("d-engine", engine.id);
        setMeta("d-source", engine.source);
        setMeta("d-opts", engine.id === "qrcodejs" ? "H / auto" : "H / 10");
        log("Engine ready", engine.id + " via " + engine.source);
        setStatus("ok", "ready");
        return engine;
      }).catch(function (err) {
        fail(err, cand.id);
        return tryNext();
      });
    }

    return tryNext();
  }

  function render(url) {
    if (!state.engine) return Promise.reject(new Error("No engine"));
    setMeta("d-url", url);
    urlEl.textContent = url;
    return state.engine.render(url).then(function (info) {
      state.renders += 1;
      state.lastError = null;
      setMeta("d-renders", String(state.renders));
      setMeta("d-error", "none");
      setMeta("d-tick", now());
      setStatus("ok", "ok");
      if (state.renders <= 3 || state.renders % 30 === 0) {
        log("Rendered", info.engine + "/" + info.mode + " #" + state.renders);
      }
    });
  }

  function tick() {
    var url = buildUrl(Math.floor(Date.now() / 1000));
    if (url === state.lastUrl) return;
    state.lastUrl = url;
    render(url).catch(function (err) {
      fail(err, "render");
      showPlaceholder("QR render failed — viz Debug");
    });
  }

  function start() {
    showPlaceholder("Načítám QR…");
    loadEngine().then(function () {
      tick();
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(tick, 1000);
    }).catch(function (err) {
      fail(err, "boot");
      showPlaceholder("QR knihovna se nenačetla — viz Debug");
    });
  }

  document.getElementById("debug-toggle").addEventListener("click", function () {
    debugEl.classList.toggle("open");
  });

  document.getElementById("btn-retry").addEventListener("click", function () {
    state.lastUrl = "";
    log("Manual retry");
    if (!state.engine) {
      start();
    } else {
      tick();
    }
  });

  document.getElementById("btn-clear").addEventListener("click", function () {
    logEl.textContent = "";
  });

  document.getElementById("btn-copy").addEventListener("click", function () {
    var payload = {
      engine: state.engine && state.engine.id,
      source: state.engine && state.engine.source,
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
