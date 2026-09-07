// Astrolabe 3D engine. Galactocentric parsecs throughout (see
// ../DATA_SCHEMA.md and ../scripts/frames.py for the frame definition —
// this file must stay consistent with that Python module's convention:
// Sun at (-8150, 0, 20.8) pc, Galactic Center at the origin, +z toward
// the North Galactic Pole).
//
// PLACEHOLDER DATA NOTICE: until the real data pipeline (scripts/) lands,
// buildPlaceholderUniverse() below generates a synthetic starfield so the
// rendering engine itself can be built and tested. It is clearly labeled
// in the UI as placeholder and must never be mistaken for real data —
// see ui.js's dataStatus handling. Swap in real tier data by replacing
// boot()'s data-loading call.

const THREE = window.THREE;
if (!THREE) {
  document.body.innerHTML = '<div style="padding:40px;color:#E8ECF4;font-family:sans-serif">Three.js failed to load (CDN blocked or offline). Nothing else can render.</div>';
  throw new Error("THREE.js missing");
}

// ---- constants ----------------------------------------------------------

const PC_PER_UNIT = 1; // 1 Three.js world unit = 1 parsec
const SUN_PC = { x: -8150, y: 0, z: 20.8 }; // must match scripts/frames.py SUN_GALACTOCENTRIC_PC
const GC_PC = { x: 0, y: 0, z: 0 };

// ---- renderer / scene / camera ------------------------------------------

const canvas = document.getElementById("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setClearColor(0x05060a, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.001, 1e7);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ---- coordinate convention: Galactocentric pc -> Three.js world units ---
// x,y in the galactic plane, z toward NGP -> world (x, z, -y), so galactic
// north maps to world +Y (up) — same convention family as Orrery's
// ecliptic-to-world mapping, for consistency across the collection.
function galacticPcToWorld(pc, originPc) {
  return new THREE.Vector3(
    (pc.x - originPc.x) / PC_PER_UNIT,
    (pc.z - originPc.z) / PC_PER_UNIT,
    -(pc.y - originPc.y) / PC_PER_UNIT
  );
}
function worldDirToGalacticPc(dir) {
  return { x: dir.x, y: -dir.z, z: dir.y };
}
function galacticDirToWorld(dir) {
  return { x: dir.x, y: dir.z, z: -dir.y };
}
function yawPitchFromWorldDir(dir) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const y = dir.y / len;
  return { yaw: Math.atan2(dir.z, dir.x), pitch: Math.asin(Math.max(-1, Math.min(1, y))) };
}

// ---- point-cloud star layer ----------------------------------------------
// Custom shader instead of THREE.PointsMaterial: real stars span an
// enormous brightness range, so point size must scale with log-magnitude
// (a linear scale would make faint stars invisible and bright ones
// oversized blobs), with an exposure control layered on top.

const STAR_VERT = `
attribute float aMag;   // apparent-ish magnitude proxy: smaller = brighter
attribute vec3 aColor;
varying vec3 vColor;
uniform float uExposure;
uniform float uPixelRatio;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Size is driven by brightness (log scale) via uExposure, deliberately
  // NOT by 1/distance the way a physical object (a planet, in Orrery)
  // would be: a star is a point source, not something with a true
  // renderable angular size, so distance-based shrinkage would make
  // distant real structure vanish — exactly what the log-brightness
  // design (see README) exists to avoid. A mild sqrt falloff keeps very
  // close points from ballooning past the screen without reintroducing
  // that problem.
  float brightness = pow(2.0, (6.0 - aMag) * uExposure);
  float size = clamp(brightness, 1.0, 14.0) * uPixelRatio;
  float nearBoost = clamp(80.0 / max(-mv.z, 1.0), 1.0, 6.0);
  gl_PointSize = size * sqrt(nearBoost);
  gl_Position = projectionMatrix * mv;
}`;
const STAR_FRAG = `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor, alpha);
}`;

