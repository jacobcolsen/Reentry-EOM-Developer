import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// ── Constants ──────────────────────────────────────────────────────────────
const COLORS = {
  eci:    { x: 0xFF3333, y: 0x33FF33, z: 0x3399FF },
  ecef:   { x: 0xFF8800, y: 0xFFDD00, z: 0x00DDFF },
  rst:    { r: 0xCC44FF, s: 0xFF44CC, t: 0x44FFCC },
  vrf:    { x: 0x44FF44, y: 0x44FFFF, z: 0xFFFF44 },
  vel:    0xFFD700,
  grav:   0x6699FF,
  drag:   0xFF9944,
  lift:   0xFF6699,
  thrust: 0xFF4444,
  arc:    0xFFEE77,
};
const EARTH_RADIUS   = 1.0;
const ORBIT_RADIUS   = 1.55;
const ORBIT_INCL     = Math.PI / 4;       // 45°
const EARTH_ROT_SPD  = 0.03;              // rad/s (visual, not real)
const ORBIT_SPD      = 0.18;              // rad/s (visual)

// ── State ──────────────────────────────────────────────────────────────────
const STATE = {
  currentSlide:   0,
  substep:        0,           // sub-step within the current slide (0 = initial)
  slideGen:       0,           // incremented on every slide/substep clear; guards stale delayed calls
  orbitT:         0.72,
  earthT:         0,
  gsapTween:      null,
  gammaAnim:      null,        // GSAP tween for γ oscillation on slide 5
  vrfAnim:        null,        // GSAP tween for RST→VRF rotation on slide 7
  bankAnim:       null,        // GSAP tween for bank-angle animation on slide 12
  spacecraft:     null,
  slideObjects:   [],          // objects added by current slide; cleared on exit
  persistent: {
    earthMesh:    null,
    eciGroup:     null,        // THREE.Group of 3 ArrowHelpers
    ecefGroup:    null,
    orbitLine:    null,
    rstGroup:     null,
    vrfGroup:     null,
    velArrow:     null,
    gravArrow:    null,
    dragArrow:    null,
    liftArrow:    null,
    thrustArrow:  null,
    coriolisArrow: null,
    centripArrow: null,
    lvnGroup:     null,
  },
};

// ── Three.js globals ───────────────────────────────────────────────────────
let renderer, camera, scene, controls, css2d, clock;

// ── Init ───────────────────────────────────────────────────────────────────
function initScene() {
  const container = document.getElementById('canvas-container');

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  // CSS2D overlay
  css2d = new CSS2DRenderer();
  css2d.setSize(container.clientWidth, container.clientHeight);
  css2d.domElement.classList.add('css2d-layer');
  container.appendChild(css2d.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020408);

  // Camera
  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 200);
  camera.position.set(0, 12, 20);
  scene.add(camera); // required so camera children render

  // Stars — parented to camera so they stay fixed as you orbit
  {
    const starCount = 2800;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // Uniform spherical distribution
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 80;
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // sizeAttenuation:false = fixed pixel size — no near-field bloat
    const stars = new THREE.Points(geo,
      new THREE.PointsMaterial({ color: 0xddeeff, size: 1.2, sizeAttenuation: false }));
    camera.add(stars);
  }

  // Lights
  scene.add(new THREE.AmbientLight(0x223344, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(8, 5, 10);
  scene.add(sun);

  // Controls — must attach to WebGL canvas, NOT the CSS2D overlay
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.5;
  controls.maxDistance = 40;
  controls.target.set(0, 0, 0);

  // Clock
  clock = new THREE.Clock();

  // Resize
  window.addEventListener('resize', onResize);

  // Loading indicator
  const loader = document.createElement('div');
  loader.id = 'loading-indicator';
  loader.innerHTML = '<div class="spinner"></div><span>Loading Assets…</span>';
  container.appendChild(loader);
}

function onResize() {
  const container = document.getElementById('canvas-container');
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  css2d.setSize(w, h);
}

// ── Asset loading ──────────────────────────────────────────────────────────
function loadAssets() {
  return new Promise((resolve) => {
    let loaded = 0;
    const done = () => { if (++loaded === 2) resolve(); };

    new THREE.TextureLoader().load(window._EARTH_SRC, (tex) => {
      // Guard against texture size exceeding GPU max
      const maxSize = renderer.capabilities.maxTextureSize;
      if (tex.image.width > maxSize || tex.image.height > maxSize) {
        const c = document.createElement('canvas');
        c.width  = Math.min(tex.image.width,  maxSize);
        c.height = Math.min(tex.image.height, maxSize);
        c.getContext('2d').drawImage(tex.image, 0, 0, c.width, c.height);
        tex.image = c;
        tex.needsUpdate = true;
      }
      buildEarth(tex);
      done();
    }, undefined, () => { buildEarth(null); done(); });

    new GLTFLoader().load(window._GLB_SRC, (gltf) => {
      const ship = gltf.scene;
      // Normalize scale — fit longest axis to ~0.22 scene units
      const box = new THREE.Box3().setFromObject(ship);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      ship.scale.setScalar(0.22 / maxDim);
      ship.traverse(c => {
        if (c.isMesh) {
          c.material.emissive = new THREE.Color(0x112233);
          c.material.emissiveIntensity = 0.3;
        }
      });
      placeSpacecraft(ship);
      done();
    }, undefined, () => {
      // Fallback: small wedge
      const geo = new THREE.ConeGeometry(0.06, 0.18, 4);
      const mat = new THREE.MeshPhongMaterial({ color: 0x88aacc });
      placeSpacecraft(new THREE.Mesh(geo, mat));
      done();
    });
  });
}

function buildEarth(texture) {
  const mat = new THREE.MeshPhongMaterial({
    color: texture ? 0xffffff : 0x2244aa,
    emissive: 0x112244,
    emissiveIntensity: 0.25,
    shininess: 15,
  });
  if (texture) mat.map = texture;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), mat);
  scene.add(mesh);
  STATE.persistent.earthMesh = mesh;

  // Subtle atmosphere glow
  const atmoMat = new THREE.MeshPhongMaterial({
    color: 0x3388ff,
    transparent: true,
    opacity: 0.07,
    side: THREE.BackSide,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.04, 32, 32), atmoMat));
}

function placeSpacecraft(ship) {
  // Fix the spacecraft at a single point on the orbit — frozen in time
  const s = getSpacecraftState(0.72); // ~41° along the orbit arc
  ship.position.copy(s.pos);
  // Nose along velocity; dorsal "up" = lift_hat (R_hat ⊥ velocity)
  // so θ=0 is wings-level and bank angle has physical meaning
  const v_hat = s.vel.clone().normalize();
  const lift_hat = s.R_hat.clone().addScaledVector(v_hat, -s.R_hat.dot(v_hat)).normalize();
  const mat = new THREE.Matrix4().lookAt(
    s.pos, s.pos.clone().add(s.vel), lift_hat
  );
  ship.quaternion.setFromRotationMatrix(mat);
  // GLB nose is along local +X; lookAt makes -Z=velocity, so rotate +X→-Z via +90° about Y
  ship.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
  STATE.spacecraft = ship;
  scene.add(ship);
}

function buildOrbitTrail() {
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    pts.push(getSpacecraftState((i / 200) * Math.PI * 2).pos.clone());
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x4499bb, transparent: true, opacity: 0.65 }),
  );
  line.visible = false;
  scene.add(line);
  STATE.persistent.orbitLine = line;
}

function buildECIAxes() {
  const L = 3.5;
  const O = new THREE.Vector3(0, 0, 0);
  const group = new THREE.Group();

  // In our Three.js scene: +X = Vernal Equinox, +Y = North Pole (ECI Ẑ), +Z = ECI Ŷ
  const xArrow = makeArrow(new THREE.Vector3(1, 0, 0), O, L, COLORS.eci.x, 'X̂');
  const yArrow = makeArrow(new THREE.Vector3(0, 0, 1), O, L, COLORS.eci.y, 'Ŷ');
  const zArrow = makeArrow(new THREE.Vector3(0, 1, 0), O, L, COLORS.eci.z, 'Ẑ');
  group.add(xArrow, yArrow, zArrow);

  // Secondary labels at arrow tips
  group.add(makeAxisLabel('Vernal Equinox', new THREE.Vector3(L + 0.15, 0, 0),      COLORS.eci.x));
  group.add(makeAxisLabel('North Pole',     new THREE.Vector3(0,         L + 0.15, 0), COLORS.eci.z));

  scene.add(group);
  setGroupVisible(group, false);
  STATE.persistent.eciGroup = group;
}

function buildECEFAxes() {
  const L = 3.0;
  const O = new THREE.Vector3(0, 0, 0);
  const group = new THREE.Group();
  // rotation.y is driven every frame by STATE.earthT in animate()

  group.add(makeArrow(new THREE.Vector3(1, 0, 0), O, L, COLORS.ecef.x, 'x̂_E'));
  group.add(makeArrow(new THREE.Vector3(0, 0, 1), O, L, COLORS.ecef.y, 'ŷ_E'));
  group.add(makeArrow(new THREE.Vector3(0, 1, 0), O, L, COLORS.ecef.z, 'ẑ_E'));

  scene.add(group);
  setGroupVisible(group, false);
  STATE.persistent.ecefGroup = group;
}

function buildRSTAxes() {
  const s = getSpacecraftState(0.72);
  const L = 2.1;               // origin at planetary center, long enough to reach past spacecraft
  const O = new THREE.Vector3(0, 0, 0);
  const group = new THREE.Group();

  group.add(makeArrow(s.R_hat, O, L, COLORS.rst.r, 'x₂'));
  group.add(makeArrow(s.S_hat, O, L, COLORS.rst.s, 'y₂'));
  group.add(makeArrow(s.T_hat, O, L, COLORS.rst.t, 'z₂'));

  group.add(makeAxisLabel('Radial (x₂)', O.clone().addScaledVector(s.R_hat, L + 0.14), COLORS.rst.r));
  group.add(makeAxisLabel('East (y₂)',   O.clone().addScaledVector(s.S_hat, L + 0.14), COLORS.rst.s));
  group.add(makeAxisLabel('North (z₂)',  O.clone().addScaledVector(s.T_hat, L + 0.14), COLORS.rst.t));

  scene.add(group);
  setGroupVisible(group, false);
  STATE.persistent.rstGroup = group;
}

function buildVRFAxes() {
  const s   = getSpacecraftState(0.72);
  const L   = 0.75;
  const pos = s.pos;

  // x_v: velocity direction
  const x_v = s.vel.clone().normalize();
  // z_v: horizontal, perpendicular to both velocity and radial (the "wing" axis)
  const z_v = new THREE.Vector3().crossVectors(s.R_hat, x_v).normalize();
  // y_v: completes right-hand system (roughly radially outward for level flight)
  const y_v = new THREE.Vector3().crossVectors(z_v, x_v).normalize();

  const group = new THREE.Group();

  // Small sphere marks the VRF origin at the spacecraft
  const originMark = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 14, 14),
    new THREE.MeshBasicMaterial({ color: COLORS.vrf.x })
  );
  originMark.position.copy(pos);
  group.add(originMark);

  group.add(makeArrow(x_v, pos, L, COLORS.vrf.x, 'xv'));
  group.add(makeArrow(y_v, pos, L, COLORS.vrf.y, 'yv'));
  group.add(makeArrow(z_v, pos, L, COLORS.vrf.z, 'zv'));

  group.add(makeAxisLabel('Velocity', pos.clone().addScaledVector(x_v, L + 0.12), COLORS.vrf.x));
  group.add(makeAxisLabel('Normal',   pos.clone().addScaledVector(y_v, L + 0.12), COLORS.vrf.y));
  group.add(makeAxisLabel('Wing',     pos.clone().addScaledVector(z_v, L + 0.12), COLORS.vrf.z));

  scene.add(group);
  setGroupVisible(group, false);
  STATE.persistent.vrfGroup = group;
}

function buildVelocityArrow() {
  const s = getSpacecraftState(0.72);
  const arrow = new THREE.ArrowHelper(
    s.vel.clone().normalize(), s.pos, 0.82, COLORS.vel, 0.09, 0.045
  );
  arrow.visible = false;
  scene.add(arrow);
  STATE.persistent.velArrow = arrow;
}

