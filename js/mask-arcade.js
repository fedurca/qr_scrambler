/**
 * Ambient "arcade" masking around the QR: Snake, Tetris, Game of Life.
 *
 * A full-viewport transparent canvas renders a grid animation but never paints
 * the cells that overlap the QR symbol (a hole is punched around it), so the
 * code stays crisp and scannable while continuous motion around it provides
 * change-blindness cover for the once-per-interval module swap.
 *
 * Pure canvas + grid logic; no dependency on mask-balls / mask-methods.
 */
(function (global) {
  "use strict";

  var CELL_CSS = 22;         // logical cell size (px) before DPR scaling
  var STEP_MS = { snake: 90, tetris: 110, life: 150 };

  function MaskArcade(opts) {
    opts = opts || {};
    this.getQrRect = opts.getQrRect || function () { return null; };
    this.mode = null;
    this.canvas = null;
    this.ctx = null;
    this.raf = 0;
    this.lastStep = 0;
    this.dpr = 1;
    this.cols = 0;
    this.rows = 0;
    this.cell = CELL_CSS;
    this.blocked = null;
    this.state = null;
    this._loop = this.loop.bind(this);
  }

  MaskArcade.MODES = ["snake", "tetris", "life"];

  MaskArcade.prototype.ensureCanvas = function () {
    if (this.canvas) return this.canvas;
    var c = document.createElement("canvas");
    c.id = "mask-arcade-canvas";
    c.setAttribute("aria-hidden", "true");
    c.style.position = "fixed";
    c.style.left = "0px";
    c.style.top = "0px";
    c.style.pointerEvents = "none";
    c.style.zIndex = "20";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
    return c;
  };

  MaskArcade.prototype.computeGrid = function () {
    this.ensureCanvas();
    this.dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = global.innerWidth;
    var h = global.innerHeight;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.cell = CELL_CSS * this.dpr;
    this.cols = Math.max(4, Math.ceil(this.canvas.width / this.cell));
    this.rows = Math.max(4, Math.ceil(this.canvas.height / this.cell));
    this.rebuildHole();
  };

  /** Mark grid cells overlapping the QR (plus a margin) as blocked. */
  MaskArcade.prototype.rebuildHole = function () {
    var n = this.rows * this.cols;
    if (!this.blocked || this.blocked.length !== n) this.blocked = new Uint8Array(n);
    else this.blocked.fill(0);
    var rect = this.getQrRect();
    if (!rect) return;
    var pad = this.cell * 0.6;
    var x0 = (rect.left * this.dpr) - pad;
    var y0 = (rect.top * this.dpr) - pad;
    var x1 = ((rect.left + rect.width) * this.dpr) + pad;
    var y1 = ((rect.top + rect.height) * this.dpr) + pad;
    var gx0 = Math.max(0, Math.floor(x0 / this.cell));
    var gy0 = Math.max(0, Math.floor(y0 / this.cell));
    var gx1 = Math.min(this.cols - 1, Math.floor(x1 / this.cell));
    var gy1 = Math.min(this.rows - 1, Math.floor(y1 / this.cell));
    for (var gy = gy0; gy <= gy1; gy++) {
      for (var gx = gx0; gx <= gx1; gx++) this.blocked[gy * this.cols + gx] = 1;
    }
  };

  MaskArcade.prototype.isBlocked = function (x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return true;
    return !!this.blocked[y * this.cols + x];
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
    this.computeGrid();
    if (mode === "snake") this.state = this.newSnake();
    else if (mode === "tetris") this.state = this.newTetris();
    else this.state = this.newLife();
    this.lastStep = 0;
    this.raf = requestAnimationFrame(this._loop);
  };

  MaskArcade.prototype.stop = function () {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  };

  MaskArcade.prototype.loop = function (ts) {
    if (!this.mode) { this.raf = 0; return; }
    // Track viewport / QR movement.
    if (this.canvas.width !== Math.round(global.innerWidth * this.dpr) ||
        this.canvas.height !== Math.round(global.innerHeight * this.dpr)) {
      this.computeGrid();
    } else {
      this.rebuildHole();
    }
    var interval = STEP_MS[this.mode] || 120;
    if (!this.lastStep || ts - this.lastStep >= interval) {
      this.lastStep = ts;
      if (this.mode === "snake") this.stepSnake();
      else if (this.mode === "tetris") this.stepTetris();
      else this.stepLife();
      this.draw();
    }
    this.raf = requestAnimationFrame(this._loop);
  };

  MaskArcade.prototype.fillCell = function (x, y, color) {
    if (this.isBlocked(x, y)) return;
    var px = x * this.cell;
    var py = y * this.cell;
    var g = this.cell * 0.12;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(px + g, py + g, this.cell - 2 * g, this.cell - 2 * g);
  };

  // ---- Snake -------------------------------------------------------------
  MaskArcade.prototype.freeCell = function () {
    for (var tries = 0; tries < 200; tries++) {
      var x = (Math.random() * this.cols) | 0;
      var y = (Math.random() * this.rows) | 0;
      if (!this.isBlocked(x, y)) return { x: x, y: y };
    }
    return { x: 0, y: 0 };
  };

  MaskArcade.prototype.newSnake = function () {
    var start = this.freeCell();
    var body = [];
    for (var i = 0; i < 4; i++) body.push({ x: start.x, y: start.y });
    return { body: body, dir: { x: 1, y: 0 }, food: this.freeCell() };
  };

  MaskArcade.prototype.stepSnake = function () {
    var s = this.state;
    var head = s.body[0];
    var dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    var occupied = {};
    for (var i = 0; i < s.body.length; i++) occupied[s.body[i].x + "," + s.body[i].y] = 1;
    var self = this;
    function safe(d) {
      var nx = head.x + d.x, ny = head.y + d.y;
      if (self.isBlocked(nx, ny)) return false;
      // allow moving into current tail cell (it will move)
      var tail = s.body[s.body.length - 1];
      if (occupied[nx + "," + ny] && !(nx === tail.x && ny === tail.y)) return false;
      return true;
    }
    // greedy toward food among safe non-reverse dirs
    var best = null, bestD = Infinity;
    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
      if (!safe(d)) continue;
      var dist = Math.abs(head.x + d.x - s.food.x) + Math.abs(head.y + d.y - s.food.y);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) s.dir = best;
    var nh = { x: head.x + s.dir.x, y: head.y + s.dir.y };
    if (this.isBlocked(nh.x, nh.y) || (occupied[nh.x + "," + nh.y] &&
        !(nh.x === s.body[s.body.length - 1].x && nh.y === s.body[s.body.length - 1].y))) {
      this.state = this.newSnake();
      return;
    }
    s.body.unshift(nh);
    if (nh.x === s.food.x && nh.y === s.food.y) {
      s.food = this.freeCell();
      if (s.body.length > 60) s.body.length = 60;
    } else {
      s.body.pop();
    }
  };

  // ---- Tetris ------------------------------------------------------------
  MaskArcade.TETROMINOES = [
    { c: "#43c6ff", cells: [[0, 0], [1, 0], [2, 0], [3, 0]] }, // I
    { c: "#ffd23f", cells: [[0, 0], [1, 0], [0, 1], [1, 1]] }, // O
    { c: "#b06dff", cells: [[1, 0], [0, 1], [1, 1], [2, 1]] }, // T
    { c: "#5cd65c", cells: [[1, 0], [2, 0], [0, 1], [1, 1]] }, // S
    { c: "#ff6b6b", cells: [[0, 0], [1, 0], [1, 1], [2, 1]] }, // Z
    { c: "#5a8bff", cells: [[0, 0], [0, 1], [1, 1], [2, 1]] }, // J
    { c: "#ff9f43", cells: [[2, 0], [0, 1], [1, 1], [2, 1]] }  // L
  ];

  MaskArcade.prototype.newTetris = function () {
    var st = { occ: new Uint8Array(this.rows * this.cols), color: [], piece: null };
    st.color = new Array(this.rows * this.cols);
    this.tetSpawn(st);
    return st;
  };

  MaskArcade.prototype.tetSpawn = function (st) {
    var t = MaskArcade.TETROMINOES[(Math.random() * MaskArcade.TETROMINOES.length) | 0];
    var ox = (this.cols / 2 - 2) | 0;
    st.piece = { color: t.c, cells: t.cells.map(function (c) { return [c[0] + ox, c[1]]; }) };
    if (this.tetCollide(st, st.piece.cells)) {
      // board full — reset
      st.occ = new Uint8Array(this.rows * this.cols);
      st.color = new Array(this.rows * this.cols);
    }
  };

  MaskArcade.prototype.tetCollide = function (st, cells) {
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (x < 0 || x >= this.cols || y >= this.rows) return true;
      if (y < 0) continue;
      if (this.isBlocked(x, y)) return true;
      if (st.occ[y * this.cols + x]) return true;
    }
    return false;
  };

  MaskArcade.prototype.stepTetris = function () {
    var st = this.state;
    if (!st.piece) this.tetSpawn(st);
    var p = st.piece;
    // occasional horizontal drift for variety
    if (Math.random() < 0.25) {
      var dx = Math.random() < 0.5 ? -1 : 1;
      var moved = p.cells.map(function (c) { return [c[0] + dx, c[1]]; });
      if (!this.tetCollide(st, moved)) p.cells = moved;
    }
    var down = p.cells.map(function (c) { return [c[0], c[1] + 1]; });
    if (this.tetCollide(st, down)) {
      // lock
      for (var i = 0; i < p.cells.length; i++) {
        var x = p.cells[i][0], y = p.cells[i][1];
        if (y >= 0 && y < this.rows && x >= 0 && x < this.cols && !this.isBlocked(x, y)) {
          st.occ[y * this.cols + x] = 1;
          st.color[y * this.cols + x] = p.color;
        }
      }
      this.tetClear(st);
      this.tetSpawn(st);
    } else {
      p.cells = down;
    }
  };

  MaskArcade.prototype.tetClear = function (st) {
    var cleared = {};
    for (var r = 0; r < this.rows; r++) {
      var play = 0, fill = 0;
      for (var c = 0; c < this.cols; c++) {
        if (this.isBlocked(c, r)) continue;
        play++;
        if (st.occ[r * this.cols + c]) fill++;
      }
      if (play > 0 && fill === play) cleared[r] = 1;
    }
    if (!Object.keys(cleared).length) return;
    // Column compaction: drop filled cells to the bottom, skipping blocked + cleared.
    for (c = 0; c < this.cols; c++) {
      var stack = [];
      for (r = this.rows - 1; r >= 0; r--) {
        if (this.isBlocked(c, r)) continue;
        var idx = r * this.cols + c;
        if (cleared[r]) { st.occ[idx] = 0; st.color[idx] = null; continue; }
        if (st.occ[idx]) { stack.push(st.color[idx]); st.occ[idx] = 0; st.color[idx] = null; }
      }
      var k = 0;
      for (r = this.rows - 1; r >= 0 && k < stack.length; r--) {
        if (this.isBlocked(c, r)) continue;
        st.occ[r * this.cols + c] = 1;
        st.color[r * this.cols + c] = stack[k++];
      }
    }
  };

  // ---- Game of Life ------------------------------------------------------
  MaskArcade.prototype.newLife = function () {
    var st = { grid: new Uint8Array(this.rows * this.cols), gen: 0, lastPop: -1, stag: 0 };
    this.lifeSeed(st);
    return st;
  };

  MaskArcade.prototype.lifeSeed = function (st) {
    for (var i = 0; i < st.grid.length; i++) {
      var x = i % this.cols, y = (i / this.cols) | 0;
      st.grid[i] = (!this.isBlocked(x, y) && Math.random() < 0.18) ? 1 : 0;
    }
    st.gen = 0;
    st.lastPop = -1;
    st.stag = 0;
  };

  MaskArcade.prototype.stepLife = function () {
    var st = this.state;
    var next = new Uint8Array(this.rows * this.cols);
    var pop = 0;
    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) {
        if (this.isBlocked(x, y)) { next[y * this.cols + x] = 0; continue; }
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
            if (this.isBlocked(nx, ny)) continue;
            n += st.grid[ny * this.cols + nx];
          }
        }
        var alive = st.grid[y * this.cols + x];
        var live = alive ? (n === 2 || n === 3) : (n === 3);
        next[y * this.cols + x] = live ? 1 : 0;
        if (live) pop++;
      }
    }
    st.grid = next;
    st.gen++;
    if (pop === st.lastPop) st.stag++; else st.stag = 0;
    st.lastPop = pop;
    if (pop < this.cols * this.rows * 0.01 || st.gen > 260 || st.stag > 16) this.lifeSeed(st);
  };

  // ---- Draw --------------------------------------------------------------
  MaskArcade.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    var x, y, i;
    if (this.mode === "snake") {
      var s = this.state;
      this.fillCell(s.food.x, s.food.y, "#ff8c42");
      for (i = 0; i < s.body.length; i++) {
        var t = 1 - i / (s.body.length + 2);
        var g = Math.round(120 + 110 * t);
        this.fillCell(s.body[i].x, s.body[i].y, i === 0 ? "#9dffb0" : "rgba(60," + g + ",90,0.9)");
      }
    } else if (this.mode === "tetris") {
      var st = this.state;
      for (i = 0; i < st.occ.length; i++) {
        if (!st.occ[i]) continue;
        this.fillCell(i % this.cols, (i / this.cols) | 0, st.color[i] || "#43c6ff");
      }
      if (st.piece) {
        for (i = 0; i < st.piece.cells.length; i++) {
          this.fillCell(st.piece.cells[i][0], st.piece.cells[i][1], st.piece.color);
        }
      }
    } else if (this.mode === "life") {
      var grid = this.state.grid;
      for (i = 0; i < grid.length; i++) {
        if (!grid[i]) continue;
        this.fillCell(i % this.cols, (i / this.cols) | 0, "rgba(90,220,180,0.85)");
      }
    }
  };

  MaskArcade.prototype.dispose = function () {
    this.stop();
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };

  global.MaskArcade = MaskArcade;
  if (typeof module !== "undefined" && module.exports) module.exports = MaskArcade;
})(typeof window !== "undefined" ? window : globalThis);