function makeStarPoints(count, positionsPc, mags, colors) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = positionsPc[i].x / PC_PER_UNIT;
    positions[i * 3 + 1] = positionsPc[i].z / PC_PER_UNIT;
    positions[i * 3 + 2] = -positionsPc[i].y / PC_PER_UNIT;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aMag", new THREE.BufferAttribute(mags, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uExposure: { value: 1.0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.isStarLayer = true;
  return pts;
}

let measuredLayer = null;
let structureLayer = null;
let modelLayer = new THREE.Group();
scene.add(modelLayer);

// ---- real tier data loading (struct-of-arrays binary, see bin_layout.py) -

async function loadTierBinary(metaUrl, binUrl) {
  const [meta, buf] = await Promise.all([
    fetch(metaUrl).then((r) => { if (!r.ok) throw new Error(metaUrl + " " + r.status); return r.json(); }),
    fetch(binUrl).then((r) => { if (!r.ok) throw new Error(binUrl + " " + r.status); return r.arrayBuffer(); }),
  ]);
  const columns = {};
  for (const col of meta.columns) {
    const Ctor = { Float32Array, BigInt64Array, Uint8Array }[col.js_typed_array];
    if (!Ctor) throw new Error("unsupported js_typed_array " + col.js_typed_array);
    columns[col.name] = new Ctor(buf, col.byte_offset, col.count);
  }
  return { meta, columns };
}

// BP-RP (Gaia color index) -> RGB. A disclosed, simple linear ramp (blue at
// hot/negative BP-RP through white near Sun-like ~0.8 to red at cool/high
// BP-RP) -- NOT a physically-modeled blackbody or the Mamajek dwarf-
// sequence color table; a real color-table pass is a documented follow-up
// (see README), and stars with no bp_rp value get a neutral white-grey.
function colorForBpRp(bpRp) {
  if (!Number.isFinite(bpRp)) return [0.85, 0.85, 0.9];
  const t = Math.max(0, Math.min(1, (bpRp + 0.3) / 3.3));
  const stops = [
    [0.65, 0.75, 1.0],   // hot/blue
    [1.0, 1.0, 1.0],     // white
    [1.0, 0.85, 0.6],    // yellow-orange
    [1.0, 0.55, 0.4],    // red
  ];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  return [
    stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f,
    stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f,
    stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f,
  ];
}

// Loads and merges one or more tier binaries (Tier B + Tier C share the
// same struct-of-arrays column shape) into a single star Points cloud,
// so the whole "measured stars" layer is one draw call.
async function buildRealMeasuredLayer(tierUrls) {
  const loaded = await Promise.all(tierUrls.map((t) => loadTierBinary(t.metaUrl, t.binUrl)));
  const total = loaded.reduce((sum, t) => sum + t.meta.row_count, 0);
  const positions = new Float32Array(total * 3);
  const mags = new Float32Array(total);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const { meta, columns } of loaded) {
    const n = meta.row_count;
    for (let i = 0; i < n; i++) {
      const o = offset + i;
      positions[o * 3] = columns.x_pc[i] / PC_PER_UNIT;
      positions[o * 3 + 1] = columns.z_pc[i] / PC_PER_UNIT;
      positions[o * 3 + 2] = -columns.y_pc[i] / PC_PER_UNIT;
      const mag = columns.phot_g_mean_mag ? columns.phot_g_mean_mag[i] : (columns.mag ? columns.mag[i] : 6);
      mags[o] = Number.isFinite(mag) ? mag : 12;
      const [r, g, b] = colorForBpRp(columns.bp_rp ? columns.bp_rp[i] : NaN);
      colors[o * 3] = r; colors[o * 3 + 1] = g; colors[o * 3 + 2] = b;
    }
    offset += n;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aMag", new THREE.BufferAttribute(mags, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uExposure: { value: 1.0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.isStarLayer = true;
  pts.userData.rowCount = total;
  return pts;
}

