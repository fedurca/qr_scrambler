/**
 * Overlay masking methods for the QR flip (alternatives to the flying balls).
 *
 * Goal: make the once-per-interval module changes imperceptible. The scanner
 * reads the settled final value (it has the whole interval); the human eye is
 * what we hide the transition from.
 *
 * Methods (all operate on a transparent canvas positioned over the QR):
 *  - crossfade (default): the changed cells ramp opacity prev -> new over
 *    ~260 ms; the swap is deferred behind the overlay (a natural paint gate),
 *    so there is never an instant pop. Robust, no fragile motion timing.
 *  - shimmer: a permanent, very low-contrast dither across the whole symbol,
 *    so a real per-interval change vanishes into the ambient micro-motion.
 *  - softpatch: a muted, soft-edged blob in the code color briefly covers each
 *    changed cell while the swap happens underneath, then fades out.
 *  - balls / none: handled by MaskBalls / no overlay (this controller no-ops
 *    the visual swap so the caller commits immediately).
 *
 * Ball radius, colors, and the RGB/CMYK model live in mask-balls.js; this file
 * only manages the flat overlay canvas.
 */
(function (global) {
  "use strict";

  function MaskFx(opts) {
    opts = opts || {};
    this.getQrRect = opts.getQrRect || function () { return null; };
    this.onLog = opts.onLog || function () {};
    this.method = "crossfade";
    this.canvas = null;
    this.ctx = null;
    this.dpr = Math.min(2, (global.devicePixelRatio || 1));
    this.anim = 0;
    this.shimmerRaf = 0;
    this._shimmerLast = 0;
    this.getQrInfo = opts.getQrInfo || null;
    this.arcade = (typeof global.MaskArcade === "function")
      ? new global.MaskArcade({
          getQrInfo: this.getQrInfo,
          getQrRect: this.getQrRect,
          getChangingCells: opts.getChangingCells || function () { return []; },
          getGentleCells: opts.getGentleCells || function () { return []; },
          getHorizon: opts.getHorizon || function () { return 1; },
          getNoiseAmount: opts.getNoiseAmount || function () { return 0.5; },
          getChangeAmount: opts.getChangeAmount || function () { return 0.7; }
        })
      : null;
  }

  MaskFx.OPTIONS = ["crossfade", "balls", "shimmer", "softpatch", "snake", "tetris", "life",
    "snow", "snow1", "snow2", "snow3", "snow4", "snow5", "snow6", "snow7", "snow8",
    "chg", "chg1", "chg2", "chg3", "chg4", "chg5", "chg6", "chgmin", "none"];
  MaskFx.ARCADE = ["snake", "tetris", "life", "snow",
    "snow1", "snow2", "snow3", "snow4", "snow5", "snow6", "snow7", "snow8",
    "chg", "chg1", "chg2", "chg3", "chg4", "chg5", "chg6", "chgmin"];

  MaskFx.prototype.ensureCanvas = function () {
    if (this.canvas) return this.canvas;
    var c = document.createElement("canvas");
    c.id = "mask-fx-canvas";
    c.setAttribute("aria-hidden", "true");
    c.style.position = "fixed";
    c.style.pointerEvents = "none";
    c.style.zIndex = "30";
    c.style.left = "0px";
    c.style.top = "0px";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
    return c;
  };

  MaskFx.prototype.positionOver = function (rect) {
    if (!rect) return false;
    this.ensureCanvas();
    this.dpr = Math.min(2, (global.devicePixelRatio || 1));
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    this.canvas.style.left = Math.round(rect.left) + "px";
    this.canvas.style.top = Math.round(rect.top) + "px";
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    return true;
  };

  MaskFx.prototype.clear = function () {
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };

  MaskFx.prototype.stopAnim = function () {
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = 0; }
  };

  MaskFx.prototype.stopShimmer = function () {
    if (this.shimmerRaf) { cancelAnimationFrame(this.shimmerRaf); this.shimmerRaf = 0; }
  };

  MaskFx.prototype.setMethod = function (m) {
    if (MaskFx.OPTIONS.indexOf(m) < 0) m = "crossfade";
    this.method = m;
    this.stopAnim();
    this.stopShimmer();
    this.clear();
    if (this.arcade) this.arcade.setMode(MaskFx.ARCADE.indexOf(m) >= 0 ? m : null);
    if (m === "shimmer") {
      this.ensureCanvas();
      this.startShimmer();
    }
  };

  /** The caller should defer the real module swap only for methods that fade it in. */
  MaskFx.prototype.wantsDeferredSwap = function () {
    return this.method === "crossfade";
  };

  MaskFx.prototype.usesBalls = function () {
    return this.method === "balls";
  };

  /** Geometry helper: device-pixel cell box for module (row,col). */
  MaskFx.prototype.cellBox = function (rect, size, margin, r, c) {
    var n = size + margin * 2;
    var cw = (rect.width * this.dpr) / n;
    var ch = (rect.height * this.dpr) / n;
    return {
      x: (c + margin) * cw,
      y: (r + margin) * ch,
      w: cw,
      h: ch,
      cx: (c + margin + 0.5) * cw,
      cy: (r + margin + 0.5) * ch
    };
  };

  /**
   * Present a flip.
   * @param cells array of [row, col, newBit]
   * @param commit function that performs the real module swap (draw new frame)
   */
  MaskFx.prototype.present = function (cells, size, margin, commit) {
    var m = this.method;
    // Ambient methods (balls / shimmer / arcade) do not cover the changed cells
    // themselves — commit the swap immediately; the animation runs independently.
    if (m !== "crossfade" && m !== "softpatch") {
      commit();
      return;
    }
    var rect = this.getQrRect();
    if (!rect || !cells || !cells.length) {
      commit();
      return;
    }
    if (!this.positionOver(rect)) { commit(); return; }

    if (m === "crossfade") this.playCrossfade(rect, cells, size, margin, commit);
    else if (m === "softpatch") this.playSoftPatch(rect, cells, size, margin, commit);
    else commit();
  };

  MaskFx.prototype.playCrossfade = function (rect, cells, size, margin, commit) {
    var self = this;
    var ctx = this.ctx;
    this.stopAnim();
    var start = 0;
    var dur = 260;
    var committed = false;
    function step(ts) {
      if (!start) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      self.clear();
      ctx.globalAlpha = k;
      for (var i = 0; i < cells.length; i++) {
        var b = self.cellBox(rect, size, margin, cells[i][0], cells[i][1]);
        ctx.fillStyle = cells[i][2] ? "#000000" : "#ffffff";
        // pad by 0.75px to avoid seams between adjacent changed cells
        ctx.fillRect(b.x - 0.5, b.y - 0.5, b.w + 1, b.h + 1);
      }
      ctx.globalAlpha = 1;
      if (k < 1) {
        self.anim = requestAnimationFrame(step);
      } else {
        if (!committed) { commit(); committed = true; }
        self.clear();
        self.anim = 0;
      }
    }
    self.anim = requestAnimationFrame(step);
  };

  MaskFx.prototype.playSoftPatch = function (rect, cells, size, margin, commit) {
    var self = this;
    var ctx = this.ctx;
    this.stopAnim();
    // Draw the covering blobs first, swap underneath, then fade the blobs out.
    var radius = 0;
    var pts = [];
    for (var i = 0; i < cells.length; i++) {
      var b = self.cellBox(rect, size, margin, cells[i][0], cells[i][1]);
      pts.push([b.cx, b.cy]);
      radius = Math.max(radius, b.w);
    }
    radius = Math.max(radius * 1.8, 6);

    function draw(alpha) {
      self.clear();
      for (var j = 0; j < pts.length; j++) {
        var g = ctx.createRadialGradient(pts[j][0], pts[j][1], 0, pts[j][0], pts[j][1], radius);
        g.addColorStop(0, "rgba(24,24,28," + (0.9 * alpha).toFixed(3) + ")");
        g.addColorStop(0.6, "rgba(24,24,28," + (0.7 * alpha).toFixed(3) + ")");
        g.addColorStop(1, "rgba(24,24,28,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pts[j][0], pts[j][1], radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    draw(1);
    commit(); // swap the real modules under the opaque blobs
    var start = 0;
    var dur = 420;
    function step(ts) {
      if (!start) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      draw(1 - k);
      if (k < 1) self.anim = requestAnimationFrame(step);
      else { self.clear(); self.anim = 0; }
    }
    self.anim = requestAnimationFrame(step);
  };

  MaskFx.prototype.startShimmer = function () {
    var self = this;
    this.stopShimmer();
    function loop(ts) {
      if (self.method !== "shimmer") { self.shimmerRaf = 0; return; }
      var rect = self.getQrRect();
      if (rect) {
        self.positionOver(rect);
        if (!self._shimmerLast || ts - self._shimmerLast > 90) {
          self._shimmerLast = ts;
          self.drawShimmer();
        }
      }
      self.shimmerRaf = requestAnimationFrame(loop);
    }
    self.shimmerRaf = requestAnimationFrame(loop);
  };

  MaskFx.prototype.drawShimmer = function () {
    var ctx = this.ctx;
    var w = this.canvas.width;
    var h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Sparse, very low-contrast gray specks that reshuffle each frame. Low alpha
    // keeps the symbol scannable while adding ambient micro-motion that a real
    // per-interval change disappears into.
    var count = Math.max(24, Math.round((w * h) / 2600));
    var s = Math.max(2, Math.round(this.dpr * 2));
    for (var i = 0; i < count; i++) {
      var x = (Math.random() * w) | 0;
      var y = (Math.random() * h) | 0;
      var g = 90 + ((Math.random() * 120) | 0);
      ctx.fillStyle = "rgba(" + g + "," + g + "," + g + ",0.05)";
      ctx.fillRect(x, y, s, s);
    }
  };

  MaskFx.prototype.dispose = function () {
    this.stopAnim();
    this.stopShimmer();
    this.clear();
    if (this.arcade) this.arcade.dispose();
  };

  global.MaskFx = MaskFx;
  if (typeof module !== "undefined" && module.exports) module.exports = MaskFx;
})(typeof window !== "undefined" ? window : globalThis);
