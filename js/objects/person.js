import * as THREE from 'three';
import { Rig } from './rig.js';
import { latheY } from '../utils/GeomUtils.js';
import { HAND_POSE, BONE, NOW, PEOPLE } from '../data/data.js';
import { FACES, PEOPLE_MAT } from '../data/faces.js';
import { clamp, damp, dampAngle, smooth01, smoothstep, lerp } from '../utils/Math.js';
import { seeded, rand } from '../utils/Random.js';
import { M4, V3 } from '../utils/Vector.js';
import { shadeHex, mixHex } from '../utils/ColorUtils.js';

// 좌/우 반복용 상수 (update 안에서 매 프레임 배열을 새로 만들지 않도록)
export const PERSON_SIDES = Object.freeze(['L', 'R']);
// 좌(+x) / 우(-x) 부호
const sideSign = s => (s === 'L' ? 1 : -1);
// 팔 상태 초기값 (좌·우 공통)
const personArm = () => ({
  mode: 'rest',
  target: new THREE.Vector3(),
  pole: new THREE.Vector3(),
  q: null,
  hand: 'relax',
  blend: 0,
  cur: new THREE.Vector3(),
  has: false,
  init: false
});

const G = {
  sph: (seg = 20, r = 12) => new THREE.SphereGeometry(1, seg, r),
  capSeg: 6,
  cap: (len, rad, seg = 12) => new THREE.CapsuleGeometry(rad, Math.max(0.001, len - 2 * rad), G.capSeg, seg), // 길이 = 전체 길이, y축
  cyl: (rt, rb, h, seg = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open),
  tor: (R, r, seg = 24, rs = 8, arc = Math.PI * 2) => new THREE.TorusGeometry(R, r, rs, seg, arc),
};

const _pv1 = new THREE.Vector3(), _pv2 = new THREE.Vector3(), _pv3 = new THREE.Vector3(), _pv4 = new THREE.Vector3(), _pv5 = new THREE.Vector3();
const _pq1 = new THREE.Quaternion(), _pq2 = new THREE.Quaternion(), _pq3 = new THREE.Quaternion();

// 두 점 사이에 놓는 캡슐 행렬
function capBetween(a, b, rad, seg = 12) {
  const d = _pv1.copy(b).sub(a), len = d.length();
  const g = G.cap(len, rad, seg);
  const q = new THREE.Quaternion();
  if (len > 1e-6) q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len)); // 길이 0이면 회전 없음 (NaN 방지)
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return { g, m: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)) };
}

// 앞(+z)으로 볼록하게 휨: z -= k·x² (단위 구 기준)
function bendZ(g, k) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, p.getZ(i) - k * x * x);
  }
  g.computeVertexNormals();
  return g;
}

const PERSON_SYNC = THREE.Object3D.prototype.updateMatrixWorld;

const _ik = {
  S: new THREE.Vector3(),
  dv: new THREE.Vector3(),
  pp: new THREE.Vector3(),
  E: new THREE.Vector3(),
  Tc: new THREE.Vector3(),
  ax: new THREE.Vector3(),
  t: new THREE.Vector3(),
  X: new THREE.Vector3(),
  Y: new THREE.Vector3(),
  Z: new THREE.Vector3(),
  m: new THREE.Matrix4(),
  qw: new THREE.Quaternion(),
  qp: new THREE.Quaternion()
};

