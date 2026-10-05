// Post-cut cleanup: the boolean leaves each planar cut face fan-triangulated against the terrain profile,
// i.e. hundreds of needle triangles per wall. Slicers count the sub-micron ones as "degenerate facets".
// We snap-weld at 1 µm, then re-triangulate every axis-aligned planar face from its boundary loops with
// earcut. Boundary vertices are untouched, so the mesh stays watertight; only the interior fan changes.
import earcut from 'earcut';
import { audit } from './mesh.js';

/** Merge vertices that coincide within `q` mm and drop triangles that collapse to a line. */
export function snapWeld(mesh, q = 0.001) {
  const p = mesh.positions, n = p.length / 3, keys = new Map(), remap = new Uint32Array(n), out = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p[3 * i] / q)},${Math.round(p[3 * i + 1] / q)},${Math.round(p[3 * i + 2] / q)}`;
    let id = keys.get(k);
    if (id === undefined) { id = out.length / 3; keys.set(k, id); out.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]); }
    remap[i] = id;
  }
  const t = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = remap[mesh.indices[i]], b = remap[mesh.indices[i + 1]], c = remap[mesh.indices[i + 2]];
    if (a !== b && b !== c && a !== c) t.push(a, b, c);
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(t) };
}

/**
 * Re-triangulate axis-aligned planar regions (cut walls, base). Groups faces by (axis, sign, offset),
 * extracts the region's boundary loops, triangulates with earcut (outer loop + holes), keeps winding.
 * Returns a new mesh; falls back to the original faces for any region that fails to triangulate cleanly.
 */
export function retriangulatePlanar(mesh, { tol = 1e-4 } = {}) {
  const p = mesh.positions, t = mesh.indices, nf = t.length / 3;
  const groups = new Map(); // key -> [faceIdx...]
  const normal = new Float64Array(3);
  for (let f = 0; f < nf; f++) {
    const a = 3 * t[3 * f], b = 3 * t[3 * f + 1], c = 3 * t[3 * f + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    normal[0] = uy * vz - uz * vy; normal[1] = uz * vx - ux * vz; normal[2] = ux * vy - uy * vx;
    const len = Math.hypot(normal[0], normal[1], normal[2]); if (len === 0) continue;
    let axis = -1;
    for (let k = 0; k < 3; k++) if (Math.abs(Math.abs(normal[k] / len) - 1) < 1e-6) axis = k;
    if (axis < 0) continue;
    const sign = normal[axis] > 0 ? 1 : -1;
    const off = Math.round(p[a + axis] / tol);
    const key = `${axis}:${sign}:${off}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  }
  const keep = new Uint8Array(nf).fill(1);
  const added = [];
  for (const [key, faces] of groups) {
    if (faces.length < 4) continue; // nothing to gain
    const [axis, sign] = key.split(':').map(Number);
    // boundary edges = edges used once within the group (directed, so loops come out oriented)
    const dir = new Map(); // "a,b" -> count
    for (const f of faces) for (let e = 0; e < 3; e++) {
      const a = t[3 * f + e], b = t[3 * f + (e + 1) % 3];
      dir.set(`${a},${b}`, (dir.get(`${a},${b}`) || 0) + 1);
    }
    const next = new Map();
    let bad = false;
    for (const [k, c] of dir) {
      const [a, b] = k.split(',').map(Number);
      if (dir.has(`${b},${a}`)) continue; // interior edge
      if (c !== 1 || next.has(a)) { bad = true; break; }
      next.set(a, b);
    }
    if (bad) continue;
    // chain into loops
    const loops = [], seen = new Set();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop = []; let v = start;
      while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
      if (v !== start) { bad = true; break; }
      loops.push(loop);
    }
    if (bad || !loops.length) continue;
    // project to 2D in the plane; choose (u,v) so that +normal is the right-handed z
    const U = (axis + 1) % 3, V = (axis + 2) % 3;
    const flip = sign < 0;
    const area2 = (loop) => { let s = 0; for (let i = 0; i < loop.length; i++) { const a = 3 * loop[i], b = 3 * loop[(i + 1) % loop.length]; s += p[a + U] * p[b + V] - p[b + U] * p[a + V]; } return s / 2; };
    loops.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)));
    const outer = loops[0], holes = loops.slice(1);
    const flat = [], idx = [], holeStarts = [];
    for (const l of [outer, ...holes]) { if (l !== outer) holeStarts.push(idx.length); for (const v of l) { flat.push(p[3 * v + U], p[3 * v + V]); idx.push(v); } }
    const tri = earcut(flat, holeStarts.length ? holeStarts : undefined);
    if (tri.length < 3) continue;
    // earcut emits CCW in (u,v); CCW in (u,v) is +normal along axis for a right-handed (U,V,axis) only when axis order is cyclic — it is (U=axis+1, V=axis+2)
    const want = !flip;
    const out = [];
    for (let i = 0; i < tri.length; i += 3) {
      const a = idx[tri[i]], b = idx[tri[i + 1]], c = idx[tri[i + 2]];
      if (want) out.push(a, b, c); else out.push(a, c, b);
    }
    // sanity: the new triangulation must cover the same area as the old faces
    let oldA = 0, newA = 0;
    const triArea = (a, b, c) => { const ax = p[3 * a + U], ay = p[3 * a + V], bx = p[3 * b + U], by = p[3 * b + V], cx = p[3 * c + U], cy = p[3 * c + V]; return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2; };
    for (const f of faces) oldA += triArea(t[3 * f], t[3 * f + 1], t[3 * f + 2]);
    for (let i = 0; i < out.length; i += 3) newA += triArea(out[i], out[i + 1], out[i + 2]);
    if (Math.abs(newA - oldA) > 1e-6 * Math.max(oldA, 1)) continue;
    // only accept a re-triangulation that is at least as well-shaped as the fan it replaces
    const minAng = (a, b, c) => { const d = (i, j) => Math.hypot(p[3*i]-p[3*j], p[3*i+1]-p[3*j+1], p[3*i+2]-p[3*j+2]); const x = d(b, c), y = d(a, c), z = d(a, b);
      const ang = (o, q, r) => Math.acos(Math.max(-1, Math.min(1, (q*q + r*r - o*o) / (2*q*r)))); return Math.min(ang(x, y, z), ang(y, x, z), ang(z, x, y)); };
    const lim = 0.5 * Math.PI / 180; let oldS = 0, newS = 0;
    for (const f of faces) if (minAng(t[3*f], t[3*f+1], t[3*f+2]) < lim) oldS++;
    for (let i = 0; i < out.length; i += 3) if (minAng(out[i], out[i+1], out[i+2]) < lim) newS++;
    if (newS > oldS) continue;
    for (const f of faces) keep[f] = 0;
    added.push(...out);
  }
  const ind = [];
  for (let f = 0; f < nf; f++) if (keep[f]) ind.push(t[3 * f], t[3 * f + 1], t[3 * f + 2]);
  ind.push(...added);
  return { positions: p, indices: Uint32Array.from(ind) };
}

/** Full cleanup with a safety net: only return the cleaned mesh if it is still closed and the same volume. */
export function cleanTile(mesh, volumeFn) {
  const v0 = volumeFn(mesh);
  const w = snapWeld(mesh, 0.005); // 5 µm: merges the 1–10 µm pairs the boolean leaves at cut intersections, far below any nozzle
  const r = retriangulatePlanar(w);
  const a = audit(r);
  if (!a.ok || a.shells !== 1 || Math.abs(volumeFn(r) - v0) > 1e-6 * Math.abs(v0)) {
    const a2 = audit(w);
    return a2.ok && Math.abs(volumeFn(w) - v0) <= 1e-6 * Math.abs(v0) ? { mesh: w, retriangulated: false } : { mesh, retriangulated: false, skipped: true };
  }
  return { mesh: r, retriangulated: true };
}
