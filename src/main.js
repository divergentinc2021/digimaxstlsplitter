import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ---------- three.js view ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches ? document.documentElement.dataset.theme !== 'light' : document.documentElement.dataset.theme === 'dark';
const theme = () => isDark() ? { bg: 0x0f172a, bed: 0x475569, plate: 0x1e293b, label: '#94a3b8', model: 0xcbd5e1 } : { bg: 0xe2e8f0, bed: 0x64748b, plate: 0xf8fafc, label: '#334155', model: 0xb8c2cc };
function applyTheme() { scene.background = new THREE.Color(theme().bg); if (model) redraw(); }
$('theme').onclick = () => { const next = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('dm-theme', next); } catch {} applyTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
camera.up.set(0, 0, 1); // must precede OrbitControls: it snapshots camera.up in its constructor
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.zoomToCursor = true; controls.screenSpacePanning = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(1, -1, 2); scene.add(sun);
const group = new THREE.Group(); scene.add(group);
let bedBox = null;
let plateView = false;
const plateGroup = new THREE.Group(); scene.add(plateGroup);
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
}
// render loop is started at the end of the module (after every const it touches exists)

function clearView() { group.clear(); plateGroup.clear(); }
function textSprite(txt, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
  x.font = 'bold 40px system-ui, sans-serif'; x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 128, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  return sp;
}
/** Multi-printer sim: every tile centred on its own bed, beds laid out in a grid like a farm of printers. */
function bedGrid(b, px, py, color) {
  const minor = Math.max(1, +$('gridMinor').value || 10), major = Math.max(minor, +$('gridMajor').value || 50);
  const pts = [], big = [];
  const isMajor = (v) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
  for (let x = 0; x <= b[0] + 1e-6; x += minor) (isMajor(x) ? big : pts).push(px + x, py, 0, px + x, py + b[1], 0);
  for (let y = 0; y <= b[1] + 1e-6; y += minor) (isMajor(y) ? big : pts).push(px, py + y, 0, px + b[0], py + y, 0);
  const g = new THREE.Group();
  const mk = (arr, op) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })); };
  g.add(mk(pts, .18)); g.add(mk(big, .55));
  return g;
}
/** Gantry + carriage + nozzle for one plate. Group origin = plate origin; carriage moves in plate coords. */
function printHead(b, px, py) {
  const g = new THREE.Group();
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(b[0] + 20, 8, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: .6 }));
  gantry.position.set(b[0] / 2, 0, 14); g.add(gantry);
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(22, 22, 18), new THREE.MeshStandardMaterial({ color: isDark() ? 0xe2e8f0 : 0x1e293b, roughness: .5 }));
  carriage.position.set(0, 0, 10); g.add(carriage);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 12), new THREE.MeshStandardMaterial({ color: 0xb45309, metalness: .6, roughness: .3 }));
  nozzle.rotation.x = Math.PI; nozzle.position.set(0, 0, -11); carriage.add(nozzle);
  g.userData = { gantry, carriage };
  g.position.set(px, py, 0); g.visible = false;
  plateGroup.add(g);
  return g;
}
// ---------- print simulation (layers reveal bottom-up, head sweeps each layer) ----------
const sim = { targets: [], playing: false, layer: 0, layers: 0, maxH: 0, lh: 0.2, frac: 0, t0: 0 };
function simSetup() {
  sim.lh = Math.max(0.05, +$('layerH').value || 0.2);
  sim.maxH = sim.targets.length ? Math.max(...sim.targets.map(t => t.tile.bounds.size[2])) : 0;
  sim.layers = Math.ceil(sim.maxH / sim.lh); sim.layer = 0; sim.frac = 0;
  simApply();
}
function simApply() {
  const z = sim.layer * sim.lh, active = sim.playing || sim.layer > 0;
  const b = bed();
  for (const { mesh, tile, head } of sim.targets) {
    const h = tile.bounds.size[2], done = z >= h;
    const planes = active && !done ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), z)] : [];
    mesh.material.clippingPlanes = planes;
    const w = mesh.getObjectByName('wire'); if (w) w.material.clippingPlanes = planes;
    mesh.visible = !active || sim.layer > 0;
    head.visible = active && !done;
    if (head.visible) {
      const s = tile.bounds.size, ox = (b[0] - s[0]) / 2, oy = (b[1] - s[1]) / 2;
      const rows = 6, r = Math.min(rows - 1, Math.floor(sim.frac * rows)), u = (sim.frac * rows) % 1;
      const x = ox + s[0] * (r % 2 ? 1 - u : u), y = oy + s[1] * (r + 0.5) / rows;
      head.position.z = z + 1;
      head.userData.gantry.position.y = y;
      head.userData.carriage.position.set(x, y, 10);
    }
  }
  const z0 = Math.min(z, sim.maxH);
  $('simStat').innerHTML = statHtml([
    ['Layer', `${Math.min(sim.layer, sim.layers)} / ${sim.layers}`],
    ['Height', `${z0.toFixed(2)} / ${sim.maxH.toFixed(2)} mm`],
    ['Plates still printing', sim.targets.filter(t => z < t.tile.bounds.size[2]).length + ' / ' + sim.targets.length]
  ]);
}
function simTick(now) {
  if (!sim.playing) return;
  const perLayer = 1000 / Math.max(0.1, +$('simSpeed').value || 4);
  const elapsed = now - sim.t0;
  sim.layer = Math.floor(elapsed / perLayer); sim.frac = (elapsed % perLayer) / perLayer;
  if (sim.layer >= sim.layers) { sim.layer = sim.layers; sim.frac = 0; sim.playing = false; $('simPlay').textContent = '▶ Print again'; }
  simApply();
}
$('simPlay').onclick = () => {
  if (!result) return;
  if (!plateView) { plateView = true; $('plates').textContent = 'Model view'; redraw(); }
  if (sim.playing) { sim.playing = false; $('simPlay').textContent = '▶ Resume'; simApply(); return; }
  if (sim.layers === 0 || sim.layer >= sim.layers) simSetup();
  const perLayer = 1000 / Math.max(0.1, +$('simSpeed').value || 4);
  sim.t0 = performance.now() - (sim.layer + sim.frac) * perLayer;
  sim.playing = true; $('simPlay').textContent = '⏸ Pause';
};
$('simReset').onclick = () => { sim.playing = false; $('simPlay').textContent = '▶ Print'; simSetup(); };
for (const id of ['gridMinor', 'gridMajor']) $(id).oninput = () => plateView && result && drawPlates();
function drawPlates() {
  clearView(); sim.targets = []; sim.playing = false; sim.layer = 0; sim.layers = 0; sim.frac = 0; $('simPlay').textContent = '▶ Print'; $('simStat').innerHTML = '';
  const b = bed(), t = theme();
  const n = result.tiles.length, cols = Math.ceil(Math.sqrt(n)), gap = Math.max(b[0], b[1]) * 0.25;
  const plateGeo = new THREE.PlaneGeometry(b[0], b[1]), edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(b[0], b[1], b[2]));
  result.tiles.forEach((tile, i) => {
    const px = (i % cols) * (b[0] + gap), py = -Math.floor(i / cols) * (b[1] + gap);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: t.plate, roughness: 1 }));
    plate.position.set(px + b[0] / 2, py + b[1] / 2, -0.5); plateGroup.add(plate);
    plateGroup.add(bedGrid(b, px, py, t.bed));
    const box = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: t.bed })); box.position.set(px + b[0] / 2, py + b[1] / 2, b[2] / 2); plateGroup.add(box);
    const s = tile.bounds.size;
    const mesh = addMesh(tile.positions, tile.indices, filamentColor(i), [px + (b[0] - s[0]) / 2, py + (b[1] - s[1]) / 2, 0]);
    sim.targets.push({ mesh, tile, head: printHead(b, px, py) });
    const lab = textSprite(tile.name.replace('tile_', '').toUpperCase(), tile.audit.ok && tile.fitsBed ? t.label : '#ef4444');
    lab.position.set(px + b[0] / 2, py - 12, 2); lab.scale.set(b[0] * .5, b[0] * .125, 1); plateGroup.add(lab);
  });
  const rows = Math.ceil(n / cols);
  frame([cols * (b[0] + gap), rows * (b[1] + gap), b[2]]);
  controls.target.set(cols * (b[0] + gap) / 2, -rows * (b[1] + gap) / 2 + b[1], 0);
  camera.position.set(controls.target.x, controls.target.y - cols * b[1] * 1.6, cols * b[0] * 1.1);
}
function drawTiles() {
  clearView();
  const p = result.plan;
  sim.targets = []; sim.playing = false; sim.layers = 0; $('simStat').innerHTML = '';
  result.tiles.forEach((t, i) => addMesh(t.positions, t.indices, filamentColor(i), [t.bounds.origin[0], t.bounds.origin[1], t.bounds.origin[2]]));
  drawBed(model.bounds.size);
}
function redraw() {
  if (result) { if (plateView) drawPlates(); else drawTiles(); }
  else { clearView(); addMesh(model.positions, model.indices, theme().model); drawBed(model.bounds.size); }
}
$('plates').onclick = () => { plateView = !plateView; $('plates').textContent = plateView ? 'Model view' : 'Plate view'; redraw(); if (!plateView) frame(model.bounds.size); };
function addMesh(positions, indices, color, offset = [0, 0, 0]) {
  const g0 = new THREE.BufferGeometry();
  g0.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g0.setIndex(new THREE.BufferAttribute(indices, 1));
  // split normals at creases sharper than 35° so cut faces and the rim chamfer stay crisp,
  // while the terrain itself still shades smoothly (plain computeVertexNormals bleeds across the edge)
  const g = toCreasedNormals(g0, THREE.MathUtils.degToRad(35));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: .75, metalness: 0, side: THREE.DoubleSide }));
  m.position.set(...offset);
  const wire = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ wireframe: true, color: isDark() ? 0x0f172a : 0x1e293b, transparent: true, opacity: .35, depthTest: true }));
  wire.visible = $('wire').checked; wire.name = 'wire';
  wire.material.polygonOffset = true; wire.material.polygonOffsetFactor = -1;
  m.add(wire);
  group.add(m);
  return m;
}
$('wire').onchange = () => group.children.forEach(m => { const w = m.getObjectByName('wire'); if (w) w.visible = $('wire').checked; });
// ---------- filament colour ----------
function filamentColor(i) {
  const v = $('filament').value;
  if (v === 'per-tile') return palette[i % palette.length];
  if (v === 'custom') return new THREE.Color($('filamentColor').value).getHex();
  return new THREE.Color(v).getHex();
}
function applyFilament() {
  if (!result) return;
  group.children.forEach((m, i) => { if (m.isMesh) m.material.color.setHex(filamentColor(i)); });
}
$('filament').onchange = () => { $('customRow').hidden = $('filament').value !== 'custom'; applyFilament(); };
$('filamentColor').oninput = applyFilament;
function frame(size) {
  const r = Math.hypot(...size) * 0.75;
  camera.position.set(size[0] / 2 + r * 0.9, size[1] / 2 - r * 1.1, size[2] + r * 0.8);
  controls.target.set(size[0] / 2, size[1] / 2, size[2] / 2);
  camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
}
// ---------- state ----------
let model = null;   // loaded summary from worker
let result = null;  // tiled summary
const bed = () => [+$('bx').value, +$('by').value, +$('bz').value];
const fmt = (v, d = 1) => (+v).toFixed(d);
const msg = (t, cls = '') => { $('msg').textContent = t; $('msg').className = cls; };
const statHtml = (rows) => rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');

