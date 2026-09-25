/* Exam Scanner — sheet engine: finds the ZipGrade 0065 sheet in a camera frame or photo,
   flattens it, and measures how dark every bubble is. No UI here. */
"use strict";
/* ============================================================
   Sheet template (PDF points, measured from 0065x1.pdf)
   ============================================================ */
const TPL = (() => {
  const c1 = [197.7, 212.7, 227.7, 242.7, 257.7], c2 = [290.7, 305.7, 320.7, 335.7, 350.7];
  const q = [];
  for (let i = 0; i < 8; i++) q[i] = c1.map(x => [x, 231.13 + 20 * i]);        // Q1-8
  for (let i = 0; i < 9; i++) q[8 + i] = c1.map(x => [x, 419.72 + 20 * i]);    // Q9-17
  for (let i = 0; i < 8; i++) q[17 + i] = c2.map(x => [x, 231.13 + 20 * i]);   // Q18-25
  const id = [];
  for (let c = 0; c < 7; c++) { id[c] = []; for (let d = 0; d < 10; d++) id[c][d] = [341.22 + 15 * c, 427.31 + 18 * d]; }
  return {
    M: { TL: [155.55, 188.15], TR: [456.45, 188.15], ML: [155.55, 396.05], MR: [456.45, 396.05], BL: [155.55, 603.85], BR: [456.45, 603.85] },
    small: [[306.0, 213.4], [306.0, 402.0], [306.0, 606.1]],
    markerPt: 11.1, colLen: 415.7, midY: 396.05,
    q, id, form: [[284.72, 588.31], [299.72, 588.31], [314.72, 588.31]],
    warp: { x0: 140, y0: 172, x1: 472, y1: 618, S: 3 },
  };
})();
const LETTERS = "ABCDE";

/* ============================================================
   Small linear algebra
   ============================================================ */
function solve(A, b) {                    // Gaussian elimination, partial pivoting
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    const d = A[i][i]; if (Math.abs(d) < 1e-12) return null;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / d; if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}
function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
function normalize(P) {
  let mx = 0, my = 0; for (const p of P) { mx += p[0]; my += p[1]; } mx /= P.length; my /= P.length;
  let d = 0; for (const p of P) d += Math.hypot(p[0] - mx, p[1] - my); d = d / P.length || 1;
  const s = Math.SQRT2 / d;
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], Ti: [1 / s, 0, mx, 0, 1 / s, my, 0, 0, 1],
           P: P.map(p => [(p[0] - mx) * s, (p[1] - my) * s]) };
}
function homography(src, dst) {           // least squares, >= 4 points, maps src -> dst
  const a = normalize(src), c = normalize(dst);
  const M = Array.from({ length: 8 }, () => new Array(8).fill(0)), r = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const [x, y] = a.P[i], [u, v] = c.P[i];
    const rows = [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]];
    for (const row of rows) for (let j = 0; j < 8; j++) { r[j] += row[j] * row[8]; for (let k = 0; k < 8; k++) M[j][k] += row[j] * row[k]; }
  }
  const h = solve(M, r); if (!h) return null;
  const H = mul3(c.Ti, mul3([...h, 1], a.T));
  return H.map(v => v / H[8]);
}
function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ============================================================
   Detection: find the 6 large squares (+3 small) in a gray image
   ============================================================ */