function buildForceArrows() {
  const s    = getSpacecraftState(0.72);
  const R    = s.R_hat;
  const v_h  = s.vel.clone().normalize();
  const lift_hat = R.clone().addScaledVector(v_h, -R.dot(v_h)).normalize();

  // Length 0.44: tip at orbit_r(1.55) - 0.44 = 1.11 — above Earth surface (1.0)
  // Large head fractions so the cone is clearly visible
  const grav   = makeArrow(R.clone().negate(),   s.pos, 0.44, COLORS.grav,   'Fg', 0.30, 0.13);
  const drag   = makeArrow(v_h.clone().negate(), s.pos, 0.50, COLORS.drag,   'FD');
  const lift   = makeArrow(lift_hat,              s.pos, 0.50, COLORS.lift,   'FL');
  const thrust = makeArrow(v_h.clone(),           s.pos, 0.44, COLORS.thrust, 'FT');

  // Coriolis: 2Ω × v — Ω along scene +Y (north pole)
  const Omega   = new THREE.Vector3(0, 1, 0).multiplyScalar(EARTH_ROT_SPD);
  const cor_dir = new THREE.Vector3().crossVectors(Omega, v_h).normalize();
  const coriolis = makeArrow(cor_dir, s.pos, 0.44, 0x44FFFF, 'Cor');

  // Centripetal: Ω×(Ω×r) — points toward spin axis (inward from spacecraft)
  const cpVec = new THREE.Vector3()
    .crossVectors(Omega, new THREE.Vector3().crossVectors(Omega, s.pos))
    .normalize();
  const centrip = makeArrow(cpVec, s.pos, 0.38, 0xAA44FF, 'Cen');

  for (const a of [grav, drag, lift, thrust, coriolis, centrip]) {
    setGroupVisible(a, false);
    scene.add(a);
  }
  STATE.persistent.gravArrow     = grav;
  STATE.persistent.dragArrow     = drag;
  STATE.persistent.liftArrow     = lift;
  STATE.persistent.thrustArrow   = thrust;
  STATE.persistent.coriolisArrow = coriolis;
  STATE.persistent.centripArrow  = centrip;
}

// CSS2DRenderer resets element.style.display every frame based on CSS2DObject.visible.
// Must set both .visible AND .element.style.display to reliably hide labels.
function setGroupVisible(group, visible) {
  if (!group) return;
  group.visible = visible;
  group.traverse(obj => {
    if (obj.isCSS2DObject) {
      obj.visible = visible;
      obj.element.style.display = visible ? '' : 'none';
    }
  });
}

// Show/hide persistent frame groups — call from every slide enter()
function setFrameVisibility({ eci = false, ecef = false, rst = false, vrf = false, vel = false } = {}) {
  setGroupVisible(STATE.persistent.eciGroup,  eci);
  setGroupVisible(STATE.persistent.ecefGroup, ecef);
  setGroupVisible(STATE.persistent.rstGroup,  rst);
  setGroupVisible(STATE.persistent.vrfGroup,  vrf);
  if (STATE.persistent.velArrow) STATE.persistent.velArrow.visible = vel;
  // Always reset force arrows — slides that need them call setForceVisibility() after
  setForceVisibility({});
}

function setForceVisibility({ grav=false, drag=false, lift=false, thrust=false, coriolis=false, centrip=false } = {}) {
  setGroupVisible(STATE.persistent.gravArrow,     grav);
  setGroupVisible(STATE.persistent.dragArrow,     drag);
  setGroupVisible(STATE.persistent.liftArrow,     lift);
  setGroupVisible(STATE.persistent.thrustArrow,   thrust);
  setGroupVisible(STATE.persistent.coriolisArrow, coriolis);
  setGroupVisible(STATE.persistent.centripArrow,  centrip);
}

// Grow arrows in with a stagger spring; labels appear only after all arrows land
function animateGroupIn(group, baseDelay = 0) {
  // Labels are already visible via setGroupVisible — only animate arrow scales
  const arrows = group.children.filter(c => c.isArrowHelper);
  arrows.forEach((arrow, i) => {
    arrow.scale.set(0.001, 0.001, 0.001);
    gsap.to(arrow.scale, {
      x: 1, y: 1, z: 1,
      duration: 0.55,
      delay: baseDelay + i * 0.12,
      ease: 'back.out(1.4)',
    });
  });
}

// ── Force hover — highlight arrow in 3D when hovering panel chip ───────────
function wireForceHovers() {
  const FORCE_MAP = {
    thrust: 'thrustArrow',
    drag:   'dragArrow',
    lift:   'liftArrow',
    grav:   'gravArrow',
    cor:    'coriolisArrow',
    cen:    'centripArrow',
  };
  // Stores the scale each arrow had before hover started so we can restore it
  const hoverBase = new Map();

  function getArrow(chip) {
    const arrow = STATE.persistent[FORCE_MAP[chip.dataset.forceHover]];
    return arrow && arrow.visible ? arrow : null;
  }

  const panel = document.getElementById('slide-body');

  panel.addEventListener('mouseover', (e) => {
    const chip = e.target.closest('[data-force-hover]');
    if (!chip) return;
    const arrow = getArrow(chip);
    if (!arrow || hoverBase.has(arrow)) return;
    hoverBase.set(arrow, arrow.scale.x);
    // Gravity arrow is short (tip near Earth surface) — cap its hover scale
    const mult = chip.dataset.forceHover === 'grav' ? 1.20 : 1.42;
    const s = arrow.scale.x * mult;
    gsap.killTweensOf(arrow.scale);
    gsap.to(arrow.scale, { x: s, y: s, z: s, duration: 0.18, ease: 'power2.out' });
    arrow.traverse(c => {
      if (c.isCSS2DObject) {
        c.element.style.textShadow = '0 0 6px currentColor, 0 0 18px currentColor, 0 0 36px currentColor';
        c.element.style.fontWeight = '900';
      }
    });
  });

  panel.addEventListener('mouseout', (e) => {
    const chip = e.target.closest('[data-force-hover]');
    if (!chip || chip.contains(e.relatedTarget)) return;
    const arrow = STATE.persistent[FORCE_MAP[chip.dataset.forceHover]];
    if (!arrow || !hoverBase.has(arrow)) return;
    const base = hoverBase.get(arrow);
    hoverBase.delete(arrow);
    gsap.killTweensOf(arrow.scale);
    gsap.to(arrow.scale, { x: base, y: base, z: base, duration: 0.28, ease: 'power2.out' });
    arrow.traverse(c => {
      if (c.isCSS2DObject) {
        c.element.style.textShadow = '';
        c.element.style.fontWeight = '';
      }
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function makeArrow(dir, origin, length, hexColor, labelText, hlFrac = 0.12, hwFrac = 0.055) {
  const d = dir.clone().normalize();
  const arrow = new THREE.ArrowHelper(d, origin, length, hexColor,
    length * hlFrac, length * hwFrac);
  if (labelText) {
    const div = document.createElement('div');
    div.className = 'label3d';
    div.textContent = labelText;
    div.style.color = '#' + hexColor.toString(16).padStart(6, '0');
    const obj = new CSS2DObject(div);
    // ArrowHelper's local Y-axis IS the shaft direction; place label along it
    obj.position.set(0, length + 0.05, 0);
    arrow.add(obj);
  }
  return arrow;
}

function makeAxisLabel(text, position, hexColor) {
  const div = document.createElement('div');
  div.className = 'label3d';
  div.textContent = text;
  div.style.color = '#' + hexColor.toString(16).padStart(6, '0');
  const obj = new CSS2DObject(div);
  obj.position.copy(position);
  return obj;
}

function makeArc(center, normal, radius, startAngle, endAngle, hexColor, segments = 80) {
  // Build arc in XZ plane, then rotate to align with normal
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (endAngle - startAngle) * (i / segments);
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: hexColor, linewidth: 2 }));

  // Rotate from Y-up to desired normal
  const up = new THREE.Vector3(0, 1, 0);
  const n = normal.clone().normalize();
  if (Math.abs(up.dot(n)) < 0.9999) {
    line.quaternion.setFromUnitVectors(up, n);
  }
  line.position.copy(center);
  return line;
}

function tweenCamera(toPos, toTarget, duration) {
  if (STATE.gsapTween) STATE.gsapTween.kill();
  const fromPos    = camera.position.clone();
  const fromTarget = controls.target.clone();
  const proxy = { t: 0 };
  STATE.gsapTween = gsap.to(proxy, {
    t: 1, duration, ease: 'power2.inOut',
    onUpdate() {
      camera.position.lerpVectors(fromPos,
        new THREE.Vector3(...toPos), proxy.t);
      controls.target.lerpVectors(fromTarget,
        new THREE.Vector3(...toTarget), proxy.t);
      controls.update();
    },
  });
}

function getSpacecraftState(t) {
  const r   = ORBIT_RADIUS;
  const inc = ORBIT_INCL;
  // Position in orbital plane (XZ), then tilt by inclination around X
  const xOrb = r * Math.cos(t);
  const zOrb = r * Math.sin(t);
  const pos = new THREE.Vector3(xOrb, zOrb * Math.sin(inc), zOrb * Math.cos(inc));
  // Velocity (derivative)
  const vx = -r * Math.sin(t);
  const vz =  r * Math.cos(t);
  const vel = new THREE.Vector3(vx, vz * Math.sin(inc), vz * Math.cos(inc)).normalize();
  const R_hat = pos.clone().normalize();
  // S: Z × R (equatorial parallel, pointing east)
  const S_hat = new THREE.Vector3(0, 1, 0).cross(R_hat).normalize();
  // If S_hat is degenerate (R_hat ≈ pole), fall back
  const T_hat = R_hat.clone().cross(S_hat).normalize();
  return { pos, vel, R_hat, S_hat, T_hat };
}

function clearSlideObjects() {
  STATE.slideGen++;
  for (const obj of STATE.slideObjects) {
    // Hide CSS2D DOM elements immediately to avoid one-frame flash
    obj.traverse(c => {
      if (c.isCSS2DObject) { c.visible = false; c.element.style.display = 'none'; }
    });
    scene.remove(obj);
    obj.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    });
  }
  STATE.slideObjects = [];
}

function addSlideObj(obj) {
  scene.add(obj);
  STATE.slideObjects.push(obj);
  return obj;
}

function setVisible(key, val) {
  const obj = STATE.persistent[key];
  if (obj) obj.visible = val;
}

// ── Phase 3 scene helpers ──────────────────────────────────────────────────

// Translucent disc + ring outline perpendicular to `normal`, at `center`
function makeHorizDisc(center, normal, radius = 0.6) {
  const group = new THREE.Group();

  // Solid translucent fill (CircleGeometry is in XY plane, normal = +Z)
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.MeshBasicMaterial({ color: 0x2244aa, transparent: true, opacity: 0.10, side: THREE.DoubleSide })
  );
  // Ring border (points in XY plane → normal = +Z)
  const ringPts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineBasicMaterial({ color: 0x4488cc, transparent: true, opacity: 0.7 })
  );
  group.add(fill, ring);
  group.position.copy(center);
  const n = normal.clone().normalize();
  const defN = new THREE.Vector3(0, 0, 1);
  if (Math.abs(defN.dot(n)) < 0.9999) group.quaternion.setFromUnitVectors(defN, n);
  return group;
}

// Arc in the plane defined by two orthogonal directions (xDir, yDir),
// sweeping from angle startA to endA, at `center` offset
function makeAngleArc(center, xDir, yDir, arcRadius, startA, endA, hexColor, segments = 48) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = startA + (endA - startA) * (i / segments);
    const pt = xDir.clone().multiplyScalar(Math.cos(a) * arcRadius)
      .addScaledVector(yDir, Math.sin(a) * arcRadius);
    pts.push(center.clone().add(pt));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: hexColor, linewidth: 2 })
  );
  return line;
}

// Small floating text label (CSS2DObject) at a world position
function makeFloatLabel(text, worldPos, hexColor = 0xFFEE77) {
  const div = document.createElement('div');
  div.className = 'label3d';
  div.textContent = text;
  div.style.color = '#' + hexColor.toString(16).padStart(6, '0');
  div.style.fontSize = '0.9rem';
  const obj = new CSS2DObject(div);
  obj.position.copy(worldPos);
  return obj;
}

