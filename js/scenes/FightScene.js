import * as THREE from 'three';
import { rand } from '../utils/Random.js';
import { smooth01, lerpAngle, clamp01 } from '../utils/Math.js';
import { V3 } from '../utils/Vector.js';
import { NOW } from '../data/data.js';

// Overshooting ease for the hand entrance (0..1 in, slightly >1 mid-way, ends at 1)
const easeOutBack = (x) => {
  const c1 = 1.70158, c3 = c1 + 1;
  const u = Math.min(1, Math.max(0, x)) - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};

export default class FightScene {
  static T = {
    handEnter: 0.5,    // hand slides in (with a little overshoot)
    handExit: 1.0,     // hand starts dropping
    handExitDur: 0.35,
    shock: 1.05,       // crowd frozen in disbelief (first reactors turn angry here)
    rushDur: 2.1,      // crowd charges the player
    gameOver: 5.0,
    booEvery: 1.5,
    shock_face_fade: 1.15,   // seconds for the initial jaw-drop to ease in
    recoilDur: 0.25,         // how fast the crowd flinches back
    recoilDist: 0.14         // how far they flinch
  };
  static HAND_DIST = 0.62;
  static HAND_SCALE = 0.78;
  static SKIN = '#f1b892';
  static SLEEVE = '#d23b4f';
  static CUFF = '#fff6e6';

  #target = new THREE.Vector3();   // scratch, reused every frame
  #base = new THREE.Vector3();     // scratch: start position + recoil

  constructor(o) {
    this.on = false;
    this.t0 = 0;
    this.fall = 0;
    this.booUntil = 0;
    this.gameOver = false;
    this.hand = null;
    this.ballGeo = null;   // shared unit sphere for knuckles and tips

    Object.assign(this, {
      GAME: null,
      CROWD: null,
      ME: null,
      UI: null,
      AE: null,
      SC: null,
      VOWEL: null,
      stopShow: (b) => null,
      capsuleBetween: (a, b, r, mat) => null,
      toonMat: (b) => null,
      aimCamera: () => null,
      voiceBlip: (when, o) => null
    }, o);
  }

  // ---------- lifecycle ----------

  /** Call from your existing fight-start code, right after setting `on` and `t0`. */
  reset() {
    this.gameOver = false;
    this.booUntil = 0;
    for (const m of this.CROWD.list) {
      m.fightStart = null;   // otherwise the 2nd fight lerps from the 1st fight's positions
      m.fightFace = '';
      m.fightDelay = null;
    }
    document.getElementById('gameOver')?.classList.add('hide');
  }

  // ---------- first-person hand ----------