// Tier A: the small, always-loaded structure layer (JSON, not binary).
// Cepheids/masers/clusters render as a distinctly-colored point cloud
// (too numerous to individually label, same reasoning Orrery uses for
// not labeling every asteroid) — landmarks (Sun, Sgr A*) get real
// clickable labels via addLandmark, same as before.
async function buildTierAStructure(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " " + res.status);
  const data = await res.json();
  const m = data.measured || {};
  const groups = [
    { rows: m.cepheids || [], color: [1.0, 0.85, 0.4], kind: "cepheid" },
    { rows: m.masers || [], color: [0.6, 1.0, 0.75], kind: "maser" },
    { rows: m.open_clusters || [], color: [0.7, 0.85, 1.0], kind: "open cluster" },
    { rows: m.globular_clusters || [], color: [1.0, 0.6, 0.85], kind: "globular cluster" },
  ];
  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  const positions = new Float32Array(total * 3);
  const mags = new Float32Array(total).fill(3.5); // structure tracers render at a fixed, visible size
  const colors = new Float32Array(total * 3);
  const pointMeta = new Array(total); // index -> {name, kind, posPc, arm?, source} for click-to-inspect
  let o = 0;
  for (const g of groups) {
    for (const row of g.rows) {
      positions[o * 3] = row.x_pc / PC_PER_UNIT;
      positions[o * 3 + 1] = row.z_pc / PC_PER_UNIT;
      positions[o * 3 + 2] = -row.y_pc / PC_PER_UNIT;
      colors[o * 3] = g.color[0]; colors[o * 3 + 1] = g.color[1]; colors[o * 3 + 2] = g.color[2];
      pointMeta[o] = { name: row.name, kind: g.kind, posPc: { x: row.x_pc, y: row.y_pc, z: row.z_pc }, arm: row.arm, source: row.source };
      o++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aMag", new THREE.BufferAttribute(mags, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uExposure: { value: 1.0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  // NOT the "Model" layer despite living in modelLayer's group for now --
  // Cepheids/masers/clusters are real catalogued objects (DATA_SCHEMA.md's
  // `measured` section), just a different object type than raw stars.
  // The actual Model layer (spiral-arm/disk shape) doesn't exist yet.
  pts.userData.isStructureTracerLayer = true;
  pts.userData.rowCount = total;
  pts.userData.pointMeta = pointMeta;
  return { points: pts, landmarks: m.landmarks || [] };
}

// ---- placeholder universe (fallback if real tier data isn't reachable) ---

function buildPlaceholderUniverse() {
  // A synthetic solar-neighborhood-like scatter (NOT real star positions —
  // random, clearly labeled as placeholder in ui.js) so the rendering
  // engine can be built/tested before the data pipeline finishes.
  const N = 20000;
  const positions = [];
  const mags = new Float32Array(N);
  const colors = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // Roughly disk-shaped scatter out to ~2000 pc from the Sun, thin in z.
    const r = Math.pow(Math.random(), 0.5) * 2000;
    const theta = Math.random() * Math.PI * 2;
    positions.push({
      x: SUN_PC.x + r * Math.cos(theta),
      y: SUN_PC.y + r * Math.sin(theta),
      z: SUN_PC.z + (Math.random() - 0.5) * 200,
    });
    mags[i] = 2 + Math.random() * 9;
    const t = Math.random();
    colors[i * 3] = 0.6 + 0.4 * t;
    colors[i * 3 + 1] = 0.7 + 0.3 * t;
    colors[i * 3 + 2] = 1.0;
  }
  measuredLayer = makeStarPoints(N, positions, mags, colors);
  scene.add(measuredLayer);

  // Placeholder spiral-arm-ish curve (model layer) — NOT the real Reid+2019
  // fit, just a visual stand-in. Built in ABSOLUTE (origin-referenced)
  // world coordinates, matching measuredLayer's convention above, since
  // both share the single scene.position floating-origin shift in tick().
  const armPts = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const ang = t * Math.PI * 1.4;
    const rad = 3000 + t * 12000;
    const pc = { x: GC_PC.x + rad * Math.cos(ang), y: GC_PC.y + rad * Math.sin(ang), z: GC_PC.z };
    armPts.push(galacticPcToWorld(pc, { x: 0, y: 0, z: 0 }));
  }
  const armGeo = new THREE.BufferGeometry().setFromPoints(armPts);
  const armMat = new THREE.LineBasicMaterial({ color: 0xc79bff, transparent: true, opacity: 0.35 });
  modelLayer.add(new THREE.Line(armGeo, armMat));

  return { landmarks: [
    { id: "sun", name: "Sun", kind: "landmark", layer: "measured", posPc: SUN_PC },
    { id: "gc", name: "Sagittarius A∗", kind: "landmark", layer: "measured", posPc: GC_PC },
  ] };
}