export class Person {
  constructor(look = {}, o = {}) {
    this.look = look;
    this.seated = !!o.seated;
    this.lod = o.lod || 0;
    const h = look.h || 1, w = look.w || 1, H = look.headScale || 1.72;
    this.h = h;
    this.w = w;
    this.H = H;
    this.root = new THREE.Group();
    this.root.name = look.name || 'person';
    this.makeBones();
    this.buildMesh();

    // 제어값
    this.c = {
      look: new THREE.Vector3(0, 1.5, 5),
      lookW: 1,
      eyeOnly: false,
      twist: 0,
      lean: 0,
      side: 0,
      bounce: 0,
      groove: 0.3,
      nod: 0.25,
      sway: 0.2,
      phase: rand(0, 2),
      stand: this.seated ? 0 : 1,
      jump: 0,
      headTilt: 0,
      headShake: 0,
      headBang: 0,
      hipSway: 0,
      step: 0,
      disbelief: 0,
      kneel: 0,
      slump: 0,
      puff: 0,
    };
    this.disb = 0;
    this.s = {
      twist: 0,
      lean: 0,
      side: 0,
      stand: this.c.stand,
      yaw: 0,
      pitch: 0,
      roll: 0,
      jumpY: 0,
      nod: 0,
      bounceY: 0,
      kneel: 0,
      slump: 0,
      puff: 0
    };
    this.face = Object.assign({}, FACES.calm);
    this.faceT = Object.assign({}, FACES.calm);
    this.base = 'calm';
    this.exUntil = 0;
    this.blink = 0;
    this.blinkT = rand(1, 4);
    this.arms = { L: personArm(), R: personArm() };
    this.handCur = {
      L: HAND_POSE.relax.slice(),
      R: HAND_POSE.relax.slice()
    };
    this.seatY = o.seatY || 0.46;
    this.feetFwd = o.feetFwd || 0.42;
    PEOPLE.all.push(this);
  }
  // ----- 뼈대 -----
  makeBones() {
    const h = this.h, w = this.w, H = this.H;
    const R = 0.118 * H;
    this.R = R;
    const P = this.P = {
      hips: [0, 0.86 * h, 0],
      spine: [0, 0.13 * h, 0],
      chest: [0, 0.19 * h, 0],
      neck: [0, 0.19 * h, 0.0],
      head: [0, 0.06 * h, 0.01],
      clav: [0.045 * w, 0.13 * h, 0],
      upper: [0.15 * w, -0.02 * h, 0],
      upperLen: 0.27 * h,
      foreLen: 0.245 * h,
      handLen: 0.09 * h,
      thigh: [0.095 * w, -0.04 * h, 0],
      thighLen: 0.37 * h,
      shinLen: 0.37 * h,
      ankle: 0.08 * h,
    };
    const B = this.bones = [];
    const mk = (name, parent, pos) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(...pos);
      if (parent != null) B[parent].add(b);
      B.push(b);
      return b;
    };
    mk('root', null, [0, 0, 0]);
    mk('hips', 0, P.hips);
    mk('spine', 1, P.spine);
    mk('chest', 2, P.chest);
    mk('neck', 3, P.neck);
    mk('head', 4, P.head);
    const hc = this.headC = new THREE.Vector3(0, R * 0.78, 0.012); // 머리 중심 (head 뼈 기준)
    mk('jaw', 5, [0, hc.y - R * 0.35, hc.z + R * 0.2]);
    mk('browL', 5, [R * 0.36, hc.y + R * 0.36, hc.z + R * 0.88]);
    mk('browR', 5, [-R * 0.36, hc.y + R * 0.36, hc.z + R * 0.88]);
    const ey = hc.y + R * 0.06,
      ez = hc.z + R * 0.8;
    this.eyeP = {
      y: ey,
      z: ez,
      x: R * 0.36,
      r: R * 0.25
    };
    mk('lidL', 5, [R * 0.36, ey, ez]);
    mk('lidR', 5, [-R * 0.36, ey, ez]);
    mk('eyeL', 5, [R * 0.36, ey, ez]);
    mk('eyeR', 5, [-R * 0.36, ey, ez]);
    const my = hc.y - R * 0.43,
      mz = hc.z + R * 0.95;
    this.mouthP = {
      y: my,
      z: mz,
      w: R * 0.3
    };
    mk('mouth', 5, [0, my, mz]);
    mk('cornerL', 5, [R * 0.3, my, mz - R * 0.04]);
    mk('cornerR', 5, [-R * 0.3, my, mz - R * 0.04]);
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s);
      mk('clav' + s, 3, [P.clav[0] * sx, P.clav[1], P.clav[2]]);
      mk('upper' + s, B.length - 1, [P.upper[0] * sx, P.upper[1], 0]);
      mk('fore' + s, B.length - 1, [0, -P.upperLen, 0]);
      mk('hand' + s, B.length - 1, [0, -P.foreLen, 0]);
      const hb = B.length - 1;
      mk('fing' + s, hb, [sx * 0.0, -P.handLen * 0.62, 0.008 * h]);
      mk('index' + s, hb, [sx * 0.0, -P.handLen * 0.62, 0.036 * h]);
      mk('thumb' + s, hb, [-sx * 0.012, -P.handLen * 0.22, 0.032 * h]);
    }
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s);
      mk('thigh' + s, 1, [P.thigh[0] * sx, P.thigh[1], 0]);
      mk('shin' + s, B.length - 1, [0, -P.thighLen, 0]);
      mk('foot' + s, B.length - 1, [0, -P.shinLen, 0]);
    }
    // 입 속: 윗니(머리에 고정), 입 안 어둠(입술 뼈를 따라감), 눈알(커짐), 혀(입 아래쪽을 따라감)
    this.teethBone = mk('teeth', BONE.head, [0, my, mz]);
    mk('mouthIn', BONE.mouth, [0, 0, 0]);
    mk('cornerInL', BONE.cornerL, [0, 0, 0]);
    mk('cornerInR', BONE.cornerR, [0, 0, 0]);
    mk('ballL', BONE.head, [R * 0.36, ey, ez]);
    mk('ballR', BONE.head, [-R * 0.36, ey, ez]);
    mk('tongue', BONE.head, [0, my, mz]);
    this.root.add(B[0]);
    // 기준 자세의 월드 위치(루트 기준) 계산
    B[0].updateMatrixWorld(true);
    this.restW = B.map(b => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
  }
  // 루트 기준 기준 자세에서 뼈 위치
  bp(i) {
    return this.restW[i].clone();
  }
  // ----- 메시 -----
  buildMesh() {
    try {
      this.buildMeshImpl();
    } finally {
      G.capSeg = 6; // 도중에 예외가 나도 전역 설정을 되돌림
    }
  }

  buildMeshImpl() {
    const L = this.look, h = this.h, w = this.w, R = this.R, rig = new Rig();
    // 멀리 있는 관객일수록 면 수를 줄임 (휴대폰 부담)
    const lo = this.lod,
      seg = [18, 10, 8][lo] || 8,
      sseg = [24, 14, 12][lo] || 12;
    G.capSeg = [6, 4, 3][lo] || 3;
    const skin = L.skin || '#f6c9a2',
      top = L.top || '#2f5bd8',
      pants = L.pants || '#22244a',
      shoes = L.shoes || '#2a1e1a';
    const hair = L.hairColor || '#2a2018', style = L.topStyle || 'tee';
    const sleeve = L.jacket || top;

    const Bn = BONE;
    const hipY = this.restW[Bn.hips].y,
      spY = this.restW[Bn.spine].y,
      chY = this.restW[Bn.chest].y,
      nkY = this.restW[Bn.neck].y;
    const torsoW = p => {
      const y = p.y;
      if (y < spY) {
        const t = smoothstep(hipY - 0.02, spY, y);
        return [[Bn.hips, 1 - t], [Bn.spine, t]];
      }
      if (y < chY) {
        const t = smoothstep(spY, chY + 0.02, y);
        return [[Bn.spine, 1 - t], [Bn.chest, t]];
      }
      const t = smoothstep(nkY - 0.03, nkY + 0.03, y);
      return [[Bn.chest, 1 - t], [Bn.neck, t]];
    };
    // 몸통 가중치: 엉덩이↔허리↔가슴 부드럽게
    // 몸통 회전체 (단면 타원): 엉덩이-허리-가슴-어깨
    const belly = L.belly || 0,
      fem = !!L.fem;
    const prof = [
      [0.001, hipY - 0.1 * h],
      [0.13 * w, hipY - 0.09 * h],
      [(fem ? 0.172 : 0.16) * w, hipY - 0.03 * h],
      [(fem ? 0.15 : 0.155) * w + belly * 0.035, spY - 0.02 * h],
      [(fem ? 0.142 : 0.152) * w + belly * 0.07, spY + 0.05 * h],
      [(fem ? 0.165 : 0.172) * w + belly * 0.035, chY + 0.0 * h],
      [0.19 * w, chY + 0.08 * h],
      [0.185 * w, nkY - 0.06 * h],
      [0.12 * w, nkY - 0.015 * h],
      [0.06 * w, nkY + 0.005 * h],
      [0.001, nkY + 0.01 * h],
    ];
    const torso = latheY(prof, sseg);
    torso.scale(1, 1, 0.72);
    const isDress = style === 'dress';
    const stripe = L.stripe;
    const jacketed = style === 'jacket' || style === 'blazer';
    rig.add(torso, jacketed ? L.jacket || top : top, torsoW);
    // 몸통 겉에 붙는 무늬 (외곽선 없는 3번 그룹)
    const profR = y => {
      for (let i = 1; i < prof.length; i++)
        if (y <= prof[i][1]) return lerp(prof[i - 1][0], prof[i][0], (y - prof[i - 1][1]) / (prof[i][1] - prof[i - 1][1]));
      return 0.001;
    };
    const band = (y0, y1, color, off = 0.006, arc = null) => {
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const y = lerp(y0, y1, k / 6);
        pts.push([profR(y) + off, y]);
      }
      const g = arc ? latheY(pts, sseg, arc[0], arc[1]) : latheY(pts, sseg);
      g.scale(1, 1, 0.72);
      rig.add(g, color, torsoW, null, 2);
    };
    if (stripe && !jacketed)
      for (let y = hipY + 0.02 * h; y < nkY - 0.1 * h; y += 0.075 * h) band(y, y + 0.032 * h, stripe);
    if (jacketed) {
      // 셔츠 V자 + 넥타이
      const vTop = nkY - 0.02 * h, vBot = chY - 0.06 * h;
      const vs = new THREE.BufferGeometry();
      const vz = (y, x) => Math.sqrt(Math.max(0, 1 - Math.pow(x / (profR(y) + 0.008), 2))) * (profR(y) + 0.008) * 0.72 + 0.001;
      const pos = [], idx = [];
      const N = 6;
      for (let k = 0; k <= N; k++) {
        const y = lerp(vBot, vTop, k / N), hw2 = lerp(0.004, 0.07 * w, k / N);
        for (const xx of [-hw2, 0, hw2]) pos.push(xx, y, vz(y, xx));
      }
      for (let k = 0; k < N; k++) {
        const a = k * 3;
        idx.push(a, a + 1, a + 4, a, a + 4, a + 3, a + 1, a + 2, a + 5, a + 1, a + 5, a + 4);
      }
      vs.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      vs.setIndex(idx);
      vs.computeVertexNormals();
      rig.add(vs, L.shirt || '#fff4de', torsoW, null, 2);
      if (L.tie) {
        const tg = new THREE.BufferGeometry(),
          tp = [],
          ti = [];
        const knotY = vTop - 0.025 * h, tipY = vBot - 0.1 * h;
        const pts = [
          [0, vTop - 0.005],
          [0.016, knotY],
          [0.012, knotY - 0.02],
          [0.03, tipY + 0.04],
          [0, tipY],
          [-0.03, tipY + 0.04],
          [-0.012, knotY - 0.02],
          [-0.016, knotY]
        ];
        for (const [x, y] of pts) tp.push(x * w, y, vz(y, x) + 0.004);
        tp.push(0, (knotY + tipY) / 2, vz((knotY + tipY) / 2, 0) + 0.006);
        for (let k = 0; k < pts.length; k++) ti.push(pts.length, k, (k + 1) % pts.length);
        tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
        tg.setIndex(ti);
        tg.computeVertexNormals();
        rig.add(tg, L.tie, torsoW, null, 2);
      }
    }
    // 허리 벨트 + 바지 엉덩이
    if (!isDress) {
      rig.add(latheY([[0.001, hipY - 0.13 * h], [0.15 * w, hipY - 0.115 * h], [0.168 * w, hipY - 0.05 * h], [0.162 * w, hipY + 0.012 * h], [0.001, hipY + 0.014 * h]], sseg).scale(1, 1, 0.78), pants, Bn.hips);
      rig.add(G.tor(1, 0.06, sseg, 6).rotateX(Math.PI / 2), L.belt || '#2a1e1a', Bn.hips, M4([0, hipY + 0.005 * h, 0], 0, [0.163 * w, 0.18, 0.163 * w * 0.78]));
    } else rig.add(latheY([[0.001, hipY - 0.04 * h], [0.17 * w, hipY - 0.03 * h], [0.24 * w, hipY - 0.3 * h], [0.27 * w, hipY - 0.42 * h], [0.001, hipY - 0.425 * h]], sseg).scale(1, 1, 0.85), L.dress || top, Bn.hips);
    // 목
    {
      const c = capBetween(V3(0, nkY - 0.04 * h, 0), V3(0, nkY + 0.1 * h, 0.01), 0.048 * w, seg);
      rig.add(c.g, skin, p => p.y < nkY + 0.03 ? [[Bn.neck, 1]] : [ [Bn.neck, 0.6], [Bn.head, 0.4]], c.m);
    }
    // 옷깃
    if (style === 'shirt' || style === 'jacket' || style === 'blazer' || style === 'polo') rig.add(G.tor(1, 0.25, sseg, 6).rotateX(Math.PI / 2), L.shirt || (style === 'polo' ? top : '#fff4de'), Bn.chest, M4([0, nkY - 0.015 * h, 0.005], [0.12, 0, 0], [0.065 * w, 0.06 * w, 0.05]));
    if (style === 'jacket' || style === 'blazer') {
      // 라펠 두 장
      for (const sx of [1, -1]) rig.add(G.sph(10, 6), L.lapel || shadeHex(L.jacket || top, 0.85), Bn.chest, M4([sx * 0.05 * w, chY + 0.07 * h, 0.12 * w], [0.15, 0, sx * 0.35], [0.03 * w, 0.11 * h, 0.012]));
    }
    if (style === 'hoodie') rig.add(G.tor(1, 0.35, sseg, 8).rotateX(Math.PI / 2), shadeHex(top, 0.9), Bn.chest, M4([0, nkY - 0.02 * h, -0.02], [0.3, 0, 0], [0.09 * w, 0.08 * w, 0.06]));
    // ----- 팔 -----
    const longSleeve = style === 'jacket' || style === 'blazer' || style === 'sweater' || style === 'hoodie' || style === 'shirt';
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s),
        iu = Bn['upper' + s],
        iff = Bn['fore' + s],
        ih = Bn['hand' + s];
      const sh = this.restW[iu],
        el = this.restW[iff],
        wr = this.restW[ih];
      // 팔: 피부 캡슐 + 소매 (무늬는 경계가 또렷하게 따로 만든 소매로)
      const shT = V3(sh.x, sh.y + 0.03 * h, sh.z),
        elB = V3(el.x, el.y - 0.015 * h, el.z),
        elT = V3(el.x, el.y + 0.01 * h, el.z);
      const sleeveKind = longSleeve ? (style === 'shirt' ? 'rolled' : 'long') : (style === 'tank' || style === 'dress' || style === 'none') ? 'none' : 'short';
      const armR = 0.054 * w, foreR = 0.046 * w;
      if (sleeveKind === 'long' || sleeveKind === 'rolled') {
        const c = capBetween(shT, elB, armR + 0.004, seg);
        rig.add(c.g, sleeve, iu, c.m);
      } else {
        const c = capBetween(shT, elB, armR, seg);
        rig.add(c.g, skin, iu, c.m);
      }
      if (sleeveKind === 'short') {

        const c = capBetween(shT, shT.clone().lerp(elB, 0.5), armR + 0.012, seg);
        rig.add(c.g, sleeve, iu, c.m);
      }
      if (sleeveKind === 'long') {
        const c = capBetween(elT, wr, foreR + 0.004, seg);
        rig.add(c.g, sleeve, iff, c.m);
      } else {
        const c = capBetween(elT, wr, foreR, seg);
        rig.add(c.g, skin, iff, c.m);
      }
      if (sleeveKind === 'rolled') {
        const c = capBetween(elT, elT.clone().lerp(wr, 0.32), foreR + 0.013, seg);
        rig.add(c.g, sleeve, iff, c.m);
      }
      if (sleeveKind === 'long') rig.add(G.tor(1, 0.3, seg, 6).rotateX(Math.PI / 2), L.cuff || shadeHex(sleeve, 0.85), iff, M4([wr.x, wr.y + 0.02 * h, wr.z], 0, [foreR + 0.004, foreR + 0.004, 0.03]));
      {
        const covered = sleeveKind === 'long' || sleeveKind === 'rolled', er = (covered ? armR + 0.003 : (armR + foreR) / 2) * 0.97;
        rig.add(G.sph(seg, 8), covered ? sleeve : skin, iff, M4([el.x, el.y - 0.004 * h, el.z], 0, [er, er, er]));
      }
      // 손: 손바닥 + 손가락 덩어리 + 검지 + 엄지 (손바닥은 몸 쪽(-sx·x)을 봄, 엄지는 앞(+z))
      const hy = wr.y;
      rig.add(G.sph(seg, 10), skin, ih, M4([wr.x, hy - 0.04 * h, wr.z + 0.004], 0, [0.027 * w, 0.048 * h, 0.046 * h]));
      const fg = this.restW[Bn['fing' + s]], ix = this.restW[Bn['index' + s]], th = this.restW[Bn['thumb' + s]];
      rig.add(G.sph(seg, 10), skin, Bn['fing' + s], M4([fg.x, fg.y - 0.034 * h, fg.z - 0.01], 0, [0.024 * w, 0.042 * h, 0.036 * h]));
      {
        const c = capBetween(V3(ix.x, ix.y + 0.006, ix.z - 0.002), V3(ix.x, ix.y - 0.062 * h, ix.z - 0.002), 0.0135 * h, 8);
        rig.add(c.g, skin, Bn['index' + s], c.m);
      } {
        const c = capBetween(V3(th.x, th.y, th.z), V3(th.x - sx * 0.012, th.y - 0.044 * h, th.z + 0.02 * h), 0.014 * h, 8);
        rig.add(c.g, skin, Bn['thumb' + s], c.m);
      }
    }
    // ----- 다리 -----
    for (const s of PERSON_SIDES) {
      const it = Bn['thigh' + s], is = Bn['shin' + s], ifo = Bn['foot' + s];
      const hp = this.restW[it], kn = this.restW[is], an = this.restW[ifo];
      const legC = isDress ? skin : pants;
      {
        const c = capBetween(V3(hp.x, hp.y + 0.03 * h, hp.z), V3(kn.x, kn.y - 0.035 * h, kn.z), 0.09 * w, seg);
        rig.add(c.g, isDress && !L.tights ? skin : legC, it, c.m, 0, null);
      } {
        const c = capBetween(V3(kn.x, kn.y + 0.02 * h, kn.z), V3(an.x, an.y + 0.02, an.z), 0.07 * w, seg);
        rig.add(c.g, isDress ? (L.tights || skin) : legC, is, c.m);
      }
      if (!isDress) rig.add(G.tor(1, 0.35, seg, 6).rotateX(Math.PI / 2), shadeHex(pants, 0.82), is, M4([an.x, an.y + 0.07 * h, an.z], 0, [0.062 * w, 0.062 * w, 0.04]));
      // 신발
      rig.add(G.sph(seg, 10), shoes, ifo, M4([an.x, an.y - 0.045 * h, an.z + 0.055 * h], 0, [0.058 * w, 0.045 * h, 0.13 * h]), 0, (p) => p.y < an.y - 0.075 * h ? new THREE.Color(L.sole || '#f4ead8') : null);
    }
    // ----- 머리 -----
    const hb = Bn.head,
      hw = this.restW[hb],
      hc = hw.clone().add(this.headC);
    const headM = M4([hc.x, hc.y, hc.z], 0, [R * 1.0, R * 1.04, R * 0.98]);
    rig.add(G.sph(sseg, [18, 13, 11][lo] || 11), skin, hb, headM);
    // 턱·볼 (아래 앞쪽으로 살짝). 입을 크게 벌리면 아래턱이 늘어나며 내려감
    rig.add(G.sph(sseg, 12), skin, p => {
      const k = smoothstep(hc.y - R * 0.4, hc.y - R * 0.86, p.y);
      return [[Bn.jaw, k], [hb, 1 - k]];
    }, M4([hc.x, hc.y - R * 0.38, hc.z + R * 0.13], 0, [R * (L.jawW || 0.86), R * 0.66, R * 0.84]));
    // 귀
    for (const sx of [1, -1]) rig.add(G.sph(10, 8), shadeHex(skin, 0.94), hb, M4([hc.x + sx * R * 0.97, hc.y - R * 0.08, hc.z - R * 0.05], [0, sx * 0.3, 0], [R * 0.13, R * 0.22, R * 0.09]));
    // 코
    const ns = L.nose || 1;
    rig.add(G.sph(12, 10), shadeHex(skin, 0.97), hb, M4([hc.x, hc.y - R * 0.16, hc.z + R * 0.96], [0.2, 0, 0], [R * 0.12 * ns, R * 0.13 * ns, R * 0.13 * ns]));
    // 볼터치
    if (L.blush !== false)
      for (const sx of [1, -1]) rig.add(G.sph(10, 6), mixHex(skin, '#ff7a8a', 0.35), hb, M4([hc.x + sx * R * 0.55, hc.y - R * 0.3, hc.z + R * 0.74], [0, sx * 0.6, 0], [R * 0.16, R * 0.1, R * 0.05]), 1);
    // ----- 눈 (얼굴 그룹) -----
    const E = this.eyeP;
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s),
        ie = Bn['eye' + s],
        il = Bn['lid' + s];
      const ec = V3(hw.x + sx * E.x, hw.y + E.y, hw.z + E.z);
      rig.add(G.sph(14, 10), '#ffffff', Bn['ball' + s], M4([ec.x, ec.y, ec.z], 0, [E.r, E.r * 1.12, E.r * 0.7]), 1);
      // 눈동자 + 반짝이
      rig.add(G.sph(12, 8), L.eye || '#2a1a14', ie, M4([ec.x, ec.y - E.r * 0.05, ec.z + E.r * 0.52], 0, [E.r * 0.58, E.r * 0.66, E.r * 0.26]), 1);
      rig.add(G.sph(8, 6), '#ffffff', ie, M4([ec.x + E.r * 0.2, ec.y + E.r * 0.2, ec.z + E.r * 0.72], 0, [E.r * 0.17, E.r * 0.17, E.r * 0.08]), 1);
      // 윗눈꺼풀 (반구) + 속눈썹 선
      const lid = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      rig.add(lid, skin, il, M4([ec.x, ec.y, ec.z], 0, [E.r * 1.08, E.r * 1.2, E.r * 0.8]), 1);
      rig.add(G.tor(1, 0.08, 14, 5, Math.PI), L.lash || '#2a1a20', il, M4([ec.x, ec.y, ec.z], [Math.PI / 2, 0, 0], [E.r * 1.08 * (fem ? 1.04 : 1), E.r * 0.8, E.r * (fem ? 1.6 : 1.1)]), 1);
      // 눈썹
      const ib = Bn['brow' + s], bwp = this.restW[ib];
      {
        const c = capBetween(V3(bwp.x - sx * R * 0.14, bwp.y - R * 0.01, bwp.z), V3(bwp.x + sx * R * 0.14, bwp.y + R * 0.015, bwp.z - R * 0.03), R * (L.browT || 0.05), 8);
        rig.add(c.g, L.browColor || hair, ib, c.m, 1);
      }
    }
    // ----- 입 (얼굴 곡면을 따라 휘게) -----
    {
      const mp = this.mouthP,
        mw = mp.w;
      // 가운데는 입 뼈, 양끝은 입꼬리 뼈 (입 안 어둠은 같은 모양을 따라가는 안쪽 뼈들)
      const split = (ce, cl, cr) => p => {
        const t = smoothstep(mw * 0.25, mw * 0.95, Math.abs(p.x - hw.x));
        return p.x >= hw.x ? [[ce, 1 - t], [cl, t]] : [[ce, 1 - t], [cr, t]];
      };
      const m0 = [hw.x, hw.y + mp.y, hw.z + mp.z];
      rig.add(bendZ(G.sph(18, 10), 0.55), L.mouthColor || '#6a1824', split(Bn.mouth, Bn.cornerL, Bn.cornerR), M4(m0, [0.1, 0, 0], [mw, R * 0.16, R * 0.08]), 1);
      rig.add(bendZ(G.sph(18, 10), 0.55), '#2b0a13', split(Bn.mouthIn, Bn.cornerInL, Bn.cornerInR), M4([m0[0], m0[1], m0[2] + R * 0.016], [0.1, 0, 0], [mw * 0.86, R * 0.16 * 0.8, R * 0.08]), 2);
      rig.add(bendZ(G.sph(12, 6), 0.5), '#fffaf0', Bn.teeth, M4([m0[0], m0[1], m0[2] + R * 0.034], [0.1, 0, 0], [mw * 0.62, R * 0.05, R * 0.05]), 2);
      rig.add(bendZ(G.sph(12, 6), 0.5), '#e0566a', Bn.tongue, M4([m0[0], m0[1], m0[2] + R * 0.028], [0.1, 0, 0], [mw * 0.52, R * 0.075, R * 0.05]), 2);
    }
    // ----- 수염 -----
    if (L.mustache)
      for (const sx of [1, -1]) rig.add(bendZ(G.sph(10, 6), 0.4), L.beardColor || hair, hb, M4([hc.x + sx * R * 0.15, hc.y - R * 0.3, hc.z + R * 0.985], [0.15, sx * 0.25, sx * -0.28], [R * 0.17, R * 0.06, R * 0.06]));
    if (L.beard) {
      // 턱 아래 (입은 가리지 않음)
      const ph0 = -Math.PI * 0.13,
        phL = Math.PI * 1.26;
      const bg = new THREE.SphereGeometry(1, sseg, 10, ph0, phL, Math.PI * 0.52, Math.PI * 0.48);
      {
        const bp = bg.attributes.position;
        for (let i = 0; i < bp.count; i++) {
          const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i), rr = Math.hypot(x, z);
          if (rr < 1e-4) continue;
          let a = Math.atan2(z, -x);
          if (a < ph0 - 0.01) a += Math.PI * 2;
          const k = lerp(0.8, 1, smoothstep(0, 0.42, Math.min(a - ph0, ph0 + phL - a)));
          bp.setXYZ(i, x * k, y, z * k);
        }
        bg.computeVertexNormals();
      }
      rig.add(bg, L.beardColor || hair, p => [
        [Bn.jaw, 0.9],
        [hb, 0.1]
      ], M4([hc.x, hc.y - R * 0.34, hc.z + R * 0.13], [-0.32, 0, 0], [R * 0.93, R * 0.78, R * 0.93]));
    }
    if (L.goatee) rig.add(G.sph(12, 8), L.beardColor || hair, Bn.jaw, M4([hc.x, hc.y - R * 0.82, hc.z + R * 0.66], 0, [R * 0.17, R * 0.2, R * 0.14]));
    // ----- 안경 -----
    if (L.glasses && !L.movableGlasses) {
      for (const sx of [1, -1]) {
        rig.add(G.tor(1, 0.11, 18, 6), L.glasses, hb, M4([hw.x + sx * E.x, hw.y + E.y - E.r * 0.05, hw.z + E.z + E.r * 0.62], 0, [E.r * 1.4, E.r * 1.3, E.r]), 1);
        rig.add(G.cap(R * 0.9, R * 0.03, 6), L.glasses, hb, M4([hw.x + sx * R * 0.86, hw.y + E.y, hw.z + E.z - R * 0.35], [Math.PI / 2, 0, 0]), 1);
      }
      rig.add(G.cap(R * 0.22, R * 0.03, 6), L.glasses, hb, M4([hw.x, hw.y + E.y + E.r * 0.15, hw.z + E.z + E.r * 0.7], [0, 0, Math.PI / 2]), 1);
    }
    // ----- 머리카락·모자 -----
    this.buildHair(rig, hc, hb, R, hair, sseg);
    // ----- 귀걸이 -----
    if (L.earring)
      for (const sx of [1, -1]) rig.add(G.tor(1, 0.25, 12, 6), L.earring, hb, M4([hc.x + sx * R * 0.99, hc.y - R * 0.36, hc.z - R * 0.02], [0, Math.PI / 2, 0], [R * 0.09, R * 0.09, R * 0.09]));
    // ----- 메시 -----
    const geo = rig.build();
    G.capSeg = 6;
    const mats = [PEOPLE_MAT.body, PEOPLE_MAT.face, PEOPLE_MAT.decal].filter((_, i) => rig.groupsUsed[i]);
    const mesh = this.mesh = new THREE.SkinnedMesh(geo, mats);
    mesh.frustumCulled = false;
    mesh.castShadow = !this.lod;
    mesh.receiveShadow = false;
    this.root.add(mesh);
    mesh.bind(new THREE.Skeleton(this.bones));
    // 그릴 때: 지난번 그린 뒤로 자세가 안 바뀐 사람은 뼈 행렬 계산과 뼈 텍스처 올리기를 건너뜀 (관객은 초당 20~30번만 움직이고 화면은 60번 그림. 숨겨 둔 사람도 여기서 걸러짐)
    // 주의: 여기서 this는 Person이므로, 원래 함수를 부를 때는 root / skeleton을 명시해서 넘김
    const self = this, root = this.root, sk = mesh.skeleton, skUpdate = sk.update;
    this.dirty = true;
    this.skDirty = true;
    root.updateMatrixWorld = (force) => {
      if (PEOPLE.drawing) {
        if (!self.dirty) return;
        self.dirty = false;
      }
      PERSON_SYNC.call(root, force);
    };
    sk.update = () => {
      if (!self.skDirty) return;
      self.skDirty = false;
      skUpdate.call(sk);
    };
  }
  buildHair(rig, hc, hb, R, hair, sseg) {
    const L = this.look, st = L.hair || 'short', Bn = BONE;
    const cap = (k = 1.08, tilt = -0.5, theta = 0.56) => {
      const g = new THREE.SphereGeometry(1, sseg, 10, 0, Math.PI * 2, 0, Math.PI * theta);
      rig.add(g, hair, hb, M4([hc.x, hc.y + R * 0.02, hc.z - R * 0.02], [tilt, 0, 0], [R * k, R * k * 1.02, R * k]));
    };
    switch (st) {
      case 'bald': {
        // 정수리는 비고 뒤통수와 양옆에만 남은 머리. 다른 머리 모양(cap)처럼 머리통보다 조금 큰 구 껍질인데, 위쪽과 얼굴 쪽이 없는 띠:
        // 뒤통수에서는 목덜미까지 내려오고, 옆으로 갈수록 얕아지다가 귀 바로 앞에서 둥글게 끝남. 뒤통수를 가운데로 좌우 대칭.
        // (구의 경도: 270도 = 뒤통수, 0·180도 = 양옆, 90도 = 앞)
        const N = Math.max(14, Math.round(sseg * 0.8)),
          M = 4,
          span = Math.PI * 1.22,
          pos = [],
          idx = [];
        for (let i = 0; i <= N; i++) {
          const u = i / N,
            t = Math.abs(2 * u - 1),
            phi = Math.PI * 1.5 + (u - 0.5) * span; // t: 뒤통수 0 → 양 끝 1
          const end = t > 0.8 ? Math.sqrt(Math.max(0, 1 - ((t - 0.8) / 0.2) ** 2)) : 1; // 끝은 둥글게 오므림
          // 위쪽 끝: 모자를 쓴 사람은 모자 속까지 올려서 모자와 머리카락 사이에 맨살 띠가 보이지 않게 함
          const top = (L.hat ? 0.2 + 0.15 * t * t : 0.32 + 0.05 * t * t) * Math.PI,
            bot = (0.7 - 0.12 * t * t * (3 - 2 * t)) * Math.PI,
            mid = (top + bot) / 2,
            half = (bot - top) / 2 * end;
          for (let j = 0; j <= M; j++) {
            const th = mid + half * (2 * j / M - 1);
            pos.push(-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th));
          }
        }
        for (let i = 0; i < N; i++)
          for (let j = 0; j < M; j++) {
            const a = i * (M + 1) + j,
              b = a + M + 1;
            idx.push(a, a + 1, b, b, a + 1, b + 1);
          }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        rig.add(g, hair, hb, M4([hc.x, hc.y + R * 0.02, hc.z - R * 0.02], 0, [R * 1.06, R * 1.06 * 1.02, R * 1.06]));
        break;
      }
      case 'buzz':
        cap(1.035, -0.55, 0.55);
        break;
      case 'short':
        cap(1.09, -0.52, 0.56);
        rig.add(G.sph(14, 8), hair, hb, M4([hc.x + R * 0.25, hc.y + R * 0.72, hc.z + R * 0.5], [0.4, 0, -0.5], [R * 0.48, R * 0.2, R * 0.32]));
        break;
      case 'side':
        cap(1.08, -0.5, 0.57);
        rig.add(G.sph(14, 8), hair, hb, M4([hc.x - R * 0.3, hc.y + R * 0.75, hc.z + R * 0.42], [0.5, 0, 0.6], [R * 0.6, R * 0.22, R * 0.38]));
        break;
      case 'pomp':
        cap(1.07, -0.5, 0.55);
        rig.add(G.sph(16, 10), hair, hb, M4([hc.x, hc.y + R * 0.92, hc.z + R * 0.5], [0.5, 0, 0], [R * 0.62, R * 0.32, R * 0.5]));
        break;
      case 'afro': {
        const g = new THREE.SphereGeometry(1, 22, 16),
          p = g.attributes.position,
          v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i);
          const n = 1 + 0.07 * Math.sin(v.x * 9 + v.y * 4) * Math.cos(v.z * 8 - v.y * 6);
          p.setXYZ(i, v.x * n, v.y * n, v.z * n);
        }
        g.computeVertexNormals();
        rig.add(g, hair, hb, M4([hc.x, hc.y + R * 0.75, hc.z - R * 0.36], 0, [R * 1.42, R * 1.12, R * 1.26]));
        break;
      }
      case 'curly': {
        cap(1.05, -0.52, 0.55);
        const r2 = seeded(this.look.seed || 7);
        for (let i = 0; i < 18; i++) {
          const a = r2.range(0, Math.PI * 2),
            b = r2.range(0.05, 1.25);
          const x = Math.sin(b) * Math.cos(a),
            y = Math.cos(b),
            z = Math.sin(b) * Math.sin(a);
          if (z > 0.55 && y < 0.55) continue;
          rig.add(G.sph(10, 6), hair, hb, M4([hc.x + x * R * 1.02, hc.y + y * R * 1.02 + R * 0.05, hc.z + z * R * 1.0 - R * 0.05], 0, [R * 0.3, R * 0.3, R * 0.3]));
        }
        break;
      }
      case 'bun':
        cap(1.06, -0.5, 0.57);
        rig.add(G.sph(16, 10), hair, hb, M4([hc.x, hc.y + R * 1.05, hc.z - R * 0.42], 0, [R * 0.44, R * 0.4, R * 0.44]));
        break;
      case 'pony':
        cap(1.07, -0.5, 0.57);
        rig.add(G.sph(12, 8), hair, hb, M4([hc.x, hc.y + R * 0.35, hc.z - R * 1.05], 0, [R * 0.22, R * 0.22, R * 0.22]));
        {
          const c = capBetween(V3(hc.x, hc.y + R * 0.3, hc.z - R * 1.12), V3(hc.x, hc.y - R * 1.0, hc.z - R * 1.3), R * 0.2, 10);
          rig.add(c.g, hair, hb, c.m);
        }
        break;
      case 'bob':
        cap(1.1, -0.46, 0.6);
        for (const sx of [1, -1]) rig.add(G.sph(14, 10), hair, hb, M4([hc.x + sx * R * 0.78, hc.y - R * 0.35, hc.z - R * 0.12], [0, 0, sx * 0.1], [R * 0.42, R * 0.78, R * 0.75]));
        rig.add(G.sph(16, 10), hair, hb, M4([hc.x, hc.y - R * 0.3, hc.z - R * 0.55], 0, [R * 0.95, R * 0.8, R * 0.6]));
        break;
      case 'long':
        cap(1.1, -0.46, 0.62);
        for (const sx of [1, -1]) rig.add(G.sph(14, 10), hair, p => p.y < hc.y - R * 1.2 ? [
          [Bn.chest, 0.7],
          [hb, 0.3]
        ] : [
          [hb, 1]
        ], M4([hc.x + sx * R * 0.75, hc.y - R * 0.6, hc.z - R * 0.2], [0, 0, sx * 0.08], [R * 0.4, R * 1.25, R * 0.62]));
        rig.add(G.sph(16, 10), hair, p => p.y < hc.y - R * 1.2 ? [
          [Bn.chest, 0.7],
          [hb, 0.3]
        ] : [
          [hb, 1]
        ], M4([hc.x, hc.y - R * 0.55, hc.z - R * 0.6], 0, [R * 1.0, R * 1.3, R * 0.55]));
        break;
      case 'mohawk':
        cap(1.02, -0.55, 0.5);
        for (let i = 0; i < 6; i++) {
          const a = -0.4 + i * 0.3;
          rig.add(new THREE.ConeGeometry(1, 2, 8), hair, hb, M4([hc.x, hc.y + Math.cos(a) * R * 1.0, hc.z + Math.sin(a) * R * 1.0], [a, 0, 0], [R * 0.12, R * 0.22, R * 0.2]));
        }
        break;
    }
    // 모자
    const hat = L.hat,
      hcol = L.hatColor || '#22244a';
    if (hat === 'beret') rig.add(G.sph(18, 10), hcol, hb, M4([hc.x - R * 0.15, hc.y + R * 0.78, hc.z - R * 0.05], [0.15, 0, 0.32], [R * 1.08, R * 0.32, R * 1.0]));
    else if (hat === 'fedora') {
      rig.add(G.cyl(0.85, 1, 1, 18), hcol, hb, M4([hc.x, hc.y + R * 0.88, hc.z - R * 0.02], [-0.1, 0, 0], [R * 0.88, R * 0.5, R * 0.82]));
      rig.add(G.cyl(1, 1, 1, 22), hcol, hb, M4([hc.x, hc.y + R * 0.65, hc.z - R * 0.02], [-0.1, 0, 0], [R * 1.5, R * 0.05, R * 1.42]));
      rig.add(G.cyl(1, 1, 1, 18, true), L.hatBand || '#ee4a2c', hb, M4([hc.x, hc.y + R * 0.72, hc.z - R * 0.02], [-0.1, 0, 0], [R * 0.9, R * 0.1, R * 0.84]));
    } else if (hat === 'cap') {
      rig.add(new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hcol, hb, M4([hc.x, hc.y + R * 0.18, hc.z], [-0.2, 0, 0], [R * 1.1, R * 1.05, R * 1.08]));
      rig.add(G.cyl(1, 1, 1, 18), hcol, hb, M4([hc.x, hc.y + R * 0.38, hc.z + R * 0.98], [-0.15, 0, 0], [R * 0.7, R * 0.04, R * 0.55]));
    } else if (hat === 'beanie') {
      rig.add(new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hcol, hb, M4([hc.x, hc.y + R * 0.08, hc.z - R * 0.02], [-0.25, 0, 0], [R * 1.12, R * 1.18, R * 1.1]));
      rig.add(G.sph(10, 8), L.hatBand || '#fff4de', hb, M4([hc.x, hc.y + R * 1.25, hc.z - R * 0.3], 0, [R * 0.22, R * 0.22, R * 0.22]));
    }
  }
  // ----- 표정 -----
  express(k, dur = 1.5) {
    const E = FACES[k];
    if (!E) return;
    Object.assign(this.faceT, E);
    this.exUntil = dur > 0 ? NOW.t + dur : 0;
    this.curFace = k;
  }
  setBase(k) {
    if (this.base === k) return;
    this.base = k;
    if (!this.exUntil) {
      Object.assign(this.faceT, FACES[k] || FACES.calm);
      this.curFace = k;
    }
  }
  // ----- 팔 -----
  // 월드 목표점으로 손 보내기. pole: 팔꿈치 방향(선택). q: 손 월드 회전(선택). hand: 손 모양(선택)
  reach(side, target, pole = null, q = null, hand = null) {
    const A = this.arms[side];
    A.mode = 'ik';
    A.target.copy(target);
    A.q = q;
    if (pole) A.pole.copy(pole);
    else A.pole.set(0, 0, 0);
    A.has = !!pole;
    if (hand) A.hand = hand;
  }
  rest(side, hand = 'relax') {
    const A = this.arms[side];
    A.mode = 'rest';
    A.hand = hand;
    A.q = null;
  }
  // 몸 기준 좌표 → 월드
  local(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z).applyMatrix4(this.root.matrixWorld);
  }
  headWorld(out = new THREE.Vector3()) {
    this.bones[BONE.head].updateWorldMatrix(true, false);
    return out.copy(this.headC).applyMatrix4(this.bones[BONE.head].matrixWorld);
  }
  chestWorld(out = new THREE.Vector3()) {
    return this.bones[BONE.chest].getWorldPosition(out);
  }

  // ----- 매 프레임 -----
  update(dt, t, beat) {
    const c = this.c,
      s = this.s,
      B = this.bones,
      Bn = BONE,
      h = this.h;
    // 표정
    if (this.exUntil && t > this.exUntil) {
      this.exUntil = 0;
      Object.assign(this.faceT, FACES[this.base] || FACES.calm);
      this.curFace = this.base;
    }
    for (const k in this.face) this.face[k] = damp(this.face[k], this.faceT[k], 12, dt);
    this.blinkT -= dt;
    if (this.blinkT < 0) {
      this.blink = 1;
      this.blinkT = rand(2, 5.5);
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    // 얼어붙음: 기가 막힌 표정일 때는 몸이 굳고 고개가 살짝 뒤로
    const shock = clamp((this.face.pop - 1) / 0.15, 0, 1);
    this.disb = damp(this.disb, c.disbelief, 3.5, dt);
    // 몸 (스무딩)
    s.stand = damp(s.stand, c.stand, 3.2, dt);
    s.twist = dampAngle(s.twist, c.twist, 4.5, dt);
    s.lean = damp(s.lean, c.lean, 4, dt);
    s.side = damp(s.side, c.side, 4, dt);
    const g = c.groove * (1 - 0.75 * shock);
    // 그루브: 2·4박에 머리 끄덕, 몸 흔들기, 무릎 바운스
    const ph = ((beat + c.phase) % 2 + 2) % 2;
    const pulse = Math.exp(-Math.pow((ph - 1.0) / 0.2, 2)) + 0.45 * Math.exp(-Math.pow(ph / 0.22, 2)) + 0.45 * Math.exp(-Math.pow((ph - 2) / 0.22, 2));
    const beatPh = ((beat + c.phase * 0.5) % 1 + 1) % 1;
    const bounce = c.bounce * g * (0.5 - 0.5 * Math.cos(beatPh * Math.PI * 2));
    const sway = Math.sin((beat + c.phase * 2) * Math.PI / 2) * c.sway * g;
    // 점프: 박마다 튀어 오름
    let jy = 0;
    if (c.jump > 0.01 && s.stand > 0.8) {
      const jp = ((beat + c.phase) % 1 + 1) % 1;
      jy = c.jump * (1 - shock) * Math.max(0, Math.sin(jp * Math.PI)) * 0.16;
    }
    s.jumpY = damp(s.jumpY, jy, 20, dt);
    // 엉덩이 높이·위치
    const standH = this.restW[Bn.hips].y,
      sitH = this.seatY + 0.09 * h;
    const st = smooth01(s.stand);
    // 무릎 꿇기 / 의자에서 미끄러져 바닥에 주저앉기
    s.kneel = damp(s.kneel, c.kneel || 0, 4.2, dt);
    s.slump = damp(s.slump, c.slump || 0, 2.6, dt);
    const kn = smooth01(s.kneel), sl = smooth01(s.slump);
    let hipsY = lerp(sitH, standH - bounce * 0.07 - 0.015, st) + s.jumpY;
    let hipsZ = lerp(-0.06, 0, st);
    if (kn > 0.001) {
      hipsY = lerp(hipsY, 0.43 * h, kn);
      hipsZ = lerp(hipsZ, 0.02, kn);
    }
    if (sl > 0.001) {
      hipsY = lerp(hipsY, 0.13 * h, sl);
      hipsZ = lerp(hipsZ, 0.34, sl);
    }
    B[Bn.hips].position.set(Math.sin(sway * 1.2) * 0.02 * st + c.hipSway * 0.03 * Math.sin(beat * Math.PI), hipsY, hipsZ);
    // 숨 참기: 머리가 풍선처럼 부풂
    s.puff = damp(s.puff, c.puff || 0, c.puff > s.puff ? 0.9 : 9, dt);
    B[Bn.head].scale.setScalar(1 + s.puff * 0.3);
    B[Bn.hips].rotation.set(0, sway * 0.12 * st, sway * 0.08 * st + c.hipSway * 0.05 * Math.sin(beat * Math.PI));
    // 허리·가슴
    const bang = c.headBang * (1 - shock);
    const lean = s.lean + (1 - st) * 0.05 + bounce * 0.04 + bang * 0.25 * Math.max(0, Math.sin(beat * Math.PI * 2)) - shock * 0.07;
    B[Bn.spine].rotation.set(lean * 0.45, s.twist * 0.45, s.side * 0.5 - sway * 0.06);
    B[Bn.chest].rotation.set(lean * 0.55, s.twist * 0.55, s.side * 0.5 + sway * 0.1);
    // IK only reads the torso and clavicle parents here. Updating every finger,
    // face bone and mesh before animating them duplicated the render traversal.
    B[Bn.neck].updateWorldMatrix(true, false);
    B[Bn.clavL].updateWorldMatrix(false, false);
    B[Bn.clavR].updateWorldMatrix(false, false);
    const hp = _pv1.setFromMatrixPosition(B[Bn.neck].matrixWorld);
    const rel = _pv2.copy(c.look).sub(hp);
    _pq1.setFromRotationMatrix(B[Bn.chest].matrixWorld).invert();
    rel.applyQuaternion(_pq1);
    let yaw = Math.atan2(rel.x, rel.z),
      pitch = -Math.atan2(rel.y, Math.hypot(rel.x, rel.z));
    yaw = clamp(yaw, -1.35, 1.35) * c.lookW;
    pitch = clamp(pitch, -0.7, 0.55) * c.lookW;
    if (c.eyeOnly) {
      yaw *= 0.25;
      pitch *= 0.25;
    }
    s.yaw = damp(s.yaw, yaw, 7, dt);
    s.pitch = damp(s.pitch, pitch, 7, dt);
    const nod = pulse * c.nod * g * 0.22 + bang * 0.5 * Math.pow(Math.max(0, Math.sin(beat * Math.PI * 2)), 2);
    // 빠른 도리도리(신남) / 느린 절레절레("미쳤네…")
    const shake = (c.headShake ? Math.sin(t * 13) * 0.22 * c.headShake : 0) + (this.disb > 0.01 ? Math.sin(t * 4.3 + c.phase * 2.7) * 0.32 * this.disb : 0);
    s.roll = damp(s.roll, c.headTilt + sway * 0.25, 5, dt);
    B[Bn.neck].rotation.set(s.pitch * 0.35 + nod * 0.35 - shock * 0.03, s.yaw * 0.4 + shake * 0.4, s.roll * 0.4);
    B[Bn.head].rotation.set(s.pitch * 0.65 + nod * 0.65 - shock * 0.07, s.yaw * 0.6 + shake * 0.6, s.roll * 0.6);
    // 다리
    this.updateLegs(st, c);
    // 팔
    this.updateArm('L', dt);
    this.updateArm('R', dt);
    // 얼굴 뼈
    this.updateFace(t);
    this.dirty = true;
    this.skDirty = true; // 다음에 그릴 때 행렬·뼈 텍스처를 다시 올림
  }

  updateLegs(st, c) {
    const B = this.bones, Bn = BONE, h = this.h;
    const kn = smooth01(this.s.kneel), sl = smooth01(this.s.slump);
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s);
      // 발 목표 (루트 기준): 앉음 = 의자 앞 바닥, 서 있음 = 엉덩이 아래
      const stepK = c.step ? Math.max(0, Math.sin(NOW.t * 6 + (s === 'L' ? 0 : Math.PI))) * 0.05 * c.step : 0;
      const fx = sx * lerp(0.13, 0.11, st) * this.w;
      let fz = lerp(this.feetFwd, 0.0, st);
      let fy = this.P.ankle + this.s.jumpY * (st > 0.8 ? 0.8 : 0) + stepK;
      if (kn > 0.001) {
        fz = lerp(fz, -0.36 * h, kn);
        fy = lerp(fy, 0.06 * h, kn);
      }
      if (sl > 0.001) {
        fz = lerp(fz, 0.98, sl);
        fy = lerp(fy, 0.06 * h, sl);
      }
      const tgt = this.local(fx, fy, fz, _pv3);
      const pole = this.local(fx * 1.1, this.restW[Bn['shin' + s]].y + 0.3, 1.5, _pv4);
      this.ik2(Bn['thigh' + s], Bn['shin' + s], tgt, pole, this.P.thighLen, this.P.shinLen);
      // 발은 바닥과 평행 (정강이 행렬은 ik2가 방금 맞춰 둠)
      _pq2.setFromRotationMatrix(B[Bn['shin' + s]].matrixWorld).invert();
      _pq3.setFromRotationMatrix(this.root.matrixWorld);
      B[Bn['foot' + s]].quaternion.copy(_pq2.multiply(_pq3));
    }
  }
  updateArm(side, dt) {
    const A = this.arms[side],
      B = this.bones,
      Bn = BONE,
      sx = sideSign(side);
    const iu = Bn['upper' + side], iff = Bn['fore' + side], ih = Bn['hand' + side];
    // 손 모양
    const hp = HAND_POSE[A.hand] || HAND_POSE.relax, hc = this.handCur[side];
    for (let k = 0; k < 3; k++) hc[k] = damp(hc[k], hp[k], 14, dt);
    B[Bn['fing' + side]].rotation.set(0, 0, -sx * hc[0]);
    B[Bn['index' + side]].rotation.set(0, 0, -sx * hc[1]);
    B[Bn['thumb' + side]].rotation.set(hc[2] * 0.25, sx * hc[2] * 0.5, -sx * hc[2] * 0.7);
    let tgt;
    if (A.mode === 'ik') tgt = A.target;
    else {
      // 쉬는 자세: 앉았으면 허벅지 위, 서 있으면 옆구리
      const st = this.s.stand;
      tgt = this.local(sx * lerp(0.11, 0.2, st) * this.w, lerp(this.seatY + 0.17, 0.82 * this.h, st), lerp(0.25, 0.04, st), _pv5);
    }
    // 목표점 부드럽게 (갑자기 튀지 않게)
    if (!A.init) {
      A.cur.copy(tgt);
      A.init = true;
    }
    A.cur.lerp(tgt, 1 - Math.exp(-dt * (A.mode === 'ik' ? 22 : 8)));
    const pole = A.has ? A.pole : this.local(sx * 0.7, 0.9, -0.6, _pv4);
    this.ik2(iu, iff, A.cur, pole, this.P.upperLen, this.P.foreLen, true);
    if (A.q) {
      _pq2.setFromRotationMatrix(B[iff].matrixWorld).invert();
      B[ih].quaternion.copy(_pq2.multiply(_pq3.copy(A.q)));
    } else B[ih].rotation.set(0.15, 0, 0);
  }
  // 두 마디 IK: 뼈의 -y가 팔다리 방향
  // update() 안에서만 부름: 부모 뼈(엉덩이·쇄골)의 월드 행렬은 update 처음의 전체 갱신 때 맞춰진 값을 그대로 씀
  ik2(i1, i2, target, pole, L1, L2, arm = false) {
    const B = this.bones,
      b1 = B[i1],
      b2 = B[i2],
      K = _ik;
    const S = K.S.copy(b1.position).applyMatrix4(b1.parent.matrixWorld);
    const sc = this.root.scale.x || 1;
    L1 *= sc;
    L2 *= sc;
    const dv = K.dv.copy(target).sub(S);
    let d = dv.length();
    const dmin = Math.abs(L1 - L2) + 1e-3,
      dmax = L1 + L2 - 1e-3;
    d = clamp(d, dmin, dmax);
    const dir = dv.normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d),
      hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pp = K.pp.copy(pole).sub(S);
    pp.addScaledVector(dir, -pp.dot(dir));
    if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).addScaledVector(dir, -dir.z);
    pp.normalize();
    const E = K.E.copy(S).addScaledVector(dir, a).addScaledVector(pp, hh);
    const Tc = K.Tc.copy(S).addScaledVector(dir, d);
    // 굽힘 축
    const ax = K.ax.subVectors(E, S).cross(K.t.subVectors(Tc, E));
    if (ax.lengthSq() < 1e-10) ax.copy(dir).cross(pp);
    ax.normalize();
    if (arm) ax.negate();
    this.ikBone(b1, S, E, ax);
    b1.updateWorldMatrix(false, false);
    this.ikBone(b2, E, Tc, ax);
    b2.updateWorldMatrix(false, false);
  }
  ikBone(bone, from, to, ax) {
    const K = _ik,
      Y = K.Y.subVectors(from, to).normalize();
    const X = K.X.copy(ax).addScaledVector(Y, -ax.dot(Y)).normalize();
    const Z = K.Z.crossVectors(X, Y);
    K.qw.setFromRotationMatrix(K.m.makeBasis(X, Y, Z));
    // 부모 스케일 영향 없음 (스케일은 루트에만)
    K.qp.setFromRotationMatrix(bone.parent.matrixWorld);
    bone.quaternion.copy(K.qp.invert().multiply(K.qw));
  }
  updateFace(t) {
    const B = this.bones, Bn = BONE, f = this.face, R = this.R, hw = this.restW[Bn.head];
    const pop = clamp(f.pop, 0.9, 1.3);
    // 눈썹: 놀라면 이마 끝까지 치켜올라감, skew는 한쪽만
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s), b = B[Bn['brow' + s]], r0 = this.restW[Bn['brow' + s]];
      const up = f.brow + sx * f.skew * 0.6, low = sx * f.skew < 0;
      b.position.set(r0.x - hw.x, r0.y - hw.y + up * R * 0.12 + (pop - 1) * R * 0.5, r0.z - hw.z + (pop - 1) * R * 0.12);
      b.rotation.set(0, 0, -sx * (f.browIn - (low ? Math.abs(f.skew) * 0.9 : 0)) * 0.3);
    }
    // 눈꺼풀: lid -0.7(크게 뜸)~1(감음) + 깜빡임. 눈알이 커지면 꺼풀도 같이
    const lid = clamp(f.lid + this.blink * 1.3, -0.7, 1.05);
    const lidAng = lid < 0 ? -0.45 + lid * 0.52 : -0.45 + lid * 1.85;
    B[Bn.lidL].rotation.set(lidAng, 0, -0.08);
    B[Bn.lidR].rotation.set(lidAng, 0, 0.08);
    B[Bn.lidL].scale.setScalar(pop);
    B[Bn.lidR].scale.setScalar(pop);
    B[Bn.ballL].scale.setScalar(pop);
    B[Bn.ballR].scale.setScalar(pop);
    // 눈동자 (놀라면 콩알만 하게)
    const hb = B[Bn.head];
    hb.updateWorldMatrix(true, false);
    const ep = _pv1.setFromMatrixPosition(hb.matrixWorld);
    const d = _pv2.copy(this.c.look).sub(ep);
    _pq1.setFromRotationMatrix(hb.matrixWorld).invert();
    d.applyQuaternion(_pq1);
    let ey = clamp(Math.atan2(d.x, d.z), -0.5, 0.5), epc = clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.35, 0.3);
    // 동공지진: 기가 막힐 때 눈동자가 잘게 떨림
    const quake = clamp((0.8 - f.pupil) / 0.3, 0, 1);
    if (quake > 0.05) {
      ey += Math.sin(t * 47 + this.c.phase * 9) * Math.sin(t * 13.3) * 0.075 * quake;
      epc += Math.sin(t * 39 + this.c.phase * 5) * 0.03 * quake;
    }
    const ps = pop * clamp(f.pupil, 0.4, 1.1);
    for (const s of PERSON_SIDES) {
      const eb = B[Bn['eye' + s]];
      eb.rotation.set(epc, ey, 0);
      eb.scale.set(ps, ps, pop);
    }
    // 입: 윗입술 자리는 그대로 두고 아래로 벌어짐 (턱이 같이 떨어짐)
    const mp = this.mouthP, open = clamp(f.open, 0, 2), wd = f.width, sm = f.smile;
    const sy = 0.12 + open, hh0 = R * 0.16 * 0.12, hh = R * 0.16 * sy, drop = hh - hh0, cy = mp.y - drop;
    const tilt = 0.1 + drop / R * 0.55; // 크게 벌릴수록 아랫입술이 얼굴 곡면을 따라 뒤로
    const mb = B[Bn.mouth];
    mb.position.set(0, cy, mp.z + drop * 0.06);
    mb.rotation.set(tilt - 0.1, 0, 0);
    mb.scale.set(1 + wd * 0.35, sy, 1);
    for (const s of PERSON_SIDES) {
      const sx = sideSign(s), cb = B[Bn['corner' + s]];
      cb.position.set(sx * mp.w * (1 + wd * 0.45 - open * 0.07), cy + sm * R * 0.11, mp.z - R * 0.04 - drop * 0.12);
      cb.scale.set(1, 0.25 + open * 0.55, 1);
    }
    // 입 안 어둠: 벌릴 때만 펼쳐짐
    const gate = smoothstep(0.1, 0.42, open) + 1e-4;
    B[Bn.mouthIn].scale.set(1, gate, 1);
    B[Bn.cornerInL].scale.set(1, gate, 1);
    B[Bn.cornerInR].scale.set(1, gate, 1);
    // 윗니는 입천장에, 혀는 아랫입술 쪽에
    const tk = smoothstep(0.16, 0.5, open) + 1e-4,
      inH = hh * 0.8 * gate,
      sinT = Math.sin(tilt - 0.1);
    const tb = B[Bn.teeth],
      tg = B[Bn.tongue],
      wx = 1 + wd * 0.3;
    tb.position.set(0, cy + inH - R * 0.05 * tk * 0.9, mp.z + drop * 0.06 + inH * sinT);
    tb.scale.set(wx * tk, tk, tk);
    const tgk = smoothstep(0.35, 0.9, open) + 1e-4;
    tg.position.set(0, cy - inH + R * 0.075 * tgk * 0.75, mp.z + drop * 0.06 - inH * sinT);
    tg.scale.set(wx * tgk, tgk, tgk);
    // 턱: 아랫입술을 따라 내려감
    const jr = this.restW[Bn.jaw], jd = drop * 2 * 0.82;
    B[Bn.jaw].position.set(jr.x - hw.x, jr.y - hw.y - jd, jr.z - hw.z - jd * 0.18);
    B[Bn.jaw].rotation.set(open * 0.08, 0, 0);
  }
}