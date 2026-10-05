// Writers: binary STL, 3MF, and a zip of a whole tile set. Pure JS + fflate.
import { zipSync, strToU8 } from 'fflate';

export function writeSTL(mesh, name = 'STL Splitter by Digimax') {
  const { positions: p, indices: t } = mesh;
  const n = t.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(strToU8(name.slice(0, 79)));
  dv.setUint32(80, n, true);
  for (let i = 0, o = 84; i < n; i++, o += 50) {
    const a = 3 * t[3 * i], b = 3 * t[3 * i + 1], c = 3 * t[3 * i + 2];
    const ax = p[b] - p[a], ay = p[b + 1] - p[a + 1], az = p[b + 2] - p[a + 2];
    const bx = p[c] - p[a], by = p[c + 1] - p[a + 1], bz = p[c + 2] - p[a + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (const [k, v] of [[a, 12], [b, 24], [c, 36]])
      for (let m = 0; m < 3; m++) dv.setFloat32(o + v + 4 * m, p[k + m], true);
    dv.setUint16(o + 48, 0, true);
  }
  return new Uint8Array(buf);
}

export function write3MF(mesh, name = 'tile') {
  const { positions: p, indices: t } = mesh;
  let v = '';
  for (let i = 0; i < p.length; i += 3) v += `<vertex x="${p[i]}" y="${p[i + 1]}" z="${p[i + 2]}"/>`;
  let f = '';
  for (let i = 0; i < t.length; i += 3) f += `<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">STL Splitter by Digimax</metadata>
<resources><object id="1" name="${name}" type="model"><mesh><vertices>${v}</vertices><triangles>${f}</triangles></mesh></object></resources>
<build><item objectid="1"/></build></model>`;
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    '3D/3dmodel.model': strToU8(model)
  };
  return zipSync(files, { level: 6 });
}

export function layoutReadme(result, opts, sourceName) {
  const { plan, tiles } = result;
  const grid = [];
  for (let j = plan.ny; j >= 1; j--) grid.push(Array.from({ length: plan.nx }, (_, i) => {
    const t = tiles.find(t => t.row === j && t.col === i + 1); return (t ? `r${j}c${i + 1}` : '  --  ').padEnd(7);
  }).join(''));
  const rows = tiles.map(t => `${t.name.padEnd(12)} ${t.bounds.size.map(v => v.toFixed(1).padStart(6)).join(' x ')} mm  ${(t.volume / 1000).toFixed(1).padStart(8)} cm3  ${t.audit.ok ? 'closed' : 'FAIL'}  ${t.fitsBed ? 'fits' : 'TOO BIG'}`);
  const size = [Math.max(...tiles.map(t => t.bounds.origin[0] + t.bounds.size[0])) - Math.min(...tiles.map(t => t.bounds.origin[0])),
                Math.max(...tiles.map(t => t.bounds.origin[1] + t.bounds.size[1])) - Math.min(...tiles.map(t => t.bounds.origin[1])),
                Math.max(...tiles.map(t => t.bounds.size[2]))];
  const seams = (plan.nx - 1) * plan.ny + (plan.ny - 1) * plan.nx;
  return `STL Splitter by Digimax — assembly sheet
Source: ${sourceName}
Assembles to: ${size.map(v => v.toFixed(1)).join(' x ')} mm (${plan.ny} rows x ${plan.nx} columns, ${tiles.length} tiles, ${seams} glued seams)
Material: ${(result.tileVolume / 1000).toFixed(1)} cm3 total, ~${(result.tileVolume / 1000 * 1.24 / 1000).toFixed(1)} kg if printed solid in PLA
Tallest tile: ${tiles.reduce((a, t) => t.bounds.size[2] > a.bounds.size[2] ? t : a).name} at ${size[2].toFixed(1)} mm
Bed: ${opts.bed.join(' x ')} mm, clearance ${opts.margin} mm
Grid: ${plan.nx} x ${plan.ny} tiles of up to ${plan.tile[0].toFixed(1)} x ${plan.tile[1].toFixed(1)} mm
Dowels: ${opts.dowel ? `${result.holes} holes, dia ${2 * opts.dowel.radius} x ${opts.dowel.depth} mm deep each side, ${opts.dowel.z} mm above base` : 'none'}

Each file is placed at its own origin with its base on z=0. Print flat, no rotation.
Name: tile_r<row>_c<col>  row = Y from front (r1 = -Y edge), col = X from left (c1 = -X edge).

Layout seen from above (+Y up). Glue row by row, starting from r1 (front edge), c1 (left):
${grid.join('\n')}

${'tile'.padEnd(12)} ${'X'.padStart(6)}   ${'Y'.padStart(6)}   ${'Z'.padStart(6)} mm  ${'volume'.padStart(8)}\n${rows.join('\n')}

Sum of tile volumes ${(result.tileVolume / 1000).toFixed(1)} cm3, source ${(result.sourceVolume / 1000).toFixed(1)} cm3.
Every tile was audited after cutting: every edge shared by exactly two triangles, one shell.
Load the tiles directly in the slicer. Do not run them through another splitter.
`;
}

export function zipTiles(result, opts, sourceName, { stl = true, threeMF = true } = {}) {
  const files = { 'README.txt': strToU8(layoutReadme(result, opts, sourceName)) };
  for (const t of result.tiles) {
    if (stl) files[`${t.name}.stl`] = writeSTL(t.mesh, t.name);
    if (threeMF) files[`${t.name}.3mf`] = write3MF(t.mesh, t.name);
  }
  return zipSync(files, { level: 0 }); // tiles are already compact / 3mf already deflated
}