// ---- landmarks / labels ---------------------------------------------------

const landmarkBodies = [];
function addLandmark(def) {
  const el = document.createElement("div");
  el.className = "body-label" + (def.layer === "model" ? " model" : "");
  el.textContent = def.name;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "Focus " + def.name);
  el.addEventListener("click", (e) => { e.stopPropagation(); focusOn(def); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); focusOn(def); }
  });
  document.getElementById("labels").appendChild(el);
  const body = { def, labelEl: el };
  landmarkBodies.push(body);
  return body;
}

// ---- free-flight camera rig (parsec space) --------------------------------

const rig = {
  posPc: { x: SUN_PC.x, y: SUN_PC.y - 3000, z: SUN_PC.z + 1500 },
  yaw: 0,
  pitch: 0,
  keys: new Set(),
  dragging: false,
  lastX: 0, lastY: 0,
};
// Derive the initial look direction from rig.posPc -> SUN_PC (rather than
// hand-picking yaw/pitch, which is easy to get pointing the wrong way —
// caught exactly that bug here via NDC projection checks, not a visual
// screenshot, since this environment's Browser pane can be hidden).
(function aimAtSunOnBoot() {
  const toSun = { x: SUN_PC.x - rig.posPc.x, y: SUN_PC.y - rig.posPc.y, z: SUN_PC.z - rig.posPc.z };
  const worldDir = galacticDirToWorld(toSun);
  const { yaw, pitch } = yawPitchFromWorldDir(worldDir);
  rig.yaw = yaw;
  rig.pitch = pitch;
})();

function rigForwardVec() {
  const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
  const cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw);
  return new THREE.Vector3(cp * cy, sp, cp * sy).normalize();
}
function rigRightVec(fwd) {
  return new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
}

let focusTarget = null; // {posPc} — defaults to the Sun
function focusOn(def) {
  focusTarget = def;
  updateInfoPanel(def);
}
window.__astrolabeFocusOn = focusOn;

function currentZoomTargetPc() {
  return (focusTarget && focusTarget.posPc) || SUN_PC;
}

function distToSunPc() {
  const camPc = rig.posPc;
  return Math.hypot(camPc.x - SUN_PC.x, camPc.y - SUN_PC.y, camPc.z - SUN_PC.z);
}

// ---- input: drag-to-look, WASD, wheel/pinch/slider zoom -------------------

let pointerMoveDist = 0;
canvas.addEventListener("pointerdown", (e) => { rig.dragging = true; rig.lastX = e.clientX; rig.lastY = e.clientY; pointerMoveDist = 0; });
addEventListener("pointerup", (e) => {
  rig.dragging = false;
  // A click (not a drag) on a structure-tracer point: raycast and inspect.
  // Deliberately NOT raycasting against measuredLayer (800k+ raw stars) —
  // per-star picking at that density needs GPU picking, not CPU raycasting;
  // scoped out of this pass, see README's open-gaps list.
  if (pointerMoveDist < 5 && structureLayer) pickStructurePoint(e.clientX, e.clientY);
});
addEventListener("pointermove", (e) => {
  if (!rig.dragging || pinch) return;
  const dx = e.clientX - rig.lastX, dy = e.clientY - rig.lastY;
  pointerMoveDist += Math.hypot(dx, dy);
  rig.lastX = e.clientX; rig.lastY = e.clientY;
  rig.yaw -= dx * 0.0035;
  rig.pitch = Math.max(-1.5, Math.min(1.5, rig.pitch - dy * 0.0035));
});

