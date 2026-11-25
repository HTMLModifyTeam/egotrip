import * as THREE from 'three';
import { NOW } from '../data/data.js';
import { Person } from '../objects/person.js';
import { smooth01, lerp, lerpAngle, clamp01 } from '../utils/Math.js';

export default class SmellyScene {
  static T = Object.freeze({
    arrive: 1.55,      // victim finishes walking in
    angerStart: 1.2,   // crowd turns angry
    scareStart: 1.45,  // victim screams
    leanStart: 2.1,
    brawlStart: 2.05,
    stone: 5.2,        // victim turns to stone
    brawlEnd: 5.25,    // crowd calms down
    grabStart: 5.7,    // two bar-goers walk up to the statue
    grabDur: 0.55,
    carryStart: 6.35,  // statue is lifted and carried to the door
    throwAt: 7.5,      // statue is released
    flightDur: 0.9,    // time in the air
    returnDur: 1.35,   // crowd walks back to its spots
    end: 9.4
  });
  static START = new THREE.Vector3(4.8, 0, -4.15);
  static TARGET = new THREE.Vector3(1.05, 0, -3.35);
  // Door the statue is carried to, and the spot outside where it lands.
  // Adjust these two to match your bar layout.
  static DOOR = new THREE.Vector3(4.2, 0, -4.15);
  static EXIT = new THREE.Vector3(7.6, 0, -4.6);
  static CARRY_HEIGHT = 0.55;
  static PUFFS = 12;
  static PUFF_PERIOD = 1.05;
  static SPARKS = 10;
  static SPARK_PERIOD = 0.34;
  static STONE_COLOR = '#969b9b';
  static STONE_EMISSIVE = '#343839';

  constructor(o) {
    this.on = false;
    this.t0 = 0;
    this.person = null;
    this.personFace = '';
    this.converted = false;
    this.target = SmellyScene.TARGET.clone();
    this.crowdStarts = [];
    this.carriers = [];      // crowd indices that carry the statue out
    this.smoke = [];
    this.smokeGeo = null;
    this.sparks = [];
    this.sparkGeo = null;
    this.statue = { pos: new THREE.Vector3(), rx: 0, ry: Math.PI * 0.7, rz: 0, carry: 0 };

    Object.assign(this, {
      UI: null,
      SC: null,
      CROWD: null,
      randomLook: () => null,
    }, o)
  }

  // ---------- lifecycle ----------

  start() {
    if (this.on || !this.UI.playing) return;

    // Clear leftovers from a previous run (old statue, smoke).
    this.disposePerson();
    this.clearSmoke();

    this.person = this.#createPerson();
    this.on = true;
    this.t0 = NOW.t;
    this.converted = false;
    this.personFace = '';
    this.target.copy(SmellyScene.TARGET);

    this.crowdStarts = this.CROWD.list.map(m => ({
      pos: m.p.root.position.clone(),
      yaw: m.p.root.rotation.y
    }));
    this.#pickCarriers();
    this.#createSmoke();

    this.UI.el.customMenu.style.display = 'none';

    for (const m of this.CROWD.list) {
      m.act = null;
      m.pending = null;
      m.smellyFace = '';
    }
  }

  /** Ends the scene. The statue stays (outside) until the next start(). */
  end() {
    this.on = false;
    this.clearSmoke();
    this.personFace = '';
    this.converted = false;
    for (const m of this.CROWD.list) m.smellyFace = '';
    if (this.UI.playing) this.UI.el.customMenu.style.display = 'flex';
  }

  update(dt, t, beat) {
    const p = this.person;
    if (!p) {
      this.on = false;
      return;
    }

    const T = SmellyScene.T;
    const age = t - this.t0;
    const step = Math.min(dt, 0.1);
    const brawl = age >= T.brawlStart && age < T.brawlEnd;
    // Smooth 0..1 fight intensity: ramps in fast, fades out just before the stone moment.
    const k = smooth01((age - T.brawlStart) / 0.35) * (1 - smooth01((age - (T.brawlEnd - 0.4)) / 0.4));

    this.#updateStatuePose(age);
    this.#updateVictim(p, age, t, beat, step, k);
    this.#updateCrowd(age, t, beat, step, k);
    this.#updateSmoke(age, brawl, k);
    this.#updateSparks(age, t, brawl, k);

    if (age > T.end) this.end();
  }

