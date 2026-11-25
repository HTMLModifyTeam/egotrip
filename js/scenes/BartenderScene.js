import * as THREE from 'three';
import { NOW } from '../data/data.js';
import { clamp, smooth01, lerp, lerpAngle } from '../utils/Math.js';
import { pick } from '../utils/Random.js';
import { V3 } from '../utils/Vector.js';

const RIOT = Object.freeze({
  BOTTLE_TIMES: [0.55, 1.22, 1.89, 2.56, 3.23],
  BOTTLE_OFFSET: { x: 0.4, y: 1.4, z: 0.75 },
  WINDUP: 0.36,
  FOLLOW: 0.3,
  FIGHT_START: 1.8,
  FIGHT_END: 7.15,
  BRAWL_START: 2.35,
  CHARGE_START: 1.65,
  CHARGE_TIME: 0.7,
  RETURN_TIME: 1.2,
  END: 8.5,
  MAX_DT: 0.1,
  NEXT_SCENE_DELAY: 8,
  PUNCH_RATE: 3.4,
  HIT_TIME: 0.55,
  SHARD_COUNT: 9,
  GRAVITY: 9.8,
  TURN_SPEED: 12
});

export default class BartenderScene {
  #assets = null;

  constructor(o) {
    this.on = false;
    this.t0 = 0;
    this.yaw = 0;
    this.bottles = [];
    this.shards = [];
    this.victims = [];
    this.crowdStarts = [];
    this.bartenderStart = null;
    this.bartenderYaw = 0;
    this.props = null;

    Object.assign(this, {
      SC: null,
      UI: null,
      CROWD: null
    }, o);
  }

  #getAssets() {
    if (this.#assets) return this.#assets;
    const materials = {
      glass: new THREE.MeshStandardMaterial({ color: '#4f9b62', roughness: 0.24, metalness: 0.08 }),
      label: new THREE.MeshStandardMaterial({ color: '#f2c24d', roughness: 0.75 }),
      cap: new THREE.MeshStandardMaterial({ color: '#d44732', roughness: 0.55 })
    };
    const shoulder = new THREE.SphereGeometry(0.105, 10, 7);
    shoulder.scale(1, 0.42, 1);
    const geometries = {
      body: new THREE.CylinderGeometry(0.105, 0.13, 0.38, 10),
      shoulder,
      neck: new THREE.CylinderGeometry(0.047, 0.06, 0.15, 9),
      stopper: new THREE.CylinderGeometry(0.05, 0.05, 0.045, 8),
      band: new THREE.CylinderGeometry(0.108, 0.108, 0.095, 10),
      shard: new THREE.TetrahedronGeometry(0.035)
    };
    this.#assets = { materials, geometries };
    return this.#assets;
  }

  #disposeAssets() {
    if (!this.#assets) return;
    Object.values(this.#assets.geometries).forEach(g => g.dispose());
    Object.values(this.#assets.materials).forEach(m => m.dispose());
    this.#assets = null;
  }

  #createBottle() {
    const { materials, geometries } = this.#getAssets();
    const parts = [
      [geometries.body, materials.glass, 0.22],
      [geometries.shoulder, materials.glass, 0.42],
      [geometries.neck, materials.glass, 0.52],
      [geometries.stopper, materials.cap, 0.62],
      [geometries.band, materials.label, 0.24]
    ];
    const group = new THREE.Group();
    for (const [geometry, material, y] of parts) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = y - 0.32;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    this.SC.scene.add(group);
    return {
      group,
      age: 0,
      duration: 0.7,
      arc: 1,
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      spin: new THREE.Vector3(10 + Math.random() * 6, 3 + Math.random() * 4, 7 + Math.random() * 6),
      active: false,
      target: null
    };
  }

  #burst(position) {
    const { materials, geometries } = this.#getAssets();
    for (let n = 0; n < RIOT.SHARD_COUNT; n++) {
      const size = 0.7 + Math.random() * 1.1;
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 1.6;
      const mesh = new THREE.Mesh(geometries.shard, n % 4 === 0 ? materials.label : materials.glass);
      mesh.position.copy(position);
      mesh.scale.setScalar(size);
      this.SC.scene.add(mesh);
      this.shards.push({
        mesh,
        size,
        age: 0,
        life: 0.6 + Math.random() * 0.5,
        vel: new THREE.Vector3(Math.cos(angle) * speed, 1.5 + Math.random() * 1.8, Math.sin(angle) * speed),
        spin: new THREE.Vector3(Math.random() * 14, Math.random() * 14, Math.random() * 14)
      });
    }
  }

