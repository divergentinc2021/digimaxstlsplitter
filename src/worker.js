// Heavy lifting off the main thread: parse → audit → tile → zip.
import Module from 'manifold-3d';
import { parseAny } from './parsers.js';
import { audit, bounds, dropDegenerate, orient, translate, volume } from './mesh.js';
import { tile } from './engine.js';
import { zipTiles, writeSTL, write3MF } from './export.js';

let wasm;
const ready = Module().then((w) => { w.setup(); wasm = w; });
let source = null; // { mesh, name, original: Float32Array positions as loaded, asModelled: size, note, dropped, factor }
let last = null;   // last tile() result

const post = (type, payload, transfer) => postMessage({ type, ...payload }, transfer || []);
function postLoaded() {
  const { mesh } = source;
  post('loaded', { name: source.name, note: source.note, dropped: source.dropped, audit: audit(mesh), bounds: bounds(mesh), volume: volume(mesh),
    asModelled: source.asModelled, scaleFactor: source.factor,
    positions: mesh.positions.slice(0), indices: mesh.indices.slice(0) });
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
      source = { mesh, name: d.name, original: mesh.positions.slice(0), asModelled: bounds(mesh).size, note: parsed.note, dropped: dd.dropped, factor: [1, 1, 1] };
      last = null;
      postLoaded();
    } else if (d.type === 'scale') {
      if (!source) throw new Error('No model loaded');
      const f = d.factor;
      const p = source.mesh.positions, o = source.original;
      for (let i = 0; i < p.length; i += 3) { p[i] = o[i] * f[0]; p[i + 1] = o[i + 1] * f[1]; p[i + 2] = o[i + 2] * f[2]; }
      source.factor = f; last = null;
      postLoaded();
    } else if (d.type === 'tile') {
      if (!source) throw new Error('No model loaded');
      const r = tile(wasm, source.mesh, { ...d.opts, onProgress: (p) => post('progress', { value: p }) });
      last = { r, opts: d.opts };
      const transfer = [];
      const tiles = r.tiles.map(t => {
        const positions = t.mesh.positions.slice(0), indices = t.mesh.indices.slice(0);
        transfer.push(positions.buffer, indices.buffer);
        return { name: t.name, row: t.row, col: t.col, audit: t.audit, bounds: t.bounds, volume: t.volume, fitsBed: t.fitsBed, positions, indices };
      });
      post('tiled', { plan: r.plan, holes: r.holes, sourceVolume: r.sourceVolume, tileVolume: r.tileVolume, allOk: r.allOk, tiles }, transfer);
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