  // ---------- victim ----------

  #createPerson() {
    const look = this.randomLook(82731);
    Object.assign(look, {
      name: 'smelly-person',
      top: '#82913e',
      pants: '#51423b',
      hairColor: '#35251f'
    });
    const p = new Person(look, { lod: 1 });
    p.root.position.copy(SmellyScene.START);
    p.root.rotation.y = -Math.PI / 2;
    p.c.stand = 1;
    p.c.groove = 0;
    p.c.look.set(0, 1.35, -2.5);
    this.SC.scene.add(p.root);
    return p;
  }

  #updateVictim(p, age, t, beat, step, k) {
    const T = SmellyScene.T, S = SmellyScene.START, target = this.target;
    const arrive = smooth01(age / T.arrive);

    if (age < T.stone) {
      // Walk in, then get shoved around by the mob.
      const shakeX = Math.sin(t * 17) * 0.07 * k + Math.sin(t * 7.3) * 0.05 * k;
      const shakeZ = Math.cos(t * 13) * 0.06 * k;
      p.root.position.set(lerp(S.x, target.x, arrive) + shakeX, 0, lerp(S.z, target.z, arrive) + shakeZ);
      p.root.rotation.set(0, lerp(-Math.PI / 2, Math.PI * 0.7, arrive) + Math.sin(t * 11) * 0.25 * k, 0);
      SmellyScene.#resetPose(p.c);
      p.c.step = age < T.arrive ? 0.7 : 0;
      p.c.look.set(0, 1.3, -4.2);
      p.c.lean = (age > T.leanStart ? Math.sin(t * 13) * 0.13 : 0) + Math.sin(t * 9) * 0.18 * k;
      p.c.side = Math.sin(t * 15) * 0.3 * k;
      p.c.twist = Math.sin(t * 19) * 0.35 * k;
      p.c.headShake = Math.sin(t * 22) * k;
      p.c.bounce = Math.abs(Math.sin(t * 8)) * 0.25 * k;
    }

    if (age > T.scareStart && age < T.stone && this.personFace !== 'scared') {
      p.express('scream', 0);
      this.personFace = 'scared';
    }

    if (age >= T.stone) {
      this.stone(p);   // guards itself
      const s = this.statue;
      p.root.position.copy(s.pos);
      p.root.rotation.set(s.rx, s.ry, s.rz);
      SmellyScene.#resetPose(p.c);
      p.c.step = p.c.lean = p.c.side = p.c.twist = p.c.headShake = 0;
      p.c.look.set(0, 1.1, -4);
    }
    p.update(step, t, beat);
  }

  /** Turns a person to stone. Safe to call repeatedly, and for any person. */
  stone(p) {
    if (p.root.userData.stoned) return;
    p.root.userData.stoned = true;
    this.converted = true;

    const cache = new Map();   // source material -> stone clone
    const stoneMats = [];
    const toStone = mat => {
      let m = cache.get(mat);
      if (!m) {
        m = mat.clone();
        if (m.color) m.color.set(SmellyScene.STONE_COLOR);
        if (m.emissive) m.emissive.set(SmellyScene.STONE_EMISSIVE);
        cache.set(mat, m);
        stoneMats.push(m);
      }
      return m;
    };

    p.root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      o.material = Array.isArray(o.material) ? o.material.map(toStone) : toStone(o.material);
    });

    p.root.userData.stoneMats = stoneMats;
    p.root.name = 'stone-smelly-person';
  }

  disposePerson() {
    const p = this.person;
    if (!p) return;
    this.SC.scene.remove(p.root);
    p.root.userData.stoneMats?.forEach(m => m.dispose());
    p.dispose?.();   // only if Person defines it
    this.person = null;
  }

  /** Computes where the statue is at this age (stationary, carried, flying, landed). */
  #updateStatuePose(age) {
    const T = SmellyScene.T, S = this.statue, target = this.target;
    const door = SmellyScene.DOOR, exit = SmellyScene.EXIT, H = SmellyScene.CARRY_HEIGHT;
    const yaw = Math.PI * 0.7;

    S.pos.copy(target);
    S.rx = 0; S.ry = yaw; S.rz = 0; S.carry = 0;

    if (age < T.carryStart) return;

    if (age < T.throwAt) {
      // Carried: lifted, tilted, and moved toward the door with a walking bob.
      const lift = smooth01((age - T.carryStart) / 0.35);
      const move = smooth01((age - T.carryStart) / (T.throwAt - T.carryStart));
      S.pos.set(lerp(target.x, door.x, move), lift * H + Math.abs(Math.sin(age * 9)) * 0.06 * lift, lerp(target.z, door.z, move));
      S.rz = lift * 0.18 + Math.sin(age * 9) * 0.04 * lift;
      S.ry = yaw + move * 0.5;
      S.carry = lift;
      return;
    }

    // Thrown: arcs through the door, tumbles, lands and bounces once.
    const f = clamp01((age - T.throwAt) / T.flightDur);
    S.pos.set(lerp(door.x, exit.x, f), lerp(H, 0.28, f) + Math.sin(f * Math.PI) * 1.4, lerp(door.z, exit.z, f));
    S.rx = lerp(0, Math.PI / 2, f) + Math.sin(f * Math.PI) * 2.4;
    S.rz = lerp(0.18, 0.05, f);
    S.ry = yaw + 0.5 + f * 0.8;

    const b = clamp01((age - T.throwAt - T.flightDur) / 0.35);
    if (f >= 1 && b < 1) S.pos.y += Math.abs(Math.sin(b * Math.PI)) * 0.22 * (1 - b);
  }

  #pickCarriers() {
    const target = this.target;
    this.carriers = this.CROWD.list
      .map((m, i) => ({ i, d: m.p.root.visible ? m.p.root.position.distanceTo(target) : Infinity }))
      .filter(c => isFinite(c.d))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map(c => c.i);
  }

  /** Position where carrier `side` (-1 or +1) stands next to the statue's current pose. */
  #carrierAnchor(side, out) {
    const target = this.target, door = SmellyScene.DOOR;
    const dx = door.x - target.x, dz = door.z - target.z;
    const d = Math.hypot(dx, dz) || 1;
    const px = -dz / d, pz = dx / d;
    const s = this.statue;
    // While in flight the statue is gone, so freeze the anchor at the door.
    const bx = s.carry > 0 || this.#age < SmellyScene.T.carryStart ? s.pos.x : door.x;
    const bz = s.carry > 0 || this.#age < SmellyScene.T.carryStart ? s.pos.z : door.z;
    return out.set(bx + px * side * 0.55, 0, bz + pz * side * 0.55);
  }

  #age = 0;

  // ---------- crowd ----------

  #updateCrowd(age, t, beat, step, k) {
    const T = SmellyScene.T, target = this.target, statue = this.statue;
    this.#age = age;
    const anger = smooth01((age - T.angerStart) / 0.55);
    const returnK = smooth01((age - T.brawlEnd) / T.returnDur);
    const faceNow = age < T.brawlEnd ? (age < T.angerStart ? 'jawdrop' : 'angry') : 'smile';
    const dirX = SmellyScene.DOOR.x - target.x, dirZ = SmellyScene.DOOR.z - target.z;
    const carryYaw = Math.atan2(dirX, dirZ);
    const anchor = new THREE.Vector3();

    for (let i = 0; i < this.CROWD.list.length; i++) {
      const m = this.CROWD.list[i], q = m.p, start = this.crowdStarts[i];
      if (!start || !q.root.visible) continue;

      const carrierIdx = this.carriers.indexOf(i);
      const isCarrier = carrierIdx !== -1 && age >= T.grabStart;

      // --- base position + fight motion ---
      const dx = target.x - start.pos.x, dz = target.z - start.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const ux = dx / d, uz = dz / d;           // toward the victim
      const px = -uz, pz = ux;                  // sideways (circling)

      // Each fighter swings on their own rhythm: wind up, then lunge in.
      const cyc = t * 6.5 + m.phase0 * 2.1;
      const strike = Math.pow(Math.max(0, Math.sin(cyc)), 2);
      const lunge = k * (0.18 + strike * 0.45);
      const circle = k * Math.sin(t * 2.4 + m.phase0) * 0.16;

      let x = start.pos.x + ux * lunge + px * circle;
      let y = start.pos.y;
      let z = start.pos.z + uz * lunge + pz * circle;
      let yaw;

      if (isCarrier) {
        const side = carrierIdx === 0 ? -1 : 1;
        const g = smooth01((age - T.grabStart) / T.grabDur);
        const back = smooth01((age - T.throwAt) / T.returnDur);

        this.#carrierAnchor(side, anchor);
        // Before carry starts, the anchor sits beside the stationary statue.
        let ax = anchor.x, az = anchor.z;
        x = lerp(x, ax, g);
        z = lerp(z, az, g);
        x = lerp(x, m.spot.pos.x, back);
        y = lerp(start.pos.y, m.spot.pos.y, back);
        z = lerp(z, m.spot.pos.z, back);
        q.root.position.set(x, y, z);

        const carrying = age >= T.carryStart && age < T.throwAt;
        const faceStatue = Math.atan2(statue.pos.x - x, statue.pos.z - z);
        yaw = lerpAngle(start.yaw, age < T.carryStart ? faceStatue : carryYaw, g);
        yaw = lerpAngle(yaw, start.yaw, back);
        q.root.rotation.y = yaw;

        SmellyScene.#resetPose(q.c);
        q.c.look.set(statue.pos.x, 1.0, statue.pos.z);
        // Heave: lean into the load, strain with each step, big swing back at the throw.
        const swing = age >= T.throwAt - 0.25 && age < T.throwAt + 0.2 ? Math.sin(((age - (T.throwAt - 0.25)) / 0.45) * Math.PI) : 0;
        q.c.lean = carrying ? 0.28 + Math.sin(t * 9) * 0.05 : swing * 0.5;
        q.c.side = carrying ? side * -0.1 : 0;
        q.c.twist = swing * side * 0.4;
        q.c.bounce = carrying ? Math.abs(Math.sin(t * 9)) * 0.2 : 0;
        q.c.step = carrying || (g > 0 && g < 1) || (back > 0 && back < 1) ? 0.7 : 0;
        q.c.kneel = age >= T.grabStart + T.grabDur - 0.2 && age < T.carryStart ? 0.3 : 0;
      } else {
        x = lerp(x, m.spot.pos.x, returnK);
        y = lerp(y, m.spot.pos.y, returnK);
        z = lerp(z, m.spot.pos.z, returnK);
        q.root.position.set(x, y, z);

        const faceYaw = Math.atan2(target.x - x, target.z - z);
        q.root.rotation.y = lerpAngle(start.yaw, faceYaw, anger * (1 - returnK));

        SmellyScene.#resetPose(q.c);
        // Fighters watch the victim; afterwards they watch the statue go out the door.
        const watchX = age < T.brawlEnd ? target.x : statue.pos.x;
        const watchY = age < T.brawlEnd ? 1.25 : statue.pos.y + 1.0;
        const watchZ = age < T.brawlEnd ? target.z : statue.pos.z;
        q.c.look.set(watchX, watchY, watchZ);

        q.c.lean = k * (0.1 + strike * 0.38 + Math.sin(t * 16 + m.phase0) * 0.08);
        q.c.side = k * Math.sin(t * 14 + m.phase0) * 0.26;
        q.c.twist = k * (Math.sin(t * 18 + m.phase0) * 0.3 + (strike > 0.5 ? 0.35 : -0.1));
        q.c.bounce = k * strike * 0.35;
        q.c.step = k > 0.05 ? 0.7 : 0;
      }

      if (m.smellyFace !== faceNow) {
        q.express(faceNow, 0);
        m.smellyFace = faceNow;
      }

      q.update(step, t, beat);
      if (!isCarrier && age >= T.brawlEnd) q.root.rotation.y = lerpAngle(q.root.rotation.y, start.yaw, returnK);
    }
  }

  // ---------- smoke + hit sparks ----------

  #createSmoke() {
    // One shared geometry; one material per puff because opacity differs.
    this.smokeGeo = new THREE.SphereGeometry(0.24, 9, 7);
    for (let i = 0; i < SmellyScene.PUFFS; i++) {
      const puff = new THREE.Mesh(this.smokeGeo, new THREE.MeshBasicMaterial({ color: '#8a8580', transparent: true, opacity: 0, depthWrite: false }));
      puff.visible = false;
      this.SC.scene.add(puff);
      this.smoke.push(puff);
    }

    // Small bright "impact" bursts that flash around the victim.
    this.sparkGeo = new THREE.SphereGeometry(0.07, 6, 5);
    for (let i = 0; i < SmellyScene.SPARKS; i++) {
      const s = new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color: '#fff2a8', transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false;
      this.SC.scene.add(s);
      this.sparks.push(s);
    }
  }

  #updateSmoke(age, brawl, k) {
    const T = SmellyScene.T, target = this.target;
    for (let i = 0; i < this.smoke.length; i++) {
      const o = this.smoke[i];
      o.visible = brawl;
      if (!brawl) continue;

      const cycle = (age - T.brawlStart + i * 0.16) / SmellyScene.PUFF_PERIOD;
      const phase = cycle - Math.floor(cycle);
      const ang = i * 2.399 + Math.floor(cycle) * 1.7;
      const size = 0.55 + phase * 1.25;

      o.position.set(target.x + Math.cos(ang) * (0.35 + phase * 0.48), 0.45 + phase * 1.45, target.z + Math.sin(ang) * (0.3 + phase * 0.42));
      o.scale.set(size, size * 1.08, size);
      o.material.opacity = Math.sin(phase * Math.PI) * 0.58 * Math.max(k, 0.25);
    }
  }

  #updateSparks(age, t, brawl, k) {
    const target = this.target;
    for (let i = 0; i < this.sparks.length; i++) {
      const o = this.sparks[i];
      o.visible = brawl && k > 0.1;
      if (!o.visible) continue;

      const cycle = (age + i * 0.11) / SmellyScene.SPARK_PERIOD;
      const n = Math.floor(cycle), phase = cycle - n;
      // Deterministic pseudo-random spot per burst, so each hit lands somewhere new.
      const r1 = Math.sin(n * 12.9898 + i * 78.233) * 43758.5453; const a = (r1 - Math.floor(r1)) * Math.PI * 2;
      const r2 = Math.sin(n * 39.346 + i * 11.135) * 24634.6345; const h = r2 - Math.floor(r2);

      const rad = 0.25 + phase * 0.35;
      o.position.set(target.x + Math.cos(a) * rad, 0.7 + h * 0.9 + phase * 0.25, target.z + Math.sin(a) * rad);
      const s = 0.8 + (1 - phase) * 1.6;
      o.scale.set(s, s, s);
      o.material.opacity = (1 - phase) * 0.9 * k;
    }
  }

  clearSmoke() {
    for (const o of this.smoke) {
      this.SC.scene.remove(o);
      o.material.dispose();
    }
    this.smoke.length = 0;
    this.smokeGeo?.dispose();
    this.smokeGeo = null;

    for (const o of this.sparks) {
      this.SC.scene.remove(o);
      o.material.dispose();
    }
    this.sparks.length = 0;
    this.sparkGeo?.dispose();
    this.sparkGeo = null;
  }

  // ---------- helpers ----------
  static #resetPose(c) {
    c.stand = 1; c.groove = 0; c.bounce = 0; c.jump = 0;
    c.kneel = 0; c.slump = 0;
  }
}