  setupHand() {
    this.disposeHand();

    const g = new THREE.Group();
    g.name = 'fight-hand';
    g.scale.setScalar(FightScene.HAND_SCALE);
    g.rotation.set(0, 0, -0.16);
    g.visible = false;

    const F = FightScene;
    const skin = this.toonMat(F.SKIN), sleeve = this.toonMat(F.SLEEVE), cuff = this.toonMat(F.CUFF);
    this.ballGeo = new THREE.SphereGeometry(1, 16, 12);

    const ball = (x, y, z, sx, sy, sz, mat = skin) => {
      const m = new THREE.Mesh(this.ballGeo, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      g.add(m);
    };
    const seg = (a, b, r = 0.018, mat = skin) => g.add(this.capsuleBetween(V3(...a), V3(...b), r, mat));

    // Sleeve, cuff, palm
    seg([0.10, -0.31, 0.02], [-0.015, -0.07, 0.015], 0.047, sleeve);
    seg([0.015, -0.11, 0.005], [-0.01, -0.055, 0.005], 0.045, cuff);
    ball(0, 0.005, 0, 0.087, 0.105, 0.035);

    // Middle finger stays raised
    seg([-0.008, 0.066, -0.002], [-0.009, 0.15, -0.012], 0.021);
    seg([-0.009, 0.15, -0.012], [-0.01, 0.245, -0.02], 0.018);
    ball(-0.01, 0.244, -0.02, 0.018, 0.02, 0.017);

    // Other three fingers curled
    for (const x of [-0.052, 0.032, 0.061]) {
      const y = x > 0.05 ? 0.045 : 0.055;
      seg([x, y, -0.002], [x * 1.02, y - 0.035, -0.025], 0.017);
      seg([x * 1.02, y - 0.035, -0.025], [x * 0.72, y - 0.052, -0.035], 0.016);
      ball(x * 0.72, y - 0.052, -0.035, 0.016, 0.016, 0.014);
    }

    // Thumb
    seg([0.069, -0.005, -0.002], [0.078, 0.038, -0.025], 0.021);
    seg([0.078, 0.038, -0.025], [0.031, 0.029, -0.045], 0.019);
    ball(0.031, 0.029, -0.045, 0.019, 0.018, 0.014);

    this.SC.vmScene.add(g);
    this.hand = this.ME.fightHand = g;   // keep the old reference for other code
    return g;
  }

  /** Call from updateMe(). Handles both the fight and non-fight cases. */
  updateHand(t) {
    const g = this.hand;
    if (!g) return;
    if (!this.on) {
      g.visible = false;
      return;
    }

    const T = FightScene.T, d = FightScene.HAND_DIST;
    const age = Math.max(0, t - this.t0);
    const hy = Math.tan(this.SC.vmCam.fov * Math.PI / 360) * d;
    const hx = hy * this.SC.vmCam.aspect;
    const enterLin = clamp01(age / T.handEnter);
    const enter = easeOutBack(enterLin);                       // overshoots, then settles
    const exitLin = smooth01((age - T.handExit) / T.handExitDur);
    const exit = exitLin * exitLin;                            // accelerates downward, like it's dropped

    this.ME.hold.visible = false;
    if (this.ME.hold2) this.ME.hold2.visible = false;
    if (this.ME.mpRig) this.ME.mpRig.visible = false;

    g.visible = exitLin < 1;
    if (!g.visible) return;

    // Life while it's up: a taunting wobble that grows once the hand has arrived
    const settle = enterLin * (1 - exitLin);
    const wob = Math.sin(age * 11) * 0.04 * settle;
    const bob = Math.sin(age * 7.5) * hy * 0.012 * settle;

    g.position.set(
      hx * 0.22 + (1 - enter) * hx * 0.75 + wob * 0.15,
      -hy * 0.02 - (1 - enter) * hy * 1.1 - exit * hy * 1.1 + bob,
      -d
    );
    // Tilts up as it thrusts in, wobbles while held, tips over as it drops
    g.rotation.set(-(1 - enterLin) * 0.35 + exit * 0.4, wob * 0.5, -0.16 + wob);
  }

  disposeHand() {
    const g = this.hand;
    if (!g) return;
    this.SC.vmScene.remove(g);
    const geos = new Set();   // capsules own their geometry; knuckles share one
    g.traverse(o => { if (o.isMesh) geos.add(o.geometry); });
    geos.forEach(geo => geo.dispose());
    // Materials come from toonMat. Dispose them here only if toonMat doesn't cache.
    this.hand = this.ME.fightHand = null;
    this.ballGeo = null;
  }

  // ---------- crowd ----------

  /** Gives each crowd member its own reaction timing and a spot to charge to. */
  #prep(m, start) {
    const me = this.CROWD.me;
    const dx = start.x - me.x, dz = start.z - me.z;
    const dist = Math.hypot(dx, dz) || 1;
    // Those closest (and the most hot-headed) snap first, so anger ripples outward
    const wild = m.wild ?? 0.5;   // guard: NaN here would freeze the whole reaction
    m.fightDelay = Math.min(0.4, dist * 0.03) + (1 - wild) * 0.25;
    m.fightAwayX = dx / dist;
    m.fightAwayZ = dz / dist;
    // Each member charges in from their own side and stops at their own distance,
    // so the crowd surrounds the player instead of stacking on a single point
    m.fightAngle = Math.atan2(dx, dz) + (wild - 0.5) * 0.6;
    m.fightRadius = 0.55 + wild * 0.9;
  }

