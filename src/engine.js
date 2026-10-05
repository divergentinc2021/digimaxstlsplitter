// Tiling engine. Takes an initialised manifold-3d module so it runs in Node, a worker, or the page.
import { audit, bounds, volume, weld } from './mesh.js';

export function toManifold(wasm, mesh) {
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  m.merge();
  try { return new wasm.Manifold(m); }
  catch (e) { throw new Error('Input is not a closed solid (' + (e.code || e.message) + '). Repair it first — cutting an open mesh only makes more open edges.'); }
}

export function fromManifold(man) {
  const m = man.getMesh();
  return weld(Float32Array.from(m.vertProperties), Uint32Array.from(m.triVerts));
}

/** Grid plan: how many tiles per axis so each tile fits the bed with margin. */
export function planGrid(size, bed, margin = 10, overrideTiles = null) {
  const usable = [bed[0] - 2 * margin, bed[1] - 2 * margin];
  const nx = overrideTiles?.[0] || Math.max(1, Math.ceil(size[0] / usable[0]));
  const ny = overrideTiles?.[1] || Math.max(1, Math.ceil(size[1] / usable[1]));
  return { nx, ny, tile: [size[0] / nx, size[1] / ny], fitsHeight: size[2] <= bed[2] };
}

/**
 * Cut `mesh` (already oriented, mm) into tiles.
 * opts: { bed:[x,y,z], margin, tiles:[nx,ny]|null, dowel:{radius,depth,z,pitch}|null, onProgress }
 * Returns { plan, tiles:[{name,row,col,mesh,audit,bounds,volume,fitsBed}], sourceAudit, sourceVolume, holes }
 */
export function tile(wasm, mesh, opts) {
  const { Manifold } = wasm;
  const bb = bounds(mesh);
  const plan = planGrid(bb.size, opts.bed, opts.margin ?? 10, opts.tiles);
  const progress = opts.onProgress || (() => {});

  let solid = toManifold(wasm, mesh);
  if (solid.status() !== 'NoError') throw new Error('Input is not a closed solid: ' + solid.status());

  // optional dowel holes on internal cut lines, only where both sides have material
  let holes = 0;
  if (opts.dowel) {
    const d = opts.dowel;
    const cyls = [];
    const full = Math.PI * d.radius * d.radius * 2 * d.depth;
    const tryHole = (x, y, axis) => {
      let c = Manifold.cylinder(2 * d.depth, d.radius, d.radius, 32, true);
      c = axis === 'x' ? c.rotate([0, 90, 0]) : c.rotate([90, 0, 0]);
      c = c.translate([x, y, d.z]);
      const inside = c.intersect(solid);
      const v = inside.volume(); inside.delete();
      if (v > 0.98 * full) cyls.push(c); else c.delete();
    };
    for (let i = 1; i < plan.nx; i++) {
      const x = bb.min[0] + plan.tile[0] * i;
      const n = Math.max(2, Math.floor(bb.size[1] / d.pitch) + 1);
      for (let k = 0; k < n; k++) tryHole(x, bb.min[1] + (k + 0.5) * bb.size[1] / n, 'x');
    }
    for (let j = 1; j < plan.ny; j++) {
      const y = bb.min[1] + plan.tile[1] * j;
      const n = Math.max(2, Math.floor(bb.size[0] / d.pitch) + 1);
      for (let k = 0; k < n; k++) tryHole(bb.min[0] + (k + 0.5) * bb.size[0] / n, y, 'y');
    }
    holes = cyls.length;
    if (cyls.length) {
      const all = Manifold.union(cyls);
      const cut = solid.subtract(all);
      solid.delete(); all.delete(); cyls.forEach(c => c.delete());
      solid = cut;
    }
  }

  const sourceVolume = solid.volume(); // after holes, so tiles must sum to exactly this
  const tiles = [];
  const H = bb.size[2] + 20;
  let done = 0;
  for (let i = 0; i < plan.nx; i++) for (let j = 0; j < plan.ny; j++) {
    const x0 = bb.min[0] + plan.tile[0] * i, y0 = bb.min[1] + plan.tile[1] * j;
    const box = Manifold.cube([plan.tile[0], plan.tile[1], H], false).translate([x0, y0, bb.min[2] - 10]);
    const t = solid.intersect(box); box.delete();
    progress(++done / (plan.nx * plan.ny));
    if (t.isEmpty() || t.volume() < 1e-6) { t.delete(); continue; }
    const tm = fromManifold(t); t.delete();
    const tb = bounds(tm);
    // place each tile at its own origin, base on z=0
    const p = tm.positions;
    for (let k = 0; k < p.length; k += 3) { p[k] -= tb.min[0]; p[k + 1] -= tb.min[1]; p[k + 2] -= tb.min[2]; }
    const a = audit(tm);
    tiles.push({
      name: `tile_r${j + 1}_c${i + 1}`, row: j + 1, col: i + 1, mesh: tm, audit: a,
      bounds: { size: tb.size, origin: tb.min }, volume: volume(tm),
      fitsBed: tb.size[0] <= opts.bed[0] && tb.size[1] <= opts.bed[1] && tb.size[2] <= opts.bed[2]
    });
  }
  solid.delete();
  const tileVolume = tiles.reduce((s, t) => s + t.volume, 0);
  return {
    plan, tiles, holes, sourceVolume, tileVolume,
    sourceAudit: audit(mesh),
    allOk: tiles.every(t => t.audit.ok && t.fitsBed) && Math.abs(tileVolume - sourceVolume) < 1e-3 * sourceVolume
  };
}