let bufs = null;
function getBufs(n, w, h) {
  if (!bufs || bufs.n !== n) {
    bufs = { n, integ: new Float64Array((w + 1) * (h + 1)), mask: new Uint8Array(n), label: new Int32Array(n), stack: new Int32Array(n) };
  }
  bufs.w = w; bufs.h = h; return bufs;
}
function toGray(data, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

function detect(g, W, H) {
  const n = W * H, B = getBufs(n, W, H), I = B.integ, W1 = W + 1;
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; }
  }
  const boxMean = (x, y, r) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
    return (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const R = Math.max(8, Math.round(Math.max(W, H) / 24));
  const mask = B.mask, label = B.label, stack = B.stack;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, m = boxMean(x, y, R), v = g[i];
    mask[i] = (v < m * 0.75 && m - v > 14) ? 1 : 0;
  }
  label.fill(0);
  const cands = []; const maxA = n * 0.004;
  let lab = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s]) continue;
    lab++; let sp = 0; stack[sp++] = s; label[s] = lab;
    let cnt = 0, sx = 0, sy = 0, sg = 0, minx = W, maxx = 0, miny = H, maxy = 0;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W;
      cnt++; sx += x; sy += y; sg += g[i];
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = lab; stack[sp++] = i - 1; }
      if (x < W - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = lab; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - W] && !label[i - W]) { label[i - W] = lab; stack[sp++] = i - W; }
      if (y < H - 1 && mask[i + W] && !label[i + W]) { label[i + W] = lab; stack[sp++] = i + W; }
    }
    if (cnt < 14 || cnt > maxA) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (bw < 4 || bh < 4) continue;
    const asp = Math.max(bw / bh, bh / bw), fill = cnt / (bw * bh);
    if (asp > 2.5 || fill < 0.45) continue;
    if (minx === 0 || miny === 0 || maxx === W - 1 || maxy === H - 1) continue;
    const cx = sx / cnt, cy = sy / cnt;
    const local = boxMean(Math.round(cx), Math.round(cy), R * 2);
    if (sg / cnt > local * 0.5) continue;                       // markers are much darker than paper
    cands.push({ x: cx, y: cy, a: cnt, s: Math.sqrt(cnt), bw, bh, dk: sg / cnt / local });
  }
  cands.sort((p, q) => q.a - p.a);
  if (cands.length > 160) cands.length = 160;

  const res = { found: false, cands, reason: cands.length < 6 ? "none" : "pattern" };
  if (cands.length < 6) return res;

  // 1) triples: two squares with a third at their midpoint (a column of 3 markers)
  const N = cands.length, triples = [];
  const simA = (p, q) => { const r = p.a / q.a; return r > 0.33 && r < 3; };   // near markers look bigger when tilted
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const A = cands[i], C = cands[j]; if (!simA(A, C)) continue;
    const d = Math.hypot(A.x - C.x, A.y - C.y), s = (A.s + C.s) / 2;
    if (d < 16 * s || d > 60 * s) continue;
    // Perspective keeps the middle marker on the line between the ends, but can slide it along the line.
    const ux = (C.x - A.x) / d, uy = (C.y - A.y) / d, perpTol = 0.02 * d + 0.6 * s;
    let best = -1, bd = Infinity;
    for (let k = 0; k < N; k++) {
      if (k === i || k === j) continue;
      const M = cands[k]; if (!simA(M, A) || !simA(M, C)) continue;
      const along = ((M.x - A.x) * ux + (M.y - A.y) * uy) / d;
      if (along < 0.38 || along > 0.62) continue;
      const perp = Math.abs((M.x - A.x) * uy - (M.y - A.y) * ux);
      if (perp > perpTol) continue;
      const e = perp / perpTol + Math.abs(along - 0.5) * 4;
      if (e < bd) { bd = e; best = k; }
    }
    if (best >= 0) triples.push([i, best, j, A.dk + C.dk + cands[best].dk]);
  }
  if (triples.length < 2) return res;
  // The marker columns are the longest triples on the sheet (nothing printed spans further), so keep the
  // longest ones. (Darkness alone fails on a printed key, where filled bubbles are as black as the markers.)
  for (const t of triples) t[4] = Math.hypot(cands[t[0]].x - cands[t[2]].x, cands[t[0]].y - cands[t[2]].y);
  triples.sort((p, q) => q[4] - p[4]);
  if (triples.length > 80) triples.length = 80;

  // 2) pairs of roughly parallel triples = left and right columns
  const P = k => [cands[k].x, cands[k].y];
  let bestFit = null;
  for (let a = 0; a < triples.length; a++) for (let b = a + 1; b < triples.length; b++) {
    const ta = triples[a]; let tb = triples[b];
    if (tb.slice(0, 3).some(k => ta.slice(0, 3).includes(k))) continue;   // share a square (only the 3 indices count)
    const A0 = P(ta[0]), A2 = P(ta[2]); let B0 = P(tb[0]), B2 = P(tb[2]);
    let vA = [A2[0] - A0[0], A2[1] - A0[1]], vB = [B2[0] - B0[0], B2[1] - B0[1]];
    if (vA[0] * vB[0] + vA[1] * vB[1] < 0) { tb = [tb[2], tb[1], tb[0]]; [B0, B2] = [B2, B0]; vB = [-vB[0], -vB[1]]; }
    const lA = Math.hypot(...vA), lB = Math.hypot(...vB);
    if (lA / lB < 0.55 || lA / lB > 1.8) continue;
    if ((vA[0] * vB[0] + vA[1] * vB[1]) / (lA * lB) < 0.8) continue;
    const A1 = P(ta[1]), B1 = P(tb[1]), sep = [B1[0] - A1[0], B1[1] - A1[1]], lS = Math.hypot(...sep);
    const rel = lS / ((lA + lB) / 2);
    if (rel < 0.4 || rel > 1.2) continue;
    if (Math.abs((sep[0] * vA[0] + sep[1] * vA[1]) / (lS * lA)) > 0.55) continue;
    // left/right so that the labelling is not mirrored
    let L = ta, Rr = tb;
    const cross = (B0[0] - A0[0]) * (A2[1] - A0[1]) - (B0[1] - A0[1]) * (A2[0] - A0[0]);
    if (cross < 0) { L = tb; Rr = ta; }
    for (const lab of [
      { TL: L[0], TR: Rr[0], ML: L[1], MR: Rr[1], BL: L[2], BR: Rr[2] },     // as found
      { TL: Rr[2], TR: L[2], ML: Rr[1], MR: L[1], BL: Rr[0], BR: L[0] },     // rotated 180
    ]) {
      const fit = verify(lab, cands);
      if (fit && (!bestFit || fit.score > bestFit.score)) bestFit = fit;
    }
  }
  if (!bestFit) return res;
  res.found = true; Object.assign(res, bestFit);
  return res;
}

