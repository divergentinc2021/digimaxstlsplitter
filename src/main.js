import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { planGrid } from './engine.js';
import printersJson from './printers.json';

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const PLA_G_PER_CM3 = 1.24;

// ---------- persisted settings (bed, margin, dowels, view) ----------
const SETTING_IDS = ['bedPreset', 'bx', 'by', 'bz', 'margin', 'dowel', 'dDia', 'dDepth', 'dZ', 'dPitch', 'filament', 'filamentColor', 'wire', 'gridMinor', 'gridMajor', 'layerH', 'simSpeed', 'simWalls', 'simLine', 'simInfill', 'spdPerim', 'spdInfill', 'solidLayers', 'maxFlow', 'layerOverhead', 'hollow', 'hWall', 'hOpen', 'scale', 'up'];
function saveSettings() {
  try {
    const o = {}; for (const id of SETTING_IDS) { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.value; }
    localStorage.setItem('dm-settings', JSON.stringify(o));
  } catch {}
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('dm-settings') || '{}');
    for (const id of SETTING_IDS) if (id in o) { const el = $(id); if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id]; }
  } catch {}
}
const PRINTERS = printersJson.printers;
for (const p of PRINTERS) { const o = document.createElement('option'); o.value = p.id; o.textContent = `${p.name} · ${p.bed.join(' × ')}`; $('bedPreset').insertBefore(o, $('bedPreset').lastElementChild); }
loadSettings();
for (const id of SETTING_IDS) $(id).addEventListener('change', saveSettings);

// ---------- three.js view ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches ? document.documentElement.dataset.theme !== 'light' : document.documentElement.dataset.theme === 'dark';
const theme = () => isDark()
  ? { bg: 0x0b1220, bed: 0x5b6b80, plate: 0x151e2e, label: '#cbd5e1', model: 0xf2f2ee, wire: 0x0b1220, carriage: 0xe2e8f0 }
  : { bg: 0xcfd8e3, bed: 0x64748b, plate: 0xf8fafc, label: '#1e293b', model: 0xf4f4f0, wire: 0x1e293b, carriage: 0x1e293b };
const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
camera.up.set(0, 0, 1); // must precede OrbitControls: it snapshots camera.up in its constructor
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.zoomToCursor = true; controls.screenSpacePanning = true;
// Relief needs raking light: a low key from the front-left, a cooler fill from the opposite side, soft sky/ground ambient.
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 0.55));
const key = new THREE.DirectionalLight(0xfff4e6, 1.6); key.position.set(-1.2, -1.6, 0.9); scene.add(key);
const fill = new THREE.DirectionalLight(0xdbe7ff, 0.7); fill.position.set(1.4, 0.8, 0.6); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.35); rim.position.set(0.3, 1.5, 2.5); scene.add(rim);
const group = new THREE.Group(); scene.add(group);         // tile / model meshes
const plateGroup = new THREE.Group(); scene.add(plateGroup); // beds, grids, heads, labels
let bedBox = null, plateView = false;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
}
function frame(size, center = [size[0] / 2, size[1] / 2, size[2] / 2]) {
  const r = Math.hypot(...size) * 0.75;
  camera.position.set(center[0] + r * 0.9, center[1] - r * 1.1, center[2] + r * 0.8);
  controls.target.set(...center);
  camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
}
function clearView() { group.clear(); plateGroup.clear(); pathGroup.clear(); sim.pathZ = -1; sim.paths = {}; }

function addMesh(positions, indices, color, offset = [0, 0, 0]) {
  const g0 = new THREE.BufferGeometry();
  g0.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g0.setIndex(new THREE.BufferAttribute(indices, 1));
  // split normals at creases over 35° so cut faces and the rim chamfer stay crisp while terrain shades smoothly
  const g = toCreasedNormals(g0, THREE.MathUtils.degToRad(35));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: .62, metalness: 0, side: THREE.DoubleSide }));
  m.position.set(...offset);
  const wire = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ wireframe: true, color: theme().wire, transparent: true, opacity: .35, polygonOffset: true, polygonOffsetFactor: -1 }));
  wire.visible = $('wire').checked; wire.name = 'wire';
  m.add(wire);
  group.add(m);
  return m;
}
$('wire').onchange = () => group.children.forEach(m => { const w = m.getObjectByName('wire'); if (w) w.visible = $('wire').checked; });

function textSprite(txt, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
  x.font = '600 36px system-ui, sans-serif'; x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 128, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, sizeAttenuation: false }));
  sp.scale.set(0.14, 0.035, 1); // screen-relative: readable at any zoom
  return sp;
}

// ---------- state ----------
let model = null;   // loaded summary from worker
let result = null;  // tiled summary
let selected = null; // highlighted tile name
const bed = () => [+$('bx').value, +$('by').value, +$('bz').value];
const marginMm = () => +$('margin').value || 0;
const fmt = (v, d = 1) => (+v).toFixed(d);
const msg = (t, cls = '') => { $('msg').textContent = t; $('msg').className = cls; };
const statHtml = (rows) => rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
const label = (name) => name.replace('tile_r', 'R').replace('_c', '·C');
const palette = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0xfb923c, 0x2dd4bf, 0xf87171, 0xc084fc, 0xa3e635];
function setStep(n) {
  for (const i of [1, 2, 3]) { const s = $('s' + i); s.classList.toggle('active', i === n); s.classList.toggle('done', i < n); }
}

