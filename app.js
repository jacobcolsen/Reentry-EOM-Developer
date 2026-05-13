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
  orbitT:         0,
  earthT:         0,
  gsapTween:      null,
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

  // Controls
  controls = new OrbitControls(camera, css2d.domElement);
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

    // Earth texture
    new THREE.TextureLoader().load('Earth_Blue_Marble.jpg', (tex) => {
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

    // Spacecraft GLB
    new GLTFLoader().load('x-37b.glb', (gltf) => {
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
  // Nose points along velocity, dorsal side faces radially outward
  const mat = new THREE.Matrix4().lookAt(
    s.pos, s.pos.clone().add(s.vel), s.R_hat
  );
  ship.quaternion.setFromRotationMatrix(mat);
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
    new THREE.LineBasicMaterial({ color: 0x1a4466, transparent: true, opacity: 0.45 }),
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

  group.visible = false;
  scene.add(group);
  STATE.persistent.eciGroup = group;
}

function buildECEFAxes() {
  const L = 3.0;
  const O = new THREE.Vector3(0, 0, 0);
  const group = new THREE.Group();
  // Rotate ~30° about North Pole axis to visually distinguish from ECI at t=0
  group.rotation.y = Math.PI / 6;

  group.add(makeArrow(new THREE.Vector3(1, 0, 0), O, L, COLORS.ecef.x, 'x̂_E'));
  group.add(makeArrow(new THREE.Vector3(0, 0, 1), O, L, COLORS.ecef.y, 'ŷ_E'));
  group.add(makeArrow(new THREE.Vector3(0, 1, 0), O, L, COLORS.ecef.z, 'ẑ_E'));

  group.visible = false;
  scene.add(group);
  STATE.persistent.ecefGroup = group;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function makeArrow(dir, origin, length, hexColor, labelText) {
  const d = dir.clone().normalize();
  const arrow = new THREE.ArrowHelper(d, origin, length, hexColor,
    length * 0.18, length * 0.09);
  if (labelText) {
    const div = document.createElement('div');
    div.className = 'label3d';
    div.textContent = labelText;
    div.style.color = '#' + hexColor.toString(16).padStart(6, '0');
    const obj = new CSS2DObject(div);
    obj.position.copy(d.clone().multiplyScalar(length + 0.05));
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
  for (const obj of STATE.slideObjects) {
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
      <strong>6-DOF Equations of Motion</strong> for atmospheric reentry vehicles.</p>
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
      STATE.persistent.orbitLine.visible  = true;
      STATE.persistent.eciGroup.visible   = true;
      STATE.persistent.ecefGroup.visible  = false; // not introduced yet
      // Stagger the three arrows growing in (skip if re-entering from a later slide)
      STATE.persistent.eciGroup.children.forEach((child, i) => {
        child.scale.set(0, 0, 0);
        gsap.to(child.scale, { x: 1, y: 1, z: 1, duration: 0.5, delay: i * 0.15, ease: 'back.out(1.4)' });
      });
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
      STATE.persistent.orbitLine.visible  = true;
      STATE.persistent.eciGroup.visible   = true;
      STATE.persistent.ecefGroup.visible  = true;
      // ECEF axes grow in after a short delay
      STATE.persistent.ecefGroup.children.forEach((child, i) => {
        child.scale.set(0, 0, 0);
        gsap.to(child.scale, { x: 1, y: 1, z: 1, duration: 0.5, delay: 0.3 + i * 0.15, ease: 'back.out(1.4)' });
      });
    },
    exit() {},
  },

  // ── 3: Vehicle-Pointing Frame ──────────────────────────────────────────
  {
    title: 'Vehicle-Pointing Frame (RST)',
    html: `
      <p>The <span class="chip chip-rst">RST Frame</span> has its origin at Earth's center
      but its axes track the vehicle's position.</p>
      <div class="eq-block">
        <div class="eq-label">Axis definitions</div>
        \\[\\hat{R} = \\frac{\\vec{r}}{|\\vec{r}|}\\quad(\\text{radial, outward})\\]
        \\[\\hat{S} = \\hat{Z} \\times \\hat{R}\\quad(\\text{equatorial parallel})\\]
        \\[\\hat{T} = \\hat{R} \\times \\hat{S}\\quad(\\text{completes right-hand system})\\]
      </div>
      <p>Two successive rotations transform from ECEF to RST using the vehicle's
      <strong>longitude</strong> \\(\\lambda\\) and <strong>latitude</strong> \\(\\phi\\).</p>
      <div class="eq-block">
        \\[\\mathbf{T}_{\\text{ECEF} \\to \\text{RST}} = R_Y(-\\phi)\\,R_Z(\\lambda)\\]
      </div>`,
    camera: { pos: [5, 4, 9], target: [0, 0, 0], dur: 1.2 },
    enter() {},
    exit()  {},
  },

  // ── 4: Longitude & Latitude ────────────────────────────────────────────
  {
    title: 'Longitude λ and Latitude ϕ',
    html: `
      <p>The vehicle's position on the rotating planet is described by
      <strong>geocentric longitude</strong> \\(\\lambda\\) and
      <strong>geocentric latitude</strong> \\(\\phi\\).</p>
      <div class="eq-block">
        <div class="eq-label">Kinematic equations (position)</div>
        \\[\\dot{\\lambda} = \\frac{v\\cos\\gamma\\cos\\psi}{r\\cos\\phi}\\]
        \\[\\dot{\\phi} = \\frac{v\\cos\\gamma\\sin\\psi}{r}\\]
      </div>
      <p>These two equations, along with \\(\\dot{r} = v\\sin\\gamma\\), form the
      <em>kinematic</em> half of our 6-DOF system — integrating them gives the
      vehicle's position on Earth at any time.</p>`,
    camera: { pos: [3, 5, 7], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
  },

  // ── 5: Flight-Path Angle γ ─────────────────────────────────────────────
  {
    title: 'Flight-Path Angle γ',
    html: `
      <p>The <strong>flight-path angle</strong> \\(\\gamma\\) is the angle between the
      <em>local horizontal plane</em> and the velocity vector.</p>
      <div class="eq-block">
        <div class="eq-label">Radial rate</div>
        \\[\\dot{r} = v\\sin\\gamma\\]
      </div>
      <ul>
        <li>\\(\\gamma > 0\\): climbing (velocity above local horizontal)</li>
        <li>\\(\\gamma < 0\\): descending (entry corridor)</li>
        <li>\\(\\gamma = 0\\): purely horizontal flight</li>
      </ul>
      <p>Watch the gold velocity arrow sweep relative to the horizontal disc as
      \\(\\gamma\\) varies.</p>`,
    camera: { pos: [4, 3, 8], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
  },

  // ── 6: Heading Angle ψ ─────────────────────────────────────────────────
  {
    title: 'Heading Angle ψ',
    html: `
      <p>The <strong>heading angle</strong> \\(\\psi\\) describes the direction of
      horizontal flight — measured from the local parallel of latitude toward north.</p>
      <div class="eq-block">
        <div class="eq-label">Longitude and latitude rates</div>
        \\[\\dot{\\lambda} = \\frac{v\\cos\\gamma\\cos\\psi}{r\\cos\\phi}\\]
        \\[\\dot{\\phi} = \\frac{v\\cos\\gamma\\sin\\psi}{r}\\]
      </div>
      <ul>
        <li>\\(\\psi = 0°\\): flying along a latitude line (eastward)</li>
        <li>\\(\\psi = 90°\\): flying toward the equator</li>
      </ul>
      <p>Look down from above — the arc shows the heading angle in the local
      horizontal plane.</p>`,
    camera: { pos: [0, 9, 6], target: [0, 0, 0], dur: 1.2 },
    enter() {},
    exit()  {},
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
      RST for the equations of motion.</p>`,
    camera: { pos: [3, 3, 7], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
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
        <li><span class="chip chip-thrust">Thrust</span> — propulsive force</li>
        <li><span class="chip chip-drag">Drag</span> — aerodynamic retarding force</li>
        <li><span class="chip chip-lift">Lift</span> — aerodynamic perpendicular force</li>
        <li><span class="chip chip-grav">Gravity</span> — central body attraction</li>
      </ul>
      <p>The superscript \\(I\\) on \\(\\ddot{\\vec{r}}\\) emphasizes the derivative is taken
      with respect to the <em>inertial</em> frame.</p>`,
    camera: { pos: [4, 3, 7], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
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
        <li><strong>Coriolis</strong> — depends on velocity relative to planet</li>
        <li><strong>Centripetal</strong> — depends on distance from spin axis</li>
      </ul>
      <p>Both terms update in real-time as the spacecraft moves — watch the arrows change
      direction along the orbit.</p>`,
    camera: { pos: [5, 5, 8], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
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
      <p>The <span class="chip chip-grav">blue arrow</span> grows longer as the spacecraft
      descends closer to Earth.</p>`,
    camera: { pos: [4, 2, 9], target: [0, 0, 0], dur: 1.2 },
    enter() {},
    exit()  {},
  },

  // ── 11: Drag Force ─────────────────────────────────────────────────────
  {
    title: 'Drag Force',
    html: `
      <p>Drag acts directly <em>opposite</em> to the velocity vector — always in the
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
    enter() {},
    exit()  {},
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
      <p>Watch the <span class="chip chip-lift">pink arrow</span> rotate around the velocity
      axis as bank angle \\(\\theta\\) changes — this is how a lifting entry vehicle controls
      its trajectory.</p>`,
    camera: { pos: [3, 4, 6], target: [0, 0, 0], dur: 1.0 },
    enter() {},
    exit()  {},
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
      <p>All four forces are now simultaneously visible on the vehicle.</p>`,
    camera: { pos: [4, 3, 7], target: [0, 0, 0], dur: 0.8 },
    enter() {},
    exit()  {},
  },

  // ── 14: Complete 6-DOF EOM ─────────────────────────────────────────────
  {
    title: 'Complete 6-DOF Equations of Motion',
    html: `
      <p>Assembling all forces and frames yields six coupled scalar ODEs — the full
      trajectory model.</p>
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
      <p>State vector: \\(\\mathbf{x} = (r,\\,v,\\,\\gamma,\\,\\psi,\\,\\lambda,\\,\\phi)^T\\)</p>`,
    camera: { pos: [6, 5, 10], target: [0, 0, 0], dur: 1.5 },
    enter() {},
    exit()  {},
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
    enter() {},
    exit()  {},
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
  document.getElementById('btn-next').disabled = idx === SLIDES.length - 1;
}

function goToSlide(idx) {
  if (idx < 0 || idx >= SLIDES.length) return;
  const prev = SLIDES[STATE.currentSlide];
  if (prev.exit) prev.exit();
  clearSlideObjects();

  STATE.currentSlide = idx;
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

// ── Render loop ────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  clock.getDelta(); // keep clock ticking for future use

  controls.update();
  renderer.render(scene, camera);
  css2d.render(scene, camera);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  // CORS check
  if (window.location.protocol === 'file:') {
    document.getElementById('cors-overlay').classList.add('visible');
    return;
  }

  initScene();
  await loadAssets();

  // Build persistent 3D elements
  buildOrbitTrail();
  buildECIAxes();
  buildECEFAxes();

  // Remove loading indicator
  const li = document.getElementById('loading-indicator');
  if (li) li.remove();

  buildProgressDots();
  goToSlide(0);
  animate();

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ')  goToSlide(STATE.currentSlide + 1);
    if (e.key === 'ArrowLeft')                     goToSlide(STATE.currentSlide - 1);
  });
  document.getElementById('btn-next').addEventListener('click', () => goToSlide(STATE.currentSlide + 1));
  document.getElementById('btn-prev').addEventListener('click', () => goToSlide(STATE.currentSlide - 1));
}

main();