  #clearBottles() {
    for (const bottle of this.bottles) {
      if (bottle) this.SC.scene.remove(bottle.group);
    }
    for (const shard of this.shards) this.SC.scene.remove(shard.mesh);
    this.bottles.length = 0;
    this.shards.length = 0;
    this.victims.length = 0;
    this.#disposeAssets();
  }

  start() {
    const bartender = this.CROWD.bartender;
    if (!bartender || this.on || !this.UI.playing) return;

    this.on = true;
    this.t0 = NOW.t;
    this.bottles.length = 0;
    this.shards.length = 0;
    this.victims.length = 0;
    this.bartenderStart = bartender.p.root.position.clone();
    this.bartenderYaw = bartender.p.root.rotation.y;
    this.yaw = this.bartenderYaw;
    this.props = { cup: bartender.props.cup.visible, cloth: bartender.props.cloth.visible };

    bartender.props.cup.visible = false;
    bartender.props.cloth.visible = false;
    bartender.pending = null;
    bartender.dropAt = 0;
    bartender.act = null;

    this.crowdStarts = this.CROWD.list.map(m => ({
      pos: m.p.root.position.clone(),
      yaw: m.p.root.rotation.y,
      visible: m.p.root.visible
    }));
    for (const m of this.CROWD.list) {
      m.act = null;
      m.pending = null;
      m.riotFace = '';
      m.riotHit = -Infinity;
    }

    this.UI.el.customMenu.style.display = 'none';
  }

  #activeThrow(age) {
    const times = RIOT.BOTTLE_TIMES;
    for (let i = 0; i < times.length; i++) {
      if (age >= times[i] - RIOT.WINDUP && age < times[i] + RIOT.FOLLOW) return i;
    }
    return -1;
  }

  #chooseVictim(index) {
    const eligible = this.CROWD.list.filter(m => m.p.root.visible);
    if (!eligible.length) return null;
    const previous = this.victims[index - 1];
    const fresh = eligible.filter(m => m !== previous);
    return pick(fresh.length ? fresh : eligible);
  }

  #nearestBrawler(origin) {
    let best = null;
    let bestDist = Infinity;
    for (const m of this.CROWD.list) {
      if (!m.p.root.visible) continue;
      const d = origin.distanceToSquared(m.p.root.position);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  #planThrows(age) {
    RIOT.BOTTLE_TIMES.forEach((time, i) => {
      if (age >= time - RIOT.WINDUP && this.victims[i] === undefined) {
        this.victims[i] = this.#chooseVictim(i);
      }
    });
  }

  #spawnBottles(age) {
    RIOT.BOTTLE_TIMES.forEach((time, i) => {
      if (age < time || this.bottles[i]) return;
      const victim = this.victims[i] ?? null;
      const bottle = this.#createBottle();
      const side = i % 2 ? -1 : 1;
      const { x, y, z } = RIOT.BOTTLE_OFFSET;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const origin = this.bartenderStart;
      const end = victim ? victim.p.root.position.clone() : V3(0, 0.7, -2.5);

      end.y = Math.max(0.72, end.y + 0.95);
      bottle.start.set(origin.x + x * side * cos + z * sin, y, origin.z - x * side * sin + z * cos);
      bottle.end.copy(end);

      const dist = bottle.start.distanceTo(end);
      bottle.duration = clamp(dist / 9, 0.45, 0.85);
      bottle.arc = clamp(dist * 0.18, 0.5, 1.4);
      bottle.active = true;
      bottle.target = victim;
      bottle.group.position.copy(bottle.start);
      this.bottles[i] = bottle;
    });
  }

  #updateBottles(dt, t) {
    for (const bottle of this.bottles) {
      if (!bottle?.active) continue;
      bottle.age += dt;

      if (bottle.target) {
        const tp = bottle.target.p.root.position;
        bottle.end.set(tp.x, Math.max(0.72, tp.y + 0.95), tp.z);
      }

      const k = clamp(bottle.age / bottle.duration, 0, 1);
      bottle.group.position.lerpVectors(bottle.start, bottle.end, k);
      bottle.group.position.y += Math.sin(k * Math.PI) * bottle.arc;
      bottle.group.rotation.x += bottle.spin.x * dt;
      bottle.group.rotation.y += bottle.spin.y * dt;
      bottle.group.rotation.z += bottle.spin.z * dt;
      if (k < 1) continue;

      bottle.active = false;
      bottle.group.visible = false;
      this.#burst(bottle.group.position);
      if (bottle.target) bottle.target.riotHit = t;
    }
  }

  #updateShards(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.SC.scene.remove(s.mesh);
        this.shards.splice(i, 1);
        continue;
      }
      s.vel.y -= RIOT.GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.mesh.position.y < 0.03) {
        s.mesh.position.y = 0.03;
        s.vel.x *= 0.4;
        s.vel.z *= 0.4;
        s.vel.y *= -0.3;
      }
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      const fade = 1 - (s.age / s.life) ** 2;
      s.mesh.scale.setScalar(s.size * fade);
    }
  }

  #desiredYaw(index, fighting) {
    const origin = this.bartenderStart;
    const target = index >= 0 ? this.victims[index] : fighting ? this.#nearestBrawler(origin) : null;
    if (!target) return this.bartenderYaw;
    const pos = target.p.root.position;
    return Math.atan2(pos.x - origin.x, pos.z - origin.z);
  }

  #updateBartender(p, age, dt, t, beat) {
    const fighting = age > RIOT.FIGHT_START && age < RIOT.FIGHT_END;
    const throwIndex = this.#activeThrow(age);
    const wave = (speed, amp) => (fighting ? Math.sin(age * speed) * amp : 0);

    const desired = this.#desiredYaw(throwIndex, fighting);
    this.yaw = lerpAngle(this.yaw, desired, 1 - Math.exp(-dt * RIOT.TURN_SPEED));

    p.root.position.copy(this.bartenderStart);
    p.root.rotation.y = this.yaw + (fighting ? Math.sin(age * 2) * 0.1 : 0);

    p.c.look.set(this.CROWD.me.x, 1.3, this.CROWD.me.z);
    p.c.stand = 1;
    p.c.groove = 0;
    p.c.bounce = fighting ? Math.abs(Math.sin(age * RIOT.PUNCH_RATE * Math.PI)) * 0.08 : 0;
    p.c.lean = wave(15, 0.2);
    p.c.side = wave(13, 0.3);
    p.c.twist = wave(16, 0.32);
    p.c.step = fighting ? 0.65 : 0;

    if (age < 0.45) p.express('smile', 0);
    else if (age < RIOT.FIGHT_START) p.express('scream', 0);
    else p.express('angry', 0);

    if (throwIndex >= 0) {
      const time = RIOT.BOTTLE_TIMES[throwIndex];
      const hand = throwIndex % 2 ? 'L' : 'R';
      const other = hand === 'R' ? 'L' : 'R';
      const s = hand === 'R' ? 1 : -1;
      let target;

      if (age < time) {
        const w = smooth01((age - (time - RIOT.WINDUP)) / RIOT.WINDUP);
        target = p.local(s * 0.55, lerp(1.35, 1.8, w), lerp(0.25, -0.3, w));
        p.c.lean = -0.22 * w;
        p.c.twist = -s * 0.4 * w;
        p.c.side = -s * 0.15 * w;
      } else {
        const r = smooth01((age - time) / RIOT.FOLLOW);
        target = p.local(s * 0.4, lerp(1.8, 1.25, r), lerp(-0.3, 0.9, r));
        p.c.lean = lerp(-0.22, 0.3, r);
        p.c.twist = s * 0.35 * r;
        p.c.side = s * 0.12 * r;
      }
      p.rest(other);
      p.reach(hand, target, null, null, 'fist');
    } else if (fighting) {
      const cycle = age * RIOT.PUNCH_RATE;
      const index = Math.floor(cycle);
      const ext = Math.sin((cycle - index) * Math.PI);
      const hand = index % 2 ? 'L' : 'R';
      const s = hand === 'R' ? 1 : -1;
      p.rest(hand === 'R' ? 'L' : 'R');
      p.reach(hand, p.local(s * 0.42, 1.28 + ext * 0.06, 0.3 + ext * 0.55), null, null, 'fist');
      p.c.twist += s * ext * 0.25;
      p.c.lean += ext * 0.15;
    } else if (age < RIOT.FIGHT_START) {
      p.reach('R', p.local(0.55, 1.35, 0.38), null, null, 'fist');
    } else {
      p.rest('R');
      p.rest('L');
    }

    p.update(Math.min(dt, RIOT.MAX_DT), t, beat);
  }

  #updateCrowdMember(m, start, i, age, dt, t, beat) {
    const q = m.p;
    const origin = this.bartenderStart;
    const charge = smooth01((age - RIOT.CHARGE_START) / RIOT.CHARGE_TIME);
    const brawl = age > RIOT.BRAWL_START && age < RIOT.FIGHT_END;
    const back = smooth01((age - RIOT.FIGHT_END) / RIOT.RETURN_TIME);
    const hit = clamp(1 - (t - (m.riotHit ?? -Infinity)) / RIOT.HIT_TIME, 0, 1) ** 2;
    const shake = (speed, amp) => (brawl ? Math.sin(t * speed + m.phase0) * amp : 0);

    const dx = start.pos.x - origin.x;
    const dz = start.pos.z - origin.z;
    const len = Math.hypot(dx, dz) || 1;
    const orbit = shake(1.3, 0.3);
    const ux = dx / len;
    const uz = dz / len;
    const rx = ux * Math.cos(orbit) - uz * Math.sin(orbit);
    const rz = ux * Math.sin(orbit) + uz * Math.cos(orbit);
    const lunge = brawl ? Math.max(0, Math.sin(t * 6 + m.phase0)) * 0.18 : 0;
    const radius = 1.1 + (i % 4) * 0.16 - lunge;
    const targetX = origin.x + rx * radius + ux * hit * 0.3;
    const targetZ = origin.z + rz * radius + uz * hit * 0.3;
    const chargeX = lerp(start.pos.x, targetX, charge) + shake(13, 0.16);
    const chargeZ = lerp(start.pos.z, targetZ, charge);

    q.root.position.set(lerp(chargeX, m.spot.pos.x, back), lerp(start.pos.y, m.spot.pos.y, back), lerp(chargeZ, m.spot.pos.z, back));
    const facing = Math.atan2(origin.x - q.root.position.x, origin.z - q.root.position.z);
    q.root.rotation.y = lerpAngle(start.yaw, facing, charge * (1 - back));
    q.root.rotation.z = shake(17, 0.1) + Math.sin(t * 40) * hit * 0.12;

    q.c.stand = 1;
    q.c.groove = 0;
    q.c.bounce = 0;
    q.c.jump = 0;
    q.c.look.set(origin.x, 1.3, origin.z);
    q.c.lean = (brawl ? 0.18 + Math.sin(t * 16 + m.phase0) * 0.14 : charge > 0.2 ? 0.1 : 0) - hit * 0.45;
    q.c.side = shake(14, 0.28) + Math.sin(t * 38) * hit * 0.3;
    q.c.twist = shake(19, 0.36);
    q.c.step = charge > 0.1 && !back ? (brawl ? 0.65 : 0.8) : 0;

    if (brawl && !back) {
      const cycle = t * RIOT.PUNCH_RATE * 0.9 + m.phase0;
      const index = Math.floor(cycle);
      const ext = Math.sin((cycle - index) * Math.PI);
      const hand = index % 2 ? 'L' : 'R';
      const s = hand === 'R' ? 1 : -1;
      q.rest(hand === 'R' ? 'L' : 'R');
      q.reach(hand, q.local(s * 0.4, 1.25, 0.3 + ext * 0.5), null, null, 'fist');
    } else if (charge > 0.2 && !back) {
      q.reach('R', q.local(0.4, 1.3, 0.3), null, null, 'fist');
      q.reach('L', q.local(-0.4, 1.3, 0.3), null, null, 'fist');
    } else if (back) {
      q.rest('R');
      q.rest('L');
    }

    if (!back && age > 0.8) {
      if (hit > 0.4) {
        if (m.riotFace !== 'hit') {
          q.express('scream', 0);
          m.riotFace = 'hit';
        }
      } else if (m.riotFace !== 'angry') {
        q.express('angry', 0);
        m.riotFace = 'angry';
      }
    } else if (back && m.riotFace !== 'return') {
      q.express('smile', 0);
      m.riotFace = 'return';
    }

    q.update(Math.min(dt, RIOT.MAX_DT), t, beat);
    if (back) q.root.rotation.y = lerpAngle(q.root.rotation.y, start.yaw, back);
    q.root.rotation.z *= 1 - back;
  }

  #finish(bartender, t) {
    this.on = false;
    this.#clearBottles();
    if (this.props) {
      bartender.props.cup.visible = this.props.cup;
      bartender.props.cloth.visible = this.props.cloth;
    }
    bartender.act = null;
    bartender.pending = null;
    bartender.nextScene = t + RIOT.NEXT_SCENE_DELAY;
    if (this.UI.playing) this.UI.el.customMenu.style.display = 'flex';
  }

  update(dt, t, beat) {
    const bartender = this.CROWD.bartender;
    const p = bartender?.p;
    if (!p) {
      this.on = false;
      this.#clearBottles();
      return;
    }

    const age = t - this.t0;
    this.#planThrows(age);
    this.#updateBartender(p, age, dt, t, beat);
    this.#spawnBottles(age);
    this.#updateBottles(dt, t);
    this.#updateShards(dt);

    this.CROWD.list.forEach((m, i) => {
      const start = this.crowdStarts[i];
      if (m.p.root.visible && start) this.#updateCrowdMember(m, start, i, age, dt, t, beat);
    });

    if (age > RIOT.END) this.#finish(bartender, t);
  }
}