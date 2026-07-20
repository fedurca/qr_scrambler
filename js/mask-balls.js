/**
 * Mask balls: R/G/B + C/M/Y/K billiard motion on two independent canvases.
 * - RGB group: additive blend (lighter) within the group only
 * - CMYK group: subtractive blend (multiply) within the group only
 * Groups do not color-mix with each other.
 * Direction changes ONLY on viewport-edge bounce.
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
    { id: "K", group: "cmyk", hex: "#000000", rgb: [0, 0, 0] }
  ];

  var BASE_SPEED = 260;
  var SPEED_JITTER = 40;
  /** Hold on target around the flip so every changed module stays fully masked. */
  var COVER_LEAD_MS = 70;
  var COVER_TRAIL_MS = 90;
  var MIN_COVER_MS = COVER_LEAD_MS;
  var MAX_COVER_MS = 160;
  var AIM_LOOKAHEAD_BOUNCES = 3;
  var MAX_BALL_R = 88;
  var BASE_BALL_R = 30;
  var MAX_TARGETS = 7;

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
      var ang = (i / BALL_COLORS.length) * Math.PI * 2 + Math.random() * 0.5;
      this.spawnBall(
        40 + Math.random() * Math.max(1, w - 80),
        40 + Math.random() * Math.max(1, h - 80),
        30,
        c,
        Math.cos(ang) * speed,
        Math.sin(ang) * speed
      );
    }
  };

  MaskBalls.prototype.spawnBall = function (x, y, r, color, vx, vy) {
    var speed = hypot(vx, vy) || BASE_SPEED;
    var radius = r || BASE_BALL_R;
    var ball = {
      colorId: color.id,
      group: color.group,
      hex: color.hex,
      rgb: color.rgb.slice(),
      x: x,
      y: y,
      vx: vx,
      vy: vy,
      speed: speed,
      r: radius,
      baseR: radius,
      pendingAngle: null,
      queue: [],
      covering: false,
      held: false
    };
    this.balls.push(ball);
    return ball;
  };

  MaskBalls.prototype.playBounds = function (ball) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    return {
      L: ball.r,
      T: ball.r,
      R: Math.max(ball.r + 1, w - ball.r),
      B: Math.max(ball.r + 1, h - ball.r)
    };
  };

  MaskBalls.prototype.unfoldPoint = function (px, py, nx, ny, bounds) {
    var W = bounds.R - bounds.L;
    var H = bounds.B - bounds.T;
    var x = px - bounds.L;
    var y = py - bounds.T;
    var ax = Math.abs(nx);
    var ay = Math.abs(ny);
    var ux = (ax % 2 === 0) ? x : (W - x);
    var uy = (ay % 2 === 0) ? y : (H - y);
    return {
      x: bounds.L + ux + nx * W,
      y: bounds.T + uy + ny * H
    };
  };

  MaskBalls.prototype.aimAngleFromBounce = function (bx, by, target, travelDist, ball) {
    var bounds = this.playBounds(ball);
    var best = null;
    var bestErr = Infinity;
    var bestRaw = Infinity;
    for (var nx = -AIM_LOOKAHEAD_BOUNCES; nx <= AIM_LOOKAHEAD_BOUNCES; nx++) {
      for (var ny = -AIM_LOOKAHEAD_BOUNCES; ny <= AIM_LOOKAHEAD_BOUNCES; ny++) {
        var imgX;
        var imgY;
        if (nx === 0 && ny === 0) {
          imgX = target.x;
          imgY = target.y;
        } else {
          var img = this.unfoldPoint(target.x, target.y, nx, ny, bounds);
          imgX = img.x;
          imgY = img.y;
        }
        var d = hypot(imgX - bx, imgY - by);
        if (d <= 1) continue;
        var raw = Math.abs(d - travelDist);
        var err = raw + (Math.abs(nx) + Math.abs(ny)) * 4;
        if (err < bestErr) {
          bestErr = err;
          bestRaw = raw;
          best = Math.atan2(imgY - by, imgX - bx);
        }
      }
    }
    if (best == null) return null;
    var slack = Math.max(ball.r * 2.8, travelDist * 0.28, 70);
    if (bestRaw > slack) return null;
    return best;
  };

  /**
   * Build cover targets that geometrically contain EVERY changed module.
   * Greedy packing into ≤ MAX_TARGETS discs; leftovers expand nearest disc.
   */
  MaskBalls.prototype.clusterDiffs = function (moduleDiffs, meta, qr) {
    var size = meta.moduleSize;
    var margin = meta.margin || 2;
    var n = size + margin * 2;
    var cellW = qr.width / n;
    var cellH = qr.height / n;
    var pad = Math.max(cellW, cellH) * 0.55 + 2;

    function cellCenter(row, col) {
      return {
        row: row,
        col: col,
        x: qr.left + (col + margin + 0.5) * cellW,
        y: qr.top + (row + margin + 0.5) * cellH
      };
    }

    /** Smallest CSS circle covering the given module cells (center + corners). */
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
      // Seed: densest neighborhood
      var bestSeed = 0;
      var bestNeigh = -1;
      for (i = 0; i < uncovered.length; i++) {
        var neigh = 0;
        for (var j = 0; j < uncovered.length; j++) {
          if (hypot(uncovered[i].x - uncovered[j].x, uncovered[i].y - uncovered[j].y) < MAX_BALL_R * 0.85) {
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
        var pickCirc = null;
        for (j = 0; j < uncovered.length; j++) {
          var trial = cluster.concat([uncovered[j]]);
          var tc = coverCircle(trial);
          if (tc.r <= MAX_BALL_R && (!pickCirc || tc.r < pickCirc.r)) {
            // Prefer points close to current center
            var d = hypot(uncovered[j].x - circ.x, uncovered[j].y - circ.y);
            if (d <= MAX_BALL_R) {
              pick = j;
              pickCirc = tc;
            }
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
        r: Math.min(MAX_BALL_R, Math.max(BASE_BALL_R, final.r)),
        count: final.count,
        cells: final.cells,
        assigned: null,
        covered: false
      });
      // If clamping r shrank below geometric need, keep true r (must fully cover)
      if (final.r > targets[targets.length - 1].r) {
        targets[targets.length - 1].r = final.r;
      }
    }

    // Absorb leftovers into nearest target (expand radius — full cover required)
    while (uncovered.length) {
      var p = uncovered.pop();
      var nearest = 0;
      var nearestD = Infinity;
      for (i = 0; i < targets.length; i++) {
        var dd = hypot(p.x - targets[i].x, p.y - targets[i].y);
        if (dd < nearestD) {
          nearestD = dd;
          nearest = i;
        }
      }
      if (!targets.length) {
        var solo = coverCircle([p]);
        targets.push({
          x: solo.x,
          y: solo.y,
          r: solo.r,
          count: 1,
          cells: solo.cells,
          assigned: null,
          covered: false
        });
      } else {
        var t = targets[nearest];
        var cells = (t.cells || []).concat([p]);
        var rebuilt = coverCircle(cells);
        t.x = rebuilt.x;
        t.y = rebuilt.y;
        t.r = rebuilt.r;
        t.count = rebuilt.count;
        t.cells = rebuilt.cells;
      }
    }

    return targets;
  };

  MaskBalls.prototype.setForecast = function (events, meta) {
    if (!this.enabled) return;
    this.intervalMs = (meta && meta.intervalMs) || this.intervalMs || 1000;
    var qr = this.getQrRect();
    this.qrRect = qr;
    if (!qr || !events || !events.length) {
      this.events = [];
      this.clearAssignments();
      return;
    }

    if (!this.balls.length) this.spawnPalette();

    var coverMs = clamp(this.intervalMs * 0.08, MIN_COVER_MS, MAX_COVER_MS);
    var leadMs = Math.min(COVER_LEAD_MS, coverMs);
    var trailMs = Math.min(COVER_TRAIL_MS, Math.max(60, coverMs * 0.55));
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
    for (i = 0; i < this.balls.length; i++) {
      this.balls[i].pendingAngle = null;
    }
    this.assignAndAim(now);
    this.onLog("Mask forecast", {
      events: built.length,
      targets: built.reduce(function (n, e) { return n + e.targets.length; }, 0),
      coverMs: Math.round(coverMs),
      horizon: built.length ? Math.round((built[built.length - 1].changeAtMs - now) / 1000) + "s" : "0"
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

  MaskBalls.prototype.trajectoryCovers = function (ball, target, changeAtMs, coverMs, now) {
    var tHit = (changeAtMs - now) / 1000;
    if (tHit < 0 || tHit > 12) return false;
    var sim = {
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      r: ball.r,
      speed: ball.speed
    };
    var elapsed = 0;
    var steps = 0;
    while (elapsed < tHit + coverMs / 1000 && steps < 40) {
      var remain = tHit + coverMs / 1000 - elapsed;
      var nb = this.nextBounce(sim, remain + 1e-4);
      var dt = nb ? Math.min(nb.t, remain) : remain;
      var dx = sim.vx * dt;
      var dy = sim.vy * dt;
      var len2 = dx * dx + dy * dy;
      if (len2 >= 1e-8) {
        var u = clamp(((target.x - sim.x) * dx + (target.y - sim.y) * dy) / len2, 0, 1);
        var cx = sim.x + u * dx;
        var cy = sim.y + u * dy;
        var closestDist = hypot(cx - target.x, cy - target.y);
        var tSeg = elapsed + u * dt;
        if (closestDist <= ball.r + target.r * 0.35 &&
            Math.abs(tSeg - tHit) <= (coverMs / 1000) * 0.9) {
          return true;
        }
      }
      if (!nb || dt < nb.t - 1e-6) break;
      sim.x = nb.x;
      sim.y = nb.y;
      elapsed += nb.t;
      if (nb.wall.indexOf("L") >= 0 || nb.wall.indexOf("R") >= 0) sim.vx = -sim.vx;
      if (nb.wall.indexOf("T") >= 0 || nb.wall.indexOf("B") >= 0) sim.vy = -sim.vy;
      steps++;
    }
    return false;
  };

  MaskBalls.prototype.ballFreeFor = function (ball, changeAtMs, coverMs) {
    var q = ball.queue || [];
    for (var i = 0; i < q.length; i++) {
      var a = q[i];
      if (Math.abs(a.changeAtMs - changeAtMs) < (a.coverMs + coverMs + 80)) return false;
    }
    return true;
  };

  MaskBalls.prototype.assignAndAim = function (now) {
    for (var i = 0; i < this.balls.length; i++) {
      this.balls[i].queue = [];
      this.balls[i].covering = false;
    }
    var aimForBall = {};

    for (var ei = 0; ei < this.events.length; ei++) {
      var ev = this.events[ei];
      for (var ti = 0; ti < ev.targets.length; ti++) {
        var target = ev.targets[ti];
        var chosen = null;
        var chosenScore = Infinity;
        var chosenAng = null;
        var bi;
        var ball;
        var score;
        var tAvail;
        var nb;
        var travel;
        var ang;

        for (bi = 0; bi < this.balls.length; bi++) {
          ball = this.balls[bi];
          if (!this.ballFreeFor(ball, ev.changeAtMs, ev.coverMs)) continue;
          if (this.trajectoryCovers(ball, target, ev.changeAtMs, ev.coverMs, now)) {
            score = Math.abs(ev.changeAtMs - now);
            if (score < chosenScore) {
              chosenScore = score;
              chosen = bi;
              chosenAng = null;
            }
          }
        }

        if (chosen == null) {
          for (bi = 0; bi < this.balls.length; bi++) {
            ball = this.balls[bi];
            if (!this.ballFreeFor(ball, ev.changeAtMs, ev.coverMs)) continue;
            tAvail = (ev.changeAtMs - now) / 1000;
            if (tAvail < 0.05) continue;
            nb = this.nextBounce(ball, tAvail);
            if (!nb) continue;
            travel = ball.speed * Math.max(0.04, tAvail - nb.t);
            ang = this.aimAngleFromBounce(nb.x, nb.y, target, travel, ball);
            if (ang == null) continue;
            score = nb.t * 1000 + Math.abs(travel - hypot(target.x - nb.x, target.y - nb.y));
            if (score < chosenScore) {
              chosenScore = score;
              chosen = bi;
              chosenAng = ang;
            }
          }
        }

        if (chosen == null) {
          for (bi = 0; bi < this.balls.length; bi++) {
            ball = this.balls[bi];
            if (!this.ballFreeFor(ball, ev.changeAtMs, ev.coverMs)) continue;
            tAvail = (ev.changeAtMs - now) / 1000;
            nb = this.nextBounce(ball, Math.max(tAvail, 2.5));
            if (!nb) continue;
            travel = ball.speed * Math.max(0.04, Math.max(0.05, tAvail - nb.t));
            ang = this.aimAngleFromBounce(nb.x, nb.y, target, travel, ball);
            score = hypot(ball.x - target.x, ball.y - target.y) + nb.t * 200;
            if (ang == null) {
              ang = Math.atan2(target.y - nb.y, target.x - nb.x);
              score += 500;
            }
            if (score < chosenScore) {
              chosenScore = score;
              chosen = bi;
              chosenAng = ang;
            }
          }
        }

        if (chosen != null) {
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
          // Size ball to fully cover its target disc
          ball.r = Math.max(ball.baseR || BASE_BALL_R, target.r);
          if (aimForBall[chosen] == null || job.changeAtMs < aimForBall[chosen].changeAtMs) {
            aimForBall[chosen] = { job: job, ang: chosenAng };
          }
        }
      }
    }

    for (bi = 0; bi < this.balls.length; bi++) {
      ball = this.balls[bi];
      ball.queue.sort(function (a, b) { return a.changeAtMs - b.changeAtMs; });
      var aim = aimForBall[bi];
      if (!aim) {
        ball.pendingAngle = null;
        continue;
      }
      if (aim.ang != null) {
        ball.pendingAngle = aim.ang;
      } else {
        tAvail = (aim.job.changeAtMs - now) / 1000;
        nb = this.nextBounce(ball, tAvail);
        if (nb) {
          travel = ball.speed * Math.max(0.04, tAvail - nb.t);
          ang = this.aimAngleFromBounce(nb.x, nb.y, aim.job, travel, ball);
          ball.pendingAngle = ang;
        }
      }
    }
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
        if (nb.wall.indexOf("L") >= 0 || nb.wall.indexOf("R") >= 0) {
          ball.vx = -ball.vx;
        }
        if (nb.wall.indexOf("T") >= 0 || nb.wall.indexOf("B") >= 0) {
          ball.vy = -ball.vy;
        }
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
    var alpha = ball.covering ? 1 : 0.92;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + alpha + ")";
    ctx.fill();
    if (ball.covering) {
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.stroke();
    }
  };

  /** Paint RGB (additive) and CMYK (subtractive) on separate canvases — no cross-group mix. */
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

    // RGB — additive (lighter)
    var ctx = this.rgbCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < rgbBalls.length; i++) this.drawBall(ctx, rgbBalls[i], scale);
    ctx.globalCompositeOperation = "source-over";

    // CMYK — subtractive (multiply on white), then keep only ball union alpha
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
    }
  };

  MaskBalls.prototype.activeHoldJob = function (ball, now) {
    var q = ball.queue || [];
    var best = null;
    for (var qi = 0; qi < q.length; qi++) {
      var a = q[qi];
      var lead = a.leadMs != null ? a.leadMs : COVER_LEAD_MS;
      var trail = a.trailMs != null ? a.trailMs : COVER_TRAIL_MS;
      if (now >= a.changeAtMs - lead && now <= a.changeAtMs + trail) {
        if (!best || a.changeAtMs < best.changeAtMs) best = a;
      }
    }
    return best;
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

    for (var i = 0; i < this.balls.length; i++) {
      var ball = this.balls[i];
      var hold = this.activeHoldJob(ball, now);

      if (hold) {
        // Hard lock on the cover disc through the flip — full module occlusion
        ball.held = true;
        ball.covering = true;
        ball.x = hold.x;
        ball.y = hold.y;
        ball.r = Math.max(ball.r, hold.r);
        // Keep speed vector for resume; do not integrate while held
      } else {
        if (ball.held) {
          ball.held = false;
          // Resume billiard; shrink back toward base after cover
          ball.r = ball.baseR || BASE_BALL_R;
          var ang = Math.atan2(ball.vy, ball.vx);
          if (!isFinite(ang)) ang = Math.random() * Math.PI * 2;
          ball.vx = Math.cos(ang) * ball.speed;
          ball.vy = Math.sin(ang) * ball.speed;
        }
        this.integrate(ball, dt);
        ball.covering = false;
      }
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

  global.MaskBalls = MaskBalls;
})(typeof window !== "undefined" ? window : globalThis);