// ── KaTeX rendering ────────────────────────────────────────────────────────
function renderSlideContent(slide) {
  const panel = document.getElementById('slide-body');
  panel.innerHTML = slide.html || '';
  if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(panel, {
      delimiters: [
        { left: '\\[', right: '\\]', display: true  },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  }
}

// ── Slide definitions ──────────────────────────────────────────────────────
// Each slide: { title, html, camera:{pos,target,dur}, enter(), exit() }
// Slides are zero-indexed internally; displayed as 1-based.

const SLIDES = [
  // ── 0: Introduction ────────────────────────────────────────────────────
  {
    title: 'Introduction',
    html: `
      <p>This interactive lesson walks you through the complete derivation of the
      <strong>3-DOF Equations of Motion</strong> for atmospheric reentry vehicles.</p>
      <h3>What we'll build</h3>
      <ul>
        <li>Four nested coordinate frames</li>
        <li>Kinematic equations linking position angles to velocity</li>
        <li>All forces acting on the entry vehicle</li>
        <li>Six coupled scalar ODEs that govern the trajectory</li>
      </ul>
      <h3>Controls</h3>
      <ul>
        <li><strong>← →</strong> or buttons below — advance slides</li>
        <li><strong>Mouse drag</strong> — orbit the 3D scene</li>
        <li><strong>Scroll</strong> — zoom in/out</li>
      </ul>
      <p style="color:#3a6a9a;font-size:0.8rem;margin-top:1rem;">
        MECH 637: Astrodynamic Reentry &nbsp;·&nbsp; Fall 2022
      </p>`,
    camera: { pos: [0, 12, 20], target: [0, 0, 0], dur: 0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({}); // intro: no frames yet
    },
    exit() {},
  },

  // ── 1: ECI Frame ───────────────────────────────────────────────────────
  {
    title: 'Geocentric-Equatorial Frame (ECI)',
    html: `
      <p>The <span class="chip chip-eci">ECI Frame</span> is our inertial reference — fixed in space,
      origin at Earth's center.</p>
      <div class="eq-block">
        <div class="eq-label">Axis definitions</div>
        \\[\\hat{X} \\rightarrow \\text{Vernal Equinox}\\]
        \\[\\hat{Z} \\rightarrow \\text{North Pole}\\]
        \\[\\hat{Y} = \\hat{Z} \\times \\hat{X}\\]
      </div>
      <p>Because this frame does <em>not</em> rotate with Earth, Newton's Second Law
      holds in its standard inertial form:</p>
      <div class="eq-block">
        \\[m\\ddot{\\vec{r}}_I = \\vec{F}_{\\text{total}}\\]
      </div>
      <p>All other frames we introduce will be defined relative to this one.</p>`,
    camera: { pos: [8, 6, 8], target: [0, 0, 0], dur: 1.2 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ eci: true }); // ECI only
      animateGroupIn(STATE.persistent.eciGroup);
    },
    exit() {},
  },

  // ── 2: ECEF Frame ──────────────────────────────────────────────────────
  {
    title: 'Planet-Fixed Frame (ECEF)',
    html: `
      <p>The <span class="chip chip-ecef">ECEF Frame</span> rotates with Earth at constant
      angular velocity \\(\\Omega\\) about the polar axis.</p>
      <div class="eq-block">
        <div class="eq-label">Earth's rotation</div>
        \\[\\Omega = 7.292 \\times 10^{-5} \\ \\text{rad/s}\\]
      </div>
      <div class="eq-block">
        <div class="eq-label">ECI → ECEF rotation matrix</div>
        \\[\\mathbf{T}_{\\text{ECI} \\to \\text{ECEF}} = R_Z(\\theta_E)\\]
        \\[R_Z(\\theta) = \\begin{bmatrix}
          \\cos\\theta & \\sin\\theta & 0 \\\\
          -\\sin\\theta & \\cos\\theta & 0 \\\\
          0 & 0 & 1
        \\end{bmatrix}\\]
      </div>
      <p>The scene is frozen at a moment in time — the
      <span class="chip chip-ecef">amber ECEF axes</span> are offset from the
      <span class="chip chip-eci">white ECI axes</span> by the current Earth rotation
      angle \\(\\theta_E\\). As Earth spins, this offset grows at rate \\(\\Omega\\).</p>`,
    camera: { pos: [8, 8, 6], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ eci: true, ecef: true }); // ECI stays for reference, ECEF rotates in
      animateGroupIn(STATE.persistent.ecefGroup, 0.3);
    },
    exit() {},
  },

  // ── 3: Vehicle-Pointing Frame ──────────────────────────────────────────
  {
    title: 'Vehicle-Pointing Frame (OX₂Y₂Z₂)',
    html: `
      <p>The <span class="chip chip-rst">Vehicle-Pointing Frame</span> (notation:
      <strong>OX₂Y₂Z₂</strong>) has its <strong>origin at the planetary center</strong>,
      with axes defined by the vehicle's instantaneous position.</p>
      <div class="eq-block">
        <div class="eq-label">Axis definitions</div>
        \\[\\hat{e}_{x_2} = \\frac{\\vec{r}}{|\\vec{r}|}\\quad\\text{(points along position vector)}\\]
        \\[\\hat{e}_{y_2} = \\hat{Z} \\times \\hat{e}_{x_2}\\quad\\text{(parallel to equatorial plane)}\\]
        \\[\\hat{e}_{z_2} = \\hat{e}_{x_2} \\times \\hat{e}_{y_2}\\quad\\text{(completes right-hand system)}\\]
      </div>
      <div class="eq-block">
        <div class="eq-label">ECEF → Vehicle-Pointing rotation</div>
        \\[\\mathbf{T}_{\\text{ECEF} \\to \\text{VP}} = R_Y(-\\phi)\\,R_Z(\\lambda)\\]
      </div>`,
    camera: { pos: [6, 5, 10], target: [0, 0, 0], dur: 1.2 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ rst: true }); // RST only — origin marker at spacecraft
      animateGroupIn(STATE.persistent.rstGroup, 0.3);
    },
    exit() {},
  },

  // ── 4: Longitude & Latitude ────────────────────────────────────────────
  {
    title: 'Longitude λ and Latitude ϕ',
    html: `
      <p>The vehicle's position on the rotating planet is described by
      <strong>geocentric longitude</strong>
      <span style="color:#FF44CC;font-weight:600">\\(\\lambda\\)</span> and
      <strong>geocentric latitude</strong>
      <span style="color:#44FFEE;font-weight:600">\\(\\phi\\)</span>.
      The <span style="color:#FFD700;font-weight:600">velocity vector <em>v</em></span>
      can be broken into components that directly drive these rates —
      press <strong>Next →</strong> to see each step.</p>`,
    camera: { pos: [3, 5, 7], target: [0, 0, 0], dur: 1.0 },
    substeps: [
      // ── substep 0: Step 1 — γ decomposition (animated) ──
      {
        html: `
          <div class="eq-block">
            <div class="eq-label">Step 1 — Split v by flight-path angle γ</div>
            \\[\\underbrace{\\textcolor{#FF5555}{v\\sin\\gamma}}_{\\dot{r}\\ =\\ \\text{radial rate}}
              \\qquad
              \\underbrace{\\textcolor{#00DDFF}{v\\cos\\gamma}}_{v_h\\ =\\ \\text{horizontal speed}}\\]
          </div>`,
        enter3D() {
          const GAMMA  = 25 * Math.PI / 180;
          const s      = getSpacecraftState(0.72);
          const R      = s.R_hat;
          const hDir   = s.vel.clone().normalize();
          const vLen   = 0.82;
          const hLen   = vLen * Math.cos(GAMMA);
          const vHat   = hDir.clone().multiplyScalar(Math.cos(GAMMA)).addScaledVector(R, Math.sin(GAMMA)).normalize();
          const hEnd   = s.pos.clone().addScaledVector(hDir, hLen);
          const vTip   = s.pos.clone().addScaledVector(vHat, vLen);

          // ── Zoom camera to close-up of vehicle first ──
          const side = new THREE.Vector3().crossVectors(R, hDir).normalize();
          const cp = s.pos.clone()
            .addScaledVector(hDir, -1.8)
            .addScaledVector(R,     0.7)
            .addScaledVector(side,  1.3);
          tweenCamera([cp.x, cp.y, cp.z], [s.pos.x, s.pos.y, s.pos.z], 0.85);
          const CAM_DELAY = 1.0;

          // ── Build all geometry at scale≈0 (hidden until camera arrives) ──
          const cg = new THREE.Group();
          cg.position.copy(s.pos);
          cg.add(new THREE.ArrowHelper(hDir, new THREE.Vector3(), hLen, 0x00DDFF, 0.07, 0.035));
          cg.scale.set(0.001, 0.001, 0.001);
          addSlideObj(cg);

          const sinVec = new THREE.Vector3().subVectors(vTip, hEnd);
          const sinLen = sinVec.length();
          const sinDir = sinVec.clone().normalize();
          const rg = new THREE.Group();
          rg.position.copy(hEnd);
          rg.add(new THREE.ArrowHelper(sinDir, new THREE.Vector3(), sinLen, 0xFF5555, 0.07, 0.035));
          rg.scale.set(0.001, 0.001, 0.001);
          addSlideObj(rg);

          const ra    = 0.036;
          const raMat = new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0 });
          addSlideObj(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              hEnd.clone().addScaledVector(R, ra),
              hEnd.clone().addScaledVector(R, ra).addScaledVector(hDir, -ra),
              hEnd.clone().addScaledVector(hDir, -ra),
            ]), raMat));

          // ── γ arc sweeps from hDir to vHat in the hDir-R plane ──
          const arcR   = 0.22;
          const arcMat = new THREE.LineBasicMaterial({ color: 0xFFEE77, transparent: true, opacity: 0 });
          const gArc   = makeAngleArc(s.pos, hDir, R, arcR, 0, GAMMA, 0xFFEE77);
          gArc.material = arcMat;
          addSlideObj(gArc);

          const lblG = new THREE.Group();
          lblG.add(makeFloatLabel('v cosγ',
            s.pos.clone().addScaledVector(hDir, hLen * 0.5).addScaledVector(R, -0.13), 0x00DDFF));
          lblG.add(makeFloatLabel('v sinγ',
            hEnd.clone().lerp(vTip, 0.5).addScaledVector(hDir, -0.16), 0xFF5555));
          // γ label at arc midpoint
          const gammaA = GAMMA / 2;
          lblG.add(makeFloatLabel('γ',
            s.pos.clone()
              .addScaledVector(hDir, (arcR + 0.10) * Math.cos(gammaA))
              .addScaledVector(R,    (arcR + 0.10) * Math.sin(gammaA)),
            0xFFEE77));
          lblG.visible = false;
          addSlideObj(lblG);

          // ── Start projection animations once camera has arrived ──
          const gen0 = STATE.slideGen;
          gsap.delayedCall(CAM_DELAY, () => {
            if (STATE.slideGen !== gen0) return;
            gsap.to(cg.scale,  { x: 1, y: 1, z: 1, duration: 0.75, ease: 'power2.out' });
            gsap.to(rg.scale,  { x: 1, y: 1, z: 1, duration: 0.60, delay: 0.60, ease: 'power2.out' });
            gsap.to(raMat,     { opacity: 0.6,  duration: 0.35, delay: 1.20 });
            gsap.to(arcMat,    { opacity: 0.90, duration: 0.35, delay: 1.20 });
            gsap.delayedCall(1.3, () => {
              if (STATE.slideGen !== gen0) return;
              lblG.visible = true;
              lblG.traverse(c => { if (c.isCSS2DObject) c.element.style.display = ''; });
            });
          });
        },
      },
      // ── substep 1: Step 2 — ψ split (animated) ──
      {
        html: `
          <div class="eq-block">
            <div class="eq-label">Step 2 — Split v cosγ by heading angle ψ</div>
            \\[v_{\\text{east}} = \\textcolor{#FF44CC}{v\\cos\\gamma\\cos\\psi}
              \\qquad
              v_{\\text{north}} = \\textcolor{#44FF88}{v\\cos\\gamma\\sin\\psi}\\]
          </div>`,
        enter3D() {
          const GAMMA    = 25 * Math.PI / 180;
          const cosG     = Math.cos(GAMMA);
          const s        = getSpacecraftState(0.72);
          const R        = s.R_hat;
          const hDir     = s.vel.clone().normalize();
          const vLen     = 0.82;
          const hLen     = vLen * cosG;
          const psi      = Math.atan2(hDir.dot(s.T_hat), hDir.dot(s.S_hat));
          const hEnd     = s.pos.clone().addScaledVector(hDir, hLen);
          const eastEnd  = s.pos.clone().addScaledVector(s.S_hat, hLen * Math.cos(psi));

          // ── Zoom to slightly overhead so the horizontal split is clear ──
          const cp2 = s.pos.clone()
            .addScaledVector(R,    2.0)
            .addScaledVector(hDir, 0.4);
          tweenCamera([cp2.x, cp2.y, cp2.z], [s.pos.x, s.pos.y, s.pos.z], 0.85);
          const CAM_DELAY = 1.0;

          // ── Build geometry at scale≈0 ──
          const mg = Math.abs(Math.cos(psi)) > 0.05 ? (() => {
            const g = new THREE.Group();
            g.position.copy(s.pos);
            g.add(new THREE.ArrowHelper(
              s.S_hat.clone().multiplyScalar(Math.sign(Math.cos(psi))),
              new THREE.Vector3(), hLen * Math.abs(Math.cos(psi)), 0xFF44CC, 0.06, 0.03));
            g.scale.set(0.001, 0.001, 0.001);
            addSlideObj(g);
            return g;
          })() : null;

          const northVec = new THREE.Vector3().subVectors(hEnd, eastEnd);
          const northLen = northVec.length();
          const northDir = northVec.clone().normalize();
          const ng = new THREE.Group();
          ng.position.copy(eastEnd);
          ng.add(new THREE.ArrowHelper(northDir, new THREE.Vector3(), northLen, 0x44FF88, 0.06, 0.030));
          ng.scale.set(0.001, 0.001, 0.001);
          addSlideObj(ng);

          const rb    = 0.030;
          const perp2 = new THREE.Vector3().crossVectors(s.S_hat, R).normalize();
          const rbMat = new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0 });
          addSlideObj(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              eastEnd.clone().addScaledVector(perp2, rb),
              eastEnd.clone().addScaledVector(perp2, rb).addScaledVector(s.S_hat, rb),
              eastEnd.clone().addScaledVector(s.S_hat, rb),
            ]), rbMat));

          // ── ψ arc sweeps from S_hat (east) to hDir in the horizontal plane ──
          const psiArcR   = 0.22;
          const psiArcMat = new THREE.LineBasicMaterial({ color: 0xFFEE77, transparent: true, opacity: 0 });
          const psiArc    = makeAngleArc(s.pos, s.S_hat, s.T_hat, psiArcR, 0, psi, 0xFFEE77);
          psiArc.material = psiArcMat;
          addSlideObj(psiArc);

          const enG = new THREE.Group();
          enG.add(makeFloatLabel('v cosγ cosψ',
            s.pos.clone().addScaledVector(s.S_hat, hLen * Math.cos(psi) * 0.5).addScaledVector(R, -0.14),
            0xFF44CC));
          enG.add(makeFloatLabel('v cosγ sinψ',
            eastEnd.clone().lerp(hEnd, 0.5).addScaledVector(s.S_hat, -0.17),
            0x44FF88));
          // ψ label at arc midpoint
          const psiA = psi / 2;
          enG.add(makeFloatLabel('ψ',
            s.pos.clone()
              .addScaledVector(s.S_hat, (psiArcR + 0.10) * Math.cos(psiA))
              .addScaledVector(s.T_hat, (psiArcR + 0.10) * Math.sin(psiA)),
            0xFFEE77));
          enG.visible = false;
          addSlideObj(enG);

          // ── Start animations once camera has arrived ──
          const gen1 = STATE.slideGen;
          gsap.delayedCall(CAM_DELAY, () => {
            if (STATE.slideGen !== gen1) return;
            if (mg) gsap.to(mg.scale, { x: 1, y: 1, z: 1, duration: 0.75, ease: 'power2.out' });
            gsap.to(ng.scale,    { x: 1, y: 1, z: 1, duration: 0.60, delay: 0.60, ease: 'power2.out' });
            gsap.to(rbMat,       { opacity: 0.55, duration: 0.35, delay: 1.20 });
            gsap.to(psiArcMat,   { opacity: 0.90, duration: 0.35, delay: 1.20 });
            gsap.delayedCall(1.3, () => {
              if (STATE.slideGen !== gen1) return;
              enG.visible = true;
              enG.traverse(c => { if (c.isCSS2DObject) c.element.style.display = ''; });
            });
          });
        },
      },
      // ── substep 2: Step 3 — angular rates (equations only) ──
      {
        html: `
          <div class="eq-block">
            <div class="eq-label">Step 3 — Convert speed to angular rate</div>
            \\[\\textcolor{#44FFEE}{\\dot{\\phi}} = \\frac{v_{\\text{north}}}{r} = \\frac{\\textcolor{#44FF88}{v\\cos\\gamma\\sin\\psi}}{r}\\]
            \\[\\textcolor{#FF44CC}{\\dot{\\lambda}} = \\frac{v_{\\text{east}}}{r\\cos\\textcolor{#44FFEE}{\\phi}} = \\frac{\\textcolor{#FF44CC}{v\\cos\\gamma\\cos\\psi}}{r\\cos\\textcolor{#44FFEE}{\\phi}}\\]
          </div>
          <p style="font-size:0.82rem;color:#6a90b0;margin-top:0.4rem;">
            The extra \\(\\cos\\textcolor{#44FFEE}{\\phi}\\) in
            \\(\\textcolor{#FF44CC}{\\dot\\lambda}\\):
            a latitude circle at \\(\\textcolor{#44FFEE}{\\phi}\\) has radius
            \\(r\\cos\\textcolor{#44FFEE}{\\phi}\\) — same eastward speed covers more
            \\(\\textcolor{#FF44CC}{\\lambda}\\) degrees near the equator than near the poles.</p>`,
        enter3D() {},
      },
    ],
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({});

      const s      = getSpacecraftState(0.72);
      // Re-tween camera with spacecraft as pivot so OrbitControls orbits around it
      // Position: +z > 0.615*+x so Earth appears on the left, close enough to see spacecraft clearly
      tweenCamera([2.0, 1.5, 2.5], [s.pos.x, s.pos.y, s.pos.z], 1.0);
      const R      = s.R_hat;
      const phi    = Math.asin(R.y);
      const lambda = Math.atan2(R.z, R.x);

      // Latitude ring (magenta)
      const latPts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        latPts.push(new THREE.Vector3(
          Math.cos(phi) * Math.cos(a) * (EARTH_RADIUS + 0.008),
          Math.sin(phi)              * (EARTH_RADIUS + 0.008),
          Math.cos(phi) * Math.sin(a) * (EARTH_RADIUS + 0.008)
        ));
      }
      addSlideObj(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(latPts),
        new THREE.LineBasicMaterial({ color: 0xFF44CC, transparent: true, opacity: 0.85 })
      ));
      // Meridian arc (teal)
      const merPts = [];
      for (let i = 0; i <= 48; i++) {
        const p = (i / 48) * phi;
        merPts.push(new THREE.Vector3(
          Math.cos(p) * Math.cos(lambda) * (EARTH_RADIUS + 0.008),
          Math.sin(p)                    * (EARTH_RADIUS + 0.008),
          Math.cos(p) * Math.sin(lambda) * (EARTH_RADIUS + 0.008)
        ));
      }
      addSlideObj(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(merPts),
        new THREE.LineBasicMaterial({ color: 0x44FFEE, transparent: true, opacity: 0.85 })
      ));
      // Radial altitude line
      const subPt  = R.clone().multiplyScalar(EARTH_RADIUS + 0.008);
      const altLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([subPt, s.pos]),
        new THREE.LineDashedMaterial({ color: 0x334466, dashSize: 0.04, gapSize: 0.03, opacity: 0.6, transparent: true })
      );
      altLine.computeLineDistances();
      addSlideObj(altLine);
      // φ / λ labels
      const lG = new THREE.Group();
      lG.add(makeFloatLabel('φ (lat)',
        new THREE.Vector3(
          Math.cos(phi * 0.55) * Math.cos(lambda) * (EARTH_RADIUS + 0.15),
          Math.sin(phi * 0.55)                    * (EARTH_RADIUS + 0.15),
          Math.cos(phi * 0.55) * Math.sin(lambda) * (EARTH_RADIUS + 0.15)), 0x44FFEE));
      lG.add(makeFloatLabel('λ (lon)',
        new THREE.Vector3(
          Math.cos(phi) * Math.cos(lambda + Math.PI * 0.3) * (EARTH_RADIUS + 0.2),
          Math.sin(phi)                                    * (EARTH_RADIUS + 0.2),
          Math.cos(phi) * Math.sin(lambda + Math.PI * 0.3) * (EARTH_RADIUS + 0.2)), 0xFF44CC));
      addSlideObj(lG);

      // Gold velocity arrow — animates in with a slight overshoot
      const GAMMA    = 25 * Math.PI / 180;
      const hDir     = s.vel.clone().normalize();
      const vHatDemo = hDir.clone().multiplyScalar(Math.cos(GAMMA)).addScaledVector(R, Math.sin(GAMMA)).normalize();
      const vLen     = 0.82;
      const vg = new THREE.Group();
      vg.position.copy(s.pos);
      vg.add(new THREE.ArrowHelper(vHatDemo, new THREE.Vector3(), vLen, 0xFFD700, 0.09, 0.045));
      vg.scale.set(0.001, 0.001, 0.001);
      addSlideObj(vg);
      gsap.to(vg.scale, { x: 1, y: 1, z: 1, duration: 0.8, delay: 0.25, ease: 'back.out(1.3)' });
      // Label appears after arrow
      const lblG = new THREE.Group();
      lblG.add(makeFloatLabel('v  (γ=25° demo)',
        s.pos.clone().addScaledVector(vHatDemo, vLen * 0.52).addScaledVector(R, 0.13), 0xFFD700));
      lblG.visible = false;
      addSlideObj(lblG);
      const genV = STATE.slideGen;
      gsap.delayedCall(0.85, () => {
        if (STATE.slideGen !== genV) return;
        lblG.visible = true;
        lblG.traverse(c => { if (c.isCSS2DObject) c.element.style.display = ''; });
      });
    },
    exit() {},
  },

  // ── 5: Flight-Path Angle γ ─────────────────────────────────────────────
  {
    title: 'Flight-Path Angle γ',
    html: `
      <p>The <strong>flight-path angle</strong>
      <span style="color:#FFEE77">\\(\\gamma\\)</span> is the angle between the
      <em>local horizontal plane</em> and the
      <span style="color:#FFD700">velocity vector</span>.</p>
      <div class="eq-block">
        <div class="eq-label">Radial rate</div>
        \\[\\textcolor{#FF5555}{\\dot{r}} = \\textcolor{#FFD700}{v}\\,\\sin\\,\\textcolor{#FFEE77}{\\gamma}\\]
      </div>
      <ul>
        <li>\\(\\textcolor{#44FF88}{\\gamma > 0}\\) — <span style="color:#44FF88">climbing</span> (velocity above local horizontal)</li>
        <li>\\(\\textcolor{#FF5555}{\\gamma < 0}\\) — <span style="color:#FF5555">descending</span> (entry corridor)</li>
        <li>\\(\\textcolor{#FFD700}{\\gamma = 0}\\) — purely horizontal flight</li>
      </ul>
      <p>Watch the <span style="color:#FFD700">gold velocity arrow</span> sweep as
      <span style="color:#FFEE77">\\(\\gamma\\)</span> varies.</p>
      <div id="gamma-readout" style="margin-top:0.9rem;padding:0.7rem 1.1rem;background:#07162a;border:1px solid #1e3a5f;border-radius:8px;text-align:center;line-height:1.7;"></div>`,
    camera: { pos: [2.0, 1.5, 2.5], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vel: true });

      const s = getSpacecraftState(0.72);
      tweenCamera([2.0, 1.5, 2.5], [s.pos.x, s.pos.y, s.pos.z], 1.0);
      const R     = s.R_hat;
      const vel0  = s.vel.clone().normalize();
      const vel_h = vel0.clone().addScaledVector(R, -vel0.dot(R)).normalize();

      // ── Local horizontal disc ──
      addSlideObj(makeHorizDisc(s.pos, R, 0.62));

      // ── Dynamic γ arc — radius 0.65 so it spans close to the arrow tip ──
      const arcPts = [];
      for (let i = 0; i <= 40; i++) arcPts.push(new THREE.Vector3());
      const gammaArcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
      const gammaArc    = new THREE.Line(gammaArcGeo,
        new THREE.LineBasicMaterial({ color: COLORS.arc, transparent: true, opacity: 0.9 }));
      addSlideObj(gammaArc);

      const ARC_R = 0.65;

      function rebuildArc(g) {
        const pts = [];
        for (let i = 0; i <= 40; i++) {
          const a = (i / 40) * g;
          pts.push(s.pos.clone().add(
            vel_h.clone().multiplyScalar(Math.cos(a)).addScaledVector(R, Math.sin(a)).multiplyScalar(ARC_R)
          ));
        }
        gammaArcGeo.setFromPoints(pts);
      }

      // ── Horizontal reference dash ──
      const hRefLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([s.pos.clone(), s.pos.clone().addScaledVector(vel_h, 0.75)]),
        new THREE.LineDashedMaterial({ color: 0x4488cc, dashSize: 0.04, gapSize: 0.03, opacity: 0.7, transparent: true })
      );
      hRefLine.computeLineDistances();
      addSlideObj(hRefLine);

      // ── γ label floating near the arc midpoint in 3D space ──
      const gammaLblEl = document.createElement('div');
      gammaLblEl.style.cssText = 'font-size:13px;font-weight:700;font-family:Segoe UI,system-ui,sans-serif;pointer-events:none;text-shadow:0 0 8px rgba(0,0,0,1);white-space:nowrap;';
      const gammaLblObj = new CSS2DObject(gammaLblEl);
      addSlideObj(gammaLblObj);

      function updateHUD(g) {
        const deg   = g * 180 / Math.PI;
        const color = deg >  0.5 ? '#44FF88' : deg < -0.5 ? '#FF5555' : '#FFD700';
        const arrow = deg >  0.5 ? '↑' : deg < -0.5 ? '↓' : '→';
        const label = deg >  0.5 ? 'Climbing' : deg < -0.5 ? 'Descending' : 'Horizontal';
        const sign  = deg > 0    ? '+' : '';

        // 3D arc label — angle value + color, sits just outside arc midpoint
        const mid = g / 2;
        gammaLblObj.position.copy(s.pos.clone().add(
          vel_h.clone().multiplyScalar(Math.cos(mid)).addScaledVector(R, Math.sin(mid)).multiplyScalar(ARC_R + 0.14)
        ));
        gammaLblEl.style.color = color;
        gammaLblEl.textContent = `γ = ${sign}${deg.toFixed(1)}°`;

        // Panel readout
        const readout = document.getElementById('gamma-readout');
        if (readout) {
          readout.style.borderColor = color;
          readout.innerHTML = `
            <div style="font-size:10px;letter-spacing:.1em;color:#3a6a9a;text-transform:uppercase;margin-bottom:2px">Live Flight-Path Angle</div>
            <div style="font-size:26px;font-weight:700;color:${color};letter-spacing:.02em">γ = ${sign}${deg.toFixed(1)}°</div>
            <div style="font-size:13px;color:${color}">${arrow}&nbsp;${label}</div>
          `;
        }
      }

      // ── Oscillating γ animation ──
      const swing = { g: -28 * Math.PI / 180 };
      rebuildArc(swing.g);
      updateHUD(swing.g);
      STATE.gammaAnim = gsap.to(swing, {
        g: 28 * Math.PI / 180,
        duration: 2.2,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
        onUpdate() {
          const dir = vel_h.clone()
            .multiplyScalar(Math.cos(swing.g))
            .addScaledVector(R, Math.sin(swing.g))
            .normalize();
          STATE.persistent.velArrow.setDirection(dir);
          rebuildArc(swing.g);
          updateHUD(swing.g);
        }
      });
    },
    exit() {
      // Kill animation and reset velArrow to true velocity direction
      if (STATE.gammaAnim) { STATE.gammaAnim.kill(); STATE.gammaAnim = null; }
      const s = getSpacecraftState(0.72);
      if (STATE.persistent.velArrow) STATE.persistent.velArrow.setDirection(s.vel.clone().normalize());
    },
  },

  // ── 6: Heading Angle ψ ─────────────────────────────────────────────────
  {
    title: 'Heading Angle ψ',
    html: `
      <p>The <strong>heading angle</strong>
      <span style="color:#FFEE77">\\(\\psi\\)</span> describes the direction of
      horizontal flight — measured from
      <span style="color:#FF44CC">East (S)</span> toward
      <span style="color:#44FFEE">North (T)</span>.</p>
      <div class="eq-block">
        <div class="eq-label">Where each arrow comes from</div>
        <p style="font-size:0.82rem;margin-bottom:0.4rem">
          <span style="color:#00DDFF">\\(v\\cos\\gamma\\)</span>
          = horizontal speed &nbsp;→&nbsp; split by \\(\\psi\\):
        </p>
        \\[\\textcolor{#FF44CC}{\\dot{\\lambda}} =
          \\frac{\\textcolor{#00DDFF}{v\\cos\\gamma}\\,\\textcolor{#FF44CC}{\\cos\\psi}}{r\\cos\\textcolor{#44FFEE}{\\phi}}
          \\quad \\leftarrow \\textcolor{#FF44CC}{\\text{east component}}\\]
        \\[\\textcolor{#44FFEE}{\\dot{\\phi}} =
          \\frac{\\textcolor{#00DDFF}{v\\cos\\gamma}\\,\\textcolor{#44FFEE}{\\sin\\psi}}{r}
          \\quad \\leftarrow \\textcolor{#44FFEE}{\\text{north component}}\\]
      </div>
      <ul>
        <li>\\(\\psi = 0°\\): all eastward → only
          <span style="color:#FF44CC">\\(\\dot\\lambda\\)</span> grows</li>
        <li>\\(\\psi = 90°\\): all northward → only
          <span style="color:#44FFEE">\\(\\dot\\phi\\)</span> grows</li>
      </ul>
      <p style="font-size:0.82rem;color:#6a90b0">
        The arrows in the scene are the two components — their lengths are
        proportional to <span style="color:#FF44CC">cos ψ</span> and
        <span style="color:#44FFEE">sin ψ</span>.</p>`,
    camera: { pos: [2.5, 1.5, 1.5], target: [0, 0, 0], dur: 1.2 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vel: true });

      const s    = getSpacecraftState(0.72);
      const R    = s.R_hat;
      const vel0 = s.vel.clone().normalize();
      const vel_h = vel0.clone().addScaledVector(R, -vel0.dot(R)).normalize();
      const psi   = Math.atan2(vel_h.dot(s.T_hat), vel_h.dot(s.S_hat));
      const hLen  = 0.65;  // horizontal speed visual length

      // ── Horizontal disc ──
      addSlideObj(makeHorizDisc(s.pos, R, 0.62));

      // ── ψ arc from S_hat to vel_h ──
      const psiArc = makeAngleArc(s.pos, s.S_hat, s.T_hat, 0.38, 0, psi, COLORS.arc);
      addSlideObj(psiArc);

      // ── Horizontal velocity dashed line ──
      const projLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([s.pos, s.pos.clone().addScaledVector(vel_h, hLen)]),
        new THREE.LineDashedMaterial({ color: 0x00DDFF, dashSize: 0.045, gapSize: 0.03, opacity: 0.7, transparent: true })
      );
      projLine.computeLineDistances();
      addSlideObj(projLine);

      // ── East component arrow (magenta) → drives λ̇ ──
      const eastLen = hLen * Math.abs(Math.cos(psi));
      const eastDir = s.S_hat.clone().multiplyScalar(Math.sign(Math.cos(psi)));
      const eastArrow = new THREE.ArrowHelper(eastDir, s.pos, eastLen, 0xFF44CC, 0.07, 0.035);
      addSlideObj(eastArrow);

      // ── North component arrow (teal) → drives φ̇ ──
      const northEnd  = s.pos.clone().addScaledVector(s.S_hat, eastLen * Math.sign(Math.cos(psi)));
      const northLen  = hLen * Math.abs(Math.sin(psi));
      const northDir  = s.T_hat.clone().multiplyScalar(Math.sign(Math.sin(psi)));
      const northArrow = new THREE.ArrowHelper(northDir, northEnd, northLen, 0x44FFEE, 0.07, 0.035);
      addSlideObj(northArrow);

      // ── Right-angle marker at corner of the triangle ──
      const ra = 0.032;
      const raMat = new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.5 });
      addSlideObj(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          northEnd.clone().addScaledVector(s.S_hat.clone().multiplyScalar(-Math.sign(Math.cos(psi))), ra),
          northEnd.clone()
            .addScaledVector(s.S_hat.clone().multiplyScalar(-Math.sign(Math.cos(psi))), ra)
            .addScaledVector(northDir, ra),
          northEnd.clone().addScaledVector(northDir, ra),
        ]), raMat));

      // ── East reference dashed line ──
      const eastRefLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([s.pos, s.pos.clone().addScaledVector(s.S_hat, 0.55)]),
        new THREE.LineDashedMaterial({ color: 0xFF44CC, dashSize: 0.04, gapSize: 0.03, opacity: 0.45, transparent: true })
      );
      eastRefLine.computeLineDistances();
      addSlideObj(eastRefLine);

      // ── Labels ──
      const psiMidDir = s.S_hat.clone().multiplyScalar(Math.cos(psi * 0.5))
        .addScaledVector(s.T_hat, Math.sin(psi * 0.5));
      const psiDeg = (psi * 180 / Math.PI).toFixed(1);
      const lG = new THREE.Group();
      // ψ arc label with value
      lG.add(makeFloatLabel(`ψ = ${psiDeg}°`, s.pos.clone().addScaledVector(psiMidDir, 0.52), COLORS.arc));
      // East reference label
      lG.add(makeFloatLabel('East (S →λ̇)', s.pos.clone().addScaledVector(s.S_hat, 0.62), 0xFF44CC));
      // East component label (at arrow midpoint)
      lG.add(makeFloatLabel('v cosγ cosψ',
        s.pos.clone().addScaledVector(s.S_hat, eastLen * 0.5 * Math.sign(Math.cos(psi))).addScaledVector(R, -0.08),
        0xFF44CC));
      // North component label (at arrow midpoint)
      lG.add(makeFloatLabel('v cosγ sinψ',
        northEnd.clone().addScaledVector(northDir, northLen * 0.5).addScaledVector(R, -0.08),
        0x44FFEE));
      addSlideObj(lG);
    },
    exit() {},
  },

  // ── 7: Velocity-Referenced Frame ───────────────────────────────────────
  {
    title: 'Velocity-Referenced Frame (VRF)',
    html: `
      <p>The <span class="chip chip-vrf">VRF</span> is obtained from RST by two rotations
      that align the \\(x_v\\)-axis with the velocity vector.</p>
      <div class="eq-block">
        <div class="eq-label">Two-step rotation</div>
        \\[\\mathbf{T}_{\\text{RST} \\to \\text{VRF}} = R_Y(-\\gamma)\\,R_Z(\\psi)\\]
      </div>
      <div class="eq-block">
        <div class="eq-label">Axis definitions</div>
        \\[\\hat{x}_v \\parallel \\vec{v}\\quad(\\text{along velocity})\\]
        \\[\\hat{z}_v \\perp \\vec{v},\\; \\hat{z}_v \\text{ lies in local horiz. plane}\\]
        \\[\\hat{y}_v = \\hat{z}_v \\times \\hat{x}_v\\]
      </div>
      <p>Forces are most naturally expressed in this frame, then transformed back to
      RST for the equations of motion.</p>
      <div style="margin-top:1.1rem;">
        <div style="font-size:0.72rem;letter-spacing:.1em;color:#3a6a9a;text-transform:uppercase;margin-bottom:0.5rem">Toggle Frames</div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button id="toggle-rst" style="padding:.35rem .8rem;background:#160a2a;border:1px solid #CC44FF;border-radius:6px;color:#DD88FF;font-size:.8rem;cursor:pointer;letter-spacing:.04em;transition:opacity .15s,border-color .15s;">● RST</button>
          <button id="toggle-vrf" style="padding:.35rem .8rem;background:#0a1a0a;border:1px solid #44FF44;border-radius:6px;color:#88FF88;font-size:.8rem;cursor:pointer;letter-spacing:.04em;transition:opacity .15s,border-color .15s;">● VRF</button>
          <button id="toggle-vel8" style="padding:.35rem .8rem;background:#1a1200;border:1px solid #FFD700;border-radius:6px;color:#FFD700;font-size:.8rem;cursor:pointer;letter-spacing:.04em;transition:opacity .15s,border-color .15s;">● Velocity</button>
        </div>
      </div>`,
    camera: { pos: [3, 3, 7], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ rst: true, vrf: true, vel: true });

      const s = getSpacecraftState(0.72);
      tweenCamera([3, 3, 7], [s.pos.x, s.pos.y, s.pos.z], 1.0);

      const x_v = s.vel.clone().normalize();
      const z_v = new THREE.Vector3().crossVectors(s.R_hat, x_v).normalize();
      const y_v = new THREE.Vector3().crossVectors(z_v, x_v).normalize();

      const vrfGroup = STATE.persistent.vrfGroup;
      const arrows   = vrfGroup.children.filter(c => c.isArrowHelper);

      const startDirs = [s.R_hat.clone(), s.S_hat.clone(), s.T_hat.clone()];
      const endDirs   = [x_v.clone(),    y_v.clone(),    z_v.clone()];

      if (arrows[0]) arrows[0].setDirection(startDirs[0]);
      if (arrows[1]) arrows[1].setDirection(startDirs[1]);
      if (arrows[2]) arrows[2].setDirection(startDirs[2]);

      // Labels stay visible throughout the rotation animation
      const proxy = { t: 0 };
      STATE.vrfAnim = gsap.to(proxy, {
        t: 1, duration: 1.5, ease: 'power2.inOut', delay: 0.5,
        onUpdate() {
          arrows.forEach((arrow, i) => {
            if (!arrow) return;
            arrow.setDirection(new THREE.Vector3().lerpVectors(startDirs[i], endDirs[i], proxy.t).normalize());
          });
        },
      });

      // ── Frame toggle buttons ──
      function wireToggle(id, grp) {
        const btn = document.getElementById(id);
        if (!btn || !grp) return;
        btn.addEventListener('click', () => {
          const show = !grp.visible;
          grp.visible = show;
          grp.traverse(c => {
            if (c.isCSS2DObject) { c.visible = show; c.element.style.display = show ? '' : 'none'; }
          });
          btn.style.opacity = show ? '1' : '0.35';
        });
      }
      wireToggle('toggle-rst',  STATE.persistent.rstGroup);
      wireToggle('toggle-vrf',  STATE.persistent.vrfGroup);

      const btnVel = document.getElementById('toggle-vel8');
      if (btnVel) {
        btnVel.addEventListener('click', () => {
          const show = !STATE.persistent.velArrow.visible;
          STATE.persistent.velArrow.visible = show;
          btnVel.style.opacity = show ? '1' : '0.35';
        });
      }
    },
    exit() {
      if (STATE.vrfAnim) { STATE.vrfAnim.kill(); STATE.vrfAnim = null; }
      // Restore VRF arrows to their built directions so later slides see correct state
      const s = getSpacecraftState(0.72);
      const x_v = s.vel.clone().normalize();
      const z_v = new THREE.Vector3().crossVectors(s.R_hat, x_v).normalize();
      const y_v = new THREE.Vector3().crossVectors(z_v, x_v).normalize();
      const arrows = STATE.persistent.vrfGroup
        ? STATE.persistent.vrfGroup.children.filter(c => c.isArrowHelper)
        : [];
      if (arrows[0]) arrows[0].setDirection(x_v);
      if (arrows[1]) arrows[1].setDirection(y_v);
      if (arrows[2]) arrows[2].setDirection(z_v);
    },
  },

  // ── 8: Newton's 2nd Law ────────────────────────────────────────────────
  {
    title: "Newton's Second Law",
    html: `
      <p>With constant mass, Newton's Second Law in the inertial frame gives us the
      starting point for the entire EOM derivation.</p>
      <div class="eq-block">
        <div class="eq-label">Inertial EOM</div>
        \\[m\\ddot{\\vec{r}}_I = \\vec{F}_T + \\vec{F}_{\\text{aero}} + \\vec{F}_g\\]
      </div>
      <h3>Forces acting on the vehicle</h3>
      <ul>
        <li><span class="chip chip-thrust" data-force-hover="thrust">Thrust</span> — propulsive force</li>
        <li><span class="chip chip-drag" data-force-hover="drag">Drag</span> — aerodynamic retarding force</li>
        <li><span class="chip chip-lift" data-force-hover="lift">Lift</span> — aerodynamic perpendicular force</li>
        <li><span class="chip chip-grav" data-force-hover="grav">Gravity</span> — central body attraction</li>
      </ul>
      <p>The superscript \\(I\\) on \\(\\ddot{\\vec{r}}\\) emphasizes the derivative is taken
      with respect to the <em>inertial</em> frame.</p>`,
    camera: { pos: [4, 3, 7], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vrf: true, vel: true });
      setForceVisibility({ grav: true, drag: true, lift: true });
      [STATE.persistent.gravArrow, STATE.persistent.dragArrow, STATE.persistent.liftArrow]
        .forEach((a, i) => {
          if (!a) return;
          a.scale.set(0, 0, 0);
          a.traverse(o => { if (o.isCSS2DObject) { o.visible = false; o.element.style.display = 'none'; } });
          gsap.to(a.scale, {
            x: 1, y: 1, z: 1, duration: 0.5, delay: 0.3 + i * 0.25, ease: 'back.out(1.4)',
            onComplete() {
              a.traverse(o => { if (o.isCSS2DObject) { o.visible = true; o.element.style.display = ''; } });
            }
          });
        });
    },
    exit() { setForceVisibility({}); },
  },

  // ── 9: Rotating Frame Conversion ───────────────────────────────────────
  {
    title: 'Rotating Frame Conversion',
    html: `
      <p>Reentry trajectory measurement is more convenient in the rotating, planet-fixed
      frame. Converting introduces two new acceleration terms.</p>
      <div class="eq-block">
        <div class="eq-label">Inertial vs. rotating derivative</div>
        \\[\\ddot{\\vec{r}}_I = \\underbrace{\\ddot{\\vec{r}}_{\\text{rot}}}_{\\text{rel. accel.}}
          + \\underbrace{2\\vec{\\Omega}\\times\\dot{\\vec{r}}_{\\text{rot}}}_{\\text{Coriolis}}
          + \\underbrace{\\vec{\\Omega}\\times(\\vec{\\Omega}\\times\\vec{r})}_{\\text{centripetal}}\\]
      </div>
      <ul>
        <li><span class="chip" style="background:#001a1a;border:1px solid #44FFFF;color:#44FFFF" data-force-hover="cor">Coriolis</span> — depends on velocity relative to planet</li>
        <li><span class="chip" style="background:#120a1a;border:1px solid #AA44FF;color:#AA44FF" data-force-hover="cen">Centripetal</span> — depends on distance from spin axis</li>
      </ul>
      <p>Both terms update in real-time as the spacecraft moves — watch the arrows change
      direction along the orbit.</p>`,
    camera: { pos: [5, 5, 8], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ eci: true, ecef: true });
      setForceVisibility({ coriolis: true, centrip: true });
      [STATE.persistent.coriolisArrow, STATE.persistent.centripArrow].forEach((a, i) => {
        if (!a) return;
        a.scale.set(0, 0, 0);
        a.traverse(o => { if (o.isCSS2DObject) { o.visible = false; o.element.style.display = 'none'; } });
        gsap.to(a.scale, {
          x: 1, y: 1, z: 1, duration: 0.5, delay: 0.3 + i * 0.22, ease: 'back.out(1.4)',
          onComplete() {
            a.traverse(o => { if (o.isCSS2DObject) { o.visible = true; o.element.style.display = ''; } });
          }
        });
      });
    },
    exit() { setForceVisibility({}); },
  },

  // ── 10: Gravitational Force ────────────────────────────────────────────
  {
    title: 'Gravitational Force',
    html: `
      <p>Gravity acts radially inward along \\(-\\hat{R}\\) and follows the inverse-square law.</p>
      <div class="eq-block">
        <div class="eq-label">Gravitational force</div>
        \\[\\vec{F}_g = -\\frac{\\mu m}{r^2}\\hat{R}\\]
        \\[\\mu = GM_\\oplus = 3.986 \\times 10^{14}\\ \\text{m}^3/\\text{s}^2\\]
      </div>
      <p>In the vehicle-pointing frame, the gravitational acceleration vector has only
      a radial component:</p>
      <div class="eq-block">
        \\[\\vec{g} = -\\frac{\\mu}{r^2}\\hat{R} = \\begin{bmatrix}-g \\\\ 0 \\\\ 0\\end{bmatrix}_{\\text{RST}}\\]
      </div>
      <p>The <span class="chip chip-grav" data-force-hover="grav">gravity arrow</span> grows longer as the spacecraft
      descends closer to Earth.</p>`,
    camera: { pos: [4, 2, 9], target: [0, 0, 0], dur: 1.2 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ rst: true });
      setForceVisibility({ grav: true });
      const s = getSpacecraftState(0.72);
      addSlideObj(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), s.pos]),
        new THREE.LineBasicMaterial({ color: COLORS.grav, transparent: true, opacity: 0.30 })
      ));
    },
    exit() { setForceVisibility({}); },
  },

  // ── 11: Drag Force ─────────────────────────────────────────────────────
  {
    title: 'Drag Force',
    html: `
      <p><span class="chip chip-drag" data-force-hover="drag">Drag</span> acts directly <em>opposite</em> to the velocity vector — always in the
      \\(-\\hat{x}_v\\) direction of the VRF.</p>
      <div class="eq-block">
        <div class="eq-label">Aerodynamic drag</div>
        \\[\\vec{F}_D = -\\frac{1}{2}\\rho V^2 S C_D\\,\\hat{v}\\]
      </div>
      <ul>
        <li>\\(\\rho\\) — atmospheric density (decreases with altitude)</li>
        <li>\\(V\\) — speed relative to planet-fixed frame</li>
        <li>\\(S\\) — reference area</li>
        <li>\\(C_D\\) — drag coefficient</li>
      </ul>
      <div class="eq-block">
        <div class="eq-label">In vehicle-pointing frame</div>
        \\[\\vec{F}_D = \\begin{bmatrix}
          D\\sin\\gamma \\\\ -D\\cos\\gamma\\cos\\psi \\\\ -D\\cos\\gamma\\sin\\psi
        \\end{bmatrix}_{\\text{RST}}\\]
      </div>`,
    camera: { pos: [4, 3, 7], target: [0, 0, 0], dur: 0.8 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vrf: true, vel: true });
      setForceVisibility({ drag: true });
      if (STATE.persistent.dragArrow) STATE.persistent.dragArrow.scale.set(1.4, 1.4, 1.4);
    },
    exit() {
      if (STATE.persistent.dragArrow) STATE.persistent.dragArrow.scale.set(1, 1, 1);
      setForceVisibility({});
    },
  },

  // ── 12: Lift Force & Bank Angle ────────────────────────────────────────
  {
    title: 'Lift Force & Bank Angle θ',
    html: `
      <p>Lift is <em>perpendicular</em> to velocity. The <strong>bank angle</strong>
      \\(\\theta\\) defines its orientation about the velocity axis.</p>
      <div class="eq-block">
        <div class="eq-label">L-V-N reference frame</div>
        \\[\\hat{V} \\parallel \\vec{v},\\quad \\hat{L} = \\hat{V}\\times\\hat{N},\\quad
        \\hat{N} = -(\\hat{R} - (\\hat{R}\\cdot\\hat{V})\\hat{V})^{\\text{norm}}\\]
      </div>
      <div class="eq-block">
        <div class="eq-label">Lift vector</div>
        \\[\\vec{F}_L = L(\\cos\\theta\\,\\hat{L} + \\sin\\theta\\,\\hat{N})\\]
      </div>
      <p>Watch the <span class="chip chip-lift" data-force-hover="lift">lift arrow</span> rotate around the velocity
      axis as bank angle \\(\\theta\\) changes — this is how a lifting entry vehicle controls
      its trajectory.</p>`,
    camera: { pos: [3, 4, 6], target: [0, 0, 0], dur: 1.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vrf: true, vel: true });
      setForceVisibility({ lift: true });

      const s = getSpacecraftState(0.72);
      const v_h = s.vel.clone().normalize();
      const R   = s.R_hat;
      const lift_hat = R.clone().addScaledVector(v_h, -R.dot(v_h)).normalize();
      const lat_hat  = new THREE.Vector3().crossVectors(v_h, lift_hat).normalize();

      // L-V-N triad arrows (N = downward, L = lateral)
      const lvnGroup = new THREE.Group();
      lvnGroup.add(makeArrow(lift_hat.clone().negate(), s.pos, 0.38, 0x8888FF, 'N̂'));
      lvnGroup.add(makeArrow(lat_hat,                   s.pos, 0.38, 0xFF88AA, 'L̂'));
      addSlideObj(lvnGroup);

      // θ arc (0° → 60°) in the perpendicular plane
      const arcPts = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * (Math.PI / 3);
        arcPts.push(s.pos.clone()
          .addScaledVector(lift_hat, Math.cos(a) * 0.30)
          .addScaledVector(lat_hat,  Math.sin(a) * 0.30));
      }
      addSlideObj(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arcPts),
        new THREE.LineBasicMaterial({ color: COLORS.arc })
      ));

      // θ label at arc midpoint (30°)
      const lG = new THREE.Group();
      lG.add(makeFloatLabel('θ',
        s.pos.clone()
          .addScaledVector(lift_hat, Math.cos(Math.PI / 6) * 0.42)
          .addScaledVector(lat_hat,  Math.sin(Math.PI / 6) * 0.42),
        COLORS.arc));
      addSlideObj(lG);

      // Bank angle animation: rotate lift around velocity axis, yoyo 0°→60°
      const theta = { val: 0 };
      STATE.bankAnim = gsap.to(theta, {
        val: Math.PI / 3, duration: 2.2, ease: 'power2.inOut', repeat: -1, yoyo: true,
        onUpdate() {
          if (!STATE.persistent.liftArrow) return;
          // Lift rotates around velocity axis by θ
          const bankUp = lift_hat.clone().multiplyScalar(Math.cos(theta.val))
            .addScaledVector(lat_hat, Math.sin(theta.val));
          STATE.persistent.liftArrow.setDirection(bankUp.clone().normalize());
          // Roll the spacecraft in sync — bank angle is rotation of body around velocity axis
          if (STATE.spacecraft) {
            const mat = new THREE.Matrix4().lookAt(
              s.pos, s.pos.clone().add(s.vel), bankUp
            );
            STATE.spacecraft.quaternion.setFromRotationMatrix(mat);
            STATE.spacecraft.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
          }
        }
      });
    },
    exit() {
      if (STATE.bankAnim) { STATE.bankAnim.kill(); STATE.bankAnim = null; }
      const s  = getSpacecraftState(0.72);
      const vh = s.vel.clone().normalize();
      const lh = s.R_hat.clone().addScaledVector(vh, -s.R_hat.dot(vh)).normalize();
      if (STATE.persistent.liftArrow) STATE.persistent.liftArrow.setDirection(lh);
      // Restore spacecraft to wings-level (θ = 0)
      if (STATE.spacecraft) {
        const mat = new THREE.Matrix4().lookAt(s.pos, s.pos.clone().add(s.vel), lh);
        STATE.spacecraft.quaternion.setFromRotationMatrix(mat);
        STATE.spacecraft.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      }
      setForceVisibility({});
    },
  },

  // ── 13: Thrust Force ───────────────────────────────────────────────────
  {
    title: 'Thrust Force',
    html: `
      <p>Thrust is expressed in the VRF using a pitch angle \\(\\alpha_T\\) and a
      bank angle \\(\\beta_T\\).</p>
      <div class="eq-block">
        <div class="eq-label">Thrust vector (VRF)</div>
        \\[\\vec{F}_T = T\\begin{bmatrix}
          \\cos\\alpha_T \\\\
          \\sin\\alpha_T\\cos\\beta_T \\\\
          \\sin\\alpha_T\\sin\\beta_T
        \\end{bmatrix}_{\\text{VRF}}\\]
      </div>
      <p>Transforming to RST via \\(\\mathbf{T}_{\\text{VRF}\\to\\text{RST}}\\) gives the
      thrust components used in the force equations.</p>
      <p>All four forces are now simultaneously visible on the vehicle.</p>
      <p style="margin-top:0.9rem;font-size:0.82rem;color:#3a6a9a;">Hover to highlight in scene:</p>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.3rem;">
        <span class="chip chip-grav"   data-force-hover="grav">Gravity</span>
        <span class="chip chip-drag"   data-force-hover="drag">Drag</span>
        <span class="chip chip-lift"   data-force-hover="lift">Lift</span>
        <span class="chip chip-thrust" data-force-hover="thrust">Thrust</span>
      </div>`,
    camera: { pos: [4, 3, 7], target: [0, 0, 0], dur: 0.8 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      setFrameVisibility({ vrf: true, vel: true });
      setForceVisibility({ grav: true, drag: true, lift: true, thrust: true });
      // Thrust fades in last
      if (STATE.persistent.thrustArrow) {
        STATE.persistent.thrustArrow.scale.set(0, 0, 0);
        STATE.persistent.thrustArrow.traverse(o => {
          if (o.isCSS2DObject) { o.visible = false; o.element.style.display = 'none'; }
        });
        gsap.to(STATE.persistent.thrustArrow.scale, {
          x: 1, y: 1, z: 1, duration: 0.55, delay: 0.4, ease: 'back.out(1.4)',
          onComplete() {
            STATE.persistent.thrustArrow.traverse(o => {
              if (o.isCSS2DObject) { o.visible = true; o.element.style.display = ''; }
            });
          }
        });
      }
    },
    exit() { setForceVisibility({}); },
  },

  // ── 14: Complete 3-DOF EOM ─────────────────────────────────────────────
  {
    title: 'Complete 3-DOF Equations of Motion',
    html: `
      <p>Assembling all forces and frames yields six coupled scalar ODEs — the
      complete <strong>3-DOF point-mass</strong> trajectory model
      (3 translational states, no attitude dynamics).</p>
      <div class="eq-block">
        <div class="eq-label">3 Kinematic equations</div>
        \\[\\dot{r} = v\\sin\\gamma\\]
        \\[\\dot{\\lambda} = \\frac{v\\cos\\gamma\\cos\\psi}{r\\cos\\phi}\\]
        \\[\\dot{\\phi} = \\frac{v\\cos\\gamma\\sin\\psi}{r}\\]
      </div>
      <div class="eq-block">
        <div class="eq-label">3 Force equations</div>
        \\[\\dot{v} = \\frac{T\\cos\\alpha_T}{m} - \\frac{D}{m} - g\\sin\\gamma + \\Omega^2 r\\cos\\phi(\\sin\\gamma\\cos\\phi - \\cos\\gamma\\sin\\phi\\cos\\psi)\\]
        \\[\\dot{\\gamma} = \\frac{1}{v}\\left[\\frac{L\\cos\\theta}{m} - \\left(g - \\frac{v^2}{r}\\right)\\cos\\gamma + 2\\Omega v\\cos\\phi\\cos\\psi + \\Omega^2 r\\cos\\phi(\\cos\\gamma\\cos\\phi + \\sin\\gamma\\sin\\phi\\cos\\psi)\\right]\\]
        \\[\\dot{\\psi} = \\frac{1}{v\\cos\\gamma}\\left[\\frac{L\\sin\\theta}{m\\cos\\gamma} + \\frac{v^2\\cos^2\\gamma\\sin\\psi\\tan\\phi}{r} - 2\\Omega v(\\tan\\gamma\\cos\\phi\\cos\\psi - \\sin\\phi) + \\frac{\\Omega^2 r\\sin\\phi\\cos\\phi\\sin\\psi}{\\cos\\gamma}\\right]\\]
      </div>
      <p>State vector: \\(\\mathbf{x} = (r,\\,v,\\,\\gamma,\\,\\psi,\\,\\lambda,\\,\\phi)^T\\)</p>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.7rem;">
        <span class="chip chip-grav"   data-force-hover="grav">Gravity</span>
        <span class="chip chip-drag"   data-force-hover="drag">Drag</span>
        <span class="chip chip-lift"   data-force-hover="lift">Lift</span>
        <span class="chip chip-thrust" data-force-hover="thrust">Thrust</span>
      </div>`,
    camera: { pos: [6, 5, 10], target: [0, 0, 0], dur: 1.5 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      if (STATE.persistent.orbitLine) {
        STATE.persistent.orbitLine.material.color.setHex(0x2a88cc);
        STATE.persistent.orbitLine.material.opacity = 0.88;
      }
      setFrameVisibility({ eci: true, ecef: true, rst: true, vrf: true, vel: true });
      setForceVisibility({ grav: true, drag: true, lift: true, thrust: true });
      controls.autoRotate      = true;
      controls.autoRotateSpeed = 0.5;
    },
    exit() {
      controls.autoRotate = false;
      if (STATE.persistent.orbitLine) {
        STATE.persistent.orbitLine.material.color.setHex(0x4499bb);
        STATE.persistent.orbitLine.material.opacity = 0.65;
      }
      setForceVisibility({});
    },
  },

  // ── 15: Summary ────────────────────────────────────────────────────────
  {
    title: 'Summary & Assumptions',
    html: `
      <p>The six-state system is complete. Here are the assumptions underlying the model:</p>
      <ul>
        <li>Entry vehicle treated as a <strong>point mass</strong></li>
        <li>Planetary rotation is <strong>constant</strong> about the polar axis</li>
        <li>Planet-fixed and inertial frames <strong>coincide at \\(t_0 = 0\\)</strong></li>
        <li>Vehicle mass is <strong>constant</strong> (no propellant depletion for EOM)</li>
        <li>Drag acts <strong>opposite to velocity</strong></li>
        <li>Lift is <strong>perpendicular to velocity</strong></li>
        <li>Gravity directed along \\(-\\hat{R}\\) (<strong>no oblateness</strong>)</li>
      </ul>
      <div class="eq-block">
        <div class="eq-label">Complete state vector</div>
        \\[\\mathbf{x} = \\begin{bmatrix}r \\\\ v \\\\ \\gamma \\\\ \\psi \\\\ \\lambda \\\\ \\phi\\end{bmatrix}
        \\qquad \\dot{\\mathbf{x}} = f(\\mathbf{x},\\,\\vec{F})\\]
      </div>
      <p style="color:#3a6a9a;font-size:0.8rem;margin-top:1rem;">
        Source: Hicks, K. D. <em>Introduction to Astrodynamic Reentry, 2nd ed.</em> 2014.
      </p>`,
    camera: { pos: [0, 12, 20], target: [0, 0, 0], dur: 2.0 },
    enter() {
      STATE.persistent.orbitLine.visible = true;
      if (STATE.persistent.orbitLine) {
        STATE.persistent.orbitLine.material.color.setHex(0x2a88cc);
        STATE.persistent.orbitLine.material.opacity = 0.88;
      }
      setFrameVisibility({ eci: true, ecef: true, rst: true, vrf: true, vel: true });
      setForceVisibility({ grav: true, drag: true, lift: true, thrust: true });
      controls.autoRotate      = true;
      controls.autoRotateSpeed = 0.4;
    },
    exit() {
      controls.autoRotate = false;
      if (STATE.persistent.orbitLine) {
        STATE.persistent.orbitLine.material.color.setHex(0x4499bb);
        STATE.persistent.orbitLine.material.opacity = 0.65;
      }
      setForceVisibility({});
    },
  },
];