// ---------- filament ----------
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
$('customRow').hidden = $('filament').value !== 'custom';

// ---------- theme (materials only — never rebuilds, so a running sim survives) ----------
function applyTheme() {
  const t = theme();
  scene.background = new THREE.Color(t.bg);
  group.children.forEach((m) => {
    if (!m.isMesh) return;
    if (!result) m.material.color.setHex(t.model);
    const w = m.getObjectByName('wire'); if (w) w.material.color.setHex(t.wire);
  });
  plateGroup.traverse(o => {
    if (o.userData.kind === 'bedline') o.material.color.setHex(t.bed);
    if (o.userData.kind === 'plate') o.material.color.setHex(t.plate);
    if (o.userData.kind === 'carriage') o.material.color.setHex(t.carriage);
    if (o.isSprite && o.userData.text) { const n = textSprite(o.userData.text, o.userData.bad ? '#ef4444' : t.label); o.material.map.dispose(); o.material.map = n.material.map; o.material.needsUpdate = true; }
  });
  if (bedBox) bedBox.material.color.setHex(t.bed);
}
$('theme').onclick = () => { const next = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('dm-theme', next); } catch {} applyTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- bed presets + live plan ----------
function applyPrinter(p) {
  $('bx').value = p.bed[0]; $('by').value = p.bed[1]; $('bz').value = p.bed[2];
  $('spdPerim').value = p.wall; $('spdInfill').value = p.infill; $('maxFlow').value = p.maxFlow; $('layerOverhead').value = p.layerOverhead;
  $('presetNote').textContent = `${p.name}: walls ${p.wall} / infill ${p.infill} mm/s, flow cap ${p.maxFlow} mm³/s. Source: ${p.source}. Edit any value to go custom.`;
}
$('bedPreset').onchange = () => {
  const p = PRINTERS.find(x => x.id === $('bedPreset').value);
  if (!p) { $('presetNote').textContent = 'Custom: set the bed and the print speeds yourself.'; saveSettings(); return; }
  applyPrinter(p); saveSettings(); onBedChange(); requestEstimate();
};
/** Which profile matches every current value? None → Custom. */
function syncPresetFromInputs() {
  const b = bed();
  const matches = (x) => x.bed.join() === b.join() && +$('spdPerim').value === x.wall && +$('spdInfill').value === x.infill && +$('maxFlow').value === x.maxFlow;
  const cur = PRINTERS.find(x => x.id === $('bedPreset').value);
  const p = (cur && matches(cur)) ? cur : PRINTERS.find(matches); // several printers share a profile: keep the one chosen
  $('bedPreset').value = p ? p.id : 'custom';
  $('presetNote').textContent = p ? `${p.name}: walls ${p.wall} / infill ${p.infill} mm/s, flow cap ${p.maxFlow} mm³/s. Source: ${p.source}.` : 'Custom: bed and print speeds as entered below and under View & print simulation.';
}
function tilesOverride() { return ($('nx').value || $('ny').value) ? [+$('nx').value || null, +$('ny').value || null] : null; }
function sizeFromInputs() { return [+$('sx').value, +$('sy').value, +$('sz').value]; }
/** The plan line: computed from the pure planGrid() on every keystroke, before anything is cut. */
function updatePlan() {
  const el = $('plan');
  if (!model) { el.textContent = 'Load a model to see the tile plan.'; el.className = 'plan'; return; }
  const size = model.scalePending ? sizeFromInputs() : model.bounds.size;
  const b = bed(), m = marginMm(), p = planGrid(size, b, m, tilesOverride());
  const seams = (p.nx - 1) * p.ny + (p.ny - 1) * p.nx;
  const usable = [b[0] - 2 * m, b[1] - 2 * m];
  const tooBig = p.tile[0] > usable[0] + 1e-6 || p.tile[1] > usable[1] + 1e-6;
  const n = p.nx * p.ny;
  const bits = [`<b>${p.nx} × ${p.ny} = ${n} tile${n === 1 ? '' : 's'}</b> of ${fmt(p.tile[0])} × ${fmt(p.tile[1])} mm`, `${seams} glued seam${seams === 1 ? '' : 's'}`];
  let bad = false;
  if (n === 1 && p.fitsHeight && !tooBig) bits.splice(0, 2, '<b>Fits the bed whole</b> — splitting is optional');
  if (!p.fitsHeight) { bits.push(`<b>${fmt(size[2])} mm tall &gt; bed Z ${b[2]}</b> — scale down or use a taller printer`); bad = true; }
  if (tooBig) { bits.push(`<b>tiles exceed the usable ${fmt(usable[0])} × ${fmt(usable[1])} mm</b> — raise the tile count`); bad = true; }
  el.innerHTML = bits.join(' · '); el.className = 'plan' + (bad ? ' bad' : '');
  $('run').disabled = !model.audit.ok || model.scalePending;
}
function onBedChange() { syncPresetFromInputs(); updatePlan(); if (model) { if (plateView && result) drawPlates(); else drawBed(model.bounds.size); } }
for (const id of ['bx', 'by', 'bz', 'margin', 'nx', 'ny']) $(id).addEventListener('input', onBedChange);
if (!localStorage.getItem('dm-settings')) { const p = PRINTERS[0]; applyPrinter(p); $('bedPreset').value = p.id; }
syncPresetFromInputs();

