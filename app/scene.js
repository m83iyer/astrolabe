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

async function buildRealMeasuredLayer(metaUrl, binUrl) {
  const { meta, columns } = await loadTierBinary(metaUrl, binUrl);
  const n = meta.row_count;
  const positions = new Float32Array(n * 3);
  const mags = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = columns.x_pc[i] / PC_PER_UNIT;
    positions[i * 3 + 1] = columns.z_pc[i] / PC_PER_UNIT;
    positions[i * 3 + 2] = -columns.y_pc[i] / PC_PER_UNIT;
    const mag = columns.phot_g_mean_mag ? columns.phot_g_mean_mag[i] : (columns.mag ? columns.mag[i] : 6);
    mags[i] = Number.isFinite(mag) ? mag : 12;
    const [r, g, b] = colorForBpRp(columns.bp_rp ? columns.bp_rp[i] : NaN);
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
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
  pts.userData.rowCount = n;
  return pts;
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

canvas.addEventListener("pointerdown", (e) => { rig.dragging = true; rig.lastX = e.clientX; rig.lastY = e.clientY; });
addEventListener("pointerup", () => { rig.dragging = false; });
addEventListener("pointermove", (e) => {
  if (!rig.dragging || pinch) return;
  const dx = e.clientX - rig.lastX, dy = e.clientY - rig.lastY;
  rig.lastX = e.clientX; rig.lastY = e.clientY;
  rig.yaw -= dx * 0.0035;
  rig.pitch = Math.max(-1.5, Math.min(1.5, rig.pitch - dy * 0.0035));
});
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

function updateInfoPanel(def) {
  const hud = document.getElementById("hud");
  let panel = document.getElementById("info-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "info-panel";
    panel.className = "panel";
    hud.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="info-name">${def.name}</div>
    <div class="info-layer-tag ${def.layer}">${def.layer}</div>
    <div class="info-row"><span>Distance from Sun</span><span>${formatAlt(Math.hypot(def.posPc.x - SUN_PC.x, def.posPc.y - SUN_PC.y, def.posPc.z - SUN_PC.z))}</span></div>
  `;
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  let dataStatus = "placeholder";
  try {
    measuredLayer = await buildRealMeasuredLayer("data/tier_c_neighborhood.meta.json", "data/tier_c_neighborhood.bin");
    scene.add(measuredLayer);
    addLandmark({ id: "sun", name: "Sun", kind: "landmark", layer: "measured", posPc: SUN_PC });
    addLandmark({ id: "gc", name: "Sagittarius A∗", kind: "landmark", layer: "measured", posPc: GC_PC });
    dataStatus = "real:tier_c_only"; // tier A (model/structure) and tier B (bright stars) not yet wired in
  } catch (err) {
    console.warn("Real tier data unavailable, falling back to placeholder:", err);
    const universe = buildPlaceholderUniverse();
    for (const lm of universe.landmarks) addLandmark(lm);
  }
  window.__astrolabe = { landmarkBodies, rig, SUN_PC, GC_PC, dataStatus, scene, camera, measuredLayer, modelLayer, galacticPcToWorld, renderer, tick };
  requestAnimationFrame(tick);
}
boot();
