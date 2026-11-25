import * as THREE from 'three';
import { NOW } from '../data/data.js';
import { rand, pick } from '../utils/Random.js';
import { smooth01, clamp01, lerp } from '../utils/Math.js';

const easeOutCubic = x => 1 - Math.pow(1 - clamp01(x), 3);
// RGBA presets for the particle systems
const C = {
  emberHot: [1.0, 0.72, 0.28, 1],
  emberCool: [0.85, 0.18, 0.03, 0],
  smokeHot: [0.34, 0.25, 0.22, 0.55],
  smokeEnd: [0.12, 0.10, 0.11, 0],
  dust0: [0.56, 0.46, 0.38, 0.6],
  dust1: [0.30, 0.26, 0.24, 0],
  spark0: [1.0, 0.9, 0.6, 1],
  spark1: [1.0, 0.35, 0.05, 0]
};
/**
 * Fixed-capacity GPU point-sprite pool (soft round sprites, per-particle size and
 * RGBA over life). Additive pools are used for fire/embers, normal-blend for smoke/dust.
 */
class ParticlePool {
  constructor(capacity, additive) {
    this.cap = capacity;
    this.n = 0;
    this.pos = new Float32Array(capacity * 3);
    this.aSize = new Float32Array(capacity);
    this.aColor = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.c0 = new Float32Array(capacity * 4);
    this.c1 = new Float32Array(capacity * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.aColor, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: `
        uniform float uScale;
        attribute float aSize;
        attribute vec4 aColor;
        varying vec4 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vC = aColor;
          gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), 700.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vC.rgb, vC.a * a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, drag = 0, grav = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++, i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.c0.set(c0, i4);
    this.c1.set(c1, i4);
    this.drag[i] = drag;
    this.grav[i] = grav;
  }
  #move(from, to) {
    if (from === to) return;
    for (let j = 0; j < 3; j++) {
      this.pos[to * 3 + j] = this.pos[from * 3 + j];
      this.vel[to * 3 + j] = this.vel[from * 3 + j];
    }
    for (let j = 0; j < 4; j++) {
      this.c0[to * 4 + j] = this.c0[from * 4 + j];
      this.c1[to * 4 + j] = this.c1[from * 4 + j];
    }
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.s0[to] = this.s0[from];
    this.s1[to] = this.s1[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
  }
  update(dt, scale) {
    this.material.uniforms.uScale.value = scale;
    const { pos, vel, life, maxLife, drag, grav } = this;
    // descending so swap-removal only pulls in particles already updated this frame
    for (let i = this.n - 1; i >= 0; i--) {
      life[i] -= dt;
      if (life[i] <= 0) {
        this.#move(this.n - 1, i);
        this.n--;
        continue;
      }
      const i3 = i * 3, k = Math.exp(-drag[i] * dt);
      vel[i3] *= k;
      vel[i3 + 1] = vel[i3 + 1] * k - grav[i] * dt; // positive grav = falls, negative = rises
      vel[i3 + 2] *= k;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
    }
    for (let i = 0; i < this.n; i++) {
      const u = 1 - life[i] / maxLife[i], i4 = i * 4;
      this.aSize[i] = lerp(this.s0[i], this.s1[i], u);
      for (let j = 0; j < 4; j++) this.aColor[i4 + j] = lerp(this.c0[i4 + j], this.c1[i4 + j], u);
    }
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
  }
  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }
  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}
export default class MeteorScene {
  static T = Object.freeze({
    flight: 1.7, // seconds from spawn to impact
    nearStart: 0.75, // pre-impact rumble begins
    nearDur: 0.95,
    preShake: 0.12,
    shakeDecay: 2.4, // post-impact shake fades over this
    gameOverDelay: 2.4,
    hitStop: 0.09, // near-freeze on the impact frame (real seconds)
    slowMoRamp: 0.75, // then ease back to full speed over this
    shockSpeed: 24 // blast front travel speed (units/s) -> outward ripple
  });
  static GRAVITY = 9.8;
  static SPAWN_DIST = 1.65; // target distance in front of camera
  static SHARDS = 36; // first CHUNKS of these are larger, slower fragments
  static CHUNKS = 8;
  static SHARD_COLORS = ['#ff6835', '#ffc36d', '#6d4858', '#3a303f'];
  static ROCK_RADIUS = 1.25;
  static ROCK_DETAIL = 2;
  // scratch objects, reused every frame
  #v = new THREE.Vector3();
  #v2 = new THREE.Vector3();
  #q = new THREE.Quaternion();
  #e = new THREE.Euler();
  static #FWD = new THREE.Vector3(0, 0, -1);
  constructor(o) {
    this.on = false;
    this.impacted = false;
    this.gameOver = false;
    this.t0 = 0;
    this.impactT = 0;
    this.simAge = 0; // time since impact, scaled by slow-mo (drives physics + fx)
    this.shake = 0;
    this.groundY = 0;
    this.puffBudget = 0;
    this.bodyPhysics = [];
    this.debris = [];
    this.basePos = new THREE.Vector3();
    this.baseQuat = new THREE.Quaternion();
    this.baseFov = 50;
    this.start_ = new THREE.Vector3(); // spawn point (see note on `start`)
    this.target = new THREE.Vector3();
    this.flight = new THREE.Vector3(); // camera forward
    this.dir = new THREE.Vector3(0, 0, -1); // meteor travel direction
    this.up = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.group = null; // assigned externally
    this.light = null; // assigned externally
    this.rock = null;
    this.glows = [];
    this.fx = null;
    this.embers = null;
    this.smoke = null;
    this.emberAcc = 0;
    this.smokeAcc = 0;
    this.flashEl = null;
    this.heatEl = null;
    Object.assign(this, {
      UI: null,
      SC: null,
      CROWD: null,
      BAND: null,
      VENUE: null,
      stopShow: (b) => null
    }, o);
  }

  // ---------- lifecycle ----------
  start() {
    if (this.on || !this.UI.playing) return;
    if (!this.group) return;
    this.on = true;
    this.impacted = false;
    this.gameOver = false;
    this.t0 = NOW.t;
    this.impactT = 0;
    this.simAge = 0;
    this.shake = 0;
    this.emberAcc = this.smokeAcc = 0;
    this.bodyPhysics.length = 0;
    this.clearDebris();
    this.embers?.clear();
    this.smoke?.clear();
    this.#hideImpactFx();
    this.#ensureOverlays();
    this.stopShow(true);
    this.#hideUI();
    this.#setupCamera();
  }
  /** Puts everything back (camera, thrown objects, fx) so the scene can be replayed. */
  end() {
    const cam = this.SC.camera;
    if (this.on) {
      cam.position.copy(this.basePos);
      cam.quaternion.copy(this.baseQuat);
      if (cam.isPerspectiveCamera) {
        cam.fov = this.baseFov;
        cam.updateProjectionMatrix();
      }
    }
    for (const b of this.bodyPhysics) {
      b.object.position.copy(b.home);
      b.object.rotation.copy(b.homeRot);
    }
    this.bodyPhysics.length = 0;
    this.clearDebris();
    this.embers?.clear();
    this.smoke?.clear();
    this.#hideImpactFx();
    if (this.group) this.group.visible = false;
    if (this.flashEl) this.flashEl.style.opacity = 0;
    if (this.heatEl) this.heatEl.style.opacity = 0;
    this.on = false;
    this.impacted = false;
    this.gameOver = false;
  }
  #hideUI() {
    for (const id of ['pause', 'fight', 'meteor', 'endShow', 'nextSong', 'hudMode', 'autoMode', 'special', 'finishHint', 'finBar', 'customMenu']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    document.getElementById('controls')?.classList.add('off');
    document.getElementById('gameOver')?.classList.add('hide'); // clear any previous run
  }
  #setupCamera() {
    const cam = this.SC.camera;
    cam.updateMatrixWorld(true);
    this.basePos.copy(cam.position);
    this.baseQuat.copy(cam.quaternion);
    if (cam.isPerspectiveCamera) this.baseFov = cam.fov;
    cam.getWorldDirection(this.flight).normalize();
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    this.right.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
    this.target.copy(cam.position).addScaledVector(this.flight, MeteorScene.SPAWN_DIST);
    this.start_.copy(this.target).addScaledVector(this.flight, 22).addScaledVector(this.up, 8).addScaledVector(this.right, 6);
    this.dir.copy(this.target).sub(this.start_).normalize();
    const g = this.group;
    g.position.copy(this.start_);
    g.visible = true;
    g.quaternion.setFromUnitVectors(MeteorScene.#FWD, this.dir); // orientation is fixed; only the rock tumbles
    g.scale.setScalar(1.0);
  }
  // ---------- update ----------
  update(dt, t) {
    if (!this.on) return;
    dt = Math.min(dt, 0.1); // avoid physics tunnelling after a long frame
    const T = MeteorScene.T;
    const age = t - this.t0;
    const impactAge = this.impacted ? t - this.impactT : 0;
    // viewport -> point-size scale for the particle shader
    const cam = this.SC.camera;
    const h = window.innerHeight * (window.devicePixelRatio || 1);
    const pScale = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) * 0.5));
    let sdt = dt; // simulated dt (slow-mo after impact)
    let pre = 0; // 0..1 approach progress, for FOV squeeze / heat vignette
    if (!this.impacted) {
      pre = this.#updateFlight(dt, age, t);
    } else {
      // hit-stop, then ease back to real time
      const ts = impactAge < T.hitStop ? 0.08 : lerp(0.18, 1, smooth01(clamp01((impactAge - T.hitStop) / T.slowMoRamp)));
      sdt = dt * ts;
      this.simAge += sdt;
      this.puffBudget = 6;
      this.#updateBodies(sdt);
      this.#updateDebris(sdt);
      this.#updateImpactFx(this.simAge);
      if (impactAge > T.gameOverDelay && !this.gameOver) {
        this.gameOver = true;
        document.getElementById('gameOver')?.classList.remove('hide');
      }
    }
    this.embers.update(sdt, pScale);
    this.smoke.update(sdt, pScale);
    const trauma = this.impacted ? Math.max(0, 1 - impactAge / T.shakeDecay) : this.shake;
    const s = this.impacted ? Math.pow(trauma, 1.6) : trauma;
    const kick = this.impacted ? Math.exp(-4.5 * impactAge) * Math.cos(7 * impactAge) : 0;
    this.#applyCamera(t, s, kick, pre);
    if (this.flashEl) this.flashEl.style.opacity = this.impacted ? Math.exp(-impactAge * 6.5) * 0.95 : 0;
    if (this.heatEl) this.heatEl.style.opacity = this.impacted ? Math.exp(-impactAge * 4) * 0.8 : clamp01(pre * 0.95 * (0.85 + 0.15 * Math.sin(t * 30)));
  }
  #updateFlight(dt, age, t) {
    const T = MeteorScene.T,
      g = this.group;
    const k = clamp01(age / T.flight);
    const p = Math.pow(k, 1.9); // accelerates into the camera instead of easing to a stop
    g.position.lerpVectors(this.start_, this.target, p);
    g.scale.setScalar(1.0 + p * 0.3);
    // tumble the rock only (glow + tail stay aligned with the direction of travel)
    this.rock.rotation.x += dt * (1.6 + 2.2 * k);
    this.rock.rotation.y += dt * (2.3 + 3.0 * k);
    this.rock.rotation.z += dt * 0.9;
    // flickering, stretching flame + light
    const flick = 1 + 0.12 * Math.sin(t * 38) + 0.07 * Math.sin(t * 67 + 1);
    const stretch = 1 + p * 0.9;
    for (const m of this.glows) {
      const u = m.userData;
      m.position.z = u.z * stretch;
      m.scale.set(u.sx * (1 + 0.05 * Math.sin(t * 52 + u.z)), u.sy, u.sz * stretch * flick);
    }
    if (this.light) this.light.intensity = (4 + 7 * p) * flick;
    this.#emitTrail(dt, p, g.scale.x);
    this.shake = smooth01(clamp01((age - T.nearStart) / T.nearDur)) * T.preShake;
    if (age >= T.flight) this.impact(t);
    return p;
  }
  #emitTrail(dt, p, s) {
    const d = this.dir, pos = this.group.position;
    const tx = pos.x - d.x * 0.9 * s, ty = pos.y - d.y * 0.9 * s, tz = pos.z - d.z * 0.9 * s;
    this.emberAcc += dt * (90 + 170 * p);
    while (this.emberAcc >= 1) {
      this.emberAcc--;
      const sp = rand(2, 6) * (1 + p);
      this.embers.emit(tx + rand(-0.4, 0.4) * s, ty + rand(-0.4, 0.4) * s, tz + rand(-0.4, 0.4) * s, -d.x * sp + rand(-1.2, 1.2), -d.y * sp + rand(-1.2, 1.2), -d.z * sp + rand(-1.2, 1.2), rand(0.45, 1.0), rand(0.2, 0.4) * s, 0, C.emberHot, C.emberCool, 0.8, 0);
    }
    this.smokeAcc += dt * (35 + 55 * p);
    while (this.smokeAcc >= 1) {
      this.smokeAcc--;
      this.smoke.emit(tx - d.x * 0.6 + rand(-0.3, 0.3), ty - d.y * 0.6 + rand(-0.3, 0.3), tz - d.z * 0.6 + rand(-0.3, 0.3), -d.x + rand(-0.5, 0.5), -d.y + rand(-0.2, 0.8), -d.z + rand(-0.5, 0.5), rand(0.9, 1.5), 0.5 * s, rand(1.3, 1.9) * s, C.smokeHot, C.smokeEnd, 1.0, -0.3);
    }
  }
  #applyCamera(t, s, kick, pre) {
    const cam = this.SC.camera;
    cam.position.copy(this.basePos);
    cam.position.addScaledVector(this.flight, -0.42 * kick); // blast shoves the camera back, then it springs forward
    cam.position.addScaledVector(this.up, -0.08 * kick);
    cam.position.x += Math.sin(t * 48) * s * 0.17;
    cam.position.y += Math.sin(t * 37 + 0.7) * s * 0.14;
    cam.position.z += Math.sin(t * 54 + 1.4) * s * 0.08;
    this.#e.set(Math.sin(t * 33) * s * 0.07, Math.sin(t * 41 + 1) * s * 0.07, Math.sin(t * 45 + 2) * s * 0.095 + kick * 0.03);
    cam.quaternion.copy(this.baseQuat).multiply(this.#q.setFromEuler(this.#e));
    if (cam.isPerspectiveCamera) {
      // slight tunnel-vision squeeze on approach, FOV punch on impact
      cam.fov = this.baseFov * (1 - 0.06 * pre) + 8 * kick;
      cam.updateProjectionMatrix();
    }
  }
  // ---------- impact ----------
  impact(t) {
    this.impacted = true;
    this.impactT = t;
    this.simAge = 0;
    this.shake = 1;
    this.group.visible = false;
    this.#findGround();
    this.#launchBodies();
    this.#spawnDebris();
    this.#spawnBurst();
    const eyebrow = document.querySelector('.game-over-eyebrow');
    if (eyebrow) eyebrow.textContent = 'METEOR STRIKE';
  }
  #findGround() {
    let y = Infinity;
    for (const m of this.CROWD.list) if (m.p?.root.visible) y = Math.min(y, m.p.root.position.y);
    for (const m of this.BAND.members) if (m.root?.visible) y = Math.min(y, m.root.position.y);
    if (!isFinite(y)) y = this.target.y - 1.2;
    this.groundY = Math.min(y, this.target.y - 0.2);
  }
  #launchBodies() {
    const origin = this.target;
    const seen = new Set([this.group, this.fx]); // O(1) duplicate check; never throw our own fx
    const add = (object, weight) => {
      if (!object?.position || seen.has(object)) return;
      seen.add(object);
      // radial blast from the impact point: closer = harder, far = delayed ripple
      const d = this.#v.copy(object.position).sub(origin);
      const dist = Math.max(0.6, d.length());
      const horiz = this.#v2.set(d.x, 0, d.z);
      if (horiz.lengthSq() < 1e-4) horiz.set(rand(-1, 1), 0, rand(-1, 1));
      horiz.normalize();
      const power = weight * (3.5 + 11 / (1 + 0.35 * dist)) * rand(0.85, 1.15);
      const velocity = horiz.clone().multiplyScalar(power * 0.8);
      velocity.y = power * 0.55 + rand(0.8, 2.4) * weight;
      // tumble forward along the throw direction, plus a little chaos
      const spin = new THREE.Vector3(horiz.z, rand(-1, 1), -horiz.x).multiplyScalar(power * 0.55);
      spin.x += rand(-2, 2);
      spin.y += rand(-2, 2);
      spin.z += rand(-2, 2);
      this.bodyPhysics.push({
        object,
        velocity,
        spin,
        weight,
        floor: object.position.y,
        delay: Math.min(0.6, dist / MeteorScene.T.shockSpeed),
        go: false,
        rest: false,
        home: object.position.clone(),
        homeRot: object.rotation.clone()
      });
    };
    // Order matters: the first weight given to an object wins.
    if (this.VENUE?.root) add(this.VENUE.root, 0.55);
    for (const m of this.CROWD.list) if (m.p?.root.visible) add(m.p.root, 1);
    for (const m of this.BAND.members) if (m.root?.visible) add(m.root, 1.05);
    for (const o of this.SC.scene.children) {
      if (o.visible && !o.isLight && !o.isCamera) add(o, 0.62);
    }
  }
  #spawnDebris() {
    const colors = MeteorScene.SHARD_COLORS;
    for (let i = 0; i < MeteorScene.SHARDS; i++) {
      const chunk = i < MeteorScene.CHUNKS;
      const r = chunk ? rand(0.26, 0.45) : rand(0.08, 0.26);
      const geo = new THREE.IcosahedronGeometry(r, 0);
      const heat = chunk ? rand(0.5, 1.0) : rand(0.25, 0.8);
      const mat = new THREE.MeshStandardMaterial({
        color: pick(colors),
        emissive: '#a73418',
        emissiveIntensity: heat,
        roughness: 0.8,
        flatShading: true
      });
      const shard = new THREE.Mesh(geo, mat);
      shard.castShadow = true;
      shard.position.set(this.target.x + rand(-0.6, 0.6), this.target.y + rand(-0.5, 0.6), this.target.z + rand(-0.6, 0.6));
      this.SC.scene.add(shard);
      const speed = chunk ? rand(3, 7) : rand(5, 14);
      const life = chunk ? rand(3.4, 5) : rand(2.3, 4.2);
      this.debris.push({
        object: shard,
        mat,
        r,
        heat,
        life,
        maxLife: life,
        chunk,
        velocity: new THREE.Vector3(rand(-1, 1), rand(-0.1, 1.2), rand(-1, 1)).normalize().multiplyScalar(speed),
        spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8))
      });
    }
  }
  #spawnBurst() {
    const { x, y, z } = this.target;
    const dir = this.#v;
    // fire sparks
    for (let i = 0; i < 160; i++) {
      dir.set(rand(-1, 1), rand(-0.6, 1), rand(-1, 1)).normalize().multiplyScalar(rand(6, 22));
      this.embers.emit(x, y, z, dir.x, dir.y, dir.z, rand(0.6, 1.7), rand(0.12, 0.3), 0, C.spark0, C.spark1, 1.4, 7);
    }
    // billowing smoke ring along the ground + rising cloud
    const gy = this.groundY;
    for (let i = 0; i < 70; i++) {
      const a = rand(0, Math.PI * 2),
        sp = rand(3, 10);
      this.smoke.emit(x + Math.cos(a) * rand(0, 1.5), gy + 0.1, z + Math.sin(a) * rand(0, 1.5), Math.cos(a) * sp, rand(0.5, 3.5), Math.sin(a) * sp, rand(1.6, 3.2), rand(0.6, 1.0), rand(3, 5), C.dust0, C.dust1, 1.5, -0.4);
    }
    // shock shell, fireball, ground ring, scorch
    for (const m of this.impactMeshes) m.visible = true;
    this.scorch.position.set(x, gy + 0.012, z);
    this.scorchGlow.position.set(x, gy + 0.016, z);
    this.ring.position.set(x, gy + 0.03, z);
    this.dome.position.set(x, y, z);
    this.fireball.position.set(x, y, z);
    this.blastLight.position.set(x, y, z);
  }
  // ---------- physics ----------
  #updateBodies(dt) {
    const g = MeteorScene.GRAVITY;
    for (const b of this.bodyPhysics) {
      if (!b.go) {
        if (this.simAge < b.delay) continue; // blast front has not reached it yet
        b.go = true;
      }
      if (b.rest) continue;
      const o = b.object;
      b.velocity.y -= g * dt;
      o.position.addScaledVector(b.velocity, dt);
      o.rotation.x += b.spin.x * dt;
      o.rotation.y += b.spin.y * dt;
      o.rotation.z += b.spin.z * dt;
      if (o.position.y <= b.floor && b.velocity.y <= 0) {
        const vy = -b.velocity.y;
        o.position.y = b.floor;
        if (vy > 0.7) {
          if (vy > 2.5 && this.puffBudget > 0) {
            this.puffBudget--;
            this.#puff(o.position.x, b.floor, o.position.z, Math.min(1, vy / 10));
          }
          b.velocity.y = vy * 0.32;
          b.velocity.x *= 0.7;
          b.velocity.z *= 0.7;
          b.spin.multiplyScalar(0.65);
        } else b.velocity.y = 0;
        // rolling friction
        const f = Math.exp(-3.5 * dt);
        b.velocity.x *= f;
        b.velocity.z *= f;
        b.spin.multiplyScalar(Math.exp(-3 * dt));
        if (b.velocity.y === 0 && Math.hypot(b.velocity.x, b.velocity.z) < 0.15) {
          b.velocity.set(0, 0, 0);
          b.rest = true;
        }
      }
    }
  }
  #puff(x, y, z, power) {
    const n = 2 + ((power * 3) | 0);
    for (let i = 0; i < n; i++) {
      this.smoke.emit(x + rand(-0.15, 0.15), y + 0.05, z + rand(-0.15, 0.15), rand(-1, 1) * 1.5 * power, 0.3 + rand(0.4, 1.4) * power, rand(-1, 1) * 1.5 * power, rand(0.6, 1.2), 0.25, 0.9 + power * 0.6, C.dust0, C.dust1, 1.8, -0.6);
    }
  }
  #updateDebris(dt) {
    const g = MeteorScene.GRAVITY;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i], o = d.object;
      d.velocity.y -= g * dt;
      o.position.addScaledVector(d.velocity, dt);
      o.rotation.x += d.spin.x * dt;
      o.rotation.y += d.spin.y * dt;
      o.rotation.z += d.spin.z * dt;
      // bounce on the ground instead of falling through it
      const floor = this.groundY + d.r * 0.8;
      if (o.position.y < floor && d.velocity.y < 0) {
        o.position.y = floor;
        const vy = -d.velocity.y * 0.42;
        d.velocity.y = vy < 0.8 ? 0 : vy;
        d.velocity.x *= 0.78;
        d.velocity.z *= 0.78;
        d.spin.multiplyScalar(0.7);
      }
      d.life -= dt;
      const lifeK = clamp01(d.life / d.maxLife);
      d.mat.emissiveIntensity = d.heat * clamp01(lifeK * 1.6); // cools as it flies
      o.scale.setScalar(smooth01(clamp01(d.life / 0.8))); // shrinks only at the end
      // glowing trail while it is hot
      if (lifeK > 0.45 && Math.random() < dt * (d.chunk ? 45 : 22)) {
        this.embers.emit(o.position.x, o.position.y, o.position.z, rand(-0.5, 0.5), rand(0, 1), rand(-0.5, 0.5), rand(0.3, 0.6), d.r * 1.6, 0, C.emberHot, C.emberCool, 1, 1);
      }
      if (d.life <= 0) {
        this.SC.scene.remove(o);
        o.geometry.dispose();
        o.material.dispose();
        this.debris.splice(i, 1);
      }
    }
  }
  clearDebris() {
    for (const d of this.debris) {
      this.SC.scene.remove(d.object);
      d.object.geometry.dispose();
      d.object.material.dispose();
    }
    this.debris.length = 0;
  }
  #updateImpactFx(a) {
    // expanding shock shell (camera ends up inside it -> warm full-screen wash)
    const ud = clamp01(a / 0.55);
    this.dome.scale.setScalar(lerp(0.3, 10, easeOutCubic(ud)));
    this.dome.material.opacity = Math.pow(1 - ud, 2) * 0.4;
    this.dome.visible = ud < 1;
    // fireball
    const uf = clamp01(a / 0.7);
    this.fireball.scale.setScalar(lerp(0.6, 3.2, easeOutCubic(uf)));
    this.fireball.material.opacity = (1 - uf) * 0.9;
    this.fireball.visible = uf < 1;
    // ground shock ring
    const ur = clamp01(a / 1.2);
    this.ring.scale.setScalar(lerp(0.5, 22, easeOutCubic(ur)));
    this.ring.material.opacity = Math.pow(1 - ur, 1.5) * 0.85;
    this.ring.visible = ur < 1;
    // scorch mark burns in, ember disc cools
    this.scorch.scale.setScalar(lerp(0.5, 1.9, easeOutCubic(a / 0.5)));
    this.scorch.material.opacity = Math.min(0.6, a * 2);
    this.scorchGlow.scale.setScalar(lerp(0.5, 1.6, easeOutCubic(a / 0.5)));
    this.scorchGlow.material.opacity = 0.75 * Math.exp(-a * 0.8) * clamp01(a * 6);
    // flash light
    this.blastLight.intensity = 90 * Math.exp(-a * 5.5);
  }
  // ---------- setup / teardown ----------
  /** Builds the meteor group once. Safe to call again: it disposes the old one first. */
  setup() {
    this.dispose();
    const group = new THREE.Group();
    group.name = 'meteor';
    this.rock = this.#buildRock();
    group.add(this.rock);
    this.glows = [
      this.#buildGlow({
        radius: 0.68,
        segs: [16, 12],
        color: '#ff4b12',
        opacity: 0.72,
        z: 1.42,
        scale: [0.78, 0.78, 2.5]
      }),
      this.#buildGlow({
        radius: 0.42,
        segs: [14, 10],
        color: '#ffd36a',
        opacity: 0.88,
        z: 1.0,
        scale: [0.58, 0.58, 2.1]
      })
    ];
    for (const m of this.glows) group.add(m);
    this.light = new THREE.PointLight('#ff642b', 5, 16, 2);
    group.add(this.light);
    group.visible = false;
    this.SC.scene.add(group);
    this.group = group;
    this.#buildFx();
    return group;
  }
  #buildFx() {
    const fx = new THREE.Group();
    fx.name = 'meteorFx';
    this.fx = fx;
    this.embers = new ParticlePool(1000, true);
    this.smoke = new ParticlePool(600, false);
    fx.add(this.smoke.points, this.embers.points);
    const add = (color, extra = {}) => new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      ...extra
    });
    const mk = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      fx.add(m);
      return m;
    };
    this.dome = mk(new THREE.SphereGeometry(1, 24, 16), add('#ffb070', {
      side: THREE.BackSide,
      opacity: 0
    }));
    this.fireball = mk(new THREE.SphereGeometry(1, 20, 14), add('#ff7a1f', {
      opacity: 0
    }));
    this.ring = mk(new THREE.RingGeometry(0.84, 1, 72).rotateX(-Math.PI / 2), add('#ffb978', {
      side: THREE.DoubleSide,
      opacity: 0
    }));
    this.scorch = mk(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      color: '#050304',
      transparent: true,
      opacity: 0,
      depthWrite: false
    }));
    this.scorchGlow = mk(new THREE.CircleGeometry(0.8, 40).rotateX(-Math.PI / 2), add('#ff5a1a', {
      opacity: 0
    }));
    this.impactMeshes = [this.dome, this.fireball, this.ring, this.scorch, this.scorchGlow];
    // stays "visible" at intensity 0 so the shader isn't recompiled at the moment of impact
    this.blastLight = new THREE.PointLight('#ffa35c', 0, 40, 2);
    fx.add(this.blastLight);
    this.SC.scene.add(fx);
  }
  #hideImpactFx() {
    for (const m of this.impactMeshes ?? []) m.visible = false;
    if (this.blastLight) this.blastLight.intensity = 0;
  }
  #ensureOverlays() {
    if (this.flashEl) return;
    const mk = (css) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:25;' + css;
      document.body.appendChild(d);
      return d;
    };
    this.heatEl = mk('background:radial-gradient(ellipse at center,rgba(255,90,20,0) 45%,rgba(255,70,10,.55) 100%);');
    this.flashEl = mk('background:radial-gradient(circle at center,#fff 0%,#ffd9a0 35%,rgba(255,120,40,.6) 100%);mix-blend-mode:screen;');
  }
  #buildRock() {
    const geo = new THREE.IcosahedronGeometry(MeteorScene.ROCK_RADIUS, MeteorScene.ROCK_DETAIL);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Two layers of position-based noise. It depends only on position, so
      // vertices shared between faces move identically and the mesh has no cracks.
      const n = 1 + 0.16 * Math.sin(x * 19 + y * 23 + z * 29) + 0.07 * Math.sin(x * 41 - y * 17 + z * 13);
      pos.setXYZ(i, x * n, y * n, z * n);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: '#4a3029',
      roughness: 0.86,
      emissive: '#a72e12',
      emissiveIntensity: 0.42
    }));
    rock.castShadow = true;
    return rock;
  }
  #buildGlow({ radius, segs, color, opacity, z, scale }) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segs[0], segs[1]), new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false, // stops the translucent tail from occluding itself
      blending: THREE.AdditiveBlending // reads as fire against any background
    }));
    mesh.position.z = z;
    mesh.scale.set(...scale);
    mesh.userData = { z, sx: scale[0], sy: scale[1], sz: scale[2] };
    return mesh;
  }
  /** Frees GPU resources and removes the meteor and its effects from the scene. */
  dispose() {
    this.clearDebris();
    this.embers?.dispose();
    this.smoke?.dispose();
    this.embers = this.smoke = null;
    for (const root of [this.group, this.fx]) {
      if (!root) continue;
      this.SC.scene.remove(root);
      root.traverse(o => {
        if (!(o.isMesh || o.isPoints)) return;
        o.geometry.dispose();
        o.material.dispose();
      });
    }
    this.flashEl?.remove();
    this.heatEl?.remove();
    this.flashEl = this.heatEl = null;
    this.group = null;
    this.fx = null;
    this.light = null;
    this.rock = null;
    this.glows = [];
    this.impactMeshes = [];
  }
}