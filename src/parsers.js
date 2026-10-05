// File parsers → { positions, indices, unit, upAxis, note }. Pure JS + fflate; no three.js, so tests run in Node.
import { unzipSync, strFromU8 } from 'fflate';
import { weld } from './mesh.js';

export function parseSTL(buf) {
  const u8 = new Uint8Array(buf);
  const head = strFromU8(u8.subarray(0, Math.min(512, u8.length)));
  const dv = new DataView(buf);
  const n = u8.length >= 84 ? dv.getUint32(80, true) : -1;
  const isBinary = u8.length === 84 + 50 * n || !/^\s*solid[\s\S]*facet/i.test(head);
  let positions;
  if (isBinary) {
    positions = new Float32Array(n * 9);
    for (let i = 0, o = 84; i < n; i++, o += 50)
      for (let k = 0; k < 9; k++) positions[9 * i + k] = dv.getFloat32(o + 12 + 4 * k, true);
  } else {
    const txt = strFromU8(u8);
    const out = [];
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m; while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    positions = Float32Array.from(out);
  }
  return { ...weld(positions, null), unit: 'mm', upAxis: 'z', note: isBinary ? 'binary STL' : 'ASCII STL' };
}

const UNIT = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export function parse3MF(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const name = Object.keys(files).find(f => /\.model$/i.test(f));
  if (!name) throw new Error('3MF: no .model part');
  const xml = strFromU8(files[name]);
  const unit = (/<model[^>]*\sunit="(\w+)"/i.exec(xml) || [, 'millimeter'])[1].toLowerCase();
  const scale = UNIT[unit] ?? 1;
  const pos = [], idx = [];
  const meshRe = /<mesh>([\s\S]*?)<\/mesh>/gi;
  let mm;
  while ((mm = meshRe.exec(xml))) {
    const base = pos.length / 3;
    const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    let v; while ((v = vRe.exec(mm[1]))) pos.push(+v[1] * scale, +v[2] * scale, +v[3] * scale);
    const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    let t; while ((t = tRe.exec(mm[1]))) idx.push(base + +t[1], base + +t[2], base + +t[3]);
  }
  return { ...weld(Float32Array.from(pos), Uint32Array.from(idx)), unit: 'mm', upAxis: 'z', note: `3MF (${unit})` };
}

/** GLB → mesh in mm, converted Y-up → Z-up. Handles KHR_mesh_quantization and node transforms. */
export function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(strFromU8(new Uint8Array(buf, 20, jsonLen)));
  const binOff = 20 + jsonLen + 8;
  const bin = new Uint8Array(buf, binOff);
  const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const acc = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], T = CT[a.componentType], nc = NC[a.type];
    const stride = bv.byteStride || T.BYTES_PER_ELEMENT * nc;
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * nc);
    for (let k = 0; k < a.count; k++) {
      const view = new T(bin.buffer, bin.byteOffset + off + k * stride, nc);
      for (let c = 0; c < nc; c++) out[k * nc + c] = a.normalized ? view[c] / NORM[a.componentType] : view[c];
    }
    return out;
  };
  // world matrices via scene traversal
  const mul = (A, B) => { const R = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) R[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return R; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [tx, ty, tz] = n.translation || [0, 0, 0], [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1];
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
            2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
            2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
  };
  const pos = [], idx = [];
  const visit = (ni, parent) => {
    const n = json.nodes[ni]; const M = mul(parent, local(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const P = acc(p.attributes.POSITION); const base = pos.length / 3;
      for (let k = 0; k < P.length; k += 3) {
        const x = P[k], y = P[k + 1], z = P[k + 2];
        pos.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
      }
      const I = p.indices !== undefined ? acc(p.indices) : Float64Array.from({ length: P.length / 3 }, (_, i) => i);
      for (let k = 0; k < I.length; k++) idx.push(base + I[k]);
    }
    for (const c of n.children || []) visit(c, M);
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  for (const r of scene ? scene.nodes : json.nodes.map((_, i) => i)) visit(r, I4);
  // glTF is metres, Y-up → mm, Z-up (rotation about X)
  const out = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 3) { out[k] = pos[k] * 1000; out[k + 1] = -pos[k + 2] * 1000; out[k + 2] = pos[k + 1] * 1000; }
  const q = json.extensionsUsed?.includes('KHR_mesh_quantization') ? ', quantized — expect collapsed triangles' : '';
  return { ...weld(out, Uint32Array.from(idx)), unit: 'mm', upAxis: 'z', note: 'GLB (m, Y-up → mm, Z-up)' + q };
}

export function parseAny(name, buf) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stl') return parseSTL(buf);
  if (ext === '3mf') return parse3MF(buf);
  if (ext === 'glb') return parseGLB(buf);
  throw new Error('Unsupported file type: .' + ext);
}