// ---------- load ----------
async function load(file) {
  msg('Reading ' + file.name + ' …');
  $('run').disabled = true; $('srcStl').disabled = $('src3mf').disabled = true;
  const buffer = await file.arrayBuffer();
  worker.postMessage({ type: 'load', name: file.name, buffer, scale: +$('scale').value, upAxis: $('up').value }, [buffer]);
}
window.dmLoad = load; // used by tests
$('file').onchange = (e) => e.target.files[0] && load(e.target.files[0]);
$('drop').onclick = () => $('file').click();
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', (e) => e.dataTransfer.files[0] && load(e.dataTransfer.files[0]));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });

// ---------- tile ----------
$('run').onclick = () => {
  const opts = {
    bed: bed(), margin: +$('margin').value,
    tiles: ($('nx').value || $('ny').value) ? [+$('nx').value || null, +$('ny').value || null] : null,
    dowel: $('dowel').checked ? { radius: +$('dDia').value / 2, depth: +$('dDepth').value, z: +$('dZ').value, pitch: +$('dPitch').value } : null
  };
  $('run').disabled = true; $('dl').disabled = true; $('resultBox').hidden = true;
  $('progress').firstElementChild.style.width = '0';
  msg('Cutting … (big models take a while, the page stays responsive)');
  worker.postMessage({ type: 'tile', opts });
};
$('dl').onclick = () => { $('dl').disabled = true; worker.postMessage({ type: 'zip', formats: { stl: $('fStl').checked, threeMF: $('f3mf').checked } }); };
$('srcStl').onclick = () => worker.postMessage({ type: 'exportSource', format: 'stl' });
$('src3mf').onclick = () => worker.postMessage({ type: 'exportSource', format: '3mf' });

