/**
 * Optional bouncing mask balls that cover upcoming QR module changes.
 * Default: disabled. Smooth rAF motion with edge bounces.
 */
(function (global) {
  "use strict";

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function MaskBalls(options) {
    this.enabled = false;
    this.layer = null;
    this.balls = [];
    this.raf = 0;
    this.lastTs = 0;
    this.missions = [];
    this.qrRect = null;
    this.getQrRect = options && options.getQrRect ? options.getQrRect : function () { return null; };
    this.onLog = options && options.onLog ? options.onLog : function () {};
  }

  MaskBalls.prototype.ensureLayer = function () {
    if (this.layer) return this.layer;
    var layer = document.createElement("div");
    layer.id = "ball-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    this.layer = layer;
    return layer;
  };

  MaskBalls.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (this.enabled) {
      this.ensureLayer();
      this.layer.style.display = "block";
      if (!this.balls.length) this.spawnIdleBalls(3);
      this.startLoop();
    } else {
      this.stopLoop();
      this.missions = [];
      this.clearBalls();
      if (this.layer) this.layer.style.display = "none";
    }
  };

  MaskBalls.prototype.clearBalls = function () {
    for (var i = 0; i < this.balls.length; i++) {
      if (this.balls[i].el && this.balls[i].el.parentNode) {
        this.balls[i].el.parentNode.removeChild(this.balls[i].el);
      }
    }
    this.balls = [];
  };

  MaskBalls.prototype.spawnBall = function (x, y, r) {
    var layer = this.ensureLayer();
    var el = document.createElement("div");
    el.className = "mask-ball";
    var radius = r || 28;
    el.style.width = radius * 2 + "px";
    el.style.height = radius * 2 + "px";
    layer.appendChild(el);
    var speed = 220 + Math.random() * 120;
    var ang = Math.random() * Math.PI * 2;
    var ball = {
      el: el,
      x: x,
      y: y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      r: radius,
      mode: "idle",
      mission: null
    };
    this.balls.push(ball);
    this.place(ball);
    return ball;
  };

  MaskBalls.prototype.spawnIdleBalls = function (n) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    for (var i = 0; i < n; i++) {
      this.spawnBall(
        40 + Math.random() * Math.max(1, w - 80),
        40 + Math.random() * Math.max(1, h - 80),
        26 + Math.random() * 10
      );
    }
  };

  MaskBalls.prototype.place = function (ball) {
    ball.el.style.transform = "translate(" + (ball.x - ball.r) + "px," + (ball.y - ball.r) + "px)";
  };

  MaskBalls.prototype.ensureBallCount = function (n) {
    while (this.balls.length < n) {
      this.spawnBall(
        Math.random() * window.innerWidth,
        Math.random() * window.innerHeight,
        28
      );
    }
    // Hide extras visually at edge if too many
    for (var i = 0; i < this.balls.length; i++) {
      this.balls[i].el.style.opacity = i < n || this.balls[i].mode !== "idle" ? "0.92" : "0.35";
    }
  };

  /**
   * Cluster changed module cells into cover targets in viewport coords.
   * moduleDiffs: [[row,col], ...]
   * meta: { moduleSize, margin, changeAtMs }
   */
  MaskBalls.prototype.planForDiffs = function (moduleDiffs, meta) {
    if (!this.enabled) return;
    var qr = this.getQrRect();
    if (!qr || !moduleDiffs || !moduleDiffs.length) {
      this.missions = [];
      return;
    }

    var size = meta.moduleSize;
    var margin = meta.margin || 2;
    var n = size + margin * 2;
    var cellW = qr.width / n;
    var cellH = qr.height / n;

    // Grid clustering
    var cell = Math.max(4, Math.round(size / 12));
    var buckets = {};
    for (var i = 0; i < moduleDiffs.length; i++) {
      var row = moduleDiffs[i][0];
      var col = moduleDiffs[i][1];
      var br = (row / cell) | 0;
      var bc = (col / cell) | 0;
      var key = br + ":" + bc;
      if (!buckets[key]) buckets[key] = { sumR: 0, sumC: 0, count: 0, minR: row, maxR: row, minC: col, maxC: col };
      var b = buckets[key];
      b.sumR += row;
      b.sumC += col;
      b.count += 1;
      b.minR = Math.min(b.minR, row);
      b.maxR = Math.max(b.maxR, row);
      b.minC = Math.min(b.minC, col);
      b.maxC = Math.max(b.maxC, col);
    }

    var clusters = [];
    Object.keys(buckets).forEach(function (k) {
      var b = buckets[k];
      var mr = b.sumR / b.count;
      var mc = b.sumC / b.count;
      var span = Math.max(b.maxR - b.minR + 1, b.maxC - b.minC + 1);
      clusters.push({
        row: mr,
        col: mc,
        count: b.count,
        radiusMod: Math.max(2.5, span * 0.65)
      });
    });

    // Merge very close clusters
    clusters.sort(function (a, b) { return b.count - a.count; });
    var merged = [];
    for (i = 0; i < clusters.length; i++) {
      var c = clusters[i];
      var absorbed = false;
      for (var j = 0; j < merged.length; j++) {
        var m = merged[j];
        var dist = Math.hypot(c.row - m.row, c.col - m.col);
        if (dist < cell * 1.1) {
          var tot = m.count + c.count;
          m.row = (m.row * m.count + c.row * c.count) / tot;
          m.col = (m.col * m.count + c.col * c.count) / tot;
          m.count = tot;
          m.radiusMod = Math.max(m.radiusMod, c.radiusMod + 1);
          absorbed = true;
          break;
        }
      }
      if (!absorbed) merged.push(c);
    }

    var changeAt = meta.changeAtMs;
    var coverMs = Math.min(180, Math.max(90, (meta.intervalMs || 1000) * 0.08));
    var approachMs = Math.min(420, Math.max(220, (meta.intervalMs || 1000) * 0.18));
    var leaveAt = changeAt + coverMs;
    var approachAt = changeAt - approachMs;

    this.qrRect = qr;
    this.missions = merged.map(function (cl) {
      var x = qr.left + (cl.col + margin + 0.5) * cellW;
      var y = qr.top + (cl.row + margin + 0.5) * cellH;
      var radius = Math.max(22, Math.min(56, cl.radiusMod * Math.max(cellW, cellH) * 0.9));
      return {
        x: x,
        y: y,
        r: radius,
        approachAt: approachAt,
        coverAt: changeAt,
        leaveAt: leaveAt,
        assigned: null
      };
    });

    this.ensureBallCount(Math.max(3, this.missions.length));
    for (i = 0; i < this.missions.length; i++) {
      this.missions[i].assigned = this.balls[i];
      this.balls[i].r = this.missions[i].r;
      this.balls[i].el.style.width = this.missions[i].r * 2 + "px";
      this.balls[i].el.style.height = this.missions[i].r * 2 + "px";
      this.balls[i].mission = this.missions[i];
      this.balls[i].mode = "idle";
    }
    for (; i < this.balls.length; i++) {
      this.balls[i].mission = null;
      this.balls[i].mode = "idle";
    }

    this.onLog("Mask balls planned", {
      clusters: this.missions.length,
      diffs: moduleDiffs.length,
      approachMs: approachMs,
      coverMs: coverMs
    });
    this.startLoop();
  };

  MaskBalls.prototype.notifyChanged = function () {
    // Nudge covering balls into retreat immediately after swap.
    var now = performance.now();
    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      if (ball.mission && now >= ball.mission.coverAt) {
        ball.mode = "retreat";
      }
    }
  };

  MaskBalls.prototype.bounce = function (ball, dt, w, h) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x > w - ball.r) {
      ball.x = w - ball.r;
      ball.vx = -Math.abs(ball.vx);
    }
    if (ball.y < ball.r) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y > h - ball.r) {
      ball.y = h - ball.r;
      ball.vy = -Math.abs(ball.vy);
    }
  };

  MaskBalls.prototype.steerTo = function (ball, tx, ty, speed) {
    var dx = tx - ball.x;
    var dy = ty - ball.y;
    var dist = Math.hypot(dx, dy) || 1;
    ball.vx = (dx / dist) * speed;
    ball.vy = (dy / dist) * speed;
  };

  MaskBalls.prototype.avoidQrCenter = function (ball, qr) {
    if (!qr) return;
    var cx = qr.left + qr.width / 2;
    var cy = qr.top + qr.height / 2;
    var pad = 36;
    var inside =
      ball.x > qr.left - pad &&
      ball.x < qr.left + qr.width + pad &&
      ball.y > qr.top - pad &&
      ball.y < qr.top + qr.height + pad;
    if (!inside) return;
    var dx = ball.x - cx;
    var dy = ball.y - cy;
    var dist = Math.hypot(dx, dy) || 1;
    var speed = Math.hypot(ball.vx, ball.vy) || 240;
    ball.vx = (dx / dist) * speed;
    ball.vy = (dy / dist) * speed;
  };

  MaskBalls.prototype.tick = function (ts) {
    if (!this.enabled) return;
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var qr = this.getQrRect();
    var now = performance.now();

    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      var m = ball.mission;

      if (m && now >= m.approachAt && now < m.coverAt) {
        ball.mode = "approach";
        var remain = Math.max(0.05, (m.coverAt - now) / 1000);
        var need = Math.hypot(m.x - ball.x, m.y - ball.y);
        var speed = clamp(need / remain, 280, 1400);
        this.steerTo(ball, m.x, m.y, speed);
        this.bounce(ball, dt, w, h);
        // Soft snap late in approach
        if (now > m.coverAt - 40) {
          ball.x += (m.x - ball.x) * 0.45;
          ball.y += (m.y - ball.y) * 0.45;
        }
      } else if (m && now >= m.coverAt && now < m.leaveAt) {
        ball.mode = "cover";
        ball.x += (m.x - ball.x) * 0.35;
        ball.y += (m.y - ball.y) * 0.35;
        ball.vx *= 0.2;
        ball.vy *= 0.2;
      } else if (m && (now >= m.leaveAt || ball.mode === "retreat")) {
        ball.mode = "retreat";
        // Fly to nearest outer corner away from QR
        var tx = ball.x < w / 2 ? ball.r + 8 : w - ball.r - 8;
        var ty = ball.y < h / 2 ? ball.r + 8 : h - ball.r - 8;
        if (qr) {
          // Prefer side with more free space relative to QR
          tx = Math.abs(qr.left - 0) > Math.abs(w - (qr.left + qr.width))
            ? ball.r + 10
            : w - ball.r - 10;
          ty = ball.y;
        }
        this.steerTo(ball, tx, ty, 900);
        this.bounce(ball, dt, w, h);
        if (Math.hypot(ball.x - tx, ball.y - ty) < 24 || now > m.leaveAt + 500) {
          ball.mission = null;
          ball.mode = "idle";
          var ang = Math.random() * Math.PI * 2;
          var spd = 200 + Math.random() * 160;
          ball.vx = Math.cos(ang) * spd;
          ball.vy = Math.sin(ang) * spd;
        }
      } else {
        ball.mode = "idle";
        var cur = Math.hypot(ball.vx, ball.vy);
        if (cur < 160) {
          ball.vx *= 1.05;
          ball.vy *= 1.05;
        } else if (cur > 380) {
          ball.vx *= 0.98;
          ball.vy *= 0.98;
        }
        this.bounce(ball, dt, w, h);
        this.avoidQrCenter(ball, qr);
      }

      ball.el.classList.toggle("is-cover", ball.mode === "cover" || ball.mode === "approach");
      this.place(ball);
    }

    this.raf = requestAnimationFrame(this.tick.bind(this));
  };

  MaskBalls.prototype.startLoop = function () {
    if (this.raf) return;
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.tick.bind(this));
  };

  MaskBalls.prototype.stopLoop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTs = 0;
  };

  global.MaskBalls = MaskBalls;
})(typeof window !== "undefined" ? window : globalThis);
