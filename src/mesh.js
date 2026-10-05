// Pure mesh utilities. No DOM, no three.js — runs in Node tests, workers and the page.
// A "mesh" here is { positions: Float32Array (xyz...), indices: Uint32Array (abc...) }.

/** Weld vertices that are bit-identical. Returns a new indexed mesh. */
export function weld(positions, indices) {
  const n = positions.length / 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const map = new Map();
  const remap = new Uint32Array(n);
  const out = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const key = bits[3 * i] + ',' + bits[3 * i + 1] + ',' + bits[3 * i + 2];
    let id = map.get(key);
    if (id === undefined) {
      id = count++;
      map.set(key, id);
      out.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    }
    remap[i] = id;
  }
  const src = indices || Uint32Array.from({ length: n }, (_, i) => i);
  const tris = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) tris[i] = remap[src[i]];
  return { positions: Float32Array.from(out), indices: tris };
}

/** Drop triangles with a repeated vertex or zero area. */
export function dropDegenerate(mesh, eps = 1e-12) {
  const { positions: p, indices: t } = mesh;
  const keep = [];
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i], b = t[i + 1], c = t[i + 2];
    if (a === b || b === c || a === c) continue;
    const ax = p[3 * b] - p[3 * a], ay = p[3 * b + 1] - p[3 * a + 1], az = p[3 * b + 2] - p[3 * a + 2];
    const bx = p[3 * c] - p[3 * a], by = p[3 * c + 1] - p[3 * a + 1], bz = p[3 * c + 2] - p[3 * a + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (nx * nx + ny * ny + nz * nz < eps) continue;
    keep.push(a, b, c);
  }
  return { positions: p, indices: Uint32Array.from(keep), dropped: (t.length - keep.length) / 3 };
}

/**
 * Independent topology audit (does NOT trust the boolean engine).
 * Every edge of a closed manifold is used by exactly two triangles.
 */
export function audit(mesh) {
  const { positions: p, indices: t } = mesh;
  const nv = p.length / 3;
  const edges = new Map(); // key -> count
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i], b = t[i + 1], c = t[i + 2];
    for (const k of [key(a, b), key(b, c), key(c, a)]) edges.set(k, (edges.get(k) || 0) + 1);
  }
  let open = 0, nonManifold = 0;
  for (const c of edges.values()) {
    if (c === 1) open++;
    else if (c > 2) nonManifold++;
  }
  // shells via union-find over triangles sharing an edge
  const parent = new Int32Array(t.length / 3).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  for (let f = 0; f < t.length / 3; f++) {
    const a = t[3 * f], b = t[3 * f + 1], c = t[3 * f + 2];
    for (const k of [key(a, b), key(b, c), key(c, a)]) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, f);
      else { const ra = find(o), rb = find(f); if (ra !== rb) parent[ra] = rb; }
    }
  }
  let shells = 0;
  for (let f = 0; f < parent.length; f++) if (find(f) === f) shells++;
  return { vertices: nv, triangles: t.length / 3, edges: edges.size, open, nonManifold, shells, ok: open === 0 && nonManifold === 0 };
}

export function bounds(mesh) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Signed volume (mm³) — positive for outward-wound closed meshes. */
export function volume(mesh) {
  const { positions: p, indices: t } = mesh;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
       - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Apply scale, up-axis swap and translation in place. upAxis: 'z' (no-op) or 'y' (Y-up → Z-up). */
export function orient(mesh, { scale = 1, upAxis = 'z' } = {}) {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i] * scale, y = p[i + 1] * scale, z = p[i + 2] * scale;
    if (upAxis === 'y') { const t = y; y = -z; z = t; } // rotation about X, not a mirror
    p[i] = x; p[i + 1] = y; p[i + 2] = z;
  }
  return mesh;
}

export function translate(mesh, d) {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) { p[i] += d[0]; p[i + 1] += d[1]; p[i + 2] += d[2]; }
  return mesh;
}
