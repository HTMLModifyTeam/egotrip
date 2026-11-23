import * as THREE from 'three';
import { NOW } from '../data/data.js';
import { stopBandVoices } from "../audio/BandVoice.js";
import { rand, pick } from '../utils/Random.js';
import { smooth01 } from '../utils/Math.js';

export default class MeteorScene {
  static T = {
    flight: 1.7,         // seconds from spawn to impact
    nearStart: 0.75,     // pre-impact rumble begins
    nearDur: 0.95,
    preShake: 0.12,
    shakeDecay: 2.1,     // post-impact shake fades over this
    gameOverDelay: 2.3
  };
  static GRAVITY = 9.8;
  static SPAWN_DIST = 1.65;   // target distance in front of camera
  static SHARDS = 30;
  static SHARD_COLORS = ['#ff6835', '#ffc36d', '#6d4858', '#3a303f'];
  static ROCK_RADIUS = 1.25;
  static ROCK_DETAIL = 2;

  // scratch objects, reused every frame
  #v = new THREE.Vector3();
  #q = new THREE.Quaternion();
  #e = new THREE.Euler();
  static #FWD = new THREE.Vector3(0, 0, -1);

  constructor(o) {
    this.on = false;
    this.impacted = false;
    this.gameOver = false;
    this.t0 = 0;
    this.impactT = 0;
    this.shake = 0;
    this.bodyPhysics = [];
    this.debris = [];
    this.basePos = new THREE.Vector3();
    this.baseQuat = new THREE.Quaternion();
    this.start_ = new THREE.Vector3();   // spawn point (see note on `start`)
    this.target = new THREE.Vector3();
    this.flight = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.group = null;   // assigned externally
    this.light = null;   // assigned externally
    this.bed = null;

    Object.assign(this, {
      UI: null,
      GAME: null,
      CROWD: null,
      FIGHT: null,
      BAND: null,
      SC: null,
      VENUE: null, TP: null, ITL: null, MUS: null, AE: null,
      setAuto: (b) => null,
      releaseAllInput: () => null,
      fingerVisual: (b) => null,
      bed: null
    }, o);
  }

  // ---------- lifecycle ----------

  begin() {
    if (this.on || this.FIGHT.on || !this.UI.playing) return;
    if (this.GAME.phase !== 'play' && this.GAME.phase !== 'pre') return;
    if (!this.group) return;

    this.on = true;
    this.impacted = false;
    this.gameOver = false;
    this.t0 = NOW.t;
    this.impactT = 0;
    this.shake = 0;
    this.bodyPhysics.length = 0;
    this.clearDebris();

    this.#silenceShow();
    this.#hideUI();
    this.#setupCamera();
  }