// ---------- scale (target overall size) ----------
function setSizeInputs(size) { $('sx').value = fmt(size[0], 1); $('sy').value = fmt(size[1], 1); $('sz').value = fmt(size[2], 2); }
function onSizeInput(axis) {
  if (!model) return;
  const base = model.asModelled; // size as loaded, before any scale
  if ($('lockAspect').checked) {
    const k = +$(['sx', 'sy', 'sz'][axis]).value / base[axis];
    if (k > 0) ['sx', 'sy', 'sz'].forEach((id, i) => { if (i !== axis) $(id).value = fmt(base[i] * k, i === 2 ? 2 : 1); });
  }
  model.scalePending = true; $('applyScale').disabled = false; $('resetScale').disabled = false;
  updatePlan();
  const k = sizeFromInputs().map((v, i) => v / base[i]);
  $('scaleNote').textContent = `Pending: ${k.map(v => fmt(v * 100, 1)).join(' / ')} % of modelled size. Apply to re-audit at the new size.`;
}
['sx', 'sy', 'sz'].forEach((id, i) => $(id).addEventListener('input', () => onSizeInput(i)));
$('applyScale').onclick = () => {
  if (!model) return;
  const k = sizeFromInputs().map((v, i) => v / model.asModelled[i]);
  if (k.some(v => !(v > 0))) return;
  msg('Scaling …'); $('applyScale').disabled = true;
  worker.postMessage({ type: 'scale', factor: k });
};
$('resetScale').onclick = () => { if (!model) return; worker.postMessage({ type: 'scale', factor: [1, 1, 1] }); };
// ---------- rotate (relative, about world axes) ----------
function rotate(sign) {
  if (!model) return;
  const deg = sign * (Math.abs(+$('rotDeg').value) || 90);
  msg(`Rotating ${deg > 0 ? '+' : ''}${deg}° about ${$('rotAxis').value.toUpperCase()} …`);
  worker.postMessage({ type: 'rotate', axis: $('rotAxis').value, deg });
}
$('rotPlus').onclick = () => rotate(1);
$('rotMinus').onclick = () => rotate(-1);
$('rotReset').onclick = () => { if (!model) return; worker.postMessage({ type: 'rotate', reset: true }); };

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

// ---------- split / export ----------
$('run').onclick = () => {
  const opts = {
    bed: bed(), margin: marginMm(), tiles: tilesOverride(),
    dowel: $('dowel').checked ? { radius: +$('dDia').value / 2, depth: +$('dDepth').value, z: +$('dZ').value, pitch: +$('dPitch').value } : null,
    hollow: $('hollow').checked ? { wall: Math.max(0.8, +$('hWall').value || 3), openBottom: $('hOpen').checked } : null
  };
  $('run').disabled = true; $('dl').disabled = true; $('resultBox').hidden = true;
  $('run').firstElementChild.style.transform = 'scaleX(0)';
  msg($('hollow').checked ? 'Cutting and hollowing … a few seconds per tile; the page stays responsive.' : 'Cutting … big models take a while; the page stays responsive.');
  worker.postMessage({ type: 'tile', opts });
};
const formatsPicked = () => $('fStl').checked || $('f3mf').checked;
$('dl').onclick = () => {
  if (!formatsPicked()) { msg('Tick STL or 3MF to include in the zip.', 'bad'); return; }
  $('dl').disabled = true; worker.postMessage({ type: 'zip', formats: { stl: $('fStl').checked, threeMF: $('f3mf').checked } });
};
for (const id of ['fStl', 'f3mf']) $(id).onchange = () => { if (result?.allOk) $('dl').disabled = !formatsPicked(); };
$('srcStl').onclick = () => worker.postMessage({ type: 'exportSource', format: 'stl' });
$('src3mf').onclick = () => worker.postMessage({ type: 'exportSource', format: '3mf' });
$('dowel').onchange = () => { $('dowelState').textContent = $('dowel').checked ? 'on' : 'off'; };
$('dowelState').textContent = $('dowel').checked ? 'on' : 'off';
const hollowState = () => { $('hollowState').textContent = $('hollow').checked ? `${$('hWall').value} mm shell` : 'solid'; };
for (const id of ['hollow', 'hWall']) for (const ev of ['input', 'change']) $(id).addEventListener(ev, hollowState);
hollowState();