// ── Navigation ─────────────────────────────────────────────────────────────
function buildProgressDots() {
  const container = document.getElementById('progress-dots');
  container.innerHTML = '';
  SLIDES.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    dot.title = SLIDES[i].title;
    dot.addEventListener('click', () => goToSlide(i));
    container.appendChild(dot);
  });
}

function updateNav(idx) {
  document.getElementById('slide-counter').textContent = `${idx + 1} / ${SLIDES.length}`;
  document.getElementById('slide-title').textContent = SLIDES[idx].title;
  document.querySelectorAll('.dot').forEach((d, i) =>
    d.classList.toggle('active', i === idx));
  document.getElementById('btn-prev').disabled = idx === 0;
  const slide = SLIDES[idx];
  const hasMoreSubsteps = slide.substeps && STATE.substep < slide.substeps.length;
  document.getElementById('btn-next').disabled = idx === SLIDES.length - 1 && !hasMoreSubsteps;
}

// Advances substep if available; otherwise moves to next slide.
function advanceNext() {
  const slide = SLIDES[STATE.currentSlide];
  if (slide.substeps && STATE.substep < slide.substeps.length) {
    const step = slide.substeps[STATE.substep];
    STATE.substep++;
    // Append the step's HTML and re-render KaTeX on just that fragment
    const panel = document.getElementById('slide-body');
    const div   = document.createElement('div');
    div.innerHTML = step.html;
    panel.appendChild(div);
    if (typeof renderMathInElement !== 'undefined') {
      renderMathInElement(div, {
        delimiters: [
          { left: '\\[', right: '\\]', display: true  },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    }
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (step.enter3D) step.enter3D();
    // Update Next disabled state
    const noMore   = STATE.substep >= slide.substeps.length;
    const lastSlide = STATE.currentSlide === SLIDES.length - 1;
    document.getElementById('btn-next').disabled = lastSlide && noMore;
  } else {
    goToSlide(STATE.currentSlide + 1);
  }
}

function goToSlide(idx) {
  if (idx < 0 || idx >= SLIDES.length) return;
  const prev = SLIDES[STATE.currentSlide];
  if (prev.exit) prev.exit();
  clearSlideObjects();

  STATE.currentSlide = idx;
  STATE.substep      = 0;
  const slide = SLIDES[idx];

  updateNav(idx);
  renderSlideContent(slide);

  const cam = slide.camera;
  if (cam.dur > 0) {
    tweenCamera(cam.pos, cam.target, cam.dur);
  } else {
    camera.position.set(...cam.pos);
    controls.target.set(...cam.target);
    controls.update();
  }

  if (slide.enter) slide.enter();
}

// ── Live vector update — called every frame to keep spacecraft + vectors on orbit ─
function updateLiveVectors() {
  const s = getSpacecraftState(STATE.orbitT);
  const v_hat    = s.vel.clone().normalize();
  const lift_hat = s.R_hat.clone().addScaledVector(v_hat, -s.R_hat.dot(v_hat)).normalize();

  // Spacecraft position (always); orientation only when bank animation isn't overriding it
  if (STATE.spacecraft) {
    STATE.spacecraft.position.copy(s.pos);
    if (!STATE.bankAnim) {
      const mat = new THREE.Matrix4().lookAt(s.pos, s.pos.clone().add(s.vel), lift_hat);
      STATE.spacecraft.quaternion.setFromRotationMatrix(mat);
      STATE.spacecraft.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      );
    }
  }

  // Velocity arrow
  const va = STATE.persistent.velArrow;
  if (va?.visible) { va.position.copy(s.pos); va.setDirection(v_hat); }

  // RST group — group moves to spacecraft; arrows at local origin, labels at local offset
  const rstG = STATE.persistent.rstGroup;
  if (rstG?.visible) {
    const L = 0.9;
    rstG.position.copy(s.pos);
    const ra = rstG.children.filter(c => c.isArrowHelper);
    const rl = rstG.children.filter(c => c.isCSS2DObject);
    if (ra[0]) ra[0].setDirection(s.R_hat);
    if (ra[1]) ra[1].setDirection(s.S_hat);
    if (ra[2]) ra[2].setDirection(s.T_hat);
    if (rl[0]) rl[0].position.copy(s.R_hat.clone().multiplyScalar(L + 0.14));
    if (rl[1]) rl[1].position.copy(s.S_hat.clone().multiplyScalar(L + 0.14));
    if (rl[2]) rl[2].position.copy(s.T_hat.clone().multiplyScalar(L + 0.14));
  }

  // VRF group — arrows and labels are at world-space positions (group at origin)
  const vrfG = STATE.persistent.vrfGroup;
  if (vrfG?.visible) {
    const L    = 0.75;
    const z_v  = new THREE.Vector3().crossVectors(s.R_hat, v_hat).normalize();
    const y_v  = new THREE.Vector3().crossVectors(z_v, v_hat).normalize();
    const dirs    = [v_hat, y_v, z_v];
    const vArrows = vrfG.children.filter(c => c.isArrowHelper);
    const vLabels = vrfG.children.filter(c => c.isCSS2DObject);
    const vSphere = vrfG.children.find(c => c.isMesh);
    if (vSphere) vSphere.position.copy(s.pos);
    vArrows.forEach((a, i) => { a.position.copy(s.pos); if (dirs[i]) a.setDirection(dirs[i]); });
    vLabels.forEach((lbl, i) => {
      if (dirs[i]) lbl.position.copy(s.pos.clone().addScaledVector(dirs[i], L + 0.12));
    });
  }

  // Force arrows
  const Omega = new THREE.Vector3(0, 1, 0).multiplyScalar(EARTH_ROT_SPD);

  const ga = STATE.persistent.gravArrow;
  if (ga?.visible) { ga.position.copy(s.pos); ga.setDirection(s.R_hat.clone().negate()); }

  const da = STATE.persistent.dragArrow;
  if (da?.visible) { da.position.copy(s.pos); da.setDirection(v_hat.clone().negate()); }

  const la = STATE.persistent.liftArrow;
  if (la?.visible && !STATE.bankAnim) { la.position.copy(s.pos); la.setDirection(lift_hat); }

  const ta = STATE.persistent.thrustArrow;
  if (ta?.visible) { ta.position.copy(s.pos); ta.setDirection(v_hat); }

  const cor = STATE.persistent.coriolisArrow;
  if (cor?.visible) {
    cor.position.copy(s.pos);
    const v_rel = v_hat.clone().sub(new THREE.Vector3().crossVectors(Omega, s.pos));
    const corDir = new THREE.Vector3().crossVectors(Omega, v_rel).normalize();
    if (corDir.lengthSq() > 0) cor.setDirection(corDir);
  }

  const cen = STATE.persistent.centripArrow;
  if (cen?.visible) {
    cen.position.copy(s.pos);
    const cpVec = new THREE.Vector3()
      .crossVectors(Omega, new THREE.Vector3().crossVectors(Omega, s.pos)).normalize();
    if (cpVec.lengthSq() > 0) cen.setDirection(cpVec);
  }
}

// ── Render loop ────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  // Orbit + Earth rotation
  STATE.orbitT += delta * ORBIT_SPD;
  STATE.earthT += delta * EARTH_ROT_SPD;
  if (STATE.persistent.earthMesh) STATE.persistent.earthMesh.rotation.y = STATE.earthT;
  if (STATE.persistent.ecefGroup) STATE.persistent.ecefGroup.rotation.y = STATE.earthT;

  // Keep spacecraft and all live vectors on the moving orbit
  updateLiveVectors();

  controls.update();
  renderer.render(scene, camera);
  css2d.render(scene, camera);
}

// ── Asset source resolution ────────────────────────────────────────────────
const STORAGE_EARTH = 'eom_earth_v1';
const STORAGE_GLB   = 'eom_glb_v1';

function getStoredAssets() {
  // Priority: pre-embedded (assets.js) > localStorage cache
  const earth = window.EARTH_DATA_URL || localStorage.getItem(STORAGE_EARTH);
  const glb   = window.GLB_DATA_URL   || localStorage.getItem(STORAGE_GLB);
  return (earth && glb) ? { earth, glb } : null;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function persistAndLaunch(earthURL, glbURL, onReady) {
  try {
    localStorage.setItem(STORAGE_EARTH, earthURL);
    localStorage.setItem(STORAGE_GLB,   glbURL);
  } catch (_) { /* quota exceeded — still works for this session */ }
  document.getElementById('setup-overlay').classList.add('hidden');
  document.getElementById('app').style.display = '';
  onReady(earthURL, glbURL);
}

function initSetupOverlay(onReady) {
  // ── Path A: File System Access API (Chrome/Edge) — opens folder directly ──
  if (window.showDirectoryPicker) {
    const btnFolder = document.getElementById('btn-pick-folder');
    const btnLaunch = document.getElementById('btn-launch');
    const statusEl  = document.getElementById('folder-status');

    btnFolder.addEventListener('click', async () => {
      statusEl.className = 'folder-status';
      statusEl.textContent = '';
      try {
        const dir = await window.showDirectoryPicker({ mode: 'read' });

        statusEl.textContent = 'Reading files…';
        const [earthFile, glbFile] = await Promise.all([
          dir.getFileHandle('Earth_Blue_Marble.jpg').then(h => h.getFile()),
          dir.getFileHandle('x-37b.glb').then(h => h.getFile()),
        ]);
        const [earthURL, glbURL] = await Promise.all([
          readFileAsDataURL(earthFile),
          readFileAsDataURL(glbFile),
        ]);
        statusEl.textContent = '✓ Both assets found — ready to launch';
        btnFolder.style.borderColor = '#2a8a4a';
        btnFolder.style.color = '#44ff88';
        btnLaunch.disabled = false;

        btnLaunch.addEventListener('click', () =>
          persistAndLaunch(earthURL, glbURL, onReady), { once: true });

      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled picker
        statusEl.className = 'folder-status error';
        const missing = err.message.includes('not found') || err.name === 'NotFoundError';
        statusEl.textContent = missing
          ? '✗ Could not find Earth_Blue_Marble.jpg or x-37b.glb in that folder.'
          : '✗ ' + err.message;
      }
    });

  } else {
    // ── Path B: Individual file inputs (Firefox / Safari) ──────────────────
    document.getElementById('dir-picker-section').style.display  = 'none';
    document.getElementById('file-picker-section').style.display = '';

    const pickEarth = document.getElementById('pick-earth');
    const pickGlb   = document.getElementById('pick-glb');
    const btnLaunch = document.getElementById('btn-launch-fallback');
    let earthURL = null, glbURL = null;

    pickEarth.addEventListener('change', async () => {
      const f = pickEarth.files[0]; if (!f) return;
      earthURL = await readFileAsDataURL(f);
      document.getElementById('check-earth').textContent = '✓';
      document.getElementById('check-earth').classList.add('ok');
      document.getElementById('row-earth').classList.add('ready');
      btnLaunch.disabled = !(earthURL && glbURL);
    });

    pickGlb.addEventListener('change', async () => {
      const f = pickGlb.files[0]; if (!f) return;
      glbURL = await readFileAsDataURL(f);
      document.getElementById('check-glb').textContent = '✓';
      document.getElementById('check-glb').classList.add('ok');
      document.getElementById('row-glb').classList.add('ready');
      btnLaunch.disabled = !(earthURL && glbURL);
    });

    btnLaunch.addEventListener('click', () =>
      persistAndLaunch(earthURL, glbURL, onReady));
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  const stored = getStoredAssets();

  if (!stored) {
    // First-time: show file picker, launch when both files are selected
    initSetupOverlay(async (earth, glb) => {
      window._EARTH_SRC = earth;
      window._GLB_SRC   = glb;
      await boot();
    });
    return;
  }

  // Assets already available — go straight to app
  window._EARTH_SRC = stored.earth;
  window._GLB_SRC   = stored.glb;
  document.getElementById('setup-overlay').classList.add('hidden');
  document.getElementById('app').style.display = '';

  await boot();
}

async function boot() {
  initScene();
  await loadAssets();

  // Build persistent 3D elements
  buildOrbitTrail();
  buildECIAxes();
  buildECEFAxes();
  buildRSTAxes();
  buildVRFAxes();
  buildVelocityArrow();
  buildForceArrows();

  // Remove loading indicator
  const li = document.getElementById('loading-indicator');
  if (li) li.remove();

  buildProgressDots();
  wireForceHovers();
  goToSlide(0);
  animate();

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ')  advanceNext();
    if (e.key === 'ArrowLeft')                     goToSlide(STATE.currentSlide - 1);
  });
  document.getElementById('btn-next').addEventListener('click', advanceNext);
  document.getElementById('btn-prev').addEventListener('click', () => goToSlide(STATE.currentSlide - 1));
}

main();