const _raycaster = new THREE.Raycaster();
_raycaster.params.Points.threshold = 8; // world units (pc); generous enough to hit a point without needing pixel precision
function pickStructurePoint(clientX, clientY) {
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  _raycaster.setFromCamera(ndc, camera);
  const hits = _raycaster.intersectObject(structureLayer, false);
  if (!hits.length) return;
  const meta = structureLayer.userData.pointMeta[hits[0].index];
  if (!meta) return;
  showStructureInfo(meta);
}
addEventListener("keydown", (e) => { rig.keys.add(e.code); });
addEventListener("keyup", (e) => { rig.keys.delete(e.code); });

function zoomToward(sign, magnitude01) {
  const target = currentZoomTargetPc();
  const toTarget = { x: target.x - rig.posPc.x, y: target.y - rig.posPc.y, z: target.z - rig.posPc.z };
  const dist = Math.hypot(toTarget.x, toTarget.y, toTarget.z) || 1;
  const dir = { x: toTarget.x / dist, y: toTarget.y / dist, z: toTarget.z / dist };
  const step = Math.min(dist * 0.22 * (magnitude01 == null ? 1 : magnitude01), dist - 0.05);
  const move = sign * step;
  rig.posPc.x += dir.x * move;
  rig.posPc.y += dir.y * move;
  rig.posPc.z += dir.z * move;
  updateZoomSlider();
}
window.__astrolabeZoomToward = zoomToward;

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomToward(e.deltaY > 0 ? -1 : 1);
}, { passive: false });

let pinch = null;
function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) { rig.dragging = false; pinch = { dist: touchDist(e.touches) }; }
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    const d = touchDist(e.touches);
    const delta = d - pinch.dist;
    if (Math.abs(delta) > 1) { zoomToward(delta > 0 ? 1 : -1, Math.min(1, Math.abs(delta) / 60)); pinch.dist = d; }
  }
}, { passive: false });
addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
addEventListener("touchcancel", () => { pinch = null; });

// ---- log-scale zoom slider: altitude (distance from the Sun) in pc -------
// h = MIN_PC * (MAX_PC/MIN_PC)^s, s in [0,1] (slider units 0-1000)

const MIN_ALT_PC = 1;
const MAX_ALT_PC = 60000;
function sliderToAltPc(s01) { return MIN_ALT_PC * Math.pow(MAX_ALT_PC / MIN_ALT_PC, s01); }
function altPcToSlider(pc) { return Math.log(pc / MIN_ALT_PC) / Math.log(MAX_ALT_PC / MIN_ALT_PC); }

function formatAlt(pc) {
  if (pc < 1000) return pc.toFixed(pc < 10 ? 2 : 0) + " pc  (" + (pc * 3.2616).toFixed(pc < 10 ? 1 : 0) + " ly)";
  return (pc / 1000).toFixed(2) + " kpc  (" + (pc * 3.2616 / 1000).toFixed(1) + " kly)";
}