function download(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- drawing ----------
function drawBed(size) {
  if (bedBox) scene.remove(bedBox);
  if (plateView) return;
  const b = bed();
  bedBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b[0], b[1], b[2])), new THREE.LineBasicMaterial({ color: theme().bed }));
  bedBox.position.set(size[0] + 40 + b[0] / 2, b[1] / 2, b[2] / 2); // parked beside the model, for scale
  scene.add(bedBox);
}
function bedGrid(b, px, py, color) {
  const minor = Math.max(1, +$('gridMinor').value || 10), major = Math.max(minor, +$('gridMajor').value || 50);
  const pts = [], big = [];
  const isMajor = (v) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
  for (let x = 0; x <= b[0] + 1e-6; x += minor) (isMajor(x) ? big : pts).push(px + x, py, 0, px + x, py + b[1], 0);
  for (let y = 0; y <= b[1] + 1e-6; y += minor) (isMajor(y) ? big : pts).push(px, py + y, 0, px + b[0], py + y, 0);
  const g = new THREE.Group();
  const mk = (arr, op) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })); l.userData.kind = 'bedline'; return l; };
  g.add(mk(pts, .18)); g.add(mk(big, .55));
  return g;
}
function printHead(b, px, py) {
  const t = theme(), g = new THREE.Group();
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(b[0] + 20, 8, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: .6 }));
  gantry.position.set(b[0] / 2, 0, 14); g.add(gantry);
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(22, 22, 18), new THREE.MeshStandardMaterial({ color: t.carriage, roughness: .5 }));
  carriage.userData.kind = 'carriage'; carriage.position.set(0, 0, 10); g.add(carriage);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 12), new THREE.MeshStandardMaterial({ color: 0xb45309, metalness: .6, roughness: .3 }));
  nozzle.rotation.x = Math.PI; nozzle.position.set(0, 0, -11); carriage.add(nozzle);
  g.userData = { gantry, carriage };
  g.position.set(px, py, 0); g.visible = false;
  plateGroup.add(g);
  return g;
}
/** Printer farm laid out AS the assembly map: plate (row, col) sits where tile (row, col) sits in the piece. */
function drawPlates() {
  const keep = sim.layers ? { ...sim } : null; // a bed/grid edit must not reset a running print
  clearView(); sim.targets = [];
  const b = bed(), t = theme(), p = result.plan, gap = Math.max(b[0], b[1]) * 0.25;
  const plateGeo = new THREE.PlaneGeometry(b[0], b[1]), edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(b[0], b[1], b[2]));
  result.tiles.forEach((tile, i) => {
    const px = (tile.col - 1) * (b[0] + gap), py = (tile.row - 1) * (b[1] + gap);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: t.plate, roughness: 1 }));
    plate.userData.kind = 'plate'; plate.position.set(px + b[0] / 2, py + b[1] / 2, -0.5); plateGroup.add(plate);
    plateGroup.add(bedGrid(b, px, py, t.bed));
    const box = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: t.bed })); box.userData.kind = 'bedline';
    box.position.set(px + b[0] / 2, py + b[1] / 2, b[2] / 2); plateGroup.add(box);
    const s = tile.bounds.size;
    const mesh = addMesh(tile.positions, tile.indices, filamentColor(i), [px + (b[0] - s[0]) / 2, py + (b[1] - s[1]) / 2, 0]);
    mesh.name = tile.name;
    const bad = !(tile.audit.ok && tile.fitsBed);
    const lab = textSprite(label(tile.name), bad ? '#ef4444' : t.label);
    lab.userData = { text: label(tile.name), bad }; lab.position.set(px + b[0] / 2, py - 10, 2); plateGroup.add(lab);
    sim.targets.push({ mesh, tile, head: printHead(b, px, py) });
  });
  const W = p.nx * (b[0] + gap) - gap, H = p.ny * (b[1] + gap) - gap;
  frame([W, H, b[2]], [W / 2, H / 2, 0]);
  camera.position.set(W / 2, -H * 0.9, Math.max(W, H) * 0.9);
  if (keep) { Object.assign(sim, { layer: keep.layer, frac: keep.frac, playing: keep.playing, t0: keep.t0, layers: keep.layers, lh: keep.lh, maxH: keep.maxH }); simApply(); }
  else $('simStat').innerHTML = '';
  highlight(selected);
}
function drawTiles() {
  clearView(); sim.targets = []; sim.playing = false; sim.layers = 0; $('simStat').innerHTML = ''; $('simPlay').textContent = 'Print';
  result.tiles.forEach((t, i) => { const m = addMesh(t.positions, t.indices, filamentColor(i), t.bounds.origin); m.name = t.name; });
  drawBed(model.bounds.size);
  highlight(selected);
}
function redraw() {
  if (result) { if (plateView) drawPlates(); else drawTiles(); }
  else { clearView(); addMesh(model.positions, model.indices, theme().model); drawBed(model.bounds.size); }
}
$('plates').onclick = () => { plateView = !plateView; $('plates').textContent = plateView ? 'Model view' : 'Plate view'; redraw(); if (!plateView) frame(model.bounds.size); };
for (const id of ['gridMinor', 'gridMajor']) $(id).oninput = () => plateView && result && drawPlates();

function highlight(name) {
  selected = name;
  group.children.forEach(m => { if (m.isMesh) { m.material.emissive.setHex(m.name === name ? 0x2563eb : 0x000000); m.material.emissiveIntensity = .45; } });
  document.querySelectorAll('#minimap button').forEach(b => b.classList.toggle('sel', b.dataset.name === name));
  document.querySelectorAll('#tiles tr').forEach(r => r.classList.toggle('sel', r.dataset.name === name));
}