function verify(lab, cands) {
  const pts = {}; for (const k in lab) pts[k] = [cands[lab[k]].x, cands[lab[k]].y];
  const H = homography([TPL.M.TL, TPL.M.TR, TPL.M.BL, TPL.M.BR], [pts.TL, pts.TR, pts.BL, pts.BR]);
  if (!H) return null;
  const pxPerPt = (dist(pts.TL, pts.BL) + dist(pts.TR, pts.BR)) / 2 / TPL.colLen;
  const tol = 5.5 * pxPerPt;
  const eML = dist(apply(H, ...TPL.M.ML), pts.ML), eMR = dist(apply(H, ...TPL.M.MR), pts.MR);
  if (eML > tol * 1.4 || eMR > tol * 1.4) return null;
  const used = new Set(Object.values(lab));
  let small = 0;
  for (const sp of TPL.small) {
    const q = apply(H, ...sp);
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue;
      if (Math.hypot(cands[i].x - q[0], cands[i].y - q[1]) < tol) { small++; break; }
    }
  }
  if (small < 2) return null;
  const area = Math.abs((pts.BR[0] - pts.TL[0]) * (pts.TR[1] - pts.BL[1]) - (pts.TR[0] - pts.BL[0]) * (pts.BR[1] - pts.TL[1])) / 2;
  return { pts, H, pxPerPt, small, score: small * 1000 - (eML + eMR) / tol * 50 + Math.sqrt(area) * 0.01 };
}

/* ============================================================
   Reading a captured frame at full resolution
   ============================================================ */
