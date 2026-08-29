/* reps.js — repetition detection from video. No dependencies.
 *
 * Deliberately knows nothing about bodies. It reduces each frame to a few
 * scalars and finds oscillation in them, which is enough to segment a set into
 * reps and slice video at the boundaries. It cannot assess form, and it cannot
 * tell a lift from someone walking through frame — that is the job of whoever
 * receives the frames.
 *
 * Two pieces, deliberately separable:
 *   makeSampler(video)  — pixels in, scalars out. Needs a DOM.
 *   makeRepDetector()   — scalars in, reps out. Pure, and therefore testable
 *                         against a synthetic signal with a known answer.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- signal */

  const SW = 96, SH = 72;          // enough to see a body, cheap enough to ignore

  function makeSampler(video, opts) {
    const o = Object.assign({ alpha: 0.02, threshold: 18 }, opts || {});
    const cv = document.createElement('canvas');
    cv.width = SW; cv.height = SH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let bg = null;

    return {
      canvas: cv,
      reset() { bg = null; },
      /* Foreground against a slowly-learned background, NOT a frame difference.
       * A frame difference only says that motion happened; the foreground says
       * where the body is, which is what actually oscillates during a squat. */
      sample() {
        if (!video || video.readyState < 2 || !video.videoWidth) return null;
        try { ctx.drawImage(video, 0, 0, SW, SH); }
        catch { return null; }                       // not yet decodable
        const d = ctx.getImageData(0, 0, SW, SH).data;
        const n = SW * SH;

        if (!bg) {                                   // seed from the first frame,
          bg = new Float32Array(n);                  // or everything reads as
          for (let i = 0, p = 0; i < n; i++, p += 4) // foreground for a while
            bg[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          return null;
        }

        let sum = 0, sx = 0, sy = 0, area = 0, top = -1;
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          const g = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          const b = bg[i];
          bg[i] = b + (g - b) * o.alpha;
          const diff = g > b ? g - b : b - g;
          if (diff > o.threshold) {
            const y = (i / SW) | 0;
            if (top < 0) top = y;                    // rows are scanned in order
            area++; sum += diff; sx += (i % SW) * diff; sy += y * diff;
          }
        }
        if (!area) return { topY: null, cy: null, cx: null, area: 0 };
        return { topY: top, cy: sy / sum, cx: sx / sum, area };
      },
    };
  }

  /* Which scalar actually carries the movement. Compared as coefficients of
   * variation so a row index and a pixel count are on the same footing. */
  function pickAxis(samples) {
    const cols = { cy: [], cx: [], area: [] };
    for (const s of samples) {
      if (!s || s.cy == null) continue;
      cols.cy.push(s.cy); cols.cx.push(s.cx); cols.area.push(s.area);
    }
    let best = 'cy', bestScore = -1;
    for (const k of Object.keys(cols)) {
      const v = cols[k];
      if (v.length < 8) continue;
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      if (!mean) continue;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length);
      const score = sd / Math.abs(mean);
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best;
  }

  /* -------------------------------------------------------------- detector */

  /* A rep is one full cycle: a turn, the opposite extreme, and a turn back.
   * Named tStart/tMid/tEnd rather than bottom/top because which extreme is the
   * bottom of the lift depends on the signal — a row index grows downward. */
  function makeRepDetector(opts) {
    const o = Object.assign({
      smoothMs: 150,      // noise suppression
      travel: 0.4,        // of the observed range, to accept a direction change
      minPeriod: 800,     // ms — faster than this is noise, not a rep
      maxPeriod: 30000,   // ms — a Jefferson curl is one very slow rep
      warmupMs: 600,      // learn the range before counting anything
      minRange: 1.5,      // absolute floor, so a short warm-up cannot make
                          // sensor noise look like a full-amplitude movement
      rangeDecayMs: 20000,
    }, opts || {});

    let smooth = null, lastT = 0, firstT = null;
    let lo = Infinity, hi = -Infinity;
    let dir = 0, extVal = 0, extT = 0;
    let originT = null;              // where movement began, before any turn
    let lastTurnT = null, midT = null;
    const reps = [];

    function reset() {
      smooth = null; lastT = 0; firstT = null;
      lo = Infinity; hi = -Infinity;
      dir = 0; extVal = 0; extT = 0;
      originT = null; lastTurnT = null; midT = null;
      reps.length = 0;
    }

    /* Returns a rep object on the tick that completes one, else null. */
    function push(value, t) {
      if (value == null || !isFinite(value)) return null;
      if (firstT === null) { firstT = t; smooth = value; lastT = t; }

      const dt = Math.max(1, t - lastT);
      lastT = t;
      smooth += (1 - Math.exp(-dt / o.smoothMs)) * (value - smooth);

      if (smooth < lo) lo = smooth;
      if (smooth > hi) hi = smooth;
      // Let the range follow the signal, so a set performed shallower than the
      // warm-up does not stop registering.
      const shrink = Math.min(0.5, dt / o.rangeDecayMs);
      lo += (smooth - lo) * shrink;
      hi += (smooth - hi) * shrink;

      const range = hi - lo;
      if (t - firstT < o.warmupMs || range < o.minRange) return null;
      const need = range * o.travel;

      if (dir === 0) { dir = 1; extVal = smooth; extT = t; originT = t; return null; }

      let turned = null;
      if (dir > 0) {
        if (smooth > extVal) { extVal = smooth; extT = t; }
        else if (extVal - smooth >= need) { turned = extT; dir = -1; extVal = smooth; extT = t; }
      } else {
        if (smooth < extVal) { extVal = smooth; extT = t; }
        else if (smooth - extVal >= need) { turned = extT; dir = 1; extVal = smooth; extT = t; }
      }
      if (turned === null) return null;

      // A rep is two turns. The athlete starts stationary at one end, so the
      // FIRST rep closes on the second turn, using the moment movement began as
      // its opening boundary — waiting for a third turn silently loses rep one.
      if (lastTurnT === null) { lastTurnT = originT !== null ? originT : turned; midT = turned; return null; }
      if (midT === null) { midT = turned; return null; }

      const start = lastTurnT, mid = midT, end = turned;
      lastTurnT = turned; midT = null;

      const dur = end - start;
      if (dur < o.minPeriod || dur > o.maxPeriod) return null;

      const rep = { index: reps.length + 1, tStart: start, tMid: mid, tEnd: end, dur };
      reps.push(rep);
      return rep;
    }

    return {
      push, reset, reps,
      get count() { return reps.length; },
      debug() { return { smooth, lo, hi, dir }; },
    };
  }

  window.VDReps = { makeSampler, makeRepDetector, pickAxis, SW, SH };
})();
