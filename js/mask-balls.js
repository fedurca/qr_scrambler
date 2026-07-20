/**
 * Mask balls: R/G/B + C/M/Y/K continuous billiard motion.
 *
 * Motion rules:
 * - Always visible, never teleported / despawned while enabled
 * - Direction changes ONLY on viewport-edge bounce (angle)
 * - Speed may change linearly (acceleration) between bounces
 *
 * Color:
 * - RGB group: additive (lighter) — separate canvas
 * - CMYK group: subtractive (multiply) — separate canvas
 * - Groups do not color-mix with each other
 */
(function (global) {
  "use strict";

  var BALL_COLORS = [
    { id: "R", group: "rgb", hex: "#ff0000", rgb: [255, 0, 0] },
    { id: "G", group: "rgb", hex: "#00ff00", rgb: [0, 255, 0] },
    { id: "B", group: "rgb", hex: "#0000ff", rgb: [0, 0, 255] },
    { id: "C", group: "cmyk", hex: "#00ffff", rgb: [0, 255, 255] },
    { id: "M", group: "cmyk", hex: "#ff00ff", rgb: [255, 0, 255] },
    { id: "Y", group: "cmyk", hex: "#ffff00", rgb: [255, 255, 0] },
    { id: "K", group: "cmyk", hex: "#111111", rgb: [20, 20, 20] }
  ];

  var BALL_R = 42;
  var MIN_SPEED = 140;
  var MAX_SPEED = 720;
  var BASE_SPEED = 280;
  var SPEED_JITTER = 50;
  var MAX_ACCEL = 900; // px/s² — linear speed changes only
  var COVER_LEAD_MS = 90;
  var COVER_TRAIL_MS = 100;
  var AIM_LOOKAHEAD_BOUNCES = 4;
  var MAX_TARGETS = 7;
  /** Cluster disc must fit inside the ball so a centered hit fully covers modules. */
  var MAX_TARGET_R = BALL_R - 4;

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
    this.intervalMs = 1000;
    this.dpr = 1;
    this.getQrRect = options && options.getQrRect ? options.getQrRect : function () { return null; };
    this.onLog = options && options.onLog ? options.onLog : function () {};
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
    for (var i = 0; i < BALL_COLORS.length; i++) {
      var c = BALL_COLORS[i];
      var speed = BASE_SPEED + (Math.random() * 2 - 1) * SPEED_JITTER;
      var ang = (i / BALL_COLORS.length) * Math.PI * 2 + Math.random() * 0.55;
      this.spawnBall(
        BALL_R + 20 + Math.random() * Math.max(1, w - BALL_R * 2 - 40),
        BALL_R + 20 + Math.random() * Math.max(1, h - BALL_R * 2 - 40),
        c,
        Math.cos(ang) * speed,
        Math.sin(ang) * speed
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
      queue: [],
      covering: false
    };
    this.balls.push(ball);
    return ball;
  };

  MaskBalls.prototype.playBounds = function (ball) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var r = ball.r;
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
        var score = raw + (Math.abs(nx) + Math.abs(ny)) * 3;
        if (score < bestScore) {
          bestScore = score;
          best = { ang: Math.atan2(imgY - by, imgX - bx), dist: d, raw: raw };
        }
      }
    }
    if (!best) return null;
    var slack = Math.max(BALL_R * 1.2, travelDist * 0.22, 50);
    if (best.raw > slack) return null;
    return best;
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

  MaskBalls.prototype.setForecast = function (events, meta) {
    if (!this.enabled) return;
    this.intervalMs = (meta && meta.intervalMs) || this.intervalMs || 1000;
    var qr = this.getQrRect();
    this.qrRect = qr;
    if (!this.balls.length) this.spawnPalette();

    if (!qr || !events || !events.length) {
      this.events = [];
      this.clearAssignments();
      return;
    }

    var coverMs = clamp(this.intervalMs * 0.1, COVER_LEAD_MS, 220);
    var leadMs = COVER_LEAD_MS;
    var trailMs = COVER_TRAIL_MS;
    var now = Date.now();
    var built = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.diffs || !ev.diffs.length) continue;
      if (ev.changeAtMs + trailMs < now - 30) continue;
      var targets = this.clusterDiffs(ev.diffs, ev, qr);
      if (!targets.length) continue;
      built.push({
        slot: ev.slot,
        changeAtMs: ev.changeAtMs,
        coverMs: coverMs,
        leadMs: leadMs,
        trailMs: trailMs,
        targets: targets
      });
    }
    this.events = built;
    this.assignAndAim(now);
    this.onLog("Mask forecast", {
      events: built.length,
      targets: built.reduce(function (n, e) { return n + e.targets.length; }, 0),
      coverMs: Math.round(coverMs),
      balls: this.balls.length
    });
    this.startLoop();
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
      this.balls[i].covering = false;
      this.balls[i].targetSpeed = clamp(this.balls[i].speed, MIN_SPEED, MAX_SPEED);
    }
  };

  MaskBalls.prototype.pruneBallQueues = function (now) {
    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      ball.queue = (ball.queue || []).filter(function (a) {
        var trail = a.trailMs != null ? a.trailMs : COVER_TRAIL_MS;
        return a.changeAtMs + trail > now - 20;
      });
    }
  };

  MaskBalls.prototype.notifyChanged = function () {
    var now = Date.now();
    this.events = this.events.filter(function (ev) {
      var trail = ev.trailMs != null ? ev.trailMs : COVER_TRAIL_MS;
      return ev.changeAtMs + trail > now - 20;
    });
    this.pruneBallQueues(now);
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

  /** True if current heading (with specular bounces) passes near target around tHit. */
  MaskBalls.prototype.trajectoryCovers = function (ball, target, changeAtMs, now) {
    var tHit = (changeAtMs - now) / 1000;
    if (tHit < 0.02 || tHit > 14) return false;
    var sim = { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, r: ball.r, speed: ball.speed };
    var elapsed = 0;
    var steps = 0;
    var tol = Math.max(6, BALL_R - target.r);
    while (elapsed < tHit + 0.05 && steps < 48) {
      var remain = tHit - elapsed;
      if (remain < 0) break;
      var nb = this.nextBounce(sim, remain + 1e-4);
      var dt = nb ? Math.min(nb.t, remain) : remain;
      var x1 = sim.x + sim.vx * dt;
      var y1 = sim.y + sim.vy * dt;
      var dx = x1 - sim.x;
      var dy = y1 - sim.y;
      var len2 = dx * dx + dy * dy;
      if (len2 >= 1e-8) {
        var u = clamp(((target.x - sim.x) * dx + (target.y - sim.y) * dy) / len2, 0, 1);
        var cx = sim.x + u * dx;
        var cy = sim.y + u * dy;
        var tSeg = elapsed + u * dt;
        if (hypot(cx - target.x, cy - target.y) <= tol && Math.abs(tSeg - tHit) <= 0.08) {
          return true;
        }
      }
      if (!nb || dt < nb.t - 1e-6) {
        // End of segment at tHit
        if (hypot(x1 - target.x, y1 - target.y) <= tol) return true;
        break;
      }
      sim.x = nb.x;
      sim.y = nb.y;
      elapsed += nb.t;
      if (nb.wall.indexOf("L") >= 0 || nb.wall.indexOf("R") >= 0) sim.vx = -sim.vx;
      if (nb.wall.indexOf("T") >= 0 || nb.wall.indexOf("B") >= 0) sim.vy = -sim.vy;
      steps++;
    }
    return false;
  };

  /**
   * Plan intercept using ONLY:
   * - linear targetSpeed along current heading (if on-track), and/or
   * - pendingAngle at next bounce + targetSpeed for post-bounce travel
   */
  MaskBalls.prototype.planIntercept = function (ball, target, changeAtMs, now) {
    var tHit = (changeAtMs - now) / 1000;
    if (tHit < 0.05) return null;

    var sp = hypot(ball.vx, ball.vy) || ball.speed;
    var ux = ball.vx / sp;
    var uy = ball.vy / sp;
    var toX = target.x - ball.x;
    var toY = target.y - ball.y;
    var along = toX * ux + toY * uy;
    var perpX = toX - along * ux;
    var perpY = toY - along * uy;
    var perp = hypot(perpX, perpY);
    var tol = Math.max(5, BALL_R - target.r);

    // On current ray: only speed change needed
    if (along > 8 && perp <= tol) {
      var needSpeed = along / tHit;
      if (needSpeed >= MIN_SPEED * 0.85 && needSpeed <= MAX_SPEED * 1.05) {
        return {
          pendingAngle: null,
          targetSpeed: clamp(needSpeed, MIN_SPEED, MAX_SPEED),
          score: perp + Math.abs(needSpeed - sp) * 0.05
        };
      }
    }

    var nb = this.nextBounce(ball, tHit);
    if (!nb) return null;
    var tAfter = tHit - nb.t;
    if (tAfter < 0.04) return null;

    // Try several speeds after bounce for best timed path length
    var candidates = [];
    var speeds = [
      clamp(sp, MIN_SPEED, MAX_SPEED),
      clamp(along > 0 ? along / tHit : sp, MIN_SPEED, MAX_SPEED),
      MIN_SPEED,
      (MIN_SPEED + MAX_SPEED) / 2,
      MAX_SPEED
    ];
    for (var si = 0; si < speeds.length; si++) {
      var travel = speeds[si] * tAfter;
      var aim = this.aimAngleFromBounce(nb.x, nb.y, target, travel, ball);
      if (!aim) continue;
      candidates.push({
        pendingAngle: aim.ang,
        targetSpeed: clamp(speeds[si], MIN_SPEED, MAX_SPEED),
        // Prefer arriving with exact path length; earlier bounce is fine
        score: aim.raw + nb.t * 40
      });
    }
    if (!candidates.length) {
      // Best-effort: aim toward target from bounce, speed from distance
      var direct = hypot(target.x - nb.x, target.y - nb.y);
      candidates.push({
        pendingAngle: Math.atan2(target.y - nb.y, target.x - nb.x),
        targetSpeed: clamp(direct / tAfter, MIN_SPEED, MAX_SPEED),
        score: 800 + direct * 0.2
      });
    }
    candidates.sort(function (a, b) { return a.score - b.score; });
    return candidates[0];
  };

  MaskBalls.prototype.ballFreeFor = function (ball, changeAtMs, leadMs, trailMs) {
    var q = ball.queue || [];
    var win = (leadMs || COVER_LEAD_MS) + (trailMs || COVER_TRAIL_MS) + 40;
    for (var i = 0; i < q.length; i++) {
      if (Math.abs(q[i].changeAtMs - changeAtMs) < win) return false;
    }
    return true;
  };

  MaskBalls.prototype.assignAndAim = function (now) {
    // Preserve continuous flight: only rewrite queues / aim / targetSpeed — never x,y,r
    for (var i = 0; i < this.balls.length; i++) {
      this.balls[i].queue = [];
      this.balls[i].covering = false;
    }

    var planFor = {};

    for (var ei = 0; ei < this.events.length; ei++) {
      var ev = this.events[ei];
      for (var ti = 0; ti < ev.targets.length; ti++) {
        var target = ev.targets[ti];
        var chosen = null;
        var chosenPlan = null;
        var chosenScore = Infinity;

        for (var bi = 0; bi < this.balls.length; bi++) {
          var ball = this.balls[bi];
          if (!this.ballFreeFor(ball, ev.changeAtMs, ev.leadMs, ev.trailMs)) continue;

          var plan = null;
          var score;
          if (this.trajectoryCovers(ball, target, ev.changeAtMs, now)) {
            // Already on a covering path — only tune speed
            plan = this.planIntercept(ball, target, ev.changeAtMs, now) || {
              pendingAngle: null,
              targetSpeed: ball.speed,
              score: 0
            };
            score = plan.score;
          } else {
            plan = this.planIntercept(ball, target, ev.changeAtMs, now);
            if (!plan) continue;
            score = plan.score + 20;
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
            slot: ev.slot
          };
          ball.queue.push(job);
          if (planFor[chosen] == null || job.changeAtMs < planFor[chosen].job.changeAtMs) {
            planFor[chosen] = { job: job, plan: chosenPlan };
          }
        }
      }
    }

    for (bi = 0; bi < this.balls.length; bi++) {
      ball = this.balls[bi];
      ball.queue.sort(function (a, b) { return a.changeAtMs - b.changeAtMs; });
      var pf = planFor[bi];
      if (!pf) {
        // Cruise at comfortable speed when idle
        if (!ball.queue.length) {
          ball.targetSpeed = clamp(BASE_SPEED + (Math.random() * 2 - 1) * 30, MIN_SPEED, MAX_SPEED);
        }
        continue;
      }
      ball.targetSpeed = pf.plan.targetSpeed;
      // Angle applied only at the next wall bounce
      if (pf.plan.pendingAngle != null) {
        ball.pendingAngle = pf.plan.pendingAngle;
      }
    }
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

  MaskBalls.prototype.drawBall = function (ctx, ball, scale) {
    var r = ball.r * scale;
    var x = ball.x * scale;
    var y = ball.y * scale;
    var col = ball.rgb;
    var alpha = ball.covering ? 1 : 0.94;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + alpha + ")";
    ctx.fill();
    // Outline so K (near-black) stays visible on black background
    ctx.lineWidth = (ball.covering ? 2.5 : 1.5) * scale;
    ctx.strokeStyle = ball.covering
      ? "rgba(255,255,255,0.7)"
      : "rgba(255,255,255,0.28)";
    ctx.stroke();
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
    for (i = 0; i < rgbBalls.length; i++) this.drawBall(ctx, rgbBalls[i], scale);
    ctx.globalCompositeOperation = "source-over";

    ctx = this.cmykCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (cmykBalls.length) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "multiply";
      for (i = 0; i < cmykBalls.length; i++) this.drawBall(ctx, cmykBalls[i], scale);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#ffffff";
      for (i = 0; i < cmykBalls.length; i++) {
        var b = cmykBalls[i];
        ctx.beginPath();
        ctx.arc(b.x * scale, b.y * scale, b.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      // Re-stroke outlines after multiply (visibility of C/M/Y/K)
      for (i = 0; i < cmykBalls.length; i++) {
        b = cmykBalls[i];
        ctx.beginPath();
        ctx.arc(b.x * scale, b.y * scale, b.r * scale, 0, Math.PI * 2);
        ctx.lineWidth = (b.covering ? 2.5 : 1.5) * scale;
        ctx.strokeStyle = b.covering ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.35)";
        ctx.stroke();
      }
    }
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
      this.applySpeed(ball, dt);
      this.integrate(ball, dt);

      var covering = false;
      var q = ball.queue || [];
      for (var qi = 0; qi < q.length; qi++) {
        var a = q[qi];
        var lead = a.leadMs != null ? a.leadMs : COVER_LEAD_MS;
        var trail = a.trailMs != null ? a.trailMs : COVER_TRAIL_MS;
        if (now < a.changeAtMs - lead || now > a.changeAtMs + trail) continue;
        // Full cover: target disc must lie inside the ball
        var need = a.r;
        var dist = hypot(ball.x - a.x, ball.y - a.y);
        if (dist + need <= ball.r + 1.5) covering = true;
      }
      ball.covering = covering;
    }

    this.paint();

    this.events = this.events.filter(function (ev) {
      var trail = ev.trailMs != null ? ev.trailMs : COVER_TRAIL_MS;
      return ev.changeAtMs + trail > now - 40;
    });
    this.pruneBallQueues(now);

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
