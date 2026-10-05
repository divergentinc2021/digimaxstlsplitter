// Tiling engine. Takes an initialised manifold-3d module so it runs in Node, a worker, or the page.
import { audit, bounds, volume, weld, dropDegenerate } from './mesh.js';
import { cleanTile } from './clean.js';

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
  return { nx, ny, tile: [size[0] / nx, size[1] / ny], fitsHeight: size[2] <= bed[2], seams: (nx - 1) * ny + (ny - 1) * nx };
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
  for (let j = 0; j < plan.ny; j++) for (let i = 0; i < plan.nx; i++) { // row-major: r1_c1, r1_c2, …
    const x0 = bb.min[0] + plan.tile[0] * i, y0 = bb.min[1] + plan.tile[1] * j;
    const box = Manifold.cube([plan.tile[0], plan.tile[1], H], false).translate([x0, y0, bb.min[2] - 10]);
    let t = solid.intersect(box); box.delete();
    if (t.isEmpty() || t.volume() < 1e-6) { t.delete(); progress(++done / (plan.nx * plan.ny)); continue; }
    const solidVolume = t.volume(); // the cut piece, before any hollowing — this is what must sum to the source
    let shellVolume = null;
    if (opts.hollow && opts.hollow.wall > 0) { const h = hollow(wasm, t, opts.hollow); t.delete(); t = h; shellVolume = t.volume(); }
    progress(++done / (plan.nx * plan.ny));
    // cleanup: a 5 µm tolerance simplify collapses ~half the needle triangles the boolean leaves on the cut
    // walls without moving the surface; then weld at 1 µm and re-triangulate the planar faces (clean.js)
    const simp = opts.clean === false ? t : t.simplify(0.005);
    const raw = fromManifold(simp); if (simp !== t) simp.delete(); t.delete();
    const dd = dropDegenerate(raw, 0); // only triangles with a repeated vertex (eps 0): a real micro-triangle can still close the mesh
    const tm = opts.clean === false ? { positions: dd.positions, indices: dd.indices } : cleanTile({ positions: dd.positions, indices: dd.indices }, volume).mesh;
    const tb = bounds(tm);
    // place each tile at its own origin, base on z=0
    const p = tm.positions;
    for (let k = 0; k < p.length; k += 3) { p[k] -= tb.min[0]; p[k + 1] -= tb.min[1]; p[k + 2] -= tb.min[2]; }
    const a = audit(tm);
    tiles.push({
      name: `tile_r${j + 1}_c${i + 1}`, row: j + 1, col: i + 1, mesh: tm, audit: a,
      bounds: { size: tb.size, origin: tb.min }, volume: solidVolume, shellVolume,
      fitsBed: tb.size[0] <= opts.bed[0] && tb.size[1] <= opts.bed[1] && tb.size[2] <= opts.bed[2]
    });
  }
  solid.delete();
  const tileVolume = tiles.reduce((s, t) => s + t.volume, 0);
  const printVolume = tiles.reduce((s, t) => s + (t.shellVolume ?? t.volume), 0);
  return {
    plan, tiles, holes, sourceVolume, tileVolume, printVolume,
    hollow: opts.hollow && opts.hollow.wall > 0 ? opts.hollow : null,
    sourceAudit: audit(mesh),
    allOk: tiles.every(t => t.audit.ok && t.fitsBed) && Math.abs(tileVolume - sourceVolume) < 1e-3 * sourceVolume
  };
}

/**
 * Hollow a solid to a shell of `wall` mm: erode a simplified copy by a sphere (Minkowski difference),
 * subtract that cavity from the ORIGINAL so the outer surface is untouched. openBottom extends the
 * cavity down through the base so the part prints as an open shell instead of a sealed void.
 */
export function hollow(wasm, solid, { wall, openBottom = true }) {
  const { Manifold } = wasm;
  const simp = solid.simplify(Math.min(0.3, wall / 10)); // erosion cost scales with triangle count; the cavity may be coarse
  const tool = Manifold.sphere(wall, 8);
  let cavity = simp.minkowskiDifference(tool);
  simp.delete(); tool.delete();
  if (openBottom) {
    // Extend the cavity down through the base. Extruding its own cross-section (outset 0.05 mm so no face is
    // coplanar with the cavity's vertical sides) avoids the sliver edges a union with a z-shifted copy leaves behind.
    const cs = cavity.slice(wall + 0.2);
    const grown = cs.offset(0.05, 'Round', 2, 8); cs.delete();
    const polys = grown.toPolygons(); grown.delete();
    if (polys.length) {
      const ext = Manifold.extrude(polys, wall + 6, 0, 0, [1, 1], false).translate([0, 0, -5]);
      const u = cavity.add(ext); cavity.delete(); ext.delete(); cavity = u;
    }
  }
  const shell = solid.subtract(cavity); cavity.delete();
  return shell;
}

