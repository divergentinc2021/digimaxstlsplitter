import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import Module from 'manifold-3d';
import { audit, weld, dropDegenerate, volume } from '../src/mesh.js';
import { tile, fromManifold } from '../src/engine.js';
import { parseSTL, parse3MF, parseGLB } from '../src/parsers.js';
import { writeSTL, write3MF } from '../src/export.js';

const wasm = await Module(); wasm.setup();

/** Synthetic terrain disc: flat base, 45° rim chamfer, bumpy top. Built closed by construction. */
function terrainDisc(R = 499, H = 35, chamfer = 35, step = 6) {
  const N = Math.ceil(2 * Math.PI * R / step);
  const ring = Array.from({ length: N }, (_, i) => [Math.cos(2 * Math.PI * i / N), Math.sin(2 * Math.PI * i / N)]);
  const pts = []; const g = [];
  for (let x = -R; x <= R; x += step) for (let y = -R; y <= R; y += step) if (Math.hypot(x, y) < R - step) g.push([x, y]);
  // top: ring + grid, fan-triangulated by a simple Delaunay stand-in (use manifold's extrude of polygon for the outer ring and a heightfield via levelSet is overkill) — use three steps instead:
  // we build the solid with manifold itself: extrude the ring polygon, then warp the top. Keeps test independent of engine's cutting code.
  const poly = ring.map(([c, s]) => [c * R, s * R]);
  let m = wasm.Manifold.extrude([poly], H + 60, 0, 0, [1, 1], false);
  m = m.refineToLength(step);
  const T0 = H + 60;
  m = m.warp((v) => {
    const r = Math.hypot(v[0], v[1]);
    const zb = Math.max(0, r - (R - chamfer));                         // base + 45° chamfer
    const zt = H + 30 + 25 * Math.sin(v[0] / 60) * Math.cos(v[1] / 45); // relief
    v[2] = zb + (v[2] / T0) * (zt - zb);                               // wall interpolates — injective, no collapsed columns
  });
  return fromManifold(m);
}

test('audit: closed cube passes, cube minus one face reports open edges', () => {
  const c = wasm.Manifold.cube([10, 10, 10], true).getMesh();
  const mesh = { positions: Float32Array.from(c.vertProperties), indices: Uint32Array.from(c.triVerts) };
  assert.equal(audit(mesh).ok, true);
  const broken = { positions: mesh.positions, indices: mesh.indices.slice(3) };
  const a = audit(broken);
  assert.equal(a.ok, false); assert.equal(a.open, 3);
});

test('audit: two cubes = two shells', () => {
  const a = wasm.Manifold.cube([10, 10, 10], true), b = a.translate([30, 0, 0]);
  const m = wasm.Manifold.compose([a, b]).getMesh();
  assert.equal(audit({ positions: Float32Array.from(m.vertProperties), indices: Uint32Array.from(m.triVerts) }).shells, 2);
});

test('weld merges bit-identical vertices; dropDegenerate removes zero-area tris', () => {
  const p = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  const w = weld(p, null);
  assert.equal(w.positions.length / 3, 3);
  const d = dropDegenerate(w);
  assert.equal(d.dropped, 1); assert.equal(d.indices.length, 3);
});

test('tile: synthetic disc on a 220 bed → 5x5, every tile closed, volumes sum exactly', () => {
  const mesh = terrainDisc();
  assert.equal(audit(mesh).ok, true, 'fixture must be closed');
  const r = tile(wasm, mesh, { bed: [220, 220, 250], margin: 10, tiles: null, dowel: null });
  assert.equal(r.plan.nx, 5); assert.equal(r.plan.ny, 5);
  assert.equal(r.tiles.length, 25);
  for (const t of r.tiles) { assert.equal(t.audit.ok, true, t.name); assert.equal(t.fitsBed, true, t.name); assert.equal(t.audit.shells, 1, t.name); }
  assert.ok(Math.abs(r.tileVolume - r.sourceVolume) < 1e-4 * r.sourceVolume);
  assert.equal(r.allOk, true);
});

test('tile: dowel holes only where both sides are solid, volumes still sum', () => {
  const mesh = terrainDisc();
  const r = tile(wasm, mesh, { bed: [220, 220, 250], margin: 10, tiles: null, dowel: { radius: 3.1, depth: 12, z: 17.5, pitch: 80 } });
  assert.ok(r.holes > 20, 'holes ' + r.holes);
  for (const t of r.tiles) assert.equal(t.audit.ok, true, t.name);
  assert.ok(Math.abs(r.tileVolume - r.sourceVolume) < 1e-4 * r.sourceVolume);
});

test('tile: an open input is refused, never silently cut', () => {
  const c = wasm.Manifold.cube([300, 300, 50], true).getMesh();
  const broken = { positions: Float32Array.from(c.vertProperties), indices: Uint32Array.from(c.triVerts).slice(3) };
  assert.throws(() => tile(wasm, broken, { bed: [220, 220, 250], margin: 10 }), /not a closed solid/);
});

test('STL and 3MF round-trip through our writers and parsers', () => {
  const mesh = terrainDisc(100, 20, 10, 10);
  const v0 = volume(mesh);
  const s = parseSTL(writeSTL(mesh).buffer);
  assert.equal(audit(s).ok, true); assert.ok(Math.abs(volume(s) - v0) < 1e-6 * v0);
  const m3 = parse3MF(write3MF(mesh).buffer);
  assert.equal(audit(m3).ok, true); assert.ok(Math.abs(volume(m3) - v0) < 1e-6 * v0);
});

test('GLB parser: quantized GLB with node transform decodes to mm Z-up', () => {
  // minimal GLB: one quad-free tetra, int16 normalized positions, node scale 0.5, translation y=0.068
  const P = new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767]);
  const I = new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const bin = new Uint8Array(P.byteLength + I.byteLength); bin.set(new Uint8Array(P.buffer)); bin.set(new Uint8Array(I.buffer), P.byteLength);
  const json = JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_mesh_quantization'], scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0, scale: [0.5, 0.5, 0.5], translation: [0, 0.068, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5122, normalized: true, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }], buffers: [{ byteLength: bin.byteLength }] });
  const js = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const total = 12 + 8 + js.length + 8 + bin.length;
  const glb = new Uint8Array(total); const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); glb.set(js, 20);
  dv.setUint32(20 + js.length, bin.length, true); dv.setUint32(24 + js.length, 0x004e4942, true); glb.set(bin, 28 + js.length);
  const m = parseGLB(glb.buffer);
  assert.equal(m.positions.length / 3, 4);
  // vertex 1 was (1,0,0) m → scaled 0.5 → 500 mm in X; vertex 2 was +Y → +Z after up-axis swap: (0, 68, 568)
  const y = Array.from(m.positions.slice(6, 9)).map(v => +v.toFixed(2));
  assert.deepEqual(y, [0, 0, 568]);
  assert.ok(volume(m) > 0, 'winding must stay outward after the rotation');
});

const REAL = 'D:/Downloads/iziko-centerpiece_09_remesh_1p5mm.stl';
test('real centrepiece (if present): 25 closed tiles', { skip: !existsSync(REAL) }, () => {
  const mesh = parseSTL(readFileSync(REAL).buffer);
  const r = tile(wasm, mesh, { bed: [220, 220, 250], margin: 10 });
  assert.equal(r.tiles.length, 25);
  assert.equal(r.allOk, true);
});