function download(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const palette = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0xfb923c, 0x2dd4bf, 0xf87171, 0xc084fc, 0xa3e635];

// ---------- worker replies ----------
worker.onmessage = ({ data: d }) => {
  if (d.type === 'error') { msg('✖ ' + d.message, 'bad'); $('run').disabled = !model; return; }
  if (d.type === 'progress') { $('progress').firstElementChild.style.width = (d.value * 100) + '%'; return; }
  if (d.type === 'loaded') {
    model = d; result = null;
    const a = d.audit, s = d.bounds.size;
    const tri = a.triangles.toLocaleString();
    $('modelStat').innerHTML = statHtml([
      ['File', `${d.name} <span class="hint">(${d.note})</span>`],
      ['Size', `${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} mm`],
      ['Volume', `${fmt(d.volume / 1000)} cm³`],
      ['Triangles', tri + (d.dropped ? ` <span class="warn">(${d.dropped} zero-area dropped)</span>` : '')],
      ['Topology', a.ok ? `<span class="ok">closed — every edge shared by two faces, ${a.shells} shell${a.shells > 1 ? 's' : ''}</span>`
                        : `<span class="bad">${a.open} open edge${a.open === 1 ? '' : 's'}, ${a.nonManifold} non-manifold, ${a.shells} shells</span>`]
    ]);
    plateView = false; $('plates').textContent = 'Plate view';
    redraw(); frame(s);
    $('run').disabled = !a.ok;
    $('srcStl').disabled = $('src3mf').disabled = !a.ok;
    $('resultBox').hidden = true;
    const b = bed();
    const fitsWhole = s[0] <= b[0] && s[1] <= b[1] && s[2] <= b[2];
    msg(a.ok ? (fitsWhole ? 'Model already fits the bed — splitting is optional.' : 'Model is closed. Ready to split.')
             : 'This mesh is not a closed solid. Cutting it would only make more open edges — repair it first (e.g. in your CAD tool, or by remeshing).', a.ok ? 'ok' : 'bad');
    return;
  }
  if (d.type === 'tiled') {
    result = d;
    clearView();
    const p = d.plan;
    d.tiles.forEach((t, i) => {
      const ox = model.bounds.min[0] + p.tile[0] * (t.col - 1), oy = model.bounds.min[1] + p.tile[1] * (t.row - 1);
      addMesh(t.positions, t.indices, palette[i % palette.length], [ox + (t.bounds.origin[0] - ox), oy + (t.bounds.origin[1] - oy), t.bounds.origin[2]]);
    });
    const bad = d.tiles.filter(t => !t.audit.ok), big = d.tiles.filter(t => !t.fitsBed);
    const volOk = Math.abs(d.tileVolume - d.sourceVolume) < 1e-3 * d.sourceVolume;
    $('resultStat').innerHTML = statHtml([
      ['Grid', `${p.nx} × ${p.ny} → ${d.tiles.length} tiles of ${fmt(p.tile[0])} × ${fmt(p.tile[1])} mm`],
      ['Dowel holes', d.holes],
      ['Watertight', bad.length ? `<span class="bad">${bad.length} tile(s) FAILED audit</span>` : `<span class="ok">all ${d.tiles.length} tiles closed</span>`],
      ['Fits bed', big.length ? `<span class="bad">${big.length} tile(s) too big</span>` : '<span class="ok">yes</span>'],
      ['Volume check', `${fmt(d.tileVolume / 1000)} / ${fmt(d.sourceVolume / 1000)} cm³ ${volOk ? '<span class="ok">✓</span>' : '<span class="bad">✖ mismatch</span>'}`]
    ]);
    $('tiles').innerHTML = '<tr><th>Tile</th><th>Size mm</th><th>Tris</th><th>Audit</th></tr>' + d.tiles.map(t =>
      `<tr><td>${t.name}</td><td>${t.bounds.size.map(v => fmt(v)).join(' × ')}</td><td>${t.audit.triangles.toLocaleString()}</td><td class="${t.audit.ok && t.fitsBed ? 'ok' : 'bad'}">${t.audit.ok ? (t.fitsBed ? 'closed' : 'too big') : `${t.audit.open} open / ${t.audit.nonManifold} nm`}</td></tr>`).join('');
    $('resultBox').hidden = false;
    $('simPlay').disabled = $('simReset').disabled = false;
    $('dl').disabled = !d.allOk;
    $('run').disabled = false;
    msg(d.allOk ? `Done: ${d.tiles.length} tiles, all closed, volumes match.` : 'Some tiles failed — download is blocked. Change the grid or margin and try again.', d.allOk ? 'ok' : 'bad');
    return;
  }
  if (d.type === 'zip') {
    const base = model.name.replace(/\.[^.]+$/, '');
    if (d.single) download(d.bytes, `${base}_repaired.${d.single}`, 'application/octet-stream');
    else { download(d.bytes, `${base}_tiles_${result.plan.nx}x${result.plan.ny}.zip`, 'application/zip'); $('dl').disabled = false; }
  }
};

function drawBed(size) {
  if (bedBox) scene.remove(bedBox);
  if (plateView) return;
  const b = bed();
  const g = new THREE.BoxGeometry(b[0], b[1], b[2]);
  bedBox = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: theme().bed }));
  bedBox.position.set(b[0] / 2, b[1] / 2, b[2] / 2);
  bedBox.position.x += size[0] + 40; // park the bed outline beside the model for scale
  scene.add(bedBox);
}
for (const id of ['bx', 'by', 'bz']) $(id).oninput = () => model && (plateView ? drawPlates() : drawBed(model.bounds.size));
applyTheme();
(function loop(now) { resize(); controls.update(); simTick(now || 0); renderer.render(scene, camera); requestAnimationFrame(loop); })();