  #silenceShow() {
    this.setAuto(false);
    this.releaseAllInput();
    this.fingerVisual(null);
    this.TP.blowing = false;
    this.TP.voice = null;
    this.MUS.running = false;
    if (this.ITL.cur) itlEnd();
    if (this.AE.ctx) {
      stopBandVoices(this.AE.ctx.currentTime);
      this.bed.set('applause', 0);
      this.bed.set('babble', 0);
    }
  }

  #hideUI() {
    for (const id of ['pause', 'fight', 'meteor', 'endShow', 'nextSong', 'hudMode', 'autoMode', 'special', 'finishHint', 'finBar', 'customMenu']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    document.getElementById('controls')?.classList.add('off');
    document.getElementById('gameOver')?.classList.add('hide');   // clear any previous run
  }

  #setupCamera() {
    const cam = this.SC.camera;
    cam.updateMatrixWorld(true);
    this.basePos.copy(cam.position);
    this.baseQuat.copy(cam.quaternion);
    cam.getWorldDirection(this.flight).normalize();
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    this.right.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();

    this.target.copy(cam.position).addScaledVector(this.flight, MeteorScene.SPAWN_DIST);
    this.start_.copy(this.target).addScaledVector(this.flight, 22).addScaledVector(this.up, 8).addScaledVector(this.right, 6);

    const g = this.group;
    g.position.copy(this.start_);
    g.visible = true;
    g.quaternion.setFromUnitVectors(MeteorScene.#FWD, this.#v.copy(this.target).sub(this.start_).normalize());
    g.scale.setScalar(1.18);
  }

  // ---------- update ----------

  update(dt, t) {
    if (!this.on) return;
    dt = Math.min(dt, 0.1);   // avoid physics tunnelling after a long frame

    const T = MeteorScene.T;
    const age = t - this.t0;
    const impactAge = this.impacted ? t - this.impactT : 0;

    if (!this.impacted) this.#updateFlight(dt, age, t);

    const shake = this.impacted ? Math.max(0, 1 - impactAge / T.shakeDecay) : this.shake;
    this.#applyCameraShake(t, shake);

    if (this.impacted) {
      this.#updateBodies(dt);
      this.#updateDebris(dt);
      if (impactAge > T.gameOverDelay && !this.gameOver) {
        this.gameOver = true;
        document.getElementById('gameOver')?.classList.remove('hide');
      }
    }
  }

  #updateFlight(dt, age, t) {
    const T = MeteorScene.T, g = this.group;
    const k = smooth01(age / T.flight);
    g.position.lerpVectors(this.start_, this.target, k);
    g.rotation.x += dt * 1.8;
    g.rotation.y += dt * 2.5;
    g.scale.setScalar(1.05 + k * 0.38);
    this.shake = smooth01((age - T.nearStart) / T.nearDur) * T.preShake;
    if (age >= T.flight) this.impact(t);
  }

  #applyCameraShake(t, s) {
    const cam = this.SC.camera;
    cam.position.copy(this.basePos);
    cam.position.x += Math.sin(t * 48) * s * 0.17;
    cam.position.y += Math.sin(t * 37 + 0.7) * s * 0.14;
    cam.position.z += Math.sin(t * 54 + 1.4) * s * 0.08;

    this.#e.set(Math.sin(t * 33) * s * 0.07, Math.sin(t * 41 + 1) * s * 0.07, Math.sin(t * 45 + 2) * s * 0.095);
    cam.quaternion.copy(this.baseQuat).multiply(this.#q.setFromEuler(this.#e));
  }

  // ---------- impact ----------

  impact(t) {
    this.impacted = true;
    this.impactT = t;
    this.shake = 1;
    this.group.visible = false;

    this.#launchBodies();
    this.#spawnDebris();

    const eyebrow = document.querySelector('.game-over-eyebrow');
    if (eyebrow) eyebrow.textContent = 'METEOR STRIKE';
  }

  #launchBodies() {
    const seen = new Set();   // O(1) duplicate check
    const add = (object, weight) => {
      if (!object?.position || seen.has(object)) return;
      seen.add(object);
      const dir = new THREE.Vector3(rand(-1, 1), rand(0.15, 1.25), rand(-1, 1)).normalize();
      this.bodyPhysics.push({
        object,
        velocity: dir.multiplyScalar(rand(4.8, 10.5) * weight),
        spin: new THREE.Vector3(rand(-5, 5), rand(-5, 5), rand(-5, 5)),
        floor: object.position.y,
        weight
      });
    };

    // Order matters: the first weight given to an object wins.
    if (this.VENUE?.root) add(this.VENUE.root, 0.55);
    for (const m of this.CROWD.list) if (m.p?.root.visible) add(m.p.root, 1);
    for (const m of this.BAND.members) if (m.root?.visible) add(m.root, 1.05);
    for (const o of this.SC.scene.children) {
      if (o.visible && !o.isLight && !o.isCamera && o !== this.group) add(o, 0.62);
    }
  }

  #spawnDebris() {
    const colors = MeteorScene.SHARD_COLORS;
    for (let i = 0; i < MeteorScene.SHARDS; i++) {
      const geo = new THREE.IcosahedronGeometry(rand(0.08, 0.28), 0);
      const mat = new THREE.MeshStandardMaterial({
        color: pick(colors),
        emissive: '#a73418',
        emissiveIntensity: rand(0.25, 0.8),
        roughness: 0.8
      });
      const shard = new THREE.Mesh(geo, mat);
      shard.position.set(this.target.x + rand(-0.6, 0.6), this.target.y + rand(-0.5, 0.6), this.target.z + rand(-0.6, 0.6));
      this.SC.scene.add(shard);

      this.debris.push({
        object: shard,
        velocity: new THREE.Vector3(rand(-1, 1), rand(-0.1, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(4, 12)),
        spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)),
        life: rand(2.3, 4.2)
      });
    }
  }

  // ---------- physics ----------

  #updateBodies(dt) {
    const g = MeteorScene.GRAVITY;
    for (const b of this.bodyPhysics) {
      const o = b.object;
      b.velocity.y -= g * dt;
      o.position.addScaledVector(b.velocity, dt);
      o.rotation.x += b.spin.x * dt;
      o.rotation.y += b.spin.y * dt;
      o.rotation.z += b.spin.z * dt;

      if (o.position.y < b.floor) {
        o.position.y = b.floor;
        b.velocity.y = Math.abs(b.velocity.y) * 0.24;
        b.velocity.x *= 0.68;
        b.velocity.z *= 0.68;
        b.spin.multiplyScalar(0.72);
        if (b.velocity.y < 0.7) b.velocity.y = 0;
      }
    }
  }

  #updateDebris(dt) {
    const g = MeteorScene.GRAVITY;
    const shrink = Math.exp(-0.7 * dt);   // frame-rate independent
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i], o = d.object;
      d.velocity.y -= g * dt;
      o.position.addScaledVector(d.velocity, dt);
      o.rotation.x += d.spin.x * dt;
      o.rotation.y += d.spin.y * dt;
      o.rotation.z += d.spin.z * dt;
      o.scale.multiplyScalar(shrink);

      d.life -= dt;
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

  /** Builds the meteor group once. Safe to call again: it disposes the old one first. */
  setup() {
    this.dispose();

    const group = new THREE.Group();
    group.name = 'meteor';

    group.add(this.#buildRock());
    group.add(this.#buildGlow({ radius: 0.68, segs: [16, 12], color: '#ff4b12', opacity: 0.72, z: 1.42, scale: [0.78, 0.78, 2.5] }));
    group.add(this.#buildGlow({ radius: 0.42, segs: [14, 10], color: '#ffd36a', opacity: 0.88, z: 1.0, scale: [0.58, 0.58, 2.1] }));

    this.light = new THREE.PointLight('#ff642b', 5, 16, 2);
    group.add(this.light);

    group.visible = false;
    this.SC.scene.add(group);
    this.group = group;
    return group;
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

    const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#4a3029', roughness: 0.86, emissive: '#a72e12', emissiveIntensity: 0.42 }));
    rock.castShadow = true;
    return rock;
  }

  #buildGlow({ radius, segs, color, opacity, z, scale }) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, segs[0], segs[1]),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity,
        depthWrite: false,                 // stops the translucent tail from occluding itself
        blending: THREE.AdditiveBlending   // reads as fire against any background
      })
    );
    mesh.position.z = z;
    mesh.scale.set(...scale);
    return mesh;
  }

  /** Frees GPU resources and removes the meteor from the scene. */
  dispose() {
    const g = this.group;
    if (!g) return;
    SC.scene.remove(g);
    g.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.material.dispose();
    });
    this.group = null;
    this.light = null;
  }
}