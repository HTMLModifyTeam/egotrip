import * as THREE from 'three';
import { NOW } from '../data/data.js';
import { Person } from '../objects/person.js';
import { smooth01, lerp, lerpAngle } from '../utils/Math.js';

export default class SmellyScene {
  static T = {
    arrive: 1.55,      // victim finishes walking in
    angerStart: 1.2,   // crowd turns angry
    scareStart: 1.45,  // victim screams
    leanStart: 2.1,
    brawlStart: 2.05,
    stone: 5.2,        // victim turns to stone
    brawlEnd: 5.25,    // crowd calms down
    returnDur: 1.35,   // crowd walks back to its spots
    end: 6.8
  };
  static START = new THREE.Vector3(4.8, 0, -4.15);
  static TARGET = new THREE.Vector3(1.05, 0, -3.35);
  static PUFFS = 12;
  static PUFF_PERIOD = 1.05;
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
    this.smoke = [];
    this.smokeGeo = null;

    Object.assign(this, {
      UI: null,
      GAME: null,
      CROWD: null,
      FIGHT: null,
      BAND: null,
      SC: null,
      randomLook: () => null,
      stare: () => null
    }, o)
    this.METEOR = null;
  }

  // ---------- lifecycle ----------

  start() {
    if (this.on || !this.UI.playing || this.FIGHT.on || this.METEOR.on) return;
    if (this.GAME.phase !== 'play' && this.GAME.phase !== 'pre') return;

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
    this.#createSmoke();

    this.UI.el.customMenu.style.display = 'none';

    for (const m of this.CROWD.list) {
      m.act = null;
      m.pending = null;
      m.smellyFace = '';
    }
    for (const m of this.BAND.members) this.stare(m, 5, 'jawdrop', 0.8);
  }

  /** Ends the scene. The statue stays until the next start(). */
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

    this.#updateVictim(p, age, t, beat, step);
    this.#updateCrowd(age, t, beat, step, brawl);
    this.#updateSmoke(age, brawl);

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

  #updateVictim(p, age, t, beat, step) {
    const T = SmellyScene.T, S = SmellyScene.START, target = this.target;
    const arrive = smooth01(age / T.arrive);

    p.root.position.set(lerp(S.x, target.x, arrive), 0, lerp(S.z, target.z, arrive));
    p.root.rotation.y = lerp(-Math.PI / 2, Math.PI * 0.7, arrive);
    SmellyScene.#resetPose(p.c);
    p.c.step = age < T.arrive ? 0.7 : 0;
    p.c.look.set(0, 1.3, -4.2);
    p.c.lean = (age > T.leanStart && age < T.stone) ? Math.sin(t * 13) * 0.13 : 0;

    if (age > T.scareStart && age < T.stone && this.personFace !== 'scared') {
      p.express('scream', 0);
      this.personFace = 'scared';
    }

    if (age >= T.stone) {
      this.stone(p);   // guards itself
      p.root.position.copy(target);
      p.root.rotation.set(0, Math.PI * 0.7, 0);
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

  // ---------- crowd ----------

  #updateCrowd(age, t, beat, step, brawl) {
    const T = SmellyScene.T, target = this.target;
    const anger = smooth01((age - T.angerStart) / 0.55);
    const returnK = smooth01((age - T.brawlEnd) / T.returnDur);
    const faceNow = age < T.brawlEnd ? (age < T.angerStart ? 'jawdrop' : 'angry') : 'smile';

    for (let i = 0; i < this.CROWD.list.length; i++) {
      const m = this.CROWD.list[i], q = m.p, start = this.crowdStarts[i];
      if (!start || !q.root.visible) continue;

      const dx = target.x - start.pos.x, dz = target.z - start.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const lunge = brawl ? 0.32 + Math.sin(t * 12 + m.phase0) * 0.09 : 0;

      q.root.position.set(lerp(start.pos.x + (dx / d) * lunge, m.spot.pos.x, returnK), lerp(start.pos.y, m.spot.pos.y, returnK), lerp(start.pos.z + (dz / d) * lunge, m.spot.pos.z, returnK));
      const faceYaw = Math.atan2(target.x - q.root.position.x, target.z - q.root.position.z);
      q.root.rotation.y = lerpAngle(start.yaw, faceYaw, anger * (1 - returnK));

      SmellyScene.#resetPose(q.c);
      q.c.look.set(target.x, 1.25, target.z);
      q.c.lean = brawl ? 0.15 + Math.sin(t * 16 + m.phase0) * 0.13 : 0;
      q.c.side = brawl ? Math.sin(t * 14 + m.phase0) * 0.24 : 0;
      q.c.twist = brawl ? Math.sin(t * 18 + m.phase0) * 0.3 : 0;
      q.c.step = brawl ? 0.7 : 0;

      if (m.smellyFace !== faceNow) {
        q.express(faceNow, 0);
        m.smellyFace = faceNow;
      }

      q.update(step, t, beat);
      if (age >= T.brawlEnd) q.root.rotation.y = lerpAngle(q.root.rotation.y, start.yaw, returnK);
    }
  }

  // ---------- smoke ----------

  #createSmoke() {
    // One shared geometry; one material per puff because opacity differs.
    this.smokeGeo = new THREE.SphereGeometry(0.24, 9, 7);
    for (let i = 0; i < SmellyScene.PUFFS; i++) {
      const puff = new THREE.Mesh(this.smokeGeo, new THREE.MeshBasicMaterial({ color: '#8a8580', transparent: true, opacity: 0, depthWrite: false }));
      puff.visible = false;
      this.SC.scene.add(puff);
      this.smoke.push(puff);
    }
  }

  #updateSmoke(age, brawl) {
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
      o.material.opacity = Math.sin(phase * Math.PI) * 0.58;
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
  }

  // ---------- helpers ----------
  static #resetPose(c) {
    c.stand = 1; c.groove = 0; c.bounce = 0; c.jump = 0;
    c.kneel = 0; c.slump = 0;
  }
}