/**
 * Rough print estimate for one tile from sampled real slices. Speeds in mm/s; returns seconds, mm³ of extrusion, layers.
 * Bottom `solidLayers` are sliced at 100 % infill; the rest is sampled `samples` times and scaled to the layer count.
 */
export function estimateTile(wasm, man, height, { layerHeight = 0.2, walls = 3, lineWidth = 0.4, infill = 0.15, solidLayers = 4, perimeterSpeed = 45, infillSpeed = 80, maxFlow = 0, travelPerLayer = 1.5, samples = 24 } = {}) {
  const layers = Math.max(1, Math.ceil(height / layerHeight));
  // the hotend's volumetric ceiling caps any commanded speed: v ≤ flow ÷ (line width × layer height)
  const cap = maxFlow > 0 ? maxFlow / (lineWidth * layerHeight) : Infinity;
  const vp = Math.min(perimeterSpeed, cap), vi = Math.min(infillSpeed, cap);
  const pathLen = (L) => {
    let p = 0; for (const poly of L.perims) for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; p += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    let f = 0; for (let i = 0; i < L.infill.length; i += 4) f += Math.hypot(L.infill[i + 2] - L.infill[i], L.infill[i + 3] - L.infill[i + 1]);
    return [p, f];
  };
  let perim = 0, fill = 0;
  const nb = Math.min(solidLayers, layers);
  for (let k = 0; k < nb; k++) { const [p, f] = pathLen(layerPath(wasm, man, (k + 0.5) * layerHeight, { walls, lineWidth, infill: 1 })); perim += p; fill += f; }
  const rest = layers - nb;
  if (rest > 0) {
    const n = Math.min(samples, rest);
    for (let k = 0; k < n; k++) {
      const z = (nb + (k + 0.5) * rest / n) * layerHeight;
      const [p, f] = pathLen(layerPath(wasm, man, Math.min(z, height - 1e-3), { walls, lineWidth, infill, angle: (k % 2) * Math.PI / 2 + Math.PI / 4 }));
      perim += p * rest / n; fill += f * rest / n;
    }
  }
  const seconds = perim / vp + fill / vi + layers * travelPerLayer;
  const mm3 = (perim + fill) * lineWidth * layerHeight;
  return { seconds, mm3, layers, perimeterMm: perim, infillMm: fill, wallSpeedUsed: vp, infillSpeedUsed: vi };
}

/**
 * One print layer of a tile at height z: `walls` perimeters at `lineWidth`, then straight infill at `infill` (0..1).
 * Returns { perims: [[x,y],...][], infill: [x0,y0,x1,y1,...] } in the tile's own coordinates.
 */
export function layerPath(wasm, man, z, { walls = 3, lineWidth = 0.4, infill = 0.15, angle = 0 } = {}) {
  const cs = man.slice(z);
  const perims = [];
  for (let k = 0; k < walls; k++) {
    const o = cs.offset(-lineWidth * (k + 0.5), 'Round', 2, 8);
    for (const poly of o.toPolygons()) if (poly.length > 2) perims.push(poly.map(p => [p[0], p[1]]));
    o.delete();
  }
  const seg = [];
  if (infill > 0) {
    const inner = cs.offset(-lineWidth * walls, 'Round', 2, 8);
    // rotate the region by -angle, scanline it, rotate hits back
    const ca = Math.cos(-angle), sa = Math.sin(-angle);
    const polys = inner.toPolygons().map(poly => poly.map(p => [p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca]));
    inner.delete();
    let ymin = Infinity, ymax = -Infinity;
    for (const poly of polys) for (const [, y] of poly) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    const sp = lineWidth / infill;
    const cb = Math.cos(angle), sb = Math.sin(angle);
    for (let y = ymin + sp / 2; y < ymax; y += sp) {
      const xs = [];
      for (const poly of polys) for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
        if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const ax = xs[i], bx = xs[i + 1];
        seg.push(ax * cb - y * sb, ax * sb + y * cb, bx * cb - y * sb, bx * sb + y * cb);
      }
    }
  }
  cs.delete();
  return { perims, infill: seg };
}