  /** Call from CROWDUpdate() when FIGHT.on, then return. */
  updateCrowd(dt, t, beat) {
    const T = FightScene.T;
    const me = this.CROWD.me;
    const age = t - this.t0;
    const step = Math.min(dt, 0.1);
    const turnK = Math.min(1, dt * 2);
    const recoil = T.recoilDist * smooth01(age / T.recoilDur);

    for (const m of this.CROWD.list) {
      const p = m.p;
      if (!p.root.visible) continue;

      const start = m.fightStart ??= p.root.position.clone();
      if (m.fightDelay == null) this.#prep(m, start);

      // Per-member timeline: shocked until their own anger kicks in
      const local = age - T.shock - m.fightDelay;
      const shocked = local < 0;
      const mood = shocked ? 'shock' : 'angry';
      const lin = smooth01(local / T.rushDur);
      const rush = lin * Math.sqrt(lin);   // eases in harder: slow start, fast finish

      if (m.fightFace !== mood || (!shocked && t - (m.fightFaceT ?? 0) > 0.5)) {
        p.express(shocked ? 'jawdrop' : 'angry', 0);
        m.fightFace = mood;
        m.fightFaceT = t;
      }

      // Flinch away from the player, then charge in along a personal arc
      this.#base.set(start.x + m.fightAwayX * recoil, start.y, start.z + m.fightAwayZ * recoil);
      if (shocked) {
        p.root.position.copy(this.#base);
      } else {
        this.#target.set(
          me.x + Math.sin(m.fightAngle) * m.fightRadius,
          start.y,
          me.z + Math.cos(m.fightAngle) * m.fightRadius
        );
        p.root.position.lerpVectors(this.#base, this.#target, rush);
        // Running bounce, strongest mid-charge, fading out as they arrive
        p.root.position.y = start.y + Math.abs(Math.sin(t * 13 + m.phase0)) * 0.07 * Math.sin(Math.PI * lin);
      }

      // lerpAngle takes the short way round; a plain difference can spin the long way
      const yaw = Math.atan2(me.x - p.root.position.x, me.z - p.root.position.z);
      p.root.rotation.y = lerpAngle(p.root.rotation.y, yaw, turnK);

      const c = p.c;
      c.stand = 1;
      c.lean = shocked ? -0.08 * smooth01(age / T.recoilDur) : 0.4 + rush * 0.3;   // lean back, then forward
      c.headTilt = shocked ? 0 : Math.sin(t * 9 + m.phase0) * 0.2;
      c.headShake = shocked ? Math.sin(t * 38 + m.phase0) * 0.04 : Math.sin(t * 18 + m.phase0) * 0.28;   // tremble, then rage
      c.step = shocked ? 0 : 0.5 + rush * 0.5;
      c.look.copy(me);
      p.update(step, t, beat);
    }

    if (age > T.shock && !this.gameOver) {
      this.#boo(t, smooth01((age - T.shock) / T.rushDur));
    }
    this.aimCamera();

    if (age > T.gameOver && !this.gameOver) {
      this.gameOver = true;
      document.getElementById('gameOver')?.classList.remove('hide');
    }
  }

  /** Old name kept so existing call sites don't break. */
  updatethis(dt, t, beat) {
    return this.updateCrowd(dt, t, beat);
  }

  #boo(t, intensity = 1) {
    if (t <= this.booUntil || !this.AE.decoded || !this.AE.ctx) return;
    this.booUntil = t + FightScene.T.booEvery;
    const now = this.AE.ctx.currentTime;
    const n = 4 + Math.round(intensity * 4);   // more voices as the mob closes in
    const gain = 0.6 + intensity * 0.6;
    for (let i = 0; i < n; i++) {
      this.voiceBlip(now + rand(0, 0.8), {
        dur: rand(0.45, 0.8), f0: rand(115, 205), fem: false,
        v0: this.VOWEL.u, v1: this.VOWEL.u, vol: rand(0.07, 0.14) * gain,
        att: 0.07, hold: 0.7,
        curve: [[0, 1.05], [0.28, 0.94], [1, 0.72]],
        rough: 0.18, pan: rand(-0.9, 0.9)
      });
    }
  }

  /** Starts the fight. Replaces the old reset(). */
  begin() {
    if (this.on || !this.UI.playing) return;
    if (this.GAME.phase !== 'play' && this.GAME.phase !== 'pre') return;

    this.on = true;
    this.t0 = NOW.t;
    this.booUntil = 0;
    this.gameOver = false;
    FIN.req = true;

    this.stopShow();
    this.#hideUI();
    this.#freezeCrowd();
    for (const m of BAND.members) stare(m, 4.8, 'jawdrop', 0.9);
    this.aimCamera();
  }

  #hideUI() {
    for (const id of ['fight', 'endShow', 'nextSong', 'pause', 'hudMode', 'autoMode', 'special', 'finishHint', 'finBar', 'customMenu']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    document.getElementById('controls')?.classList.add('off');
    document.getElementById('gameOver')?.classList.add('hide');   // clear any previous run
  }

  #freezeCrowd() {
    for (const m of this.CROWD.list) {
      m.fightStart = m.p.root.position.clone();   // fresh every fight
      this.#prep(m, m.fightStart);                // fresh timing and charge spot too
      m.fightFace = 'shock';                      // matches `mood` in updateCrowd, so no re-express
      m.act = null;
      m.pending = null;
      m.p.express('jawdrop', FightScene.T.shock_face_fade);
      const c = m.p.c;
      c.stand = 1;
      c.step = 0;
      c.lean = 0;
    }
  }
}