// ---------- print simulation ----------
const sim = { targets: [], playing: false, layer: 0, layers: 0, maxH: 0, lh: 0.2, frac: 0, t0: 0, pathZ: -1, pending: 0, seq: 0, paths: {}, lastReq: 0 };
const pathGroup = new THREE.Group(); scene.add(pathGroup);
function simOpts() { return { walls: Math.max(1, +$('simWalls').value || 3), lineWidth: Math.max(0.1, +$('simLine').value || 0.4), infill: Math.min(1, Math.max(0, (+$('simInfill').value || 0) / 100)) }; }
// ---------- print estimate (sampled from real slices) ----------
let estimateBusy = false, estimateDirty = false, estimates = null;
const FILAMENT_MM2 = Math.PI * 1.75 * 1.75 / 4;
const hms = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
function requestEstimate() {
  if (!result) return;
  if (estimateBusy) { estimateDirty = true; return; }
  estimateBusy = true; estimateDirty = false;
  $('estimate').innerHTML = statHtml([['Print time', '<span class="hint" style="margin:0">estimating from slices …</span>']]);
  worker.postMessage({ type: 'estimate', opts: { ...simOpts(), layerHeight: Math.max(0.05, +$('layerH').value || 0.2), solidLayers: Math.max(0, +$('solidLayers').value || 0), perimeterSpeed: Math.max(5, +$('spdPerim').value || 45), infillSpeed: Math.max(5, +$('spdInfill').value || 80), maxFlow: Math.max(0, +$('maxFlow').value || 0), travelPerLayer: Math.max(0, +$('layerOverhead').value || 0) } });
}
function renderEstimate() {
  if (!estimates || !result) return;
  const per = result.tiles.map(t => ({ t, e: estimates[t.name] })).filter(x => x.e);
  const total = per.reduce((s, x) => s + x.e.seconds, 0), mm3 = per.reduce((s, x) => s + x.e.mm3, 0);
  const longest = per.reduce((a, x) => x.e.seconds > a.e.seconds ? x : a, per[0]);
  const g = mm3 / 1000 * PLA_G_PER_CM3, metres = mm3 / FILAMENT_MM2 / 1000;
  $('estimate').innerHTML = statHtml([
    ['Print time', `<b style="color:var(--fg)">${hms(total)}</b> machine time over ${per.length} plates · longest ${label(longest.t.name)} ${hms(longest.e.seconds)}`],
    ['In parallel', `${hms(longest.e.seconds)} on ${per.length} printers · ${hms(total / 2)} on 2 · ${hms(total / 4)} on 4`],
    ['At', `${fmt(longest.e.wallSpeedUsed, 0)} / ${fmt(longest.e.infillSpeedUsed, 0)} mm/s walls / infill after the flow cap · ${$('bedPreset').selectedOptions[0]?.textContent.split(' · ')[0] || 'custom'}`],
    ['Filament', `~${fmt(g, 0)} g PLA · ${fmt(metres, 1)} m of 1.75 mm · ${fmt(mm3 / 1000, 0)} cm³ extruded (${fmt(100 * mm3 / result.tileVolume, 0)} % of solid)`]
  ]);
  renderTable();
}
for (const id of ['simWalls', 'simLine', 'simInfill', 'layerH', 'spdPerim', 'spdInfill', 'solidLayers', 'maxFlow', 'layerOverhead']) $(id).addEventListener('change', () => { syncPresetFromInputs(); requestEstimate(); });
/** Ask the worker for the current layer's toolpath (throttled; one in flight). */
function requestLayer(z) {
  if (sim.pending && performance.now() - sim.lastReq < 1500) return;
  sim.pending = ++sim.seq; sim.lastReq = performance.now();
  worker.postMessage({ type: 'layer', z, seq: sim.pending, opts: { ...simOpts(), angle: (sim.layer % 2) * Math.PI / 2 + Math.PI / 4 } });
}
/** Flatten a tile's layer into one polyline list with cumulative lengths so the head can follow it. */
function buildTrack(L) {
  const pts = []; let len = 0;
  const push = (x, y) => { if (pts.length) len += Math.hypot(x - pts[pts.length - 1][0], y - pts[pts.length - 1][1]); pts.push([x, y, len]); };
  for (const poly of L.perims) { for (const p of poly) push(p[0], p[1]); push(poly[0][0], poly[0][1]); }
  for (let i = 0; i < L.infill.length; i += 4) { push(L.infill[i], L.infill[i + 1]); push(L.infill[i + 2], L.infill[i + 3]); }
  return { pts, len };
}
function trackPoint(track, f) {
  const target = f * track.len, pts = track.pts;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][2] < target) lo = mid + 1; else hi = mid; }
  const b = pts[lo], a = pts[Math.max(0, lo - 1)];
  const u = b[2] > a[2] ? (target - a[2]) / (b[2] - a[2]) : 0;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}
function drawLayerPaths(z, tiles) {
  pathGroup.clear(); sim.paths = {};
  const b = bed(), t = theme();
  for (const { mesh, tile } of sim.targets) {
    const L = tiles[tile.name]; if (!L) continue;
    const s = tile.bounds.size, ox = mesh.position.x, oy = mesh.position.y;
    const perim = [], fill = [];
    for (const poly of L.perims) for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; perim.push(ox + p[0], oy + p[1], z + 0.05, ox + q[0], oy + q[1], z + 0.05); }
    for (let i = 0; i < L.infill.length; i += 4) fill.push(ox + L.infill[i], oy + L.infill[i + 1], z + 0.05, ox + L.infill[i + 2], oy + L.infill[i + 3], z + 0.05);
    const mk = (arr, color, op) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthTest: false })); };
    if (perim.length) pathGroup.add(mk(perim, 0xf59e0b, .95));
    if (fill.length) pathGroup.add(mk(fill, isDark() ? 0x38bdf8 : 0x0369a1, .6));
    sim.paths[tile.name] = buildTrack(L);
  }
  sim.pathZ = z;
}
function simSetup() {
  sim.lh = Math.max(0.05, +$('layerH').value || 0.2);
  sim.maxH = sim.targets.length ? Math.max(...sim.targets.map(t => t.tile.bounds.size[2])) : 0;
  sim.layers = Math.ceil(sim.maxH / sim.lh); sim.layer = 0; sim.frac = 0;
  simApply();
}
function simApply() {
  const z = sim.layer * sim.lh, active = sim.playing || sim.layer > 0, b = bed();
  for (const { mesh, tile, head } of sim.targets) {
    const h = tile.bounds.size[2], done = z >= h;
    const planes = active && !done ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), z)] : [];
    mesh.material.clippingPlanes = planes;
    const w = mesh.getObjectByName('wire'); if (w) w.material.clippingPlanes = planes;
    mesh.visible = !active || sim.layer > 0;
    head.visible = active && !done;
    if (head.visible) {
      const s = tile.bounds.size, ox = (b[0] - s[0]) / 2, oy = (b[1] - s[1]) / 2;
      const track = sim.paths[tile.name];
      let x, y;
      if (track && track.len > 0) { const q = trackPoint(track, sim.frac); x = ox + q[0]; y = oy + q[1]; }
      else { x = ox + s[0] / 2; y = oy + s[1] / 2; } // path not back from the worker yet: park over the tile centre
      head.position.z = z + 1; head.userData.gantry.position.y = y; head.userData.carriage.position.set(x, y, 10);
    }
  }
  if (active && sim.layer > 0 && sim.layer < sim.layers && Math.abs(sim.pathZ - z) > 1e-9) requestLayer(z);
  if (!active || sim.layer >= sim.layers) { pathGroup.clear(); sim.pathZ = -1; }
  $('simStat').innerHTML = statHtml([
    ['Layer', `${Math.min(sim.layer, sim.layers)} / ${sim.layers}`],
    ['Height', `${fmt(Math.min(z, sim.maxH), 2)} / ${fmt(sim.maxH, 2)} mm`],
    ['Printing', `${sim.targets.filter(t => z < t.tile.bounds.size[2]).length} / ${sim.targets.length} plates`],
    ['Recipe', `${simOpts().walls} walls × ${simOpts().lineWidth} mm · ${Math.round(simOpts().infill * 100)} % infill`]
  ]);
}
function simTick(now) {
  if (!sim.playing) return;
  const perLayer = 1000 / Math.max(0.1, +$('simSpeed').value || 4);
  const elapsed = now - sim.t0;
  sim.layer = Math.floor(elapsed / perLayer); sim.frac = (elapsed % perLayer) / perLayer;
  if (sim.layer >= sim.layers) { sim.layer = sim.layers; sim.frac = 0; sim.playing = false; $('simPlay').textContent = 'Print again'; }
  simApply();
}
$('simPlay').onclick = () => {
  if (!result) return;
  if (!plateView) { plateView = true; $('plates').textContent = 'Model view'; redraw(); }
  if (sim.playing) { sim.playing = false; $('simPlay').textContent = 'Resume'; simApply(); return; }
  if (sim.layers === 0 || sim.layer >= sim.layers) simSetup();
  const perLayer = 1000 / Math.max(0.1, +$('simSpeed').value || 4);
  sim.t0 = performance.now() - (sim.layer + sim.frac) * perLayer;
  sim.playing = true; $('simPlay').textContent = 'Pause';
};
$('simReset').onclick = () => { sim.playing = false; $('simPlay').textContent = 'Print'; simSetup(); };

// ---------- result rendering ----------
let sortKey = 'name', sortDir = 1;
function tileProblem(t) {
  if (!t.audit.ok) return `${t.audit.open} open / ${t.audit.nonManifold} non-manifold edges`;
  const b = bed(), m = marginMm(), s = t.bounds.size, over = [];
  if (s[0] > b[0] - 2 * m + 1e-6) over.push(`X ${fmt(s[0])} > ${fmt(b[0] - 2 * m)}`);
  if (s[1] > b[1] - 2 * m + 1e-6) over.push(`Y ${fmt(s[1])} > ${fmt(b[1] - 2 * m)}`);
  if (s[2] > b[2] + 1e-6) over.push(`Z ${fmt(s[2])} > ${b[2]}`);
  return over.length ? 'too big — ' + over.join(', ') + ' mm' : 'closed';
}
function renderTable() {
  const cols = [['name', 'Tile'], ['x', 'X'], ['y', 'Y'], ['z', 'Height'], ['vol', 'cm³'], ...(estimates ? [['hrs', 'Time']] : []), ['audit', 'Audit']];
  const rows = result.tiles.map(t => ({ t, name: t.name, x: t.bounds.size[0], y: t.bounds.size[1], z: t.bounds.size[2], vol: (t.shellVolume ?? t.volume) / 1000, hrs: estimates?.[t.name]?.seconds ?? 0, audit: t.audit.ok && t.fitsBed ? 1 : 0 }));
  rows.sort((a, b) => ((a[sortKey] > b[sortKey]) - (a[sortKey] < b[sortKey])) * sortDir || (a.name > b.name ? 1 : -1));
  $('tiles').innerHTML = '<tr>' + cols.map(([k, l]) => `<th data-k="${k}" class="${k === sortKey ? 'sorted' : ''}${['x', 'y', 'z', 'vol', 'hrs'].includes(k) ? ' num' : ''}">${l}${k === sortKey ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '</tr>'
    + rows.map(r => `<tr data-name="${r.name}" class="${r.name === selected ? 'sel' : ''}"><td>${label(r.name)}</td><td class="num">${fmt(r.x)}</td><td class="num">${fmt(r.y)}</td><td class="num">${fmt(r.z)}</td><td class="num">${fmt(r.vol)}</td>${estimates ? `<td class="num">${hms(r.hrs)}</td>` : ''}<td class="${r.audit ? 'ok' : 'bad'}">${tileProblem(r.t)}</td></tr>`).join('');
  $('tiles').querySelectorAll('th').forEach(th => th.onclick = () => { const k = th.dataset.k; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; } renderTable(); });
  $('tiles').querySelectorAll('tr[data-name]').forEach(tr => tr.onclick = () => highlight(tr.dataset.name === selected ? null : tr.dataset.name));
}
function renderMinimap() {
  const p = result.plan, mm = $('minimap');
  mm.style.gridTemplateColumns = `repeat(${p.nx}, 1fr)`;
  let html = '';
  for (let j = p.ny; j >= 1; j--) for (let i = 1; i <= p.nx; i++) {
    const t = result.tiles.find(t => t.row === j && t.col === i);
    html += t ? `<button data-name="${t.name}" class="${t.audit.ok && t.fitsBed ? '' : 'bad'}" title="${label(t.name)}: ${t.bounds.size.map(v => fmt(v)).join(' × ')} mm">${label(t.name)}<small>${fmt(t.bounds.size[2], 0)} mm</small></button>` : '<span></span>';
  }
  mm.innerHTML = html;
  mm.querySelectorAll('button').forEach(b => b.onclick = () => highlight(b.dataset.name === selected ? null : b.dataset.name));
}

// ---------- worker replies ----------
worker.onmessage = ({ data: d }) => {
  if (d.type === 'error') { msg(d.message, 'bad'); $('run').disabled = !model; $('applyScale').disabled = !model; return; }
  if (d.type === 'progress') { if (d.what !== 'estimate') $('run').firstElementChild.style.transform = `scaleX(${d.value})`; return; }
  if (d.type === 'loaded') {
    const first = !model || model.name !== d.name;
    model = d; model.asModelled = d.asModelled; model.scalePending = false; result = null; selected = null;
    const a = d.audit, s = d.bounds.size;
    const scaled = d.scaleFactor.some(v => Math.abs(v - 1) > 1e-9);
    $('modelBox').hidden = false; $('drop').innerHTML = `<b>${d.name}</b> — drop another file to replace`;
    $('modelStat').innerHTML = statHtml([
      ['Size', `${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} mm` + (scaled ? ` <span class="hint" style="margin:0">(${d.scaleFactor.map(v => fmt(v * 100, 1)).join(' / ')} % of modelled)</span>` : '') + (d.rotated ? ' <span class="hint" style="margin:0">(rotated)</span>' : '')],
      ['Volume', `${fmt(d.volume / 1000)} cm³ · ~${fmt(d.volume / 1000 * PLA_G_PER_CM3 / 1000, 1)} kg solid PLA`],
      ['Triangles', a.triangles.toLocaleString() + (d.dropped ? ` <span class="warn">(${d.dropped} zero-area dropped)</span>` : '')],
      ['Topology', a.ok ? `<span class="ok">closed — every edge shared by two faces, ${a.shells} shell${a.shells > 1 ? 's' : ''}</span>`
                        : `<span class="bad">${a.open} open edge${a.open === 1 ? '' : 's'}, ${a.nonManifold} non-manifold, ${a.shells} shells</span>`]
    ]);
    $('modelNote').textContent = d.note;
    setSizeInputs(s); $('applyScale').disabled = true; $('resetScale').disabled = !scaled;
    $('rotPlus').disabled = $('rotMinus').disabled = false; $('rotReset').disabled = !d.rotated;
    $('scaleNote').textContent = 'Type a new width to scale the whole piece. The tile plan below updates as you type.';
    plateView = false; $('plates').textContent = 'Plate view'; $('simPlay').disabled = $('simReset').disabled = true;
    redraw(); frame(s);
    $('srcStl').disabled = $('src3mf').disabled = !a.ok;
    $('resultBox').hidden = true; $('minimap').innerHTML = ''; $('tiles').innerHTML = '';
    updatePlan(); setStep(a.ok ? 2 : 1);
    msg(a.ok ? (first ? 'Model is closed. Check the bed, then split.' : 'Re-oriented and re-audited. Check the plan, then split.')
             : 'This mesh is not a closed solid, so it cannot be cut — cutting an open mesh only makes more open edges. Repair it in your CAD tool or remesh it, then load it again.', a.ok ? 'ok' : 'bad');
    if (first) $('s2').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  if (d.type === 'tiled') {
    result = d; selected = null;
    const p = d.plan, s = model.bounds.size, b = bed(), m = marginMm();
    const bad = d.tiles.filter(t => !t.audit.ok), big = d.tiles.filter(t => !t.fitsBed);
    const volOk = Math.abs(d.tileVolume - d.sourceVolume) < 1e-3 * d.sourceVolume;
    const seams = (p.nx - 1) * p.ny + (p.ny - 1) * p.nx;
    const kg = d.printVolume / 1000 * PLA_G_PER_CM3 / 1000;
    const minGrid = [Math.ceil(s[0] / (b[0] - 2 * m)), Math.ceil(s[1] / (b[1] - 2 * m))];
    const tallest = d.tiles.reduce((a, t) => t.bounds.size[2] > a.bounds.size[2] ? t : a);
    $('verdict').className = 'verdict ' + (d.allOk ? 'ok' : 'bad');
    $('verdict').innerHTML = d.allOk
      ? `All ${d.tiles.length} tiles closed and fit the bed<small>Volumes add up: ${fmt(d.tileVolume / 1000)} of ${fmt(d.sourceVolume / 1000)} cm³. Ready to download.</small>`
      : `${bad.length ? bad.length + ' tile(s) failed the audit' : ''}${bad.length && big.length ? ' · ' : ''}${big.length ? big.length + ' tile(s) too big for the bed' : ''}${!volOk ? ' · volume mismatch' : ''}<small>${big.length ? `Use at least ${minGrid[0]} × ${minGrid[1]} tiles, or scale the model down. ` : ''}Download stays off until every tile passes.</small>`;
    $('assembled').textContent = `Assembles to ${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} mm`;
    $('resultStat').innerHTML = statHtml([
      ['Layout', `${p.ny} row${p.ny > 1 ? 's' : ''} × ${p.nx} column${p.nx > 1 ? 's' : ''} — ${d.tiles.length} tiles of up to ${fmt(p.tile[0])} × ${fmt(p.tile[1])} mm`],
      ['Seams', `${seams} glued joint${seams === 1 ? '' : 's'}`],
      ['Walls', d.hollow ? `hollow shell, ${d.hollow.wall} mm wall, ${d.hollow.openBottom ? 'open bottom' : 'sealed cavity'}` : 'solid — perimeters and infill are set in your slicer'],
      ['Material', d.hollow ? `${fmt(d.printVolume / 1000)} cm³ · ~${fmt(kg, 1)} kg PLA (${fmt(100 * d.printVolume / d.tileVolume, 0)} % of solid)` : `${fmt(d.tileVolume / 1000)} cm³ · ~${fmt(kg, 1)} kg if printed solid in PLA`],
      ['Tallest', `${label(tallest.name)} at ${fmt(tallest.bounds.size[2])} mm — needs a printer with Z ≥ that`],
      ['Dowel holes', d.holes]
    ]);
    estimates = null; $('estimate').innerHTML = '';
    renderMinimap(); renderTable();
    $('resultBox').hidden = false;
    requestEstimate();
    $('simPlay').disabled = $('simReset').disabled = false;
    $('dl').disabled = !d.allOk || !formatsPicked();
    $('run').disabled = false; $('run').firstElementChild.style.transform = 'scaleX(0)';
    setStep(4);
    redraw();
    msg(d.allOk ? `Done — ${d.tiles.length} tiles.` : 'Some tiles failed. Adjust the plan and split again.', d.allOk ? 'ok' : 'bad');
    $('resultBox').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (d.type === 'estimate') {
    estimates = d.tiles; estimateBusy = false; renderEstimate();
    if (estimateDirty) requestEstimate();
    return;
  }
  if (d.type === 'layer') {
    if (d.seq === sim.pending) sim.pending = 0;
    if (sim.targets.length && (sim.playing || sim.layer > 0)) drawLayerPaths(d.z, d.tiles);
    return;
  }
  if (d.type === 'zip') {
    const base = model.name.replace(/\.[^.]+$/, '');
    if (d.single) download(d.bytes, `${base}_repaired.${d.single}`, 'application/octet-stream');
    else { download(d.bytes, `${base}_tiles_${result.plan.nx}x${result.plan.ny}.zip`, 'application/zip'); $('dl').disabled = false; }
  }
};

applyTheme();
(function loop(now) { resize(); controls.update(); simTick(now || 0); renderer.render(scene, camera); requestAnimationFrame(loop); })();
