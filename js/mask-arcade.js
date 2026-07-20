/**
 * In-QR "arcade" masking: Snake, Tetris, Game of Life, Snow.
 *
 * Unlike an ambient border animation, these draw BLACK, module-aligned pixels
 * directly ON the QR grid — a snake crawls through the code, Game-of-Life
 * gliders pass across it, tetrominoes fall through it, snow drifts down it.
 *
 * Why it still scans: the displayed frame is a valid QR codeword, so the reader
 * has the full Reed-Solomon budget spare (v4+H corrects ~30% of codewords). The
 * entities are kept sparse and in constant motion, so at any instant only a few
 * modules are overlaid — well within error correction — while the motion over
 * the changed region hides the per-interval flip (change blindness + occlusion).
 *
 * The overlay canvas is positioned exactly over the QR content rect and cells
 * are mapped to module coordinates (inside the symbol, never the quiet zone).
 */
(function (global) {
  "use strict";

  var STEP_MS = { snake: 110, tetris: 130, life: 160, snow: 120 };
  var INK = "#000000";

  function MaskArcade(opts) {
    opts = opts || {};
    this.getQrInfo = opts.getQrInfo || function () { return null; };
    this.mode = null;
    this.canvas = null;
    this.ctx = null;
    this.raf = 0;
    this.lastStep = 0;
    this.dpr = 1;
    this.size = 0;       // modules per side (data area)
    this.margin = 2;
    this.cell = 0;       // device px per module
    this.state = null;
    this._loop = this.loop.bind(this);
  }

  MaskArcade.MODES = ["snake", "tetris", "life", "snow"];

  MaskArcade.prototype.ensureCanvas = function () {
    if (this.canvas) return this.canvas;
    var c = document.createElement("canvas");
    c.id = "mask-arcade-canvas";
    c.setAttribute("aria-hidden", "true");
    c.style.position = "fixed";
    c.style.left = "0px";
    c.style.top = "0px";
    c.style.pointerEvents = "none";
    c.style.zIndex = "30";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
    return c;
  };

  /** Align the canvas to the QR content rect; returns false if geometry unknown. */
  MaskArcade.prototype.sync = function () {
    var info = this.getQrInfo();
    if (!info || !info.rect) return false;
    this.ensureCanvas();
    this.dpr = Math.min(2, global.devicePixelRatio || 1);
    this.size = info.size;
    this.margin = info.margin;
    var rect = info.rect;
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    this.canvas.style.left = Math.round(rect.left) + "px";
    this.canvas.style.top = Math.round(rect.top) + "px";
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    var n = this.size + this.margin * 2;
    this.cell = this.canvas.width / n;
    return true;
  };

  MaskArcade.prototype.setMode = function (mode) {
    if (MaskArcade.MODES.indexOf(mode) < 0) mode = null;
    this.mode = mode;
    this.stop();
    if (!mode) {
      if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.canvas) this.canvas.style.display = "none";
      return;
    }
    this.ensureCanvas();
    this.canvas.style.display = "block";
    if (!this.sync()) {
      // QR not painted yet — retry shortly
      var self = this;
      setTimeout(function () { if (self.mode === mode) self.setMode(mode); }, 120);
      return;
    }
    if (mode === "snake") this.state = this.newSnake();
    else if (mode === "tetris") this.state = this.newTetris();
    else if (mode === "life") this.state = this.newLife();
    else this.state = this.newSnow();
    this.lastStep = 0;
    this.raf = requestAnimationFrame(this._loop);
  };

  MaskArcade.prototype.stop = function () {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  };

  MaskArcade.prototype.loop = function (ts) {
    if (!this.mode) { this.raf = 0; return; }
    this.sync();
    var interval = STEP_MS[this.mode] || 130;
    if (!this.lastStep || ts - this.lastStep >= interval) {
      this.lastStep = ts;
      if (this.mode === "snake") this.stepSnake();
      else if (this.mode === "tetris") this.stepTetris();
      else if (this.mode === "life") this.stepLife();
      else this.stepSnow();
      this.draw();
    }
    this.raf = requestAnimationFrame(this._loop);
  };

  /** Draw one module cell (module coords) as black. */
  MaskArcade.prototype.fillModule = function (col, row) {
    if (col < 0 || row < 0 || col >= this.size || row >= this.size) return;
    var px = (col + this.margin) * this.cell;
    var py = (row + this.margin) * this.cell;
    // Full-cell fill so it reads as a module (no gap seams against the code).
    this.ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(this.cell), Math.ceil(this.cell));
  };

  MaskArcade.prototype.beginInk = function () {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = INK;
  };

  // ---- Snake -------------------------------------------------------------
  MaskArcade.prototype.newSnake = function () {
    var s = (this.size / 2) | 0;
    var body = [];
    for (var i = 0; i < 10; i++) body.push({ x: s - i, y: s });
    return { body: body, dir: { x: 1, y: 0 }, len: 12, turn: 0 };
  };

  MaskArcade.prototype.stepSnake = function () {
    var st = this.state;
    var head = st.body[0];
    // Occasionally turn (biased to keep crawling across the code).
    st.turn -= 1;
    if (st.turn <= 0 && Math.random() < 0.5) {
      var left = { x: st.dir.y, y: -st.dir.x };
      var right = { x: -st.dir.y, y: st.dir.x };
      st.dir = Math.random() < 0.5 ? left : right;
      st.turn = 2 + ((Math.random() * 4) | 0);
    }
    var nx = head.x + st.dir.x;
    var ny = head.y + st.dir.y;
    // Bounce off the symbol edges (reflect the component that went out).
    if (nx < 0 || nx >= this.size) { st.dir.x = -st.dir.x; nx = head.x + st.dir.x; }
    if (ny < 0 || ny >= this.size) { st.dir.y = -st.dir.y; ny = head.y + st.dir.y; }
    nx = Math.max(0, Math.min(this.size - 1, nx));
    ny = Math.max(0, Math.min(this.size - 1, ny));
    st.body.unshift({ x: nx, y: ny });
    while (st.body.length > st.len) st.body.pop();
  };

  // ---- Tetris (falling, passes through — no permanent stack) -------------
  MaskArcade.TETROMINOES = [
    [[0, 0], [1, 0], [2, 0], [3, 0]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]]
  ];

  MaskArcade.prototype.spawnPiece = function () {
    var t = MaskArcade.TETROMINOES[(Math.random() * MaskArcade.TETROMINOES.length) | 0];
    var ox = 1 + ((Math.random() * (this.size - 4)) | 0);
    return { cells: t.map(function (c) { return [c[0] + ox, c[1]]; }), y: -2, drift: 0 };
  };

  MaskArcade.prototype.newTetris = function () {
    return { pieces: [this.spawnPiece()], spawnIn: 3 };
  };

  MaskArcade.prototype.stepTetris = function () {
    var st = this.state;
    for (var i = st.pieces.length - 1; i >= 0; i--) {
      var p = st.pieces[i];
      p.y += 1;
      if (Math.random() < 0.2) p.drift += (Math.random() < 0.5 ? -1 : 1);
      var top = 999;
      for (var c = 0; c < p.cells.length; c++) top = Math.min(top, p.cells[c][1] + p.y);
      if (top >= this.size) st.pieces.splice(i, 1); // fell through
    }
    st.spawnIn -= 1;
    if (st.spawnIn <= 0 && st.pieces.length < 2) {
      st.pieces.push(this.spawnPiece());
      st.spawnIn = 4 + ((Math.random() * 4) | 0);
    }
    if (!st.pieces.length) { st.pieces.push(this.spawnPiece()); st.spawnIn = 5; }
  };

  // ---- Game of Life (gliders traverse the code, toroidal) ----------------
  MaskArcade.GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];

  MaskArcade.prototype.newLife = function () {
    var st = { grid: new Uint8Array(this.size * this.size), gen: 0 };
    this.seedGliders(st);
    return st;
  };

  MaskArcade.prototype.seedGliders = function (st) {
    st.grid = new Uint8Array(this.size * this.size);
    var count = 3 + ((Math.random() * 3) | 0);
    for (var g = 0; g < count; g++) {
      var ox = (Math.random() * this.size) | 0;
      var oy = (Math.random() * this.size) | 0;
      var flipX = Math.random() < 0.5 ? 1 : -1;
      var flipY = Math.random() < 0.5 ? 1 : -1;
      for (var i = 0; i < MaskArcade.GLIDER.length; i++) {
        var x = ((ox + MaskArcade.GLIDER[i][0] * flipX) % this.size + this.size) % this.size;
        var y = ((oy + MaskArcade.GLIDER[i][1] * flipY) % this.size + this.size) % this.size;
        st.grid[y * this.size + x] = 1;
      }
    }
    st.gen = 0;
  };

  MaskArcade.prototype.stepLife = function () {
    var st = this.state;
    var N = this.size;
    var next = new Uint8Array(N * N);
    var pop = 0;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = (x + dx + N) % N;
            var ny = (y + dy + N) % N;
            n += st.grid[ny * N + nx];
          }
        }
        var alive = st.grid[y * N + x];
        var live = alive ? (n === 2 || n === 3) : (n === 3);
        next[y * N + x] = live ? 1 : 0;
        if (live) pop++;
      }
    }
    st.grid = next;
    st.gen++;
    // Keep it sparse & glider-like: reseed on overcrowding, extinction, or age.
    if (pop > N * N * 0.10 || pop < 4 || st.gen > 90) this.seedGliders(st);
  };

  // ---- Snow (flakes drift down the code) ---------------------------------
  MaskArcade.prototype.newSnow = function () {
    var flakes = [];
    var count = Math.max(6, (this.size * 0.4) | 0);
    for (var i = 0; i < count; i++) {
      flakes.push({
        x: (Math.random() * this.size) | 0,
        y: Math.random() * this.size,
        v: 0.5 + Math.random() * 0.9,
        drift: Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? -1 : 1)
      });
    }
    return { flakes: flakes };
  };

  MaskArcade.prototype.stepSnow = function () {
    var st = this.state;
    for (var i = 0; i < st.flakes.length; i++) {
      var f = st.flakes[i];
      f.y += f.v;
      if (Math.random() < 0.25) f.x += f.drift;
      if (f.x < 0) f.x = this.size - 1;
      if (f.x >= this.size) f.x = 0;
      if (f.y >= this.size) {
        f.y = -Math.random() * 3;
        f.x = (Math.random() * this.size) | 0;
        f.v = 0.5 + Math.random() * 0.9;
      }
    }
  };

  // ---- Draw --------------------------------------------------------------
  MaskArcade.prototype.draw = function () {
    if (!this.ctx || !this.size) return;
    this.beginInk();
    var i;
    if (this.mode === "snake") {
      var b = this.state.body;
      for (i = 0; i < b.length; i++) this.fillModule(b[i].x, b[i].y);
    } else if (this.mode === "tetris") {
      var ps = this.state.pieces;
      for (i = 0; i < ps.length; i++) {
        var p = ps[i];
        for (var c = 0; c < p.cells.length; c++) {
          this.fillModule(p.cells[c][0] + p.drift, p.cells[c][1] + p.y);
        }
      }
    } else if (this.mode === "life") {
      var grid = this.state.grid;
      for (i = 0; i < grid.length; i++) {
        if (grid[i]) this.fillModule(i % this.size, (i / this.size) | 0);
      }
    } else if (this.mode === "snow") {
      var fl = this.state.flakes;
      for (i = 0; i < fl.length; i++) this.fillModule(fl[i].x, Math.floor(fl[i].y));
    }
  };

  MaskArcade.prototype.dispose = function () {
    this.stop();
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };

  global.MaskArcade = MaskArcade;
  if (typeof module !== "undefined" && module.exports) module.exports = MaskArcade;
})(typeof window !== "undefined" ? window : globalThis);
