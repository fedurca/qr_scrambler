/**
 * Mask balls: R/G/B + C/M/Y/K continuous billiard motion.
 *
 * Motion rules:
 * - Always visible, never teleported / despawned while enabled
 * - Direction changes ONLY on viewport-edge bounce (angle)
 * - Speed may change linearly (acceleration) between bounces
 * - Ball radius is CONSTANT (BALL_R) — never grows/shrinks
 *
 * Color:
 * - RGB group: additive (lighter) — separate canvas
 * - CMYK group: subtractive (multiply) — separate canvas
 * - Groups do not color-mix with each other
 *
 * Cover: intercept change discs, hold until the QR is actually painted,
 * then brief trail and evacuate. Jobs must not expire on planned time alone —
 * paint can lag the slot clock by hundreds of ms.
 */
(function (global) {
  "use strict";

  var BALL_COLORS = [
    { id: "R", group: "rgb", hex: "#ff0000", rgb: [255, 0, 0] },
    { id: "G", group: "rgb", hex: "#00ff00", rgb: [0, 255, 0] },
    { id: "B", group: "rgb", hex: "#0000ff", rgb: [0, 0, 255] },
    { id: "C", group: "cmyk", hex: "#00e8e8", rgb: [0, 232, 232] },
    { id: "M", group: "cmyk", hex: "#ff2fa6", rgb: [255, 47, 166] },
    { id: "Y", group: "cmyk", hex: "#f5d000", rgb: [245, 208, 0] },
    { id: "K", group: "cmyk", hex: "#3a3a3a", rgb: [58, 58, 58] }
  ];

  /** Fixed visual + physical radius for every ball (never mutated). */
  var BALL_R = 52;
  var MIN_SPEED = 160;
  var MAX_SPEED = 980;
  var BASE_SPEED = 320;
  var SPEED_JITTER = 50;
  var MAX_ACCEL = 2200; // px/s² — linear speed changes only
  /** Soft hint only — intercept runs for the whole job lifetime. */
  var COVER_LEAD_MS = 400;
  /** Be on the disc this long before the flip (linger via slowdown). */
  var COVER_HOLD_MS = 120;
  /** Leave soon after the flip is painted. */
  var COVER_TRAIL_MS = 50;
  /** Aim to arrive this early so HOLD window is non-empty. */
  var ARRIVE_EARLY_MS = 160;
  /** Start braking when this close — high speed through a tight disc overshoots. */
  var BRAKE_DIST = BALL_R * 2.15;
  var CRAWL_DIST = BALL_R * 1.35;
  /**
   * Once a job is this close to flip (or already in trail), reassignment must
   * not drop it — otherwise prefetch for N+1 abandons cover for flip N.
   */
  var JOB_LOCK_MIN_MS = 520;
  var JOB_LOCK_MAX_MS = 1100;
  /** Unfold images / bounce depth for route search. */
  var AIM_LOOKAHEAD_BOUNCES = 8;
  var MAX_PLAN_BOUNCES = 3;
  var MAX_TARGETS = 10;
  /** Cluster disc must fit inside the ball with aim slack (dist ≤ BALL_R − MAX_TARGET_R). */
  var MAX_TARGET_R = BALL_R - 16;
  var QR_CLEAR_PAD = 28;
  /** Throttle for live plan/position debug dumps. */
  var DEBUG_SNAP_MS = 220;

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function hypot(dx, dy) {
    return Math.sqrt(dx * dx + dy * dy);
  }

  function MaskBalls(options) {
    this.enabled = false;
    this.layer = null;
    this.rgbCanvas = null;
    this.cmykCanvas = null;
    this.rgbCtx = null;
    this.cmykCtx = null;
    this.balls = [];
    this.raf = 0;
    this.lastTs = 0;
    this.events = [];
    this.qrRect = null;
    this.intervalMs = 5000;
    this.dpr = 1;
    this.getQrRect = options && options.getQrRect ? options.getQrRect : function () { return null; };
    this.onLog = options && options.onLog ? options.onLog : function () {};
    this.onPlanDebug = options && options.onPlanDebug ? options.onPlanDebug : function () {};
    this._lastDebugMs = 0;
  }

  MaskBalls.prototype.ensureLayer = function () {
    if (this.layer) return this.layer;
    var layer = document.createElement("div");
    layer.id = "ball-layer";
    layer.setAttribute("aria-hidden", "true");

    var rgb = document.createElement("canvas");
    rgb.id = "ball-canvas-rgb";
    rgb.className = "ball-canvas ball-canvas-rgb";
    var cmyk = document.createElement("canvas");
    cmyk.id = "ball-canvas-cmyk";
    cmyk.className = "ball-canvas ball-canvas-cmyk";

    layer.appendChild(rgb);
    layer.appendChild(cmyk);
    document.body.appendChild(layer);

    this.layer = layer;
    this.rgbCanvas = rgb;
    this.cmykCanvas = cmyk;
    this.rgbCtx = rgb.getContext("2d", { alpha: true });
    this.cmykCtx = cmyk.getContext("2d", { alpha: true });
    this.resizeCanvases();
    return layer;
  };

  MaskBalls.prototype.resizeCanvases = function () {
    if (!this.rgbCanvas || !this.cmykCanvas) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var canvases = [this.rgbCanvas, this.cmykCanvas];
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      c.width = Math.max(1, Math.floor(w * dpr));
      c.height = Math.max(1, Math.floor(h * dpr));
      c.style.width = w + "px";
      c.style.height = h + "px";
    }
  };

  MaskBalls.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (this.enabled) {
      this.ensureLayer();
      this.layer.style.display = "block";
      this.resizeCanvases();
      if (!this.balls.length) this.spawnPalette();
      this.startLoop();
    } else {
      this.stopLoop();
      this.events = [];
      this.clearAssignments();
      // Keep ball objects? Clear for clean disable — will respawn on enable.
      this.balls = [];
      if (this.rgbCtx && this.rgbCanvas) this.rgbCtx.clearRect(0, 0, this.rgbCanvas.width, this.rgbCanvas.height);
      if (this.cmykCtx && this.cmykCanvas) this.cmykCtx.clearRect(0, 0, this.cmykCanvas.width, this.cmykCanvas.height);
      if (this.layer) this.layer.style.display = "none";
    }
  };

  MaskBalls.prototype.spawnPalette = function () {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var qr = this.getQrRect ? this.getQrRect() : null;
    // Spawn in a ring around the QR so the first flip is reachable
    var cx = qr ? qr.left + qr.width / 2 : w * 0.5;
    var cy = qr ? qr.top + qr.height / 2 : h * 0.5;
    var ring = qr
      ? Math.max(qr.width, qr.height) * 0.5 + BALL_R * 2.2
      : Math.min(w, h) * 0.22;
    for (var i = 0; i < BALL_COLORS.length; i++) {
      var c = BALL_COLORS[i];
      var speed = BASE_SPEED + (Math.random() * 2 - 1) * SPEED_JITTER;
      var ang = (i / BALL_COLORS.length) * Math.PI * 2 + Math.random() * 0.35;
      var x = clamp(cx + Math.cos(ang) * ring, BALL_R + 8, w - BALL_R - 8);
      var y = clamp(cy + Math.sin(ang) * ring, BALL_R + 8, h - BALL_R - 8);
      // Tangential cruise — stay near the code without cutting through it
      var tang = ang + Math.PI / 2;
      this.spawnBall(
        x,
        y,
        c,
        Math.cos(tang) * speed,
        Math.sin(tang) * speed
      );
    }
  };

  MaskBalls.prototype.spawnBall = function (x, y, color, vx, vy) {
    var speed = clamp(hypot(vx, vy) || BASE_SPEED, MIN_SPEED, MAX_SPEED);
    var ang = Math.atan2(vy, vx);
    var ball = {
      colorId: color.id,
      group: color.group,
      hex: color.hex,
      rgb: color.rgb.slice(),
      x: x,
      y: y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      speed: speed,
      targetSpeed: speed,
      r: BALL_R,
      pendingAngle: null,
      angleQueue: [],
      postSpeed: null,
      postSpeedQueue: [],
      queue: [],
      covering: false,
      evacuating: false,
      needEvacuate: false
    };
    this.balls.push(ball);
    return ball;
  };

  /** Always the constant radius — ignore any accidental mutation. */
  MaskBalls.prototype.ballRadius = function (ball) {
    if (ball && ball.r !== BALL_R) ball.r = BALL_R;
    return BALL_R;
  };

  MaskBalls.prototype.playBounds = function (ball) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var r = this.ballRadius(ball);
    return {
      L: r,
      T: r,
      R: Math.max(r + 1, w - r),
      B: Math.max(r + 1, h - r)
    };
  };

  MaskBalls.prototype.unfoldPoint = function (px, py, nx, ny, bounds) {
    var W = bounds.R - bounds.L;
    var H = bounds.B - bounds.T;
    var x = px - bounds.L;
    var y = py - bounds.T;
    var ux = (Math.abs(nx) % 2 === 0) ? x : (W - x);
    var uy = (Math.abs(ny) % 2 === 0) ? y : (H - y);
    return {
      x: bounds.L + ux + nx * W,
      y: bounds.T + uy + ny * H
    };
  };

  MaskBalls.prototype.aimAngleFromBounce = function (bx, by, target, travelDist, ball) {
    var bounds = this.playBounds(ball);
    var best = null;
    var bestScore = Infinity;
    for (var nx = -AIM_LOOKAHEAD_BOUNCES; nx <= AIM_LOOKAHEAD_BOUNCES; nx++) {
      for (var ny = -AIM_LOOKAHEAD_BOUNCES; ny <= AIM_LOOKAHEAD_BOUNCES; ny++) {
        var imgX = target.x;
        var imgY = target.y;
        if (nx !== 0 || ny !== 0) {
          var img = this.unfoldPoint(target.x, target.y, nx, ny, bounds);
          imgX = img.x;
          imgY = img.y;
        }
        var d = hypot(imgX - bx, imgY - by);
        if (d <= 1) continue;
        var raw = Math.abs(d - travelDist);
        var bounces = Math.abs(nx) + Math.abs(ny);
        var score = raw + bounces * 2.2;
        if (score < bestScore) {
          bestScore = score;
          best = {
            ang: Math.atan2(imgY - by, imgX - bx),
            dist: d,
            raw: raw,
            nx: nx,
            ny: ny,
            bounces: bounces
          };
        }
      }
    }
    if (!best) return null;
    var slack = Math.max(BALL_R * 1.6, travelDist * 0.28, 70);
    if (best.raw > slack) return null;
    return best;
  };

  /** Exact image aim: choose speed so distance/image matches tAfter (no discrete travel guess). */
  MaskBalls.prototype.bestImageAim = function (bx, by, target, tAfter, ball) {
    if (tAfter < 0.02) return null;
    var bounds = this.playBounds(ball);
    var best = null;
    var bestScore = Infinity;
    for (var nx = -AIM_LOOKAHEAD_BOUNCES; nx <= AIM_LOOKAHEAD_BOUNCES; nx++) {
      for (var ny = -AIM_LOOKAHEAD_BOUNCES; ny <= AIM_LOOKAHEAD_BOUNCES; ny++) {
        var imgX = target.x;
        var imgY = target.y;
        if (nx !== 0 || ny !== 0) {
          var img = this.unfoldPoint(target.x, target.y, nx, ny, bounds);
          imgX = img.x;
          imgY = img.y;
        }
        var d = hypot(imgX - bx, imgY - by);
        if (d <= 1) continue;
        var need = d / tAfter;
        if (need < MIN_SPEED * 0.85 || need > MAX_SPEED * 1.12) continue;
        var speed = clamp(need, MIN_SPEED, MAX_SPEED);
        var err = Math.abs(d - speed * tAfter);
        var bounces = Math.abs(nx) + Math.abs(ny);
        var score = err + bounces * 4 + Math.abs(need - speed) * 0.05;
        if (score < bestScore) {
          bestScore = score;
          best = {
            ang: Math.atan2(imgY - by, imgX - bx),
            dist: d,
            speed: speed,
            raw: err,
            nx: nx,
            ny: ny,
            bounces: bounces
          };
        }
      }
    }
    return best;
  };

  /**
   * Time (s) to travel `dist` along a ray while accelerating from v0 toward vGoal.
   * Direction unchanged; only linear speed (MAX_ACCEL).
   */
  MaskBalls.prototype.timeToTravelAccel = function (dist, v0, vGoal) {
    if (dist <= 0) return 0;
    v0 = clamp(v0, MIN_SPEED, MAX_SPEED);
    vGoal = clamp(vGoal, MIN_SPEED, MAX_SPEED);
    var a = MAX_ACCEL;
    if (Math.abs(vGoal - v0) < 1e-3) return dist / Math.max(v0, 1);
    if (vGoal > v0) {
      var tAcc = (vGoal - v0) / a;
      var dAcc = v0 * tAcc + 0.5 * a * tAcc * tAcc;
      if (dAcc >= dist) {
        // Solve 0.5 a t^2 + v0 t - dist = 0
        var disc = v0 * v0 + 2 * a * dist;
        return (-v0 + Math.sqrt(disc)) / a;
      }
      return tAcc + (dist - dAcc) / vGoal;
    }
    var tDec = (v0 - vGoal) / a;
    var dDec = v0 * tDec - 0.5 * a * tDec * tDec;
    if (dDec >= dist) {
      disc = v0 * v0 - 2 * a * dist;
      if (disc < 0) return dist / Math.max(v0, 1);
      return (v0 - Math.sqrt(disc)) / a;
    }
    return tDec + (dist - dDec) / Math.max(vGoal, 1);
  };

  /**
   * Cover targets: every changed module inside some disc with r <= MAX_TARGET_R
   * so a ball of radius BALL_R centered on the disc fully occludes it.
   */
  MaskBalls.prototype.clusterDiffs = function (moduleDiffs, meta, qr) {
    var size = meta.moduleSize;
    var margin = meta.margin || 2;
    var n = size + margin * 2;
    var cellW = qr.width / n;
    var cellH = qr.height / n;
    var pad = Math.max(cellW, cellH) * 0.5 + 1.5;

    function cellCenter(row, col) {
      return {
        row: row,
        col: col,
        x: qr.left + (col + margin + 0.5) * cellW,
        y: qr.top + (row + margin + 0.5) * cellH
      };
    }

    function coverCircle(cells) {
      if (!cells.length) return null;
      var minR = cells[0].row;
      var maxR = cells[0].row;
      var minC = cells[0].col;
      var maxC = cells[0].col;
      var i;
      for (i = 1; i < cells.length; i++) {
        minR = Math.min(minR, cells[i].row);
        maxR = Math.max(maxR, cells[i].row);
        minC = Math.min(minC, cells[i].col);
        maxC = Math.max(maxC, cells[i].col);
      }
      var cxMod = (minC + maxC) / 2;
      var cyMod = (minR + maxR) / 2;
      var x = qr.left + (cxMod + margin + 0.5) * cellW;
      var y = qr.top + (cyMod + margin + 0.5) * cellH;
      var r = 0;
      for (i = 0; i < cells.length; i++) {
        var dx = Math.abs(cells[i].col - cxMod) * cellW + cellW * 0.5;
        var dy = Math.abs(cells[i].row - cyMod) * cellH + cellH * 0.5;
        r = Math.max(r, hypot(dx, dy));
      }
      return { x: x, y: y, r: r + pad, count: cells.length, cells: cells };
    }

    var points = [];
    var seen = {};
    for (var i = 0; i < moduleDiffs.length; i++) {
      var row = moduleDiffs[i][0];
      var col = moduleDiffs[i][1];
      var key = row + ":" + col;
      if (seen[key]) continue;
      seen[key] = true;
      points.push(cellCenter(row, col));
    }
    if (!points.length) return [];

    var uncovered = points.slice();
    var targets = [];

    while (uncovered.length && targets.length < MAX_TARGETS) {
      var bestSeed = 0;
      var bestNeigh = -1;
      for (i = 0; i < uncovered.length; i++) {
        var neigh = 0;
        for (var j = 0; j < uncovered.length; j++) {
          if (hypot(uncovered[i].x - uncovered[j].x, uncovered[i].y - uncovered[j].y) < MAX_TARGET_R) {
            neigh++;
          }
        }
        if (neigh > bestNeigh) {
          bestNeigh = neigh;
          bestSeed = i;
        }
      }

      var cluster = [uncovered[bestSeed]];
      uncovered.splice(bestSeed, 1);
      var grew = true;
      while (grew) {
        grew = false;
        var circ = coverCircle(cluster);
        var pick = -1;
        for (j = 0; j < uncovered.length; j++) {
          var trial = coverCircle(cluster.concat([uncovered[j]]));
          if (trial.r <= MAX_TARGET_R) {
            pick = j;
            break;
          }
        }
        if (pick >= 0) {
          cluster.push(uncovered[pick]);
          uncovered.splice(pick, 1);
          grew = true;
        }
      }
      var final = coverCircle(cluster);
      targets.push({
        x: final.x,
        y: final.y,
        r: Math.min(MAX_TARGET_R, Math.max(10, final.r)),
        count: final.count,
        cells: final.cells,
        assigned: null
      });
    }

    // Leftovers → new micro-targets (one cell) displacing farthest/smallest if at cap
    while (uncovered.length) {
      var p = uncovered.pop();
      var solo = coverCircle([p]);
      if (targets.length < MAX_TARGETS) {
        targets.push({
          x: solo.x,
          y: solo.y,
          r: Math.min(MAX_TARGET_R, solo.r),
          count: 1,
          cells: solo.cells,
          assigned: null
        });
      } else {
        // Merge into nearest target only if still within MAX_TARGET_R; else replace smallest
        var nearest = 0;
        var nearestD = Infinity;
        for (i = 0; i < targets.length; i++) {
          var dd = hypot(p.x - targets[i].x, p.y - targets[i].y);
          if (dd < nearestD) {
            nearestD = dd;
            nearest = i;
          }
        }
        var mergedCells = (targets[nearest].cells || []).concat([p]);
        var rebuilt = coverCircle(mergedCells);
        if (rebuilt.r <= MAX_TARGET_R) {
          targets[nearest].x = rebuilt.x;
          targets[nearest].y = rebuilt.y;
          targets[nearest].r = rebuilt.r;
          targets[nearest].count = rebuilt.count;
          targets[nearest].cells = rebuilt.cells;
        } else {
          // Replace the target with fewest cells
          var weak = 0;
          for (i = 1; i < targets.length; i++) {
            if (targets[i].count < targets[weak].count) weak = i;
          }
          targets[weak] = {
            x: solo.x,
            y: solo.y,
            r: Math.min(MAX_TARGET_R, solo.r),
            count: 1,
            cells: solo.cells,
            assigned: null
          };
        }
      }
    }

    return targets;
  };

  MaskBalls.prototype.jobLockLeadMs = function () {
    var iv = this.intervalMs || 1000;
    // Lock from early in the cycle so N+1 prefetch cannot steal cover for N.
    return Math.max(JOB_LOCK_MIN_MS, Math.min(Math.floor(iv * 0.95), Math.max(JOB_LOCK_MAX_MS, Math.floor(iv * 0.6))));
  };

  /** Grace after planned flip time while waiting for a late paint. */
  MaskBalls.prototype.paintGraceMs = function () {
    // Stabilize/busy often delays paint 0.5–2s past the slot clock.
    return Math.max(1500, Math.min(5000, (this.intervalMs || 1000) * 1.2));
  };

  /**
   * True while a job must survive reassignment.
   * Unpainted jobs stay locked from lock-lead through planned time + paint grace
   * (stabilize/busy can delay the real QR paint past changeAtMs).
   */
  MaskBalls.prototype.jobIsLocked = function (job, now) {
    if (!job) return false;
    var trail = job.trailMs != null ? job.trailMs : COVER_TRAIL_MS;
    if (job.painted) {
      return now <= job.changeAtMs + trail;
    }
    if (now > job.changeAtMs + this.paintGraceMs()) return false;
    // Committed once within lock lead, or already past planned time awaiting paint
    return now >= job.changeAtMs - this.jobLockLeadMs();
  };

  MaskBalls.prototype.jobStillActive = function (job, now) {
    if (!job) return false;
    var trail = job.trailMs != null ? job.trailMs : COVER_TRAIL_MS;
    if (job.painted) return now <= job.changeAtMs + trail;
    return now <= job.changeAtMs + this.paintGraceMs();
  };

  MaskBalls.prototype.setForecast = function (events, meta) {
    if (!this.enabled) return;
    this.intervalMs = (meta && meta.intervalMs) || this.intervalMs || 1000;
    var qr = this.getQrRect();
    this.qrRect = qr;
    if (!this.balls.length) this.spawnPalette();

    if (!qr || !events || !events.length) {
      // Do not wipe in-flight queues on empty push — keep last good forecast
      return;
    }

    var coverMs = COVER_HOLD_MS + COVER_TRAIL_MS;
    var leadMs = COVER_LEAD_MS;
    var trailMs = COVER_TRAIL_MS;
    var now = Date.now();
    var grace = this.paintGraceMs();
    var built = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.diffs || !ev.diffs.length) continue;
      // Keep until paint grace — trail alone drops the flip before real paint
      if (ev.changeAtMs + grace < now - 30) continue;
      var targets = this.clusterDiffs(ev.diffs, ev, qr);
      if (!targets.length) continue;
      built.push({
        slot: ev.slot,
        changeAtMs: ev.changeAtMs,
        coverMs: coverMs,
        leadMs: leadMs,
        trailMs: trailMs,
        diffCount: ev.diffs.length,
        diffs: ev.diffs.slice(0, 40),
        targets: targets
      });
    }
    if (!built.length) {
      // Incoming horizon is entirely past — preserve current queues/events
      this.pruneBallQueues(now);
      return;
    }

    // Merge by slot: keep still-active flips not present in this push (partial horizon)
    var bySlot = {};
    var prev = this.events || [];
    for (i = 0; i < prev.length; i++) {
      var pe = prev[i];
      if (pe.changeAtMs + grace > now - 30) bySlot[pe.slot] = pe;
    }
    for (i = 0; i < built.length; i++) {
      bySlot[built[i].slot] = built[i];
    }
    var merged = [];
    for (var sk in bySlot) {
      if (Object.prototype.hasOwnProperty.call(bySlot, sk)) merged.push(bySlot[sk]);
    }
    merged.sort(function (a, b) { return a.changeAtMs - b.changeAtMs; });
    this.events = merged;
    this.assignAndAim(now);
    this.onLog("Mask forecast", this.forecastDebugPayload(merged, now));
    this.emitPlanDebug(now, true);
    this.startLoop();
  };

  MaskBalls.prototype.forecastDebugPayload = function (built, now) {
    var self = this;
    return {
      events: built.length,
      targets: built.reduce(function (n, e) { return n + e.targets.length; }, 0),
      balls: this.balls.length,
      horizon: built.map(function (ev) {
        return {
          slot: ev.slot,
          inMs: Math.round(ev.changeAtMs - now),
          diffs: ev.diffCount != null ? ev.diffCount : ev.targets.reduce(function (n, t) {
            return n + (t.count || 0);
          }, 0),
          cells: (ev.diffs || []).slice(0, 16).map(function (d) {
            return d[0] + "," + d[1];
          }),
          targets: ev.targets.map(function (t) {
            var cells = (t.cells || []).map(function (c) {
              return c.row + "," + c.col;
            });
            return {
              x: Math.round(t.x),
              y: Math.round(t.y),
              r: Math.round(t.r),
              n: t.count,
              ball: t.assigned || null,
              cells: cells.slice(0, 12)
            };
          })
        };
      }),
      ballsNow: self.balls.map(function (b) {
        return {
          id: b.colorId,
          x: Math.round(b.x),
          y: Math.round(b.y),
          sp: Math.round(b.speed),
          ang: Math.round(Math.atan2(b.vy, b.vx) * 180 / Math.PI),
          q: (b.queue || []).length
        };
      })
    };
  };

  MaskBalls.prototype.planForDiffs = function (moduleDiffs, meta) {
    this.setForecast([{
      slot: meta.slot || 0,
      changeAtMs: meta.changeAtMs,
      moduleSize: meta.moduleSize,
      margin: meta.margin || 2,
      diffs: moduleDiffs
    }], { intervalMs: meta.intervalMs });
  };

  MaskBalls.prototype.clearAssignments = function () {
    for (var i = 0; i < this.balls.length; i++) {
      this.balls[i].queue = [];
      this.balls[i].pendingAngle = null;
      this.balls[i].angleQueue = [];
      this.balls[i].postSpeed = null;
      this.balls[i].postSpeedQueue = [];
      this.balls[i].covering = false;
      this.balls[i].targetSpeed = clamp(this.balls[i].speed, MIN_SPEED, MAX_SPEED);
    }
  };

  MaskBalls.prototype.pruneBallQueues = function (now) {
    var self = this;
    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      ball.queue = (ball.queue || []).filter(function (a) {
        return self.jobStillActive(a, now);
      });
    }
  };

  /**
   * QR flip was painted. Sync job clocks to the real paint time so cover
   * does not expire early when stabilize/busy delayed the frame.
   */
  MaskBalls.prototype.notifyChanged = function (opts) {
    opts = opts || {};
    var now = opts.flipAtMs != null ? opts.flipAtMs : Date.now();
    var slot = opts.slot;
    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      var q = ball.queue || [];
      for (var j = 0; j < q.length; j++) {
        var job = q[j];
        var forThisFlip = (slot != null && job.slot === slot) ||
          (!job.painted && job.changeAtMs <= now + 80);
        if (!forThisFlip) continue;
        job.painted = true;
        job.changeAtMs = now; // real paint moment
        job.trailMs = COVER_TRAIL_MS;
        job.evacuateAfter = true;
        job.locked = true;
      }
    }
    var graceAfter = this.paintGraceMs();
    this.events = this.events.filter(function (ev) {
      if (slot != null && ev.slot === slot) return false; // consumed
      return ev.changeAtMs + graceAfter > now - 20;
    });
    this.pruneBallQueues(now);
  };

  /**
   * Snapshot at the exact QR flip paint moment:
   * change time, each changed module (row/col + px), ball positions, cover hit/miss.
   */
  MaskBalls.prototype.reportFlipCover = function (opts) {
    opts = opts || {};
    var now = opts.flipAtMs != null ? opts.flipAtMs : Date.now();
    var qr = this.getQrRect() || this.qrRect;
    var diffs = opts.diffs || [];
    var size = opts.moduleSize || 0;
    var margin = opts.margin != null ? opts.margin : 2;
    var cells = [];
    var covered = 0;
    var uncovered = [];
    var i;

    if (qr && size > 0 && diffs.length) {
      var n = size + margin * 2;
      var cellW = qr.width / n;
      var cellH = qr.height / n;
      for (i = 0; i < diffs.length; i++) {
        var row = diffs[i][0];
        var col = diffs[i][1];
        var cx = qr.left + (col + margin + 0.5) * cellW;
        var cy = qr.top + (row + margin + 0.5) * cellH;
        var hitBy = [];
        var nearest = null;
        var nearestD = Infinity;
        for (var bi = 0; bi < this.balls.length; bi++) {
          var b = this.balls[bi];
          var d = hypot(b.x - cx, b.y - cy);
          if (d < nearestD) {
            nearestD = d;
            nearest = b.colorId;
          }
          if (d <= BALL_R) hitBy.push(b.colorId);
        }
        var ok = hitBy.length > 0;
        if (ok) covered++;
        else uncovered.push(row + "," + col);
        cells.push({
          rc: row + "," + col,
          x: Math.round(cx),
          y: Math.round(cy),
          hit: hitBy,
          near: nearest,
          nearD: Math.round(nearestD)
        });
      }
    }

    var flipSlot = opts.slot;
    var balls = this.balls.map(function (b) {
      var job = b.queue && b.queue[0] ? b.queue[0] : null;
      // Prefer a queued job matching this flip when reporting cover
      if (flipSlot != null && b.queue && b.queue.length) {
        for (var ji = 0; ji < b.queue.length; ji++) {
          if (b.queue[ji].slot === flipSlot) {
            job = b.queue[ji];
            break;
          }
        }
      }
      var slotMismatch = !!(job && flipSlot != null && job.slot !== flipSlot);
      return {
        id: b.colorId,
        x: Math.round(b.x),
        y: Math.round(b.y),
        sp: Math.round(b.speed),
        ang: Math.round(Math.atan2(b.vy, b.vx) * 180 / Math.PI),
        cover: !!b.covering,
        plan: b.planKind || null,
        job: job ? {
          slot: job.slot,
          lock: !!job.locked,
          mismatch: slotMismatch,
          tMs: Math.round(job.changeAtMs - now),
          x: Math.round(job.x),
          y: Math.round(job.y),
          r: Math.round(job.r),
          d: Math.round(hypot(b.x - job.x, b.y - job.y))
        } : null
      };
    });

    var planned = null;
    for (i = 0; i < this.events.length; i++) {
      if (Math.abs(this.events[i].changeAtMs - now) < 800 ||
          (opts.slot != null && this.events[i].slot === opts.slot)) {
        planned = {
          slot: this.events[i].slot,
          tMs: Math.round(this.events[i].changeAtMs - now),
          diffs: this.events[i].diffCount,
          targets: (this.events[i].targets || []).map(function (t) {
            return {
              x: Math.round(t.x),
              y: Math.round(t.y),
              r: Math.round(t.r),
              n: t.count,
              ball: t.assigned || null
            };
          })
        };
        break;
      }
    }

    var report = {
      t: new Date(now).toISOString(),
      tMs: now,
      slot: opts.slot != null ? opts.slot : null,
      epoch: opts.epoch != null ? opts.epoch : null,
      qr: qr ? {
        l: Math.round(qr.left),
        t: Math.round(qr.top),
        w: Math.round(qr.width),
        h: Math.round(qr.height)
      } : null,
      diffs: diffs.length,
      covered: covered,
      miss: diffs.length - covered,
      pct: diffs.length ? Math.round(1000 * covered / diffs.length) / 10 : 100,
      uncovered: uncovered.slice(0, 40),
      cells: cells.slice(0, 48),
      balls: balls,
      planned: planned
    };
    this._lastFlipReport = report;
    return report;
  };

  MaskBalls.prototype.overlapsQr = function (ball, qr, pad) {
    if (!qr) return false;
    var p = pad != null ? pad : QR_CLEAR_PAD;
    var r = this.ballRadius(ball);
    return (
      ball.x + r > qr.left - p &&
      ball.x - r < qr.left + qr.width + p &&
      ball.y + r > qr.top - p &&
      ball.y - r < qr.top + qr.height + p
    );
  };

  /** True if current heading leaves the QR band within maxT seconds. */
  MaskBalls.prototype.headingClearsQr = function (ball, qr, maxT) {
    if (!qr || !this.overlapsQr(ball, qr, QR_CLEAR_PAD)) return true;
    var sp = hypot(ball.vx, ball.vy) || ball.speed;
    if (sp < 1) return false;
    var steps = 12;
    var dt = maxT / steps;
    var x = ball.x;
    var y = ball.y;
    var vx = ball.vx;
    var vy = ball.vy;
    for (var i = 0; i < steps; i++) {
      x += vx * dt;
      y += vy * dt;
      var ghost = { x: x, y: y, r: ball.r };
      if (!this.overlapsQr(ghost, qr, QR_CLEAR_PAD)) return true;
    }
    return false;
  };

  /**
   * After a mask job: leave the QR area ASAP using only bounce-angle + linear speed.
   */
  MaskBalls.prototype.evacuateFromQr = function (ball) {
    var qr = this.getQrRect() || this.qrRect;
    var r = this.ballRadius(ball);
    if (!qr || !this.overlapsQr(ball, qr, QR_CLEAR_PAD)) {
      ball.evacuating = false;
      if (!ball.queue || !ball.queue.length) {
        ball.targetSpeed = clamp(BASE_SPEED, MIN_SPEED, MAX_SPEED);
      }
      return;
    }
    ball.evacuating = true;
    ball.targetSpeed = MAX_SPEED;

    if (this.headingClearsQr(ball, qr, 0.55)) {
      return;
    }

    var w = window.innerWidth;
    var h = window.innerHeight;
    var cx = qr.left + qr.width / 2;
    var cy = qr.top + qr.height / 2;
    var edges = [
      { x: r + 6, y: clamp(ball.y, r + 6, h - r - 6) },
      { x: w - r - 6, y: clamp(ball.y, r + 6, h - r - 6) },
      { x: clamp(ball.x, r + 6, w - r - 6), y: r + 6 },
      { x: clamp(ball.x, r + 6, w - r - 6), y: h - r - 6 }
    ];
    // Prefer edge points far from QR center (clear of the code)
    var best = edges[0];
    var bestScore = -Infinity;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var ghost = { x: e.x, y: e.y, r: r };
      var clear = !this.overlapsQr(ghost, qr, QR_CLEAR_PAD + 10);
      var score = hypot(e.x - cx, e.y - cy) + (clear ? 400 : 0) - hypot(e.x - ball.x, e.y - ball.y) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }

    var probe = {
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      r: r,
      speed: ball.speed
    };
    var nb = this.nextBounce(probe, 10);
    if (nb) {
      ball.pendingAngle = Math.atan2(best.y - nb.y, best.x - nb.x);
      ball.postSpeed = MAX_SPEED;
    }
  };

  MaskBalls.prototype.nextBounce = function (ball, maxT) {
    var bounds = this.playBounds(ball);
    var vx = ball.vx;
    var vy = ball.vy;
    if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return null;
    var tx = Infinity;
    var ty = Infinity;
    var wallX = null;
    var wallY = null;
    if (vx > 0) {
      tx = (bounds.R - ball.x) / vx;
      wallX = "R";
    } else if (vx < 0) {
      tx = (bounds.L - ball.x) / vx;
      wallX = "L";
    }
    if (vy > 0) {
      ty = (bounds.B - ball.y) / vy;
      wallY = "B";
    } else if (vy < 0) {
      ty = (bounds.T - ball.y) / vy;
      wallY = "T";
    }
    var t = Math.min(tx, ty);
    if (!isFinite(t) || t < 0 || t > maxT) return null;
    var wall = t === tx ? wallX : wallY;
    if (Math.abs(tx - ty) < 1e-6) wall = (wallX || "") + (wallY || "");
    return {
      t: t,
      x: ball.x + vx * t,
      y: ball.y + vy * t,
      wall: wall
    };
  };

  /**
   * Simulate position after tSec with constant speed + specular bounces,
   * applying pendingAngle / angleQueue at successive walls (same as integrate).
   */
  MaskBalls.prototype.predictAt = function (ball, tSec, optSpeed, optPending, optQueue) {
    var speed = optSpeed != null ? optSpeed : (hypot(ball.vx, ball.vy) || ball.speed);
    var ang0 = Math.atan2(ball.vy, ball.vx);
    var sim = {
      x: ball.x,
      y: ball.y,
      vx: Math.cos(ang0) * speed,
      vy: Math.sin(ang0) * speed,
      r: BALL_R,
      speed: speed,
      pendingAngle: optPending != null ? optPending : ball.pendingAngle,
      angleQueue: (optQueue || ball.angleQueue || []).slice()
    };
    var elapsed = 0;
    var steps = 0;
    while (elapsed < tSec - 1e-6 && steps < 64) {
      var remain = tSec - elapsed;
      var nb = this.nextBounce(sim, remain + 1e-4);
      if (!nb || nb.t > remain) {
        sim.x += sim.vx * remain;
        sim.y += sim.vy * remain;
        elapsed = tSec;
        break;
      }
      sim.x = nb.x;
      sim.y = nb.y;
      elapsed += nb.t;
      if (sim.pendingAngle != null) {
        var ang = sim.pendingAngle;
        sim.pendingAngle = null;
        if (sim.angleQueue && sim.angleQueue.length) {
          sim.pendingAngle = sim.angleQueue.shift();
        }
        sim.vx = Math.cos(ang) * sim.speed;
        sim.vy = Math.sin(ang) * sim.speed;
      } else {
        if (nb.wall.indexOf("L") >= 0 || nb.wall.indexOf("R") >= 0) sim.vx = -sim.vx;
        if (nb.wall.indexOf("T") >= 0 || nb.wall.indexOf("B") >= 0) sim.vy = -sim.vy;
      }
      steps++;
    }
    return { x: sim.x, y: sim.y, speed: sim.speed, steps: steps };
  };

  /** True if current heading (with specular bounces / images) passes near target around tHit. */
  MaskBalls.prototype.trajectoryCovers = function (ball, target, changeAtMs, now) {
    var tHit = (changeAtMs - now) / 1000;
    if (tHit < 0.02 || tHit > 20) return false;
    var tol = Math.max(6, BALL_R - target.r);
    var pred = this.predictAt(ball, tHit);
    if (hypot(pred.x - target.x, pred.y - target.y) <= tol) return true;

    // Method of images: current heading toward some unfold of the target
    var sp = hypot(ball.vx, ball.vy) || ball.speed;
    if (sp < 1) return false;
    var ux = ball.vx / sp;
    var uy = ball.vy / sp;
    var bounds = this.playBounds(ball);
    for (var nx = -AIM_LOOKAHEAD_BOUNCES; nx <= AIM_LOOKAHEAD_BOUNCES; nx++) {
      for (var ny = -AIM_LOOKAHEAD_BOUNCES; ny <= AIM_LOOKAHEAD_BOUNCES; ny++) {
        var img = (nx === 0 && ny === 0)
          ? { x: target.x, y: target.y }
          : this.unfoldPoint(target.x, target.y, nx, ny, bounds);
        var toX = img.x - ball.x;
        var toY = img.y - ball.y;
        var along = toX * ux + toY * uy;
        var perp = hypot(toX - along * ux, toY - along * uy);
        if (along > 4 && perp <= tol && Math.abs(along / sp - tHit) <= 0.12) return true;
      }
    }
    return false;
  };

  /**
   * Plan intercept using ONLY:
   * - linear targetSpeed along current heading (incl. specular images), and/or
   * - pendingAngle (+ optional angleQueue) at wall bounces + linear speed
   * Speeding up reaches the wall sooner (same ray → earlier bounce).
   */
  MaskBalls.prototype.planIntercept = function (ball, target, changeAtMs, now) {
    // Arrive early so the ball is already on-disc during COVER_HOLD
    var arriveAt = changeAtMs - ARRIVE_EARLY_MS;
    if (arriveAt < now + 40) arriveAt = changeAtMs;
    var tHit = (arriveAt - now) / 1000;
    if (tHit < 0.04) {
      // Too late for timed intercept — rush toward target now
      tHit = Math.max(0.06, (changeAtMs - now) / 1000);
      if (tHit < 0.04) return {
        pendingAngle: null,
        angleQueue: [],
        targetSpeed: MAX_SPEED,
        postSpeed: null,
        score: 2000,
        kind: "rush",
        miss: hypot(ball.x - target.x, ball.y - target.y)
      };
    }

    var sp = hypot(ball.vx, ball.vy) || ball.speed;
    var ux = ball.vx / sp;
    var uy = ball.vy / sp;
    var tol = Math.max(4, BALL_R - target.r);
    var candidates = [];
    var bounds = this.playBounds(ball);

    // A) Speed-only along current heading toward any unfold image (multi-bounce specular)
    for (var nx = -AIM_LOOKAHEAD_BOUNCES; nx <= AIM_LOOKAHEAD_BOUNCES; nx++) {
      for (var ny = -AIM_LOOKAHEAD_BOUNCES; ny <= AIM_LOOKAHEAD_BOUNCES; ny++) {
        var img = (nx === 0 && ny === 0)
          ? { x: target.x, y: target.y }
          : this.unfoldPoint(target.x, target.y, nx, ny, bounds);
        var toX = img.x - ball.x;
        var toY = img.y - ball.y;
        var along = toX * ux + toY * uy;
        var perp = hypot(toX - along * ux, toY - along * uy);
        if (along <= 6 || perp > tol) continue;
        var needSpeed = along / tHit;
        if (needSpeed < MIN_SPEED * 0.65 || needSpeed > MAX_SPEED * 1.2) continue;
        var s = clamp(needSpeed, MIN_SPEED, MAX_SPEED);
        var tActual = this.timeToTravelAccel(along, sp, s);
        var timingErr = Math.abs(tActual - tHit);
        if (timingErr > 0.18) continue;
        candidates.push({
          pendingAngle: null,
          angleQueue: [],
          targetSpeed: s,
          postSpeed: null,
          score: perp + timingErr * 80 + Math.abs(s - sp) * 0.03 + (Math.abs(nx) + Math.abs(ny)) * 3,
          kind: "speed-image",
          bounces: Math.abs(nx) + Math.abs(ny)
        });
      }
    }

    // B) Redirect at next wall, then image-aim (encodes further specular bounces)
    var probe = {
      x: ball.x,
      y: ball.y,
      vx: ux * BASE_SPEED,
      vy: uy * BASE_SPEED,
      r: BALL_R,
      speed: BASE_SPEED
    };
    var nb = this.nextBounce(probe, 40);
    if (nb) {
      var wallDist = nb.t * BASE_SPEED;
      var preSpeeds = [
        MIN_SPEED,
        sp,
        (MIN_SPEED + MAX_SPEED) * 0.35,
        (MIN_SPEED + MAX_SPEED) * 0.55,
        MAX_SPEED * 0.72,
        MAX_SPEED * 0.88,
        MAX_SPEED
      ];
      for (var pi = 0; pi < preSpeeds.length; pi++) {
        var sPre = clamp(preSpeeds[pi], MIN_SPEED, MAX_SPEED);
        var tB = this.timeToTravelAccel(wallDist, sp, sPre);
        if (tB >= tHit - 0.04) continue;
        var tAfter = tHit - tB;
        var aim = this.bestImageAim(nb.x, nb.y, target, tAfter, ball);
        if (!aim) {
          // Fallback discrete travel match
          var sPostTry = clamp(hypot(target.x - nb.x, target.y - nb.y) / tAfter, MIN_SPEED, MAX_SPEED);
          aim = this.aimAngleFromBounce(nb.x, nb.y, target, sPostTry * tAfter, ball);
          if (aim) aim.speed = sPostTry;
        }
        if (!aim) continue;
        var ghost = {
          x: nb.x,
          y: nb.y,
          vx: Math.cos(aim.ang) * aim.speed,
          vy: Math.sin(aim.ang) * aim.speed,
          r: BALL_R,
          speed: aim.speed
        };
        var folded = this.predictAt(ghost, tAfter, aim.speed, null, []);
        var miss = hypot(folded.x - target.x, folded.y - target.y);
        candidates.push({
          pendingAngle: aim.ang,
          angleQueue: [],
          targetSpeed: sPre,
          postSpeed: aim.speed,
          postSpeedQueue: [],
          score: miss + tB * 18 + (aim.bounces || 0) * 3 + Math.abs(sPre - sp) * 0.02,
          kind: "bounce1-image",
          bounces: 1 + (aim.bounces || 0),
          miss: miss
        });
      }
    }

    // C) Two redirects — only when 1-bounce / speed-only leave a large miss
    var bestSoFar = candidates.length
      ? candidates.reduce(function (a, c) { return c.score < a.score ? c : a; }, candidates[0])
      : null;
    var needDeep = !bestSoFar || (bestSoFar.miss != null && bestSoFar.miss > tol + 10) || bestSoFar.score > 200;
    if (nb && MAX_PLAN_BOUNCES >= 2 && needDeep && tHit > 0.28) {
      var midSpeeds = [BASE_SPEED, (MIN_SPEED + MAX_SPEED) / 2, MAX_SPEED];
      var wallDist2 = nb.t * BASE_SPEED;
      for (var psi = 0; psi < midSpeeds.length; psi++) {
        var sPre2 = midSpeeds[psi];
        var tB1 = this.timeToTravelAccel(wallDist2, sp, sPre2);
        if (tB1 >= tHit - 0.1) continue;
        for (var msi = 0; msi < midSpeeds.length; msi++) {
          var sMid = midSpeeds[msi];
          for (nx = -2; nx <= 2; nx++) {
            for (ny = -2; ny <= 2; ny++) {
              if (nx === 0 && ny === 0) continue;
              img = this.unfoldPoint(target.x, target.y, nx, ny, bounds);
              var ang1 = Math.atan2(img.y - nb.y, img.x - nb.x);
              var midProbe = {
                x: nb.x,
                y: nb.y,
                vx: Math.cos(ang1) * sMid,
                vy: Math.sin(ang1) * sMid,
                r: BALL_R,
                speed: sMid
              };
              var remainAfter = tHit - tB1;
              var nb2 = this.nextBounce(midProbe, remainAfter - 0.05);
              if (!nb2 || nb2.t < 0.04) continue;
              var tB2 = nb2.t;
              if (tB1 + tB2 >= tHit - 0.04) continue;
              var tAfter2 = tHit - tB1 - tB2;
              var aim2 = this.bestImageAim(nb2.x, nb2.y, target, tAfter2, ball);
              if (!aim2) continue;
              var g2 = {
                x: nb2.x,
                y: nb2.y,
                vx: Math.cos(aim2.ang) * aim2.speed,
                vy: Math.sin(aim2.ang) * aim2.speed,
                r: BALL_R,
                speed: aim2.speed
              };
              var fold2 = this.predictAt(g2, tAfter2, aim2.speed, null, []);
              var miss2 = hypot(fold2.x - target.x, fold2.y - target.y);
              if (miss2 > tol + 18) continue;
              candidates.push({
                pendingAngle: ang1,
                angleQueue: [aim2.ang],
                targetSpeed: sPre2,
                postSpeed: sMid,
                postSpeedQueue: [aim2.speed],
                score: miss2 + (tB1 + tB2) * 12 + 40 + (Math.abs(nx) + Math.abs(ny)) * 2,
                kind: "bounce2",
                bounces: 2 + (aim2.bounces || 0),
                miss: miss2
              });
            }
          }
        }
      }
    }

    if (!candidates.length && nb) {
      // Rush to wall, aim toward nearest image; also score predicted miss at flip
      var late = this.bestImageAim(nb.x, nb.y, target, Math.max(0.12, tHit * 0.55), ball);
      var direct = hypot(target.x - nb.x, target.y - nb.y);
      var lateAng = late ? late.ang : Math.atan2(target.y - nb.y, target.x - nb.x);
      var latePost = late ? late.speed : clamp(direct / Math.max(0.08, tHit * 0.55), MIN_SPEED, MAX_SPEED);
      var lateGhost = {
        x: nb.x,
        y: nb.y,
        vx: Math.cos(lateAng) * latePost,
        vy: Math.sin(lateAng) * latePost,
        r: BALL_R,
        speed: latePost
      };
      var tWall = this.timeToTravelAccel(nb.t * BASE_SPEED, sp, MAX_SPEED);
      var lateMiss = 9999;
      if (tWall < tHit) {
        var foldLate = this.predictAt(lateGhost, tHit - tWall, latePost, null, []);
        lateMiss = hypot(foldLate.x - target.x, foldLate.y - target.y);
      } else {
        // Wall after flip: closest approach along current/max-speed ray
        var rush = this.predictAt(ball, tHit, MAX_SPEED, null, []);
        lateMiss = hypot(rush.x - target.x, rush.y - target.y);
      }
      candidates.push({
        pendingAngle: lateAng,
        angleQueue: [],
        targetSpeed: MAX_SPEED,
        postSpeed: latePost,
        score: 800 + lateMiss,
        kind: "late",
        bounces: late ? 1 + late.bounces : 1,
        miss: lateMiss
      });
    }

    if (!candidates.length) return null;
    candidates.sort(function (a, b) { return a.score - b.score; });
    var best = candidates[0];
    // Verify / refine miss with full predict when possible
    if (best.pendingAngle == null) {
      var check = this.predictAt(ball, tHit, best.targetSpeed, null, []);
      best.miss = hypot(check.x - target.x, check.y - target.y);
    }
    return best;
  };

  /**
   * Per-frame refine:
   * - With a job: ALWAYS intercept (never evacuate away from the target before trail ends)
   * - On disc near flip: slow down to linger through HOLD+TRAIL
   * - After trail: evacuate QR ASAP
   */
  MaskBalls.prototype.refineAim = function (ball, now) {
    var qr = this.getQrRect() || this.qrRect;

    while (ball.queue && ball.queue.length) {
      var head = ball.queue[0];
      if (!this.jobStillActive(head, now)) {
        ball.queue.shift();
        ball.needEvacuate = true;
        continue;
      }
      break;
    }

    var job = ball.queue && ball.queue[0] ? ball.queue[0] : null;
    var trailMs = job && job.trailMs != null ? job.trailMs : COVER_TRAIL_MS;

    // No job: leave QR / cruise — but for short intervals stay near the code
    // so the next assign has a chance (1s flips leave little travel time).
    if (!job) {
      var nextEv = null;
      for (var nei = 0; nei < (this.events || []).length; nei++) {
        var cand = this.events[nei];
        if (cand.changeAtMs + (cand.trailMs != null ? cand.trailMs : COVER_TRAIL_MS) < now) continue;
        if (!nextEv || cand.changeAtMs < nextEv.changeAtMs) nextEv = cand;
      }
      var soonMs = nextEv ? nextEv.changeAtMs - now : Infinity;
      var stayNear = soonMs < (this.intervalMs || 1000) * 1.35;

      if (stayNear) ball.needEvacuate = false;
      if (!stayNear && (ball.needEvacuate || this.overlapsQr(ball, qr, QR_CLEAR_PAD))) {
        this.evacuateFromQr(ball);
        if (!this.overlapsQr(ball, qr, QR_CLEAR_PAD)) ball.needEvacuate = false;
      } else if (stayNear && qr && !this.overlapsQr(ball, qr, QR_CLEAR_PAD + 40)) {
        // Soft approach toward QR band via next bounce only (no teleport)
        ball.evacuating = false;
        ball.needEvacuate = false;
        ball.targetSpeed = clamp(BASE_SPEED * 1.15, MIN_SPEED, MAX_SPEED);
        var cx = qr.left + qr.width / 2;
        var cy = qr.top + qr.height / 2;
        var probeIdle = {
          x: ball.x,
          y: ball.y,
          vx: ball.vx,
          vy: ball.vy,
          r: BALL_R,
          speed: ball.speed
        };
        var nbIdle = this.nextBounce(probeIdle, 12);
        if (nbIdle) {
          ball.pendingAngle = Math.atan2(cy - nbIdle.y, cx - nbIdle.x);
          ball.postSpeed = clamp(BASE_SPEED * 1.2, MIN_SPEED, MAX_SPEED);
        }
        ball.planKind = "orbit";
      } else {
        ball.evacuating = false;
        ball.needEvacuate = false;
        ball.targetSpeed = clamp(BASE_SPEED + (Math.random() * 2 - 1) * 25, MIN_SPEED, MAX_SPEED);
      }
      return;
    }

    var msToFlip = job.changeAtMs - now;
    var dist = hypot(ball.x - job.x, ball.y - job.y);
    // Slight slack: perfect disc fit is ~BALL_R−r; at high speed that window is one frame
    var onDisc = dist + job.r <= BALL_R + 10;
    var coveringCenter = dist <= BALL_R * 0.75;
    var nearApproach = dist <= BRAKE_DIST;
    var veryNear = dist <= CRAWL_DIST;
    // Waiting for late paint: treat as still in cover window past planned time
    var waitingPaint = !job.painted && msToFlip < 0 && this.jobStillActive(job, now);
    var inCoverWindow = (msToFlip <= COVER_HOLD_MS && msToFlip >= -trailMs) || waitingPaint;

    // After painted flip + trail → evacuate (next job handled next frame)
    if (job.painted && msToFlip < -trailMs) {
      ball.needEvacuate = true;
      this.evacuateFromQr(ball);
      return;
    }

    // On disc / covering center around the flip: linger (cannot reverse mid-air)
    if ((onDisc || coveringCenter) && inCoverWindow) {
      ball.evacuating = false;
      ball.needEvacuate = false;
      ball.covering = true;
      var remain = waitingPaint
        ? Math.max(0.12, this.paintGraceMs() / 1000)
        : Math.max(0.05, (msToFlip + trailMs) / 1000);
      var linger = clamp((BALL_R * 0.45) / remain, MIN_SPEED, BASE_SPEED * 0.85);
      ball.targetSpeed = linger;
      ball.pendingAngle = null;
      ball.angleQueue = [];
      ball.postSpeed = null;
      ball.planKind = waitingPaint ? "wait-paint" : "linger";
      ball.planMiss = Math.round(dist);
      return;
    }

    // Past planned flip, not on disc yet, paint not confirmed
    if (waitingPaint && !onDisc && !coveringCenter) {
      ball.evacuating = false;
      ball.needEvacuate = false;
      var rushPlan = this.planIntercept(ball, job, now + 120, now);
      if (rushPlan) this.applyPlan(ball, rushPlan);
      // Close: crawl — MAX_SPEED through the disc overshoots with no mid-air reverse
      if (nearApproach) {
        ball.targetSpeed = clamp(dist / 0.22, MIN_SPEED, BASE_SPEED * 0.95);
        ball.planKind = "brake-paint";
      } else {
        ball.targetSpeed = MAX_SPEED;
        ball.planKind = "late-paint";
      }
      return;
    }

    // Approaching: brake early so we do not fly through the cover disc
    if (nearApproach && msToFlip >= 0 && msToFlip < 1100) {
      ball.evacuating = false;
      ball.needEvacuate = false;
      var brakePlan = this.planIntercept(ball, job, job.changeAtMs, now);
      if (brakePlan) this.applyPlan(ball, brakePlan);
      var tSec = Math.max(0.16, msToFlip / 1000);
      var cap = clamp(dist / Math.max(0.14, tSec * 0.5), MIN_SPEED, MAX_SPEED);
      if (veryNear || msToFlip < COVER_HOLD_MS + 220) {
        cap = Math.min(cap, clamp(dist / 0.28, MIN_SPEED, BASE_SPEED * 0.8));
      }
      if (ball.targetSpeed == null || ball.targetSpeed > cap) ball.targetSpeed = cap;
      if (veryNear) ball.planKind = "brake";
      else if (!ball.planKind) ball.planKind = "prelinger";
      return;
    }

    // Approaching disc: if already close before HOLD, slow slightly and keep intercept
    if (onDisc && msToFlip > COVER_HOLD_MS && msToFlip < COVER_HOLD_MS + 280) {
      ball.evacuating = false;
      ball.targetSpeed = clamp(BASE_SPEED * 0.55, MIN_SPEED, BASE_SPEED);
      // Keep a light plan so direction stays good after bounce
      var earlyPlan = this.planIntercept(ball, job, job.changeAtMs, now);
      if (earlyPlan && earlyPlan.pendingAngle != null) this.applyPlan(ball, earlyPlan);
      else ball.planKind = "prelinger";
      return;
    }

    // Active job: always intercept — do NOT evacuate just because we overlap QR
    ball.evacuating = false;
    ball.needEvacuate = false;
    var plan = this.planIntercept(ball, job, job.changeAtMs, now);
    if (!plan) {
      // Fallback: rush toward target via next bounce
      ball.targetSpeed = nearApproach
        ? clamp(dist / 0.25, MIN_SPEED, BASE_SPEED)
        : MAX_SPEED;
      var probe = {
        x: ball.x,
        y: ball.y,
        vx: ball.vx,
        vy: ball.vy,
        r: BALL_R,
        speed: ball.speed
      };
      var nb = this.nextBounce(probe, 20);
      if (nb) {
        ball.pendingAngle = Math.atan2(job.y - nb.y, job.x - nb.x);
        ball.postSpeed = nearApproach
          ? clamp(dist / 0.3, MIN_SPEED, BASE_SPEED)
          : MAX_SPEED;
      }
      return;
    }
    this.applyPlan(ball, plan);

    // Late/poor plan + soon: max speed only when still far (near → brake, don't blast)
    if ((plan.kind === "late" || plan.kind === "rush" || (plan.miss != null && plan.miss > BALL_R)) &&
        msToFlip < 900 && !nearApproach) {
      ball.targetSpeed = MAX_SPEED;
    }
  };

  MaskBalls.prototype.applyPlan = function (ball, plan) {
    if (!plan) return;
    ball.targetSpeed = plan.targetSpeed;
    ball.postSpeed = plan.postSpeed != null ? plan.postSpeed : null;
    ball.postSpeedQueue = (plan.postSpeedQueue || []).slice();
    if (plan.pendingAngle != null) {
      ball.pendingAngle = plan.pendingAngle;
      ball.angleQueue = (plan.angleQueue || []).slice();
    } else if (plan.kind === "speed-image" || plan.kind === "on-track") {
      // Pure speed plan: clear stale redirects so specular path stays valid
      ball.pendingAngle = null;
      ball.angleQueue = [];
      ball.postSpeed = null;
      ball.postSpeedQueue = [];
    }
    ball.planKind = plan.kind || null;
    ball.planMiss = plan.miss != null ? plan.miss : null;
    ball.planBounces = plan.bounces != null ? plan.bounces : null;
  };

  MaskBalls.prototype.ballFreeFor = function (ball, changeAtMs, leadMs, trailMs) {
    var q = ball.queue || [];
    var win = (leadMs || COVER_LEAD_MS) + (trailMs || COVER_TRAIL_MS) + 40;
    for (var i = 0; i < q.length; i++) {
      if (Math.abs(q[i].changeAtMs - changeAtMs) < win) return false;
    }
    return true;
  };

  /** Match a locked job to the nearest event target so we do not double-assign. */
  MaskBalls.prototype.markLockedTarget = function (ev, job) {
    if (!ev || !ev.targets || !job) return null;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < ev.targets.length; i++) {
      var t = ev.targets[i];
      if (t.assigned) continue;
      var d = hypot(t.x - job.x, t.y - job.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best && bestD <= Math.max(BALL_R * 1.35, (job.r || 0) + 24)) {
      best.assigned = job.ballId || true;
      return best;
    }
    return null;
  };

  MaskBalls.prototype.assignAndAim = function (now) {
    // Preserve continuous flight: never teleport x,y,r.
    // Keep locked jobs (current / imminent flip) — only rewrite future unlocked work.
    var planFor = {};
    var assignments = [];
    var lockedCount = 0;
    var self = this;

    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      var kept = [];
      var oldQ = ball.queue || [];
      for (var qi = 0; qi < oldQ.length; qi++) {
        var oldJob = oldQ[qi];
        // Honor paint grace — trail alone drops unpainted cover before real paint
        if (!this.jobStillActive(oldJob, now)) continue;
        if (this.jobIsLocked(oldJob, now)) {
          oldJob.locked = true;
          oldJob.ballId = ball.colorId;
          kept.push(oldJob);
          lockedCount++;
        }
      }
      ball.queue = kept;
    }

    // Prefer sooner slots; for short intervals only plan the nearest 1–2 flips ahead
    var events = this.events.slice().sort(function (a, b) {
      return a.changeAtMs - b.changeAtMs;
    });
    var iv = this.intervalMs || 1000;
    var grace = this.paintGraceMs();
    var lockLead = this.jobLockLeadMs();
    // Next flip only (+ one lookahead). Far horizon steals balls from the imminent paint.
    var maxAhead = 2;
    var horizonMs = iv * maxAhead + 80;
    events = events.filter(function (ev) {
      if (now >= ev.changeAtMs - lockLead) return now <= ev.changeAtMs + grace;
      if (now > ev.changeAtMs + grace) return false;
      return ev.changeAtMs - now <= horizonMs;
    });

    // While flip N is in lock/paint window, do not staff N+1 — that was the first-flip miss
    var focusEv = null;
    for (var fe = 0; fe < events.length; fe++) {
      var fEv = events[fe];
      if (now >= fEv.changeAtMs - lockLead && now <= fEv.changeAtMs + grace) {
        focusEv = fEv;
        break;
      }
    }
    if (focusEv) {
      events = events.filter(function (ev) {
        return ev.slot === focusEv.slot ||
          Math.abs(ev.changeAtMs - focusEv.changeAtMs) < 80;
      });
    }

    // Remap locked jobs onto current event targets (same slot)
    for (i = 0; i < this.balls.length; i++) {
      ball = this.balls[i];
      for (qi = 0; qi < ball.queue.length; qi++) {
        var lj = ball.queue[qi];
        var evMatch = null;
        for (var ei0 = 0; ei0 < events.length; ei0++) {
          if (events[ei0].slot === lj.slot ||
              Math.abs(events[ei0].changeAtMs - lj.changeAtMs) < 80) {
            evMatch = events[ei0];
            break;
          }
        }
        var mt = this.markLockedTarget(evMatch, lj);
        if (mt) {
          lj.x = mt.x;
          lj.y = mt.y;
          lj.r = mt.r;
          lj.changeAtMs = evMatch.changeAtMs;
          lj.slot = evMatch.slot;
          lj.cells = (mt.cells || []).map(function (c) {
            return [c.row, c.col];
          });
        }
        assignments.push({
          slot: lj.slot,
          inMs: Math.round(lj.changeAtMs - now),
          ball: ball.colorId,
          x: Math.round(lj.x),
          y: Math.round(lj.y),
          n: (lj.cells && lj.cells.length) || 0,
          kind: "locked",
          miss: Math.round(hypot(ball.x - lj.x, ball.y - lj.y)),
          bounces: null,
          sp: Math.round(ball.targetSpeed || ball.speed),
          post: null
        });
        if (planFor[i] == null || lj.changeAtMs < planFor[i].job.changeAtMs) {
          var lockPlan = this.planIntercept(ball, lj, lj.changeAtMs, now) || {
            pendingAngle: null,
            targetSpeed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, ball.speed)),
            score: 0,
            kind: "locked",
            miss: hypot(ball.x - lj.x, ball.y - lj.y)
          };
          planFor[i] = { job: lj, plan: lockPlan };
        }
      }
    }

    for (var ei = 0; ei < events.length; ei++) {
      var ev = events[ei];
      var targets = ev.targets.slice().sort(function (a, b) {
        return (b.count || 0) - (a.count || 0);
      });
      for (var ti = 0; ti < targets.length; ti++) {
        var target = targets[ti];
        if (target.assigned) continue;
        var chosen = null;
        var chosenPlan = null;
        var chosenScore = Infinity;

        for (var bi = 0; bi < this.balls.length; bi++) {
          ball = this.balls[bi];
          if (!this.ballFreeFor(ball, ev.changeAtMs, ev.leadMs, ev.trailMs)) continue;
          var hasLocked = false;
          for (qi = 0; qi < (ball.queue || []).length; qi++) {
            if (ball.queue[qi].locked) { hasLocked = true; break; }
          }

          var plan = null;
          var score;
          if (this.trajectoryCovers(ball, target, ev.changeAtMs, now)) {
            plan = this.planIntercept(ball, target, ev.changeAtMs, now) || {
              pendingAngle: null,
              targetSpeed: ball.speed,
              score: 0,
              kind: "on-track",
              miss: 0
            };
            score = plan.score - 40;
          } else {
            plan = this.planIntercept(ball, target, ev.changeAtMs, now);
            if (!plan) continue;
            score = plan.score + 20;
          }
          score += (ball.queue.length || 0) * 12;
          if (hasLocked) score += 28;
          if (plan.miss != null) score += plan.miss * 1.1;
          else score += 500;
          if (plan.kind === "late" || plan.kind === "rush") score += 350;
          score += hypot(ball.x - target.x, ball.y - target.y) * 0.08;
          if (ev.changeAtMs - now < (this.intervalMs || 1000) * 1.15) {
            if (plan.kind === "late" || plan.kind === "rush") score += 220;
            else score -= 35;
          }
          if (score < chosenScore) {
            chosenScore = score;
            chosen = bi;
            chosenPlan = plan;
          }
        }

        if (chosen != null && chosenPlan) {
          ball = this.balls[chosen];
          target.assigned = ball.colorId;
          var job = {
            changeAtMs: ev.changeAtMs,
            coverMs: ev.coverMs,
            leadMs: ev.leadMs || COVER_LEAD_MS,
            trailMs: ev.trailMs || COVER_TRAIL_MS,
            x: target.x,
            y: target.y,
            r: target.r,
            slot: ev.slot,
            locked: this.jobIsLocked({ changeAtMs: ev.changeAtMs, trailMs: ev.trailMs, painted: false }, now),
            painted: false,
            ballId: ball.colorId,
            cells: (target.cells || []).map(function (c) {
              return [c.row, c.col];
            })
          };
          ball.queue.push(job);
          assignments.push({
            slot: ev.slot,
            inMs: Math.round(ev.changeAtMs - now),
            ball: ball.colorId,
            x: Math.round(target.x),
            y: Math.round(target.y),
            n: target.count,
            kind: chosenPlan.kind,
            miss: chosenPlan.miss != null ? Math.round(chosenPlan.miss) : null,
            bounces: chosenPlan.bounces,
            sp: Math.round(chosenPlan.targetSpeed),
            post: chosenPlan.postSpeed != null ? Math.round(chosenPlan.postSpeed) : null
          });
          if (planFor[chosen] == null || job.changeAtMs < planFor[chosen].job.changeAtMs) {
            planFor[chosen] = { job: job, plan: chosenPlan };
          }
        } else {
          assignments.push({
            slot: ev.slot,
            inMs: Math.round(ev.changeAtMs - now),
            ball: null,
            x: Math.round(target.x),
            y: Math.round(target.y),
            n: target.count,
            kind: "unassigned"
          });
        }
      }
    }

    for (bi = 0; bi < this.balls.length; bi++) {
      ball = this.balls[bi];
      ball.queue.sort(function (a, b) { return a.changeAtMs - b.changeAtMs; });
      var pf = planFor[bi];
      if (!pf) {
        if (!ball.queue.length) {
          ball.targetSpeed = clamp(BASE_SPEED + (Math.random() * 2 - 1) * 30, MIN_SPEED, MAX_SPEED);
        }
        continue;
      }
      this.applyPlan(ball, pf.plan);
    }

    this._lastAssign = assignments;
    this.onLog("Mask assign", {
      n: assignments.length,
      hits: assignments.filter(function (a) { return a.ball; }).length,
      locked: lockedCount,
      rows: assignments.slice(0, 24)
    });
  };

  /** Linear speed change toward targetSpeed; direction unchanged. */
  MaskBalls.prototype.applySpeed = function (ball, dt) {
    var cur = hypot(ball.vx, ball.vy) || ball.speed;
    var target = clamp(ball.targetSpeed || cur, MIN_SPEED, MAX_SPEED);
    var maxStep = MAX_ACCEL * dt;
    var next = cur;
    if (target > cur) next = Math.min(target, cur + maxStep);
    else if (target < cur) next = Math.max(target, cur - maxStep);
    if (cur < 1e-4) {
      var ang = ball.pendingAngle != null ? ball.pendingAngle : Math.random() * Math.PI * 2;
      ball.vx = Math.cos(ang) * next;
      ball.vy = Math.sin(ang) * next;
    } else {
      ball.vx = (ball.vx / cur) * next;
      ball.vy = (ball.vy / cur) * next;
    }
    ball.speed = next;
  };

  MaskBalls.prototype.integrate = function (ball, dt) {
    var bounds = this.playBounds(ball);
    var remaining = dt;
    var guard = 0;
    while (remaining > 1e-6 && guard++ < 8) {
      var nb = this.nextBounce(ball, remaining + 1e-5);
      if (!nb || nb.t > remaining) {
        ball.x += ball.vx * remaining;
        ball.y += ball.vy * remaining;
        remaining = 0;
        break;
      }
      ball.x = nb.x;
      ball.y = nb.y;
      remaining -= nb.t;

      if (ball.pendingAngle != null) {
        var ang = ball.pendingAngle;
        ball.pendingAngle = null;
        // Optional post-bounce speed (linear retarget after angle change)
        if (ball.postSpeed != null) {
          ball.targetSpeed = clamp(ball.postSpeed, MIN_SPEED, MAX_SPEED);
          ball.speed = ball.targetSpeed;
          ball.postSpeed = null;
        }
        // Queue next redirect for a later wall (multi-bounce plans)
        if (ball.angleQueue && ball.angleQueue.length) {
          ball.pendingAngle = ball.angleQueue.shift();
          if (ball.postSpeedQueue && ball.postSpeedQueue.length) {
            ball.postSpeed = ball.postSpeedQueue.shift();
          }
        }
        ball.vx = Math.cos(ang) * ball.speed;
        ball.vy = Math.sin(ang) * ball.speed;
      } else {
        // Specular reflection — angle change only at edge
        if (nb.wall.indexOf("L") >= 0 || nb.wall.indexOf("R") >= 0) ball.vx = -ball.vx;
        if (nb.wall.indexOf("T") >= 0 || nb.wall.indexOf("B") >= 0) ball.vy = -ball.vy;
      }
      var sp = hypot(ball.vx, ball.vy) || ball.speed;
      ball.vx = (ball.vx / sp) * ball.speed;
      ball.vy = (ball.vy / sp) * ball.speed;
      ball.x = clamp(ball.x, bounds.L, bounds.R);
      ball.y = clamp(ball.y, bounds.T, bounds.B);
    }
  };

  MaskBalls.prototype.drawBallRgb = function (ctx, ball, scale) {
    var r = this.ballRadius(ball) * scale;
    var x = ball.x * scale;
    var y = ball.y * scale;
    var col = ball.rgb;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
    ctx.fill();
    // Fixed stroke width — must not change perceived ball size when covering
    ctx.lineWidth = 1.75 * scale;
    ctx.strokeStyle = ball.covering ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.3)";
    ctx.stroke();
  };

  /**
   * CMYK: opaque multiply on white (subtractive overlaps), then punch pure-white
   * to transparent. Never use semi-transparent fills in the multiply pass —
   * that was collapsing C/M/Y to near-black.
   */
  MaskBalls.prototype.paintCmyk = function (balls, scale) {
    var ctx = this.cmykCtx;
    var w = this.cmykCanvas.width;
    var h = this.cmykCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!balls.length) return;

    if (!this._cmykBuf || this._cmykBuf.width !== w || this._cmykBuf.height !== h) {
      this._cmykBuf = document.createElement("canvas");
      this._cmykBuf.width = w;
      this._cmykBuf.height = h;
      this._cmykBufCtx = this._cmykBuf.getContext("2d", { willReadFrequently: true });
    }
    var off = this._cmykBufCtx;
    off.setTransform(1, 0, 0, 1, 0, 0);
    off.globalCompositeOperation = "source-over";
    off.globalAlpha = 1;
    off.fillStyle = "#ffffff";
    off.fillRect(0, 0, w, h);
    off.globalCompositeOperation = "multiply";
    var i;
    var rPx = BALL_R * scale;
    for (i = 0; i < balls.length; i++) {
      var b = balls[i];
      this.ballRadius(b);
      off.beginPath();
      off.arc(b.x * scale, b.y * scale, rPx, 0, Math.PI * 2);
      off.closePath();
      off.fillStyle = "rgb(" + b.rgb[0] + "," + b.rgb[1] + "," + b.rgb[2] + ")";
      off.fill();
    }

    // Bounding box of balls → only punch alpha there (perf)
    var minX = w;
    var minY = h;
    var maxX = 0;
    var maxY = 0;
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      var rr = rPx + 2;
      minX = Math.min(minX, b.x * scale - rr);
      minY = Math.min(minY, b.y * scale - rr);
      maxX = Math.max(maxX, b.x * scale + rr);
      maxY = Math.max(maxY, b.y * scale + rr);
    }
    minX = Math.max(0, minX | 0);
    minY = Math.max(0, minY | 0);
    maxX = Math.min(w, Math.ceil(maxX));
    maxY = Math.min(h, Math.ceil(maxY));
    var bw = Math.max(1, maxX - minX);
    var bh = Math.max(1, maxY - minY);
    var img = off.getImageData(minX, minY, bw, bh);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      if (d[p] >= 250 && d[p + 1] >= 250 && d[p + 2] >= 250) d[p + 3] = 0;
      else d[p + 3] = 255;
    }
    off.putImageData(img, minX, minY);

    // Clear outside bbox to transparent (rest of white buffer)
    off.globalCompositeOperation = "destination-in";
    off.fillStyle = "#ffffff";
    off.beginPath();
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      off.moveTo(b.x * scale + rPx, b.y * scale);
      off.arc(b.x * scale, b.y * scale, rPx, 0, Math.PI * 2);
    }
    off.fill();
    off.globalCompositeOperation = "source-over";

    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this._cmykBuf, 0, 0);
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      ctx.beginPath();
      ctx.arc(b.x * scale, b.y * scale, rPx, 0, Math.PI * 2);
      ctx.lineWidth = 1.75 * scale;
      ctx.strokeStyle = b.covering ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.45)";
      ctx.stroke();
    }
  };

  MaskBalls.prototype.getDebugSnapshot = function (now) {
    now = now || Date.now();
    var self = this;
    var qrChanges = (this.events || []).map(function (ev) {
      return {
        slot: ev.slot,
        inMs: Math.round(ev.changeAtMs - now),
        diffs: ev.diffCount != null ? ev.diffCount : 0,
        cells: (ev.diffs || []).slice(0, 20).map(function (d) {
          return d[0] + "," + d[1];
        }),
        targets: (ev.targets || []).map(function (t) {
          return {
            x: Math.round(t.x),
            y: Math.round(t.y),
            r: Math.round(t.r),
            n: t.count,
            ball: t.assigned || null
          };
        })
      };
    });
    var balls = this.balls.map(function (b) {
      var job = b.queue && b.queue[0] ? b.queue[0] : null;
      var tHit = job ? (job.changeAtMs - now) / 1000 : null;
      var pred = tHit != null && tHit > 0 ? self.predictAt(b, tHit) : null;
      var miss = pred && job ? Math.round(hypot(pred.x - job.x, pred.y - job.y)) : null;
      return {
        id: b.colorId,
        x: Math.round(b.x),
        y: Math.round(b.y),
        sp: Math.round(b.speed),
        tgtSp: Math.round(b.targetSpeed || b.speed),
        ang: Math.round(Math.atan2(b.vy, b.vx) * 180 / Math.PI),
        cover: !!b.covering,
        evac: !!b.evacuating || !!b.needEvacuate,
        pending: b.pendingAngle != null,
        q: (b.queue || []).map(function (j) {
          return {
            slot: j.slot,
            inMs: Math.round(j.changeAtMs - now),
            x: Math.round(j.x),
            y: Math.round(j.y),
            cells: (j.cells || []).slice(0, 8).map(function (c) {
              return c[0] + "," + c[1];
            })
          };
        }),
        pred: pred ? { x: Math.round(pred.x), y: Math.round(pred.y), miss: miss } : null,
        plan: b.planKind ? { kind: b.planKind, miss: b.planMiss != null ? Math.round(b.planMiss) : null, b: b.planBounces } : null
      };
    });
    return {
      t: now,
      qr: qrChanges,
      balls: balls,
      assign: this._lastAssign || []
    };
  };

  MaskBalls.prototype.emitPlanDebug = function (now, force) {
    now = now || Date.now();
    if (!force && this._lastDebugMs && now - this._lastDebugMs < DEBUG_SNAP_MS) return;
    this._lastDebugMs = now;
    var snap = this.getDebugSnapshot(now);
    this.onPlanDebug(snap);
  };

  MaskBalls.prototype.paint = function () {
    if (!this.rgbCtx || !this.cmykCtx) return;
    var w = this.rgbCanvas.width;
    var h = this.rgbCanvas.height;
    var scale = this.dpr;
    var rgbBalls = [];
    var cmykBalls = [];
    for (var i = 0; i < this.balls.length; i++) {
      if (this.balls[i].group === "rgb") rgbBalls.push(this.balls[i]);
      else cmykBalls.push(this.balls[i]);
    }

    var ctx = this.rgbCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < rgbBalls.length; i++) this.drawBallRgb(ctx, rgbBalls[i], scale);
    ctx.globalCompositeOperation = "source-over";

    this.paintCmyk(cmykBalls, scale);
  };

  MaskBalls.prototype.tick = function (ts) {
    if (!this.enabled) return;
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    var now = Date.now();

    if (this.rgbCanvas &&
        (this.rgbCanvas.style.width !== window.innerWidth + "px" ||
         this.rgbCanvas.style.height !== window.innerHeight + "px")) {
      this.resizeCanvases();
    }

    // Always keep full palette alive
    if (this.balls.length < BALL_COLORS.length) this.spawnPalette();

    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      this.ballRadius(ball); // enforce constant size every frame
      // Continuously refine intercept (angle only queued for next bounce)
      this.refineAim(ball, now);
      this.applySpeed(ball, dt);
      this.integrate(ball, dt);

      var covering = false;
      var q = ball.queue || [];
      var br = BALL_R;
      for (var qi = 0; qi < q.length; qi++) {
        var a = q[qi];
        var trail = a.trailMs != null ? a.trailMs : COVER_TRAIL_MS;
        var inWin;
        if (a.painted) {
          inWin = now >= a.changeAtMs - COVER_HOLD_MS && now <= a.changeAtMs + trail;
        } else {
          // Unpainted: hold window through planned time + paint grace
          inWin = now >= a.changeAtMs - COVER_HOLD_MS &&
            now <= a.changeAtMs + this.paintGraceMs();
        }
        if (!inWin) continue;
        var dist = hypot(ball.x - a.x, ball.y - a.y);
        if (dist + a.r <= br + 10 || dist <= br * 0.75) covering = true;
      }
      if ((ball.planKind === "linger" || ball.planKind === "wait-paint" ||
           ball.planKind === "brake" || ball.planKind === "brake-paint") &&
          ball.covering) covering = true;
      ball.covering = covering;
    }

    this.paint();

    var tickGrace = this.paintGraceMs();
    this.events = this.events.filter(function (ev) {
      // Keep unpainted flips through paint grace (trail is only post-paint)
      return ev.changeAtMs + tickGrace > now - 40;
    });
    this.pruneBallQueues(now);
    this.emitPlanDebug(now, false);

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

  MaskBalls.COLORS = BALL_COLORS;
  MaskBalls.BALL_R = BALL_R;

  global.MaskBalls = MaskBalls;
})(typeof window !== "undefined" ? window : globalThis);