const zoomSlider = document.getElementById("zoom-slider");
const altitudeReadout = document.getElementById("altitude-readout");
let sliderDrivesCamera = false;
function updateZoomSlider() {
  const alt = distToSunPc();
  altitudeReadout.textContent = formatAlt(alt);
  if (!sliderDrivesCamera) zoomSlider.value = String(Math.round(altPcToSlider(Math.max(alt, MIN_ALT_PC)) * 1000));
}
zoomSlider.addEventListener("input", () => {
  sliderDrivesCamera = true;
  const targetPc = currentZoomTargetPc();
  const alt = sliderToAltPc(Number(zoomSlider.value) / 1000);
  const fwd = rigForwardVec();
  const dirPc = worldDirToGalacticPc({ x: -fwd.x, y: -fwd.y, z: -fwd.z });
  const len = Math.hypot(dirPc.x, dirPc.y, dirPc.z) || 1;
  rig.posPc = {
    x: targetPc.x + (dirPc.x / len) * alt,
    y: targetPc.y + (dirPc.y / len) * alt,
    z: targetPc.z + (dirPc.z / len) * alt,
  };
  altitudeReadout.textContent = formatAlt(alt);
});
zoomSlider.addEventListener("change", () => { sliderDrivesCamera = false; });

// ---- render loop ------------------------------------------------------------

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  const fwd = rigForwardVec();
  const right = rigRightVec(fwd);
  const speed = Math.max(distToSunPc(), 1) * 0.6 * dt;
  let mx = 0, my = 0, mz = 0;
  if (rig.keys.has("KeyW")) { mx += fwd.x; my += fwd.y; mz += fwd.z; }
  if (rig.keys.has("KeyS")) { mx -= fwd.x; my -= fwd.y; mz -= fwd.z; }
  if (rig.keys.has("KeyD")) { mx += right.x; mz += right.z; }
  if (rig.keys.has("KeyA")) { mx -= right.x; mz -= right.z; }
  if (rig.keys.has("KeyE")) { my += 1; }
  if (rig.keys.has("KeyQ")) { my -= 1; }
  const len = Math.hypot(mx, my, mz);
  if (len > 0) {
    const dirPc = worldDirToGalacticPc({ x: mx / len, y: my / len, z: mz / len });
    rig.posPc.x += dirPc.x * speed;
    rig.posPc.y += dirPc.y * speed;
    rig.posPc.z += dirPc.z * speed;
  }

  camera.position.set(0, 0, 0);
  camera.lookAt(fwd.x, fwd.y, fwd.z);

  // Floating origin: measuredLayer/modelLayer content is built in ABSOLUTE
  // (origin-referenced) world units, so shifting the whole scene by
  // -cameraWorldPos re-centers everything on the camera without touching
  // per-point data (cheap, unlike recomputing 20k+ point positions/frame).
  scene.position.copy(galacticPcToWorld({ x: 0, y: 0, z: 0 }, rig.posPc));

  updateLabels();
  updateZoomSlider();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function updateLabels() {
  const w = innerWidth, h = innerHeight;
  const _v = new THREE.Vector3();
  for (const b of landmarkBodies) {
    const world = galacticPcToWorld(b.def.posPc, rig.posPc);
    _v.copy(world).project(camera);
    const behind = _v.z > 1 || _v.z < -1;
    if (behind) { b.labelEl.style.display = "none"; continue; }
    const sx = (_v.x * 0.5 + 0.5) * w;
    const sy = (-_v.y * 0.5 + 0.5) * h;
    if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) { b.labelEl.style.display = "none"; continue; }
    b.labelEl.style.display = "block";
    b.labelEl.style.left = sx + "px";
    b.labelEl.style.top = sy + "px";
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function distFromSunLabel(posPc) {
  return formatAlt(Math.hypot(posPc.x - SUN_PC.x, posPc.y - SUN_PC.y, posPc.z - SUN_PC.z));
}

let _landmarkFactsCache = null;
async function loadLandmarkFacts() {
  if (_landmarkFactsCache) return _landmarkFactsCache;
  try {
    const res = await fetch("data/landmark_facts.json");
    _landmarkFactsCache = res.ok ? await res.json() : {};
  } catch (e) {
    _landmarkFactsCache = {};
  }
  return _landmarkFactsCache;
}

function getInfoPanelEl() {
  const hud = document.getElementById("hud");
  let panel = document.getElementById("info-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "info-panel";
    panel.className = "panel";
    hud.appendChild(panel);
  }
  return panel;
}

async function updateInfoPanel(def) {
  const panel = getInfoPanelEl();
  panel.innerHTML = `
    <div class="info-name">${esc(def.name)}</div>
    <div class="info-layer-tag ${def.layer}">${def.layer}</div>
    <div class="info-row"><span>Distance from Sun</span><span>${distFromSunLabel(def.posPc)}</span></div>
  `;
  const facts = await loadLandmarkFacts();
  const entry = facts[def.id];
  if (!entry) return;
  let html = panel.innerHTML;
  if (entry.tagline) html += `<p class="info-tagline">${esc(entry.tagline)}</p>`;
  for (const f of entry.facts || []) {
    html += `<div class="info-row"><span>${esc(f.label)}</span><span>${esc(f.value)}</span></div>`;
  }
  if (entry.scale_chain) {
    html += `<div class="info-scale-chain"><p class="info-scale-caption">${esc(entry.scale_chain.caption)}</p>`;
    for (const step of entry.scale_chain.steps) {
      html += `<div class="info-scale-step"><div class="info-scale-label">${esc(step.label)}</div><div class="info-scale-value">${esc(step.value)}<span class="info-scale-note"> — ${esc(step.note)}</span></div></div>`;
    }
    html += `<p class="info-scale-source">${esc(entry.scale_chain.source)}</p></div>`;
  }
  panel.innerHTML = html;
}

const KIND_LABEL = {
  cepheid: "Cepheid variable star", maser: "Star-forming region (maser)",
  "open cluster": "Open star cluster", "globular cluster": "Globular star cluster",
};
function showStructureInfo(meta) {
  const panel = getInfoPanelEl();
  const rows = [`<div class="info-row"><span>Type</span><span>${esc(KIND_LABEL[meta.kind] || meta.kind)}</span></div>`,
    `<div class="info-row"><span>Distance from Sun</span><span>${distFromSunLabel(meta.posPc)}</span></div>`];
  if (meta.arm) rows.push(`<div class="info-row"><span>Spiral arm</span><span>${esc(meta.arm)}</span></div>`);
  if (meta.source) rows.push(`<div class="info-row"><span>Source</span><span>${esc(meta.source)}</span></div>`);
  panel.innerHTML = `<div class="info-name">${esc(meta.name)}</div><div class="info-layer-tag measured">measured</div>${rows.join("")}`;
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  let dataStatus = "placeholder";
  try {
    measuredLayer = await buildRealMeasuredLayer([
      { metaUrl: "data/tier_c_neighborhood.meta.json", binUrl: "data/tier_c_neighborhood.bin" },
      { metaUrl: "data/tier_b_bright_stars.meta.json", binUrl: "data/tier_b_bright_stars.bin" },
    ]);
    scene.add(measuredLayer);

    const structure = await buildTierAStructure("data/tier_a_structure.json");
    structureLayer = structure.points;
    modelLayer.add(structureLayer);
    for (const lm of structure.landmarks) {
      const slug = lm.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
      addLandmark({ id: slug, name: lm.name, kind: "landmark", layer: "measured", posPc: { x: lm.x_pc, y: lm.y_pc, z: lm.z_pc } });
    }
    dataStatus = "real:full";
  } catch (err) {
    console.warn("Real tier data unavailable, falling back to placeholder:", err);
    const universe = buildPlaceholderUniverse();
    for (const lm of universe.landmarks) addLandmark(lm);
  }
  window.__astrolabe = { landmarkBodies, rig, SUN_PC, GC_PC, dataStatus, scene, camera, measuredLayer, modelLayer, structureLayer, galacticPcToWorld, renderer, tick };
  requestAnimationFrame(tick);
}
boot();