function sampleGray(g, W, H, x, y) {
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > W - 1.001) x = W - 1.001; if (y > H - 1.001) y = H - 1.001;
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * W + xi;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + W] * (1 - fx) + g[i + W + 1] * fx) * fy;
}
// Finds the dark square blob of about sizePx near c; returns its centre or null.
function findBlob(g, W, H, c, sizePx, searchPx) {
  const r = Math.max(4, Math.round(searchPx));
  const x0 = Math.max(0, Math.round(c[0] - r)), x1 = Math.min(W - 1, Math.round(c[0] + r));
  const y0 = Math.max(0, Math.round(c[1] - r)), y1 = Math.min(H - 1, Math.round(c[1] + r));
  const w = x1 - x0 + 1, h = y1 - y0 + 1; if (w < 3 || h < 3) return null;
  let mn = 255, mx = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = g[y * W + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx - mn < 40) return null;
  const t = mn + (mx - mn) * 0.45, lab = new Int32Array(w * h), st = [];
  let best = null, bestD = Infinity, L = 0;
  const want = sizePx * sizePx;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const k = yy * w + xx; if (lab[k] || g[(yy + y0) * W + xx + x0] >= t) continue;
    L++; lab[k] = L; st.push(k); let n = 0, sx = 0, sy = 0, bx0 = w, bx1 = 0, by0 = h, by1 = 0;
    while (st.length) {
      const q = st.pop(), qx = q % w, qy = (q - qx) / w; n++; sx += qx; sy += qy;
      if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
      for (const [nx, ny] of [[qx - 1, qy], [qx + 1, qy], [qx, qy - 1], [qx, qy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx; if (lab[nk] || g[(ny + y0) * W + nx + x0] >= t) continue; lab[nk] = L; st.push(nk);
      }
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (n < want * 0.35 || n > want * 2.8 || Math.max(bw / bh, bh / bw) > 2.2) continue;
    const cx = x0 + sx / n, cy = y0 + sy / n, dd = Math.hypot(cx - c[0], cy - c[1]);
    if (dd < bestD) { bestD = dd; best = [cx, cy]; }
  }
  return best;
}
// Maps template points to the photo: two homographies (top and bottom halves) from the 6 large
// squares, plus a bow correction measured at the 3 small centre squares (curled paper).
function makeMapper(pts, g, W, H) {
  const Ht = homography([TPL.M.TL, TPL.M.TR, TPL.M.ML, TPL.M.MR], [pts.TL, pts.TR, pts.ML, pts.MR]);
  const Hb = homography([TPL.M.ML, TPL.M.MR, TPL.M.BL, TPL.M.BR], [pts.ML, pts.MR, pts.BL, pts.BR]);
  const base = (x, y) => apply(y < TPL.midY ? Ht : Hb, x, y);
  const offs = [];
  if (g) {
    const pxPerPt = (dist(pts.TL, pts.BL) + dist(pts.TR, pts.BR)) / 2 / TPL.colLen;
    for (const sp of TPL.small) {
      const pred = base(...sp), f = findBlob(g, W, H, pred, 7.8 * pxPerPt, 12 * pxPerPt);
      offs.push({ y: sp[1], d: f ? [f[0] - pred[0], f[1] - pred[1]] : [0, 0], found: !!f });
    }
  }
  const [xL, xR] = [TPL.M.TL[0], TPL.M.TR[0]];
  const offAt = y => {
    if (!offs.length) return [0, 0];
    if (y <= offs[0].y) return offs[0].d; if (y >= offs[2].y) return offs[2].d;
    const [a, b] = y < offs[1].y ? [offs[0], offs[1]] : [offs[1], offs[2]], t = (y - a.y) / (b.y - a.y);
    return [a.d[0] + (b.d[0] - a.d[0]) * t, a.d[1] + (b.d[1] - a.d[1]) * t];
  };
  const map = (x, y) => {
    const p = base(x, y), wgt = Math.sin(Math.PI * Math.min(1, Math.max(0, (x - xL) / (xR - xL))));
    if (!wgt) return p;
    const o = offAt(y); return [p[0] + o[0] * wgt, p[1] + o[1] * wgt];
  };
  return { Ht, Hb, map, offs };
}
const INNER = []; for (let dy = -4; dy <= 4; dy += 0.75) for (let dx = -4; dx <= 4; dx += 0.75) if (dx * dx + dy * dy <= 16) INNER.push([dx, dy]);
const RING = []; for (let k = 0; k < 20; k++) { const a = k / 20 * 2 * Math.PI; RING.push([7.5 * Math.cos(a), 7.5 * Math.sin(a)]); }
function bubbleDarkness(g, W, H, map, cx, cy) {
  let s = 0;
  for (const [dx, dy] of INNER) { const p = map(cx + dx, cy + dy); s += sampleGray(g, W, H, p[0], p[1]); }
  const inner = s / INNER.length;
  const ring = RING.map(([dx, dy]) => { const p = map(cx + dx, cy + dy); return sampleGray(g, W, H, p[0], p[1]); }).sort((a, b) => a - b);
  const white = Math.max(ring[Math.floor(ring.length * 0.75)], 1);
  return Math.max(0, Math.min(1, 1 - inner / white));
}
function classify(darks, thr, labels) {
  const low = thr * 0.6;
  const order = darks.map((d, i) => [d, i]).sort((a, b) => b[0] - a[0]);
  const filled = order.filter(o => o[0] >= thr), faint = order.filter(o => o[0] >= low && o[0] < thr);
  if (filled.length === 0) {
    if (faint.length) return { value: labels[faint[0][1]], picks: [faint[0][1]], flag: "faint" };
    return { value: null, picks: [], flag: null };
  }
  if (filled.length === 1) return { value: labels[filled[0][1]], picks: [filled[0][1]], flag: null };
  // Erasure residue usually stays below the threshold. When two marks are both above it, only pick the
  // darker one if it is at least twice as dark; otherwise it is a real double mark (flag for review).
  if (filled[0][0] >= filled[1][0] * 2) return { value: labels[filled[0][1]], picks: [filled[0][1]], flag: null, erasure: true };
  return { value: filled.map(f => labels[f[1]]).sort().join(""), picks: filled.map(f => f[1]), flag: "multiple" };
}
function readDarkness(g, W, H, map) {
  const bd = (x, y) => bubbleDarkness(g, W, H, map, x, y);
  return {
    q: TPL.q.map(row => row.map(([x, y]) => bd(x, y))),
    id: TPL.id.map(col => col.map(([x, y]) => bd(x, y))),
    form: TPL.form.map(([x, y]) => bd(x, y)),
  };
}
function warpImage(rgba, W, H, mp) {
  const { x0, y0, x1, y1, S } = TPL.warp;
  const ow = Math.round((x1 - x0) * S), oh = Math.round((y1 - y0) * S);
  const out = new ImageData(ow, oh), o = out.data, d = rgba;
  for (let oy = 0; oy < oh; oy++) {
    const ty = y0 + (oy + 0.5) / S;
    for (let ox = 0; ox < ow; ox++) {
      const [x, y] = mp.map(x0 + (ox + 0.5) / S, ty);
      const k = (oy * ow + ox) * 4;
      if (x < 0 || y < 0 || x > W - 1.001 || y > H - 1.001) { o[k] = o[k + 1] = o[k + 2] = 128; o[k + 3] = 255; continue; }
      const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = (yi * W + xi) * 4, j = i + W * 4;
      for (let c = 0; c < 3; c++)
        o[k + c] = (d[i + c] * (1 - fx) + d[i + 4 + c] * fx) * (1 - fy) + (d[j + c] * (1 - fx) + d[j + 4 + c] * fx) * fy;
      o[k + 3] = 255;
    }
  }
  return out;
}
function sharpness(img) {                 // variance of Laplacian on the flattened answer area
  const { S, x0, y0 } = TPL.warp, w = img.width, d = img.data;
  const gx0 = Math.round((190 - x0) * S), gx1 = Math.round((360 - x0) * S), gy0 = Math.round((220 - y0) * S), gy1 = Math.round((380 - y0) * S);
  const G = (x, y) => { const i = (y * w + x) * 4; return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; };
  let s = 0, s2 = 0, n = 0;
  for (let y = gy0; y < gy1; y += 2) for (let x = gx0; x < gx1; x += 2) {
    const L = 4 * G(x, y) - G(x - 1, y) - G(x + 1, y) - G(x, y - 1) - G(x, y + 1);
    s += L; s2 += L * L; n++;
  }
  return Math.round(s2 / n - (s / n) ** 2);
}
function orientationOf(pts) {
  const up = [pts.TL[0] - pts.BL[0] + pts.TR[0] - pts.BR[0], pts.TL[1] - pts.BL[1] + pts.TR[1] - pts.BR[1]];
  let rel = Math.atan2(up[1], up[0]) * 180 / Math.PI + 90;
  while (rel > 180) rel -= 360; while (rel <= -180) rel += 360;
  const a = Math.abs(rel);
  return { angle: Math.round(rel), label: a < 45 ? "Upright" : a > 135 ? "Upside down" : (rel > 0 ? "Sideways (right)" : "Sideways (left)") };
}

/* ============================================================
   Quality checks on the detection image
   ============================================================ */
function quality(g, W, H, det, fullScale) {
  const P = det.pts, xs = [P.TL[0], P.TR[0], P.BL[0], P.BR[0]], ys = [P.TL[1], P.TR[1], P.BL[1], P.BR[1]];
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  const hist = new Uint32Array(256); let n = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { hist[g[y * W + x]]++; n++; }
  let acc = 0, median = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { median = v; break; } }
  let sat = 0; for (let v = 252; v < 256; v++) sat += hist[v];
  const satFrac = sat / n;
  const pxPerPtFull = det.pxPerPt * fullScale;
  if (pxPerPtFull < 1.4) return { ok: false, hint: "Move closer" };
  if (median < 60) return { ok: false, hint: "Too dark — add light" };
  if (satFrac > 0.08 && median < 250) return { ok: false, hint: "Glare on sheet — tilt or move the light" };
  return { ok: true, median, satFrac };
}

/* ============================================================
   Reading: darkness -> answers, ID, form (with flags)
   ============================================================ */
// answers[q] is "" (blank), "C", or "AD" (several marks). ansFlags[q] is null, "faint" or "multiple".
function readSheet(dk, thr) {
  const answers = [], ansFlags = [];
  dk.q.forEach(d => { const c = classify(d, thr, LETTERS); answers.push(c.value || ""); ansFlags.push(c.flag); });
  let id = ""; const idFlags = [];
  dk.id.forEach(d => {
    const c = classify(d, thr, "0123456789");
    if (!c.value) { id += "?"; idFlags.push("blank"); }
    else if (c.flag === "multiple") { id += "?"; idFlags.push("multiple"); }
    else { id += c.value; idFlags.push(c.flag); }
  });
  const fc = classify(dk.form, thr, "ABC");
  let form = fc.value || null, formFlag = fc.flag;
  if (!form) formFlag = "none"; else if (fc.flag === "multiple") { form = null; formFlag = "multiple"; }
  return { answers, ansFlags, id, idFlags, form, formFlag };
}

/* ============================================================
   Scanner: live camera loop with auto-capture
   ============================================================ */
const DET_LONG = 800;
function captureFull(src, sw, sh, det, scale) {
  const cv = document.createElement("canvas"); cv.width = sw; cv.height = sh;
  const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(src, 0, 0, sw, sh);
  const rgba = cx.getImageData(0, 0, sw, sh), g = toGray(rgba.data, sw * sh);
  const pxPerPt = det.pxPerPt * scale, mSize = TPL.markerPt * pxPerPt, pts = {};
  for (const k in det.pts) {
    const c = [det.pts[k][0] * scale, det.pts[k][1] * scale];
    pts[k] = findBlob(g, sw, sh, c, mSize, mSize * 1.2) || c;
  }
  const mp = makeMapper(pts, g, sw, sh);
  const dark = readDarkness(g, sw, sh, mp.map);
  const flat = warpImage(rgba.data, sw, sh, mp);
  const fc = document.createElement("canvas"); fc.width = flat.width; fc.height = flat.height;
  fc.getContext("2d").putImageData(flat, 0, 0);
  return new Promise(res => fc.toBlob(blob => res({
    dark, blob, w: flat.width, h: flat.height, orient: orientationOf(pts),
    pxPerPt: +pxPerPt.toFixed(2), sharp: sharpness(flat),
  }), "image/jpeg", 0.8));
}
function round2(v) { return Math.round(v * 1000) / 1000; }
function packDark(d) { return { q: d.q.map(r => r.map(round2)), id: d.id.map(r => r.map(round2)), form: d.form.map(round2) }; }

class Scanner {
  constructor({ canvas, video, onHint, onCapture }) {
    Object.assign(this, { canvas, video, onHint, onCapture });
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.running = false; this.busy = false;
  }
  async start(res) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't open the camera here. Open the app from its https:// address in Safari.");
    const hi = res === "2160";
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: hi ? 3840 : 1920 }, height: { ideal: hi ? 2160 : 1080 } } });
    this.video.srcObject = this.stream; await this.video.play().catch(() => {});
    Object.assign(this, { running: true, armed: true, lost: 0, hist: [], lastCap: 0, capPts: null, flashUntil: 0 });
    const tick = () => { if (!this.running) return; if (this.video.readyState >= 2 && this.video.videoWidth && !this.busy) this.frame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  stop() { this.running = false; this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; }
  frame() {
    const v = this.video, vw = v.videoWidth, vh = v.videoHeight, sc = DET_LONG / Math.max(vw, vh);
    const W = Math.round(vw * sc), H = Math.round(vh * sc), cv = this.canvas, ctx = this.ctx;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.drawImage(v, 0, 0, W, H);
    const g = toGray(ctx.getImageData(0, 0, W, H).data, W * H), det = detect(g, W, H), now = performance.now();
    this.draw(det, now);
    const hint = (t, ok) => this.onHint(t, ok);
    if (!det.found) {
      this.lost++; this.hist = []; if (this.lost >= 2) this.armed = true;
      return hint(now < this.flashUntil ? "Captured" : det.cands.length >= 4 ? "Make sure all 6 corner squares are visible" : "Point the camera at an answer sheet", now < this.flashUntil);
    }
    this.lost = 0; const diag = Math.hypot(W, H);
    this.hist.push(det.pts); if (this.hist.length > 5) this.hist.shift();
    if (!this.armed && this.capPts && Math.max(...["TL", "TR", "BL", "BR"].map(k => dist(det.pts[k], this.capPts[k]))) > 0.06 * diag) this.armed = true;
    if (now < this.flashUntil) return hint("Captured", true);
    const q = quality(g, W, H, det, 1 / sc); if (!q.ok) return hint(q.hint);
    let steady = this.hist.length >= 4;
    if (steady) for (const k of ["TL", "TR", "BL", "BR"]) for (const p of this.hist) if (dist(p[k], det.pts[k]) > 0.008 * diag) steady = false;
    if (!steady) return hint("Hold still");
    if (!this.armed) return hint("Place the next sheet");
    if (now - this.lastCap < 700) return;
    Object.assign(this, { armed: false, lastCap: now, capPts: det.pts, flashUntil: now + 900, busy: true });
    hint("Captured", true);
    captureFull(v, vw, vh, det, 1 / sc).then(r => this.onCapture(r)).catch(e => console.error(e)).finally(() => { this.busy = false; });
  }
  draw(det, now) {
    if (!det.found) return;
    const ctx = this.ctx, P = det.pts, flash = now < this.flashUntil, lw = Math.max(2, this.canvas.width / 300);
    ctx.strokeStyle = flash ? "#2ea043" : "rgba(255,255,255,.9)"; ctx.lineWidth = flash ? lw * 3 : lw;
    ctx.beginPath(); ctx.moveTo(...P.TL); ctx.lineTo(...P.TR); ctx.lineTo(...P.BR); ctx.lineTo(...P.BL); ctx.closePath(); ctx.stroke();
    if (flash) { ctx.fillStyle = "rgba(46,160,67,.18)"; ctx.fill(); }
  }
}
// Reads a still photo (Blob or URL). Returns the same result as a live capture, or null if no sheet.
async function scanPhoto(src) {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  const im = await createImageBitmap(blob);
  let sw = im.width, sh = im.height; const cap = 3000 / Math.max(sw, sh);
  if (cap < 1) { sw = Math.round(sw * cap); sh = Math.round(sh * cap); }
  const sc = DET_LONG / Math.max(sw, sh), W = Math.round(sw * sc), H = Math.round(sh * sc);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(im, 0, 0, W, H);
  const det = detect(toGray(cx.getImageData(0, 0, W, H).data, W * H), W, H);
  if (!det.found) return null;
  const full = document.createElement("canvas"); full.width = sw; full.height = sh; full.getContext("2d").drawImage(im, 0, 0, sw, sh);
  return captureFull(full, sw, sh, det, 1 / sc);
}
