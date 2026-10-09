// Heavy lifting off the main thread: parse → audit → tile → zip.
import Module from 'manifold-3d';
import { parseAny } from './parsers.js';
import { audit, bounds, dropDegenerate, orient, translate, volume } from './mesh.js';
import { tile, toManifold, layerPath, estimateTile } from './engine.js';
import { zipTiles, writeSTL, write3MF } from './export.js';

let wasm;
const ready = Module().then((w) => { w.setup(); wasm = w; });
let source = null; // { mesh, name, original: positions as loaded, rot: 3x3 row-major, factor, asModelled: size after rotation at scale 1, note, dropped }
let last = null;   // last tile() result
const tileMan = new Map(); // tile name -> Manifold, built lazily for layer slicing

const post = (type, payload, transfer) => postMessage({ type, ...payload }, transfer || []);
function postLoaded() {
  const { mesh } = source;
  post('loaded', { name: source.name, note: source.note, dropped: source.dropped, audit: audit(mesh), bounds: bounds(mesh), volume: volume(mesh),
    asModelled: source.asModelled, scaleFactor: source.factor, rotated: source.rot.some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > 1e-9),
    positions: mesh.positions.slice(0), indices: mesh.indices.slice(0) });
}
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul3 = (A, B) => { const R = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) R[3 * r + c] += A[3 * r + k] * B[3 * k + c]; return R; };
function axisRot(axis, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
/** positions = scale · (rot · original), then base to the origin. asModelled = size of the rotated, unscaled mesh. */
function applyTransform() {
  const p = source.mesh.positions, o = source.original, R = source.rot, f = source.factor;
  for (let i = 0; i < p.length; i += 3) {
    const x = o[i], y = o[i + 1], z = o[i + 2];
    p[i] = (R[0] * x + R[1] * y + R[2] * z) * f[0];
    p[i + 1] = (R[3] * x + R[4] * y + R[5] * z) * f[1];
    p[i + 2] = (R[6] * x + R[7] * y + R[8] * z) * f[2];
  }
  const bb = bounds(source.mesh);
  for (let i = 0; i < p.length; i += 3) { p[i] -= bb.min[0]; p[i + 1] -= bb.min[1]; p[i + 2] -= bb.min[2]; }
  source.asModelled = bb.size.map((v, i) => v / f[i]);
  // a rotation by a non-right angle can flip winding only if the matrix has det < 0 — ours are pure rotations, so no re-orientation needed
}

onmessage = async (e) => {
  await ready;
  const d = e.data;
  try {
    if (d.type === 'load') {
      const parsed = parseAny(d.name, d.buffer);
      let mesh = { positions: parsed.positions, indices: parsed.indices };
      const dd = dropDegenerate(mesh); mesh = { positions: dd.positions, indices: dd.indices };
      orient(mesh, { scale: d.scale || 1, upAxis: d.upAxis || 'z' });
      const bb = bounds(mesh);
      if (d.baseToZero !== false) translate(mesh, [-bb.min[0], -bb.min[1], -bb.min[2]]);
      source = { mesh, name: d.name, original: mesh.positions.slice(0), rot: I3.slice(), factor: [1, 1, 1], asModelled: bounds(mesh).size, note: parsed.note, dropped: dd.dropped };
      last = null;
      postLoaded();
    } else if (d.type === 'scale') {
      if (!source) throw new Error('No model loaded');
      source.factor = d.factor; last = null;
      applyTransform(); postLoaded();
    } else if (d.type === 'rotate') {
      if (!source) throw new Error('No model loaded');
      // relative rotation about a world axis, composed onto the current orientation; 'reset' clears it
      source.rot = d.reset ? I3.slice() : mul3(axisRot(d.axis, d.deg), source.rot);
      last = null;
      applyTransform(); postLoaded();
    } else if (d.type === 'tile') {
      if (!source) throw new Error('No model loaded');
      const r = tile(wasm, source.mesh, { ...d.opts, onProgress: (p) => post('progress', { value: p }) });
      last = { r, opts: d.opts };
      for (const m of tileMan.values()) m.delete(); tileMan.clear();
      const transfer = [];
      const tiles = r.tiles.map(t => {
        const positions = t.mesh.positions.slice(0), indices = t.mesh.indices.slice(0);
        transfer.push(positions.buffer, indices.buffer);
        return { name: t.name, row: t.row, col: t.col, audit: t.audit, bounds: t.bounds, volume: t.volume, shellVolume: t.shellVolume, fitsBed: t.fitsBed, positions, indices };
      });
      post('tiled', { plan: r.plan, holes: r.holes, sourceVolume: r.sourceVolume, tileVolume: r.tileVolume, printVolume: r.printVolume, hollow: r.hollow, allOk: r.allOk, tiles }, transfer);
    } else if (d.type === 'estimate') {
      if (!last) throw new Error('Nothing tiled');
      const out = {}; let i = 0;
      for (const t of last.r.tiles) {
        let m = tileMan.get(t.name);
        if (!m) { m = toManifold(wasm, t.mesh); tileMan.set(t.name, m); }
        out[t.name] = estimateTile(wasm, m, t.bounds.size[2], d.opts);
        post('progress', { value: ++i / last.r.tiles.length, what: 'estimate' });
      }
      post('estimate', { tiles: out, opts: d.opts });
    } else if (d.type === 'layer') {
      if (!last) throw new Error('Nothing tiled');
      const out = {};
      for (const t of last.r.tiles) {
        if (d.z > t.bounds.size[2] || d.z <= 0) continue;
        let m = tileMan.get(t.name);
        if (!m) { m = toManifold(wasm, t.mesh); tileMan.set(t.name, m); }
        out[t.name] = layerPath(wasm, m, d.z, d.opts);
      }
      post('layer', { z: d.z, seq: d.seq, tiles: out });
    } else if (d.type === 'zip') {
      if (!last) throw new Error('Nothing to export');
      const zip = zipTiles(last.r, last.opts, source.name, d.formats);
      post('zip', { bytes: zip }, [zip.buffer]);
    } else if (d.type === 'exportSource') {
      if (!source) throw new Error('No model loaded');
      const bytes = d.format === '3mf' ? write3MF(source.mesh, source.name) : writeSTL(source.mesh, source.name);
      post('zip', { bytes, single: d.format }, [bytes.buffer]);
    }
  } catch (err) {
    post('error', { message: err.message || String(err) });
  }
};
