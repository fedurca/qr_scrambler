#!/usr/bin/env node
/**
 * Build a self-contained index.html (CSS + vendor + app inlined).
 * Needed for hosts that serve the same HTML for every path (no static assets).
 */
"use strict";

var fs = require("fs");
var path = require("path");

var root = path.join(__dirname, "..");
var pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
var version = pkg.version;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

var css = read("css/styles.css");
var qrcode = read("vendor/qrcode.min.js");
var jsqr = read("vendor/jsQR.js");
var versionJs = "window.APP_VERSION=" + JSON.stringify(version) + ";\n";
var codec = read("js/codec.js");
var qrStructure = read("js/qr-structure.js");
var maskBalls = read("js/mask-balls.js");
var maskArcade = read("js/mask-arcade.js");
var maskMethods = read("js/mask-methods.js");
var app = read("js/app.js");

var html = `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="application-version" content="${version}" />
  <title>v${version} het68 QR</title>
  <style>
${css}
  </style>
</head>
<body>
  <section id="controls" aria-label="Nastavení">
    <label>
      Interval epochy (s)
      <input id="epoch-interval" type="number" min="1" max="120" step="1" value="1" />
    </label>
    <label>
      Maskování
      <select id="mask-method">
        <option value="snow3" selected>Změny + sníh</option>
        <option value="snow1">Jen změny</option>
        <option value="snow2">Změny + šum</option>
        <option value="snow4">Změny + roj</option>
        <option value="snow5">Změny + sken</option>
        <option value="none">Žádné</option>
      </select>
    </label>
  </section>

  <main>
    <div id="qr" aria-label="QR kód">
      <div class="placeholder">Načítám QR…</div>
    </div>
    <p id="url"></p>
  </main>

  <aside id="debug" aria-label="Debug">
    <header id="debug-toggle">
      <strong>Debug</strong>
      <span id="debug-status" class="status-pill warn">init</span>
    </header>
    <div class="body">
      <dl>
        <dt>version</dt><dd id="d-version">${version}</dd>
        <dt>engine</dt><dd id="d-engine">—</dd>
        <dt>source</dt><dd id="d-source">—</dd>
        <dt>decoder</dt><dd id="d-decoder">—</dd>
        <dt>ecc / ver</dt><dd id="d-opts">H / 4</dd>
        <dt>render</dt><dd id="d-render">—</dd>
        <dt>interval</dt><dd id="d-interval">1 s</dd>
        <dt>mask</dt><dd id="d-mask">snow3</dd>
        <dt>forecast</dt><dd id="d-forecast">—</dd>
        <dt>ball pos</dt><dd id="d-ballpos">—</dd>
        <dt>last flip</dt><dd id="d-flip">—</dd>
        <dt>pad len</dt><dd id="d-pad">—</dd>
        <dt>epoch</dt><dd id="d-epoch">—</dd>
        <dt>raw Δ</dt><dd id="d-raw">—</dd>
        <dt>flips</dt><dd id="d-flips">—</dd>
        <dt>flip %</dt><dd id="d-pct">—</dd>
        <dt>~CSS px</dt><dd id="d-csspx">—</dd>
        <dt>orders</dt><dd id="d-orders">—</dd>
        <dt>url</dt><dd id="d-url">—</dd>
        <dt>renders</dt><dd id="d-renders">0</dd>
        <dt>last tick</dt><dd id="d-tick">—</dd>
        <dt>last error</dt><dd id="d-error">none</dd>
      </dl>
      <pre id="d-log" class="log"></pre>
      <div class="actions">
        <button type="button" id="btn-retry">Retry render</button>
        <button type="button" id="btn-clear">Clear log</button>
        <button type="button" id="btn-copy">Copy debug</button>
      </div>
    </div>
  </aside>

  <script>
/* qrcode.min.js */
${qrcode}
  </script>
  <script>
/* jsQR.js */
${jsqr}
  </script>
  <script>
${versionJs}
  </script>
  <script>
${codec}
  </script>
  <script>
${qrStructure}
  </script>
  <script>
${maskBalls}
  </script>
  <script>
${maskArcade}
  </script>
  <script>
${maskMethods}
  </script>
  <script>
${app}
  </script>
</body>
</html>
`;

var out = path.join(root, "index.html");
fs.writeFileSync(out, html, "utf8");
console.log("Wrote", out, "(" + Buffer.byteLength(html) + " bytes, v" + version + ")");
