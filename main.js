import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import TUNES from './js/data/tunes.js';
import { STYLE, BONE, NOW, PEOPLE } from './js/data/data.js';
import { FACES, FACE_DEF, PEOPLE_MAT, SHOCK_FACES } from './js/data/faces.js';
import { AUTO, AUTO_LOOK } from './js/data/auto.js';
import { PC, QUAL } from "./js/data/harmony.js";
import { Soloist } from './js/audio/soloist.js';
import SusVoice from './js/audio/susvoice.js';
import { Improviser } from './js/audio/improviser.js';
import { stopBandVoices, trackBandVoice } from './js/audio/BandVoice.js';
import { latheY } from './js/utils/GeomUtils.js';
import { clamp, smooth01, lerp, rateFor, damp, mod12, smoothstep, dampAngle } from './js/utils/Math.js';
import { seeded, rand, pick, randi, shuffle } from './js/utils/Random.js';
import { levelFor, dynGain, dynCut, chordAt } from './js/utils/Sound.js';
import { parseChord, parseForm, inSet, isChordTone, isGuide, nearestAllowed, nearestPC, stepAllowed } from './js/utils/Harmony.js';
import { Person, PERSON_SIDES } from './js/objects/person.js';
import { M4, V3 } from './js/utils/Vector.js';

// ===== 05_style.js =====
// ===================== 그림체: 셀 셰이딩 + 잉크 외곽선 =====================
// 모든 장면 요소는 이 파일의 재질·도우미만 써서 같은 그림체를 유지한다.
// - 사람·가구·벽: toonMat / toonVC (단계 음영)
// - 금속(놋쇠·크롬·심벌): metalMat (환경 반사) — 외곽선은 똑같이 붙음
// - 외곽선: OutlineEffect가 재질의 userData.outlineParameters를 읽음 (outline() 도우미)
function makeGradient(stops) {
  const n = stops.length, data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(clamp(stops[i], 0, 1) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// 금속이 반사할 가게 조명 (따뜻한 천장등, 창문 하늘, 색 무대 조명)
function buildStyleEnv(renderer) {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    vertexColors: true
  }));
  const pos = room.geometry.attributes.position,
    col = new Float32Array(pos.count * 3),
    c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 20;
    if (y > 0.35) c.set('#fff6e6').multiplyScalar(1.0);
    else if (y > 0.0) c.set('#ffe0b0').multiplyScalar(0.95);
    else if (y > -0.3) c.set('#d79a5e').multiplyScalar(0.7);
    else c.set('#6a3a1e').multiplyScalar(0.55);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  room.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  s.add(room);
  const panel = (w, h, color, k, p, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(k),
      side: THREE.DoubleSide
    }));
    m.position.set(...p);
    m.lookAt(...look);
    s.add(m);
  };
  panel(10, 3, '#ffffff', 6, [0, 15, 0], [0, 0, 0]); // 천장 조명
  panel(6, 6, '#bfe3ff', 3.2, [-17, 4, -2], [0, 2, 0]); // 왼쪽 창 하늘
  panel(6, 6, '#ffd9a0', 4, [17, 5, 3], [0, 2, 0]); // 오른쪽 노을빛
  panel(3, 3, '#ff6aa0', 5, [6, 10, -12], [0, 0, 0]); // 분홍 무대등
  panel(3, 3, '#6aa8ff', 5, [-8, 9, 10], [0, 0, 0]); // 파란 무대등
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.02);
  pm.dispose();
  return rt.texture;
}

function initStyle(renderer) {
  if (STYLE.ready) return;
  STYLE.env = buildStyleEnv(renderer); // 기본: 그림자 쪽도 너무 어둡지 않게, 밝은 쪽은 또렷하게
  STYLE.grad = makeGradient([0.34, 0.34, 0.58, 1.0, 1.0, 1.0]);
  STYLE.gradSoft = makeGradient([0.55, 0.75, 0.75, 1.0, 1.0, 1.0]);
  STYLE.ready = true;
}

// 외곽선 설정 (thickness는 화면 기준, 0이면 외곽선 없음)
function outline(mat, thickness = 0.006, color = STYLE.outlineColor) {
  mat.userData.outlineParameters = {
    thickness: thickness || 0.0001,
    color,
    alpha: 1,
    visible: thickness > 0,
    keepAlive: true
  };
  return mat;
}

function toonMat(color, o = {}) {
  const m = new THREE.MeshToonMaterial({
    color: new THREE.Color(color),
    gradientMap: o.soft ? STYLE.gradSoft : STYLE.grad,
    side: o.side || THREE.FrontSide,
    map: o.map || null,
    transparent: !!o.transparent,
    opacity: o.opacity == null ? 1 : o.opacity
  });
  if (o.emissive) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity == null ? 1 : o.emissiveIntensity;
  }
  return outline(m, o.outline == null ? 0.006 : o.outline);
}

function toonVC(o = {}) {
  const m = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: o.soft ? STYLE.gradSoft : STYLE.grad,
    side: o.side || THREE.FrontSide
  });
  if (o.emissive) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity == null ? 1 : o.emissiveIntensity;
  }
  return outline(m, o.outline == null ? 0.006 : o.outline);
}
// 금속: 나팔 안쪽까지 보이도록 기본 양면
function metalMat(color, rough = 0.22, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 1,
    roughness: rough,
    envMap: STYLE.env,
    envMapIntensity: o.env == null ? 1.35 : o.env,
    side: o.side || THREE.DoubleSide,
    vertexColors: !!o.vc
  });
  return outline(m, o.outline == null ? 0.005 : o.outline);
}
// 광택 있는 비금속 (피아노 검정, 래커칠 나무)
function glossMat(color, rough = 0.18, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0,
    roughness: rough,
    envMap: STYLE.env,
    envMapIntensity: o.env == null ? 0.9 : o.env,
    side: o.side || THREE.FrontSide,
    vertexColors: !!o.vc
  });
  return outline(m, o.outline == null ? 0.006 : o.outline);
}

function basicMat(color, o = {}) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: !!o.transparent,
    opacity: o.opacity == null ? 1 : o.opacity,
    side: o.side || THREE.FrontSide,
    depthWrite: o.depthWrite == null ? true : o.depthWrite,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    map: o.map || null,
    vertexColors: !!o.vc,
    fog: o.fog == null ? true : o.fog
  });
  return outline(m, o.outline || 0);
}

// 꼭짓점 색을 입힌 복제본 (병합용). uv는 지움
function vcol(geo, color, m) {
  let g = geo.index ? geo.toNonIndexed() : new THREE.BufferGeometry().copy(geo);
  if (m) g.applyMatrix4(m);
  for (const k of Object.keys(g.attributes))
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const c = color instanceof THREE.Color ? color : new THREE.Color(color),
    n = g.attributes.position.count,
    a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function mergeVC(list) {
  return mergeGeometries(list, false);
}
// 모서리 둥근 상자 (가운데 원점)
const RBOX = new Map();

function rbox(w, h, d, r = 0.02, seg = 3) {
  const key = w + '|' + h + '|' + d + '|' + r + '|' + seg;
  let m = RBOX.get(key);
  if (!m) {
    m = rboxMake(w, h, d, r, seg);
    RBOX.set(key, m);
  }
  return new THREE.BufferGeometry().copy(m);
}

function rboxMake(w, h, d, r, seg) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const s = new THREE.Shape(),
    x = -w / 2,
    y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const bv = Math.min(r, d / 3);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, d - 2 * bv),
    bevelEnabled: true,
    bevelThickness: bv,
    bevelSize: bv * 0.9,
    bevelSegments: seg,
    curveSegments: 5
  });
  g.translate(0, 0, -(d - 2 * bv) / 2);
  return g;
}

function tubeAlong(points, r, seg = 40, rs = 10, closed = false) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => V3(p[0], p[1], p[2])), closed, 'catmullrom', 0.2), seg, r, rs, closed);
}
// 빛 번짐 스프라이트 (전구·조명 머리)
let _glowTex = null;

function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'),
    gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, 'rgba(255,255,255,0.75)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

function canvasTex(w, h, draw, rep) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (rep) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
  }
  return t;
}
// 비어 있는 기준점 (손 위치·연주 지점 등)
function anchor(parent, name, x = 0, y = 0, z = 0) {
  const g = new THREE.Object3D();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ===== 06_layout.js =====
// ===================== 무대 배치 (미터, y 위) =====================
// 관객은 -z 쪽. 나는 무대 맨 뒤 단 위에서 관객 쪽(-z)을 본다.
// yaw: 사람·악기가 바라보는 방향. 0 = +z, PI = -z(관객 쪽)
const LAYOUT = {
  stageY: 0.45, // 무대 바닥 높이
  stage: {
    x0: -4.8,
    x1: 4.8,
    zFront: -3.9,
    zBack: 2.0
  },
  riser: {
    x: 0,
    z: 1.0,
    w: 1.8,
    d: 1.4,
    h: 0.42
  }, // 내 단 (무대 위에 한 단 더)
  eye: [0, 0.45 + 0.42 + 1.62, 1.05], // 내 눈 (카메라)
  look: [0, 1.15, -9.5], // 기본 시선
  room: {
    x0: -7.6,
    x1: 7.6,
    zFront: -15.2,
    zBack: 2.4,
    h: 4.8
  },
  // 밴드 (발 위치). 실제 값은 화면 보며 조정할 수 있음
  band: {
    dr: {
      pos: [-1.75, 0.45, -1.75],
      yaw: 2.2
    }, // 드럼 의자 위치, 무대 가운데 앞쪽을 비스듬히 봄
    bs: {
      pos: [-1.05, 0.45, -3.0],
      yaw: 2.75
    }, // 베이스 주자
    tb: {
      pos: [1.05, 0.45, -3.25],
      yaw: -2.9
    }, // 트롬본 (리더)
    pn: {
      pos: [2.15, 0.45, -1.55],
      yaw: -0.3
    }, // 피아노 의자: 피아니스트는 무대 뒤(나) 쪽을 봄, 피아노 몸통은 오른쪽 뒤로
  },
  // 관객 구역 (바닥 y=0)
  crowd: {
    standZ: [-4.5, -6.6],
    standX: [-5.2, 5.2], // 무대 앞에 서서 보는 사람들
    tableZ: [-7.4, -12.2],
    tableX: [-6.2, 6.2], // 테이블 손님
    barZ: -13.9, // 바 카운터 앞
  },
};

// ===== 10_audio.js =====
// ===================== 소리 엔진 =====================
const AE = {
  ctx: null,
  ready: false,
  decoded: false,
  buses: {},
  sets: {},
  syn: {},
  noise: null,
  master: null,
  startedAt: 0
};

function makeIR(ctx, dur, decay, pre = 0.012) {
  const sr = ctx.sampleRate,
    n = Math.floor(sr * dur),
    b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (t < pre) {
        d[i] = 0;
        continue;
      }
      const e = Math.pow(1 - (t - pre) / (dur - pre), decay);
      const w = Math.random() * 2 - 1;
      // 시간이 갈수록 어두워지는 잔향
      const k = 0.18 + 0.75 * Math.exp(-(t - pre) * 2.2);
      lp += (w - lp) * k;
      d[i] = lp * e * (t < pre + 0.004 ? (t - pre) / 0.004 : 1);
    }
    // 초기 반사 몇 개
    for (let r = 0; r < 7; r++) {
      const idx = Math.floor((pre + rand(0.004, 0.035)) * sr);
      if (idx < n) d[idx] += rand(-0.6, 0.6);
    }
  }
  return b;
}

// ----- 간단한 바이쿼드 (버퍼 합성용) -----
function biquadCoef(type, f, Q, sr, gainDb = 0) {
  const w = 2 * Math.PI * f / sr,
    cs = Math.cos(w),
    sn = Math.sin(w),
    al = sn / (2 * Q),
    A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = (1 - cs) / 2;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else if (type === 'hp') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = (1 + cs) / 2;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else if (type === 'bp') {
    b0 = al;
    b1 = 0;
    b2 = -al;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else {
    b0 = 1 + al * A;
    b1 = -2 * cs;
    b2 = 1 - al * A;
    a0 = 1 + al / A;
    a1 = -2 * cs;
    a2 = 1 - al / A;
  } // peak
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function filt(x, type, f, Q, sr, g) {
  const [b0, b1, b2, a1, a2] = biquadCoef(type, f, Q, sr, g);
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

function noiseArr(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

function toBuf(ctx, arr, peak = 0.9, arr2 = null) {
  let m = 0;
  for (const v of arr) m = Math.max(m, Math.abs(v));
  if (arr2)
    for (const v of arr2) m = Math.max(m, Math.abs(v));
  const g = m > 0 ? peak / m : 1,
    b = ctx.createBuffer(arr2 ? 2 : 1, arr.length, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < arr.length; i++) d[i] = arr[i] * g;
  if (arr2) {
    const e = b.getChannelData(1);
    for (let i = 0; i < arr2.length; i++) e[i] = arr2[i] * g;
  }
  return b;
}

// ----- 합성 효과음 -----
function synthKick(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.42 * sr),
    x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr,
      f = 46 + 70 * Math.exp(-t * 32);
    ph += 2 * Math.PI * f / sr;
    x[i] = Math.sin(ph) * Math.exp(-t * 9) + (i < sr * 0.004 ? (Math.random() * 2 - 1) * 0.25 * (1 - i / (sr * 0.004)) : 0);
  }
  return toBuf(ctx, filt(x, 'lp', 900, 0.7, sr), 0.9);
}

function synthHat(ctx, open = false) {
  const sr = ctx.sampleRate, n = Math.floor((open ? 0.5 : 0.09) * sr);
  let x = noiseArr(n);
  // 금속성: 고주파 사각파 몇 개 섞기
  const fs = [3270, 4710, 5550, 6790, 8410, 9960];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of fs) s += Math.sign(Math.sin(2 * Math.PI * f * i / sr));
    x[i] = x[i] * 0.6 + s * 0.08;
  }
  x = filt(filt(x, 'hp', 6500, 0.7, sr), 'peak', 9000, 1.2, sr, 6);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] *= Math.exp(-t * (open ? 7 : 55)) * (t < 0.0015 ? t / 0.0015 : 1);
  }
  return toBuf(ctx, x, 0.85);
}

function synthBrushSweep(ctx) {
  // 원을 그리는 브러시: 부드럽게 커졌다 줄어드는 두 번의 봉우리
  const sr = ctx.sampleRate,
    n = Math.floor(0.48 * sr);
  let x = noiseArr(n);
  x = filt(filt(x, 'bp', 3200, 0.55, sr), 'hp', 900, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = Math.sin(Math.PI * clamp(t / 0.46, 0, 1)) ** 1.6 * (0.75 + 0.25 * Math.sin(2 * Math.PI * t / 0.46 * 2 - 1));
    x[i] *= e;
  }
  return toBuf(ctx, x, 0.7);
}

function synthBrushTap(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.22 * sr);
  let nz = filt(noiseArr(n), 'bp', 2600, 0.6, sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = nz[i] * Math.exp(-t * 28) + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.35;
  }
  return toBuf(ctx, x, 0.8);
}

function synthTom(ctx, f0) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.6 * sr),
    x = new Float32Array(n),
    nz = filt(noiseArr(n), 'bp', 1800, 0.8, sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr,
      f = f0 * (1 + 0.35 * Math.exp(-t * 25));
    ph += 2 * Math.PI * f / sr;
    x[i] = Math.sin(ph) * Math.exp(-t * 7) + nz[i] * Math.exp(-t * 45) * 0.4;
  }
  return toBuf(ctx, x, 0.85);
}

function synthStickClick(ctx) {
  const sr = ctx.sampleRate, n = Math.floor(0.12 * sr);
  let x = noiseArr(n);
  x = filt(filt(x, 'bp', 2400, 3, sr), 'peak', 1150, 6, sr, 10);
  for (let i = 0; i < n; i++) x[i] *= Math.exp(-i / sr * 60);
  return toBuf(ctx, x, 0.85);
}

function synthClap(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.14 * sr),
    x = new Float32Array(n);
  const bursts = [[0, 1], [rand(0.002, 0.005), rand(0.5, 0.8)], [rand(0.007, 0.012), rand(0.25, 0.45)]];
  const nz = noiseArr(n);
  for (const [o, a] of bursts) {
    const s = Math.floor(o * sr);
    for (let i = s; i < n; i++) x[i] += nz[i] * a * Math.exp(-(i - s) / sr * 70);
  }
  return toBuf(ctx, filt(filt(x, 'bp', rand(1100, 1700), 0.9, sr), 'hp', 400, 0.7, sr), 0.9);
}

function synthSnap(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.07 * sr);
  let x = noiseArr(n);
  x = filt(filt(x, 'bp', rand(2300, 3100), 2.5, sr), 'peak', 1200, 3, sr, 8);
  for (let i = 0; i < n; i++) x[i] *= Math.exp(-i / sr * 95);
  return toBuf(ctx, x, 0.9);
}

function synthClink(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.9 * sr),
    x = new Float32Array(n);
  const base = rand(2600, 3600),
    fs = [1, 2.32, 3.7, 5.1].map(k => base * k);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    fs.forEach((f, j) => s += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (6 + j * 5)) / (j + 1));
    x[i] = s;
  }
  return toBuf(ctx, x, 0.5);
}

function synthShake(ctx) {
  // 칵테일 셰이커 한 번 흔들기 (얼음 부딪힘)
  const sr = ctx.sampleRate,
    n = Math.floor(0.28 * sr),
    x = new Float32Array(n);
  for (let k = 0; k < 26; k++) {
    const s = Math.floor(rand(0, 0.22) * sr),
      f = rand(2500, 6000),
      d = rand(0.006, 0.02);
    for (let i = s; i < Math.min(n, s + d * sr * 4); i++) {
      const t = (i - s) / sr;
      x[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t / d) * rand(0.3, 1);
    }
  }
  const nz = filt(noiseArr(n), 'bp', 5000, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = x[i] * 0.8 + nz[i] * 0.3 * Math.sin(Math.PI * clamp(t / 0.26, 0, 1));
  }
  return toBuf(ctx, x, 0.6);
}

function synthTableSlap(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(0.3 * sr),
    x = new Float32Array(n),
    nz = filt(noiseArr(n), 'lp', 1400, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = Math.sin(2 * Math.PI * 105 * t) * Math.exp(-t * 18) + nz[i] * Math.exp(-t * 40) * 0.7;
  }
  return toBuf(ctx, x, 0.85);
}
// 관중 박수 바탕 (스테레오, 길게) — density: 1초당 박수 수
function synthApplause(ctx, dur, density) {
  const sr = ctx.sampleRate,
    n = Math.floor(dur * sr),
    L = new Float32Array(n),
    R = new Float32Array(n);
  const clapN = Math.floor(0.12 * sr),
    nz = noiseArr(clapN * 8);
  const people = Math.floor(density / 4.5),
    one = new Float64Array(clapN);
  for (let p = 0; p < people; p++) {
    const rate = rand(3.6, 5.6),
      pan = rand(-1, 1),
      gl = Math.sqrt((1 - pan) / 2),
      gr = Math.sqrt((1 + pan) / 2),
      amp = rand(0.35, 1);
    const fc = rand(900, 2400),
      off = Math.floor(rand(0, clapN * 7));
    // 이 사람의 박수 한 번: 치는 내내 같은 소리라 한 번만 계산해 두고 되풀이해 얹음 (전에는 칠 때마다 표본마다 exp를 다시 계산)
    for (let i = 0; i < clapN; i++) one[i] = nz[off + i] * Math.exp(-i / sr * (60 + fc / 40)) * amp;
    let t = rand(0, 0.3);
    while (t < dur) {
      const s = Math.floor(t * sr),
        m = Math.min(clapN, n - s);
      for (let i = 0; i < m; i++) {
        const v = one[i];
        L[s + i] += v * gl;
        R[s + i] += v * gr;
      }
      t += (1 / rate) * rand(0.92, 1.08);
    }
  }
  const fL = filt(filt(L, 'bp', 1500, 0.5, sr), 'hp', 300, 0.7, sr),
    fR = filt(filt(R, 'bp', 1500, 0.5, sr), 'hp', 300, 0.7, sr);
  // 고리 처리를 위해 앞뒤 0.3초 교차
  const xf = Math.floor(0.3 * sr);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    fL[i] = fL[i] * a + fL[n - xf + i] * (1 - a);
    fR[i] = fR[i] * a + fR[n - xf + i] * (1 - a);
  }
  return toBuf(ctx, fL.subarray(0, n - xf), 0.8, fR.subarray(0, n - xf));
}

function synthRoomTone(ctx) {
  const sr = ctx.sampleRate,
    n = Math.floor(6 * sr);
  let a = noiseArr(n),
    b = noiseArr(n);
  a = filt(filt(a, 'lp', 500, 0.5, sr), 'hp', 60, 0.7, sr);
  b = filt(filt(b, 'lp', 520, 0.5, sr), 'hp', 60, 0.7, sr);
  const xf = Math.floor(0.5 * sr);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    a[i] = a[i] * k + a[n - xf + i] * (1 - k);
    b[i] = b[i] * k + b[n - xf + i] * (1 - k);
  }
  return toBuf(ctx, a.subarray(0, n - xf), 0.5, b.subarray(0, n - xf));
}

function b64ToAB(s) {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function decodeAB(ctx, ab) {
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });
}

function createAudio() {
  if (AE.ctx) return AE.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  AE.ctx = ctx;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16;
  glue.knee.value = 10;
  glue.ratio.value = 2.6;
  glue.attack.value = 0.012;
  glue.release.value = 0.22;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -2.5;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.002;
  lim.release.value = 0.12;
  glue.connect(master);
  master.connect(lim);
  lim.connect(ctx.destination);
  AE.master = master;
  AE.glue = glue;
  AE.lim = lim;
  const rev = ctx.createConvolver(); // 잔향 버퍼는 합성 묶음에서 만들어 decodePack 끝에 끼움
  const revOut = ctx.createGain();
  revOut.gain.value = 0.8;
  rev.connect(revOut);
  revOut.connect(glue);
  AE.rev = rev;
  const bus = (gain, send, pan = 0) => {
    const g = ctx.createGain();
    g.gain.value = gain;
    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    tail.connect(glue);
    const s = ctx.createGain();
    s.gain.value = send;
    tail.connect(s);
    s.connect(rev);
    g.send = s;
    return g;
  };
  AE.buses = {
    tp: bus(1.0, 0.24, 0),
    tbn: bus(0.62, 0.26, 0.22),
    pno: bus(0.5, 0.2, -0.32),
    pnoSolo: bus(0.5, 0.2, -0.32),
    bass: bus(0.95, 0.08, 0.16),
    drums: bus(0.6, 0.13, 0),
    crowd: bus(0.55, 0.3, 0),
    cheer: bus(0.5, 0.42, 0),
    room: bus(0.4, 0.12, 0),
  };
  return ctx;
}

// ---------- 합성 소리 묶음 ----------
// 전에는 샘플을 다 푼 뒤 본 화면에서 한꺼번에 만들어서, 그동안(느린 폰은 몇 초) 화면이 멈춰 있었음.
// 이제는 맨 처음에 워커로 보냄. 합성 함수들은 ctx에서 sampleRate와 createBuffer만 쓰므로 글자 그대로 워커로 옮길 수 있음.
const SYNTH_STEPS = [
  ['ir', c => makeIR(c, 1.9, 3.4)],
  ['kick', c => synthKick(c)],
  ['hat', c => synthHat(c)],
  ['hatOpen', c => synthHat(c, true)],
  ['brush', c => synthBrushSweep(c)],
  ['btap', c => synthBrushTap(c)],
  ['tomHi', c => synthTom(c, 175)],
  ['tomLo', c => synthTom(c, 105)],
  ['stick', c => synthStickClick(c)],
  ['claps', c => [0, 1, 2, 3, 4].map(() => synthClap(c))],
  ['snaps', c => [0, 1, 2].map(() => synthSnap(c))],
  ['clinks', c => [0, 1, 2].map(() => synthClink(c))],
  ['shaker', c => synthShake(c)],
  ['slap', c => synthTableSlap(c)],
  ['applause', c => synthApplause(c, 6.3, 160)],
  ['applauseBig', c => synthApplause(c, 7.1, 420)],
  ['roar', c => synthRoar(c, 6.5)],
  ['stomp', c => synthStomp(c)],
  ['room', c => synthRoomTone(c)],
  ['babble', c => synthBabble(c, 7.5)],
];

function synthWorkerSrc() {
  const C = { rand, randi, pick, clamp, lerp };
  const F = [makeIR, biquadCoef, filt, noiseArr, toBuf, synthKick, synthHat, synthBrushSweep, synthBrushTap, synthTom, synthStickClick, synthClap, synthSnap, synthClink, synthShake, synthTableSlap, synthApplause, synthRoomTone, synthRoar, synthStomp, synthBabble];
  return Object.keys(C).map(k => 'const ' + k + ' = ' + C[k].toString() + ';').join('\n') + '\n' + F.map(f => f.toString()).join('\n') + '\n' +
    'const SYNTH_STEPS = [' + SYNTH_STEPS.map(s => '[' + JSON.stringify(s[0]) + ', ' + s[1].toString() + ']').join(', ') + '];\n' +
    'onmessage = e => { postMessage(1); const sr = e.data.sr; const ctx = { sampleRate: sr, createBuffer: (n, len) => { const ch = []; for (let i = 0; i < n; i++) ch.push(new Float32Array(len)); return { ch, getChannelData: c => ch[c] }; } };' +
    ' const out = {}, tr = []; const pack = b => { for (const c of b.ch) tr.push(c.buffer); return { ch: b.ch }; };' +
    ' for (const s of SYNTH_STEPS) { const r = s[1](ctx); out[s[0]] = Array.isArray(r) ? r.map(pack) : pack(r); }' +
    ' postMessage(out, tr); };';
}
// onStart: 합성이 실제로 돌기 시작했을 때(워커가 떴을 때, 또는 워커를 못 써서 본 화면에서 만들기로 했을 때) 한 번 부름
async function synthBegin(onStart) {
  if (AE.synP) {
    if (onStart) onStart();
    return AE.synP;
  }
  const ctx = createAudio(), sr = ctx.sampleRate;
  (AE.at || (AE.at = {})).syn0 = performance.now();
  const started = () => {
    const f = onStart;
    onStart = null;
    if (f) f();
  };
  const real = o => {
    const b = ctx.createBuffer(o.ch.length, o.ch[0].length, sr);
    for (let i = 0; i < o.ch.length; i++) b.getChannelData(i).set(o.ch[i]);
    return b;
  };
  // 워커를 못 쓸 때: 본 화면에서 만들되 하나 만들 때마다 화면이 숨 돌릴 틈을 줌 (무대 만들기가 먼저 끼어듦)
  const local = async () => {
    started();
    const S = {};
    for (const s of SYNTH_STEPS) {
      await new Promise(r => setTimeout(r, 0));
      S[s[0]] = s[1](ctx);
    }
    AE.at.syn = performance.now();
    return S;
  };
  AE.synP = new Promise(resolve => {
    let done = false,
      alive = false,
      w = null,
      timer = 0;
    const fallback = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (w) w.terminate();
      } catch { }
      local().then(resolve);
    };
    // 무대를 다 만들고 4초가 지나도록 워커가 뜨지도 않았으면(소식 없음) 기다리지 않고 본 화면에서 만듦
    AE.synWatch = () => setTimeout(() => {
      if (!alive) fallback();
    }, 4000);
    try {
      w = new Worker(URL.createObjectURL(new Blob([synthWorkerSrc()], { type: 'text/javascript' })));
      w.onmessage = e => {
        if (e.data === 1) {
          alive = true;
          started();
          return;
        }
        if (done) return;
        done = true;
        clearTimeout(timer);
        const S = {};
        for (const k in e.data) S[k] = Array.isArray(e.data[k]) ? e.data[k].map(real) : real(e.data[k]);
        AE.synWorker = true;
        AE.at.syn = performance.now();
        w.terminate();
        resolve(S);
      };
      w.onerror = e => {
        if (e && e.preventDefault) e.preventDefault();
        fallback();
      };
      timer = setTimeout(fallback, 45000);
      w.postMessage({ sr });
    } catch { fallback(); }
  });
  return AE.synP;
}
// ---------- 샘플 풀기: 한 번만 시작하고, 진행률은 나중에 화면이 붙음 ----------
const PACK = {
  p: null,
  f: 0,
  on: null
};

function packBegin() {
  if (!PACK.p) {
    PACK.p = decodePack(f => {
      PACK.f = f;
      if (PACK.on) PACK.on(f);
    });
    PACK.p.catch(() => { });
  }
  return PACK.p;
}
// 트럼펫 지속음 녹음의 음정 보정값(센트). 고리 구간의 실제 음높이를 재서 평균율 기준으로 맞춤.
const T_TUNE = {
  T57: 2.6,
  T60: 3.0,
  T67: -3.1,
  T70: -1.8,
  T74: -0.8,
  T81: -4.6,
  T84: 1.9,
  T85: 11.4,
  T88: -11.8
};

async function decodePack(onProgress) {
  const ctx = createAudio(), P = window.JAZZ_AUDIO;
  if (!P) throw new Error('소리 묶음을 못 불러왔습니다');
  const keys = Object.keys(P.meta);
  let done = 0;
  const sets = {};
  const worker = async (key) => {
    const meta = P.meta[key];
    const buf = await decodeAB(ctx, b64ToAB(P.data[key]));
    const sr = buf.sampleRate, d0 = buf.getChannelData(0), lim = Math.min(d0.length, Math.floor(0.06 * sr));
    let pk = 0, pi = 0;
    for (let i = 0; i < lim; i++) {
      const a = Math.abs(d0[i]);
      if (a > pk) {
        pk = a;
        pi = i;
      }
    }
    const onS = pi + Math.round(meta.on * sr);
    const clearTo = Math.max(0, onS - Math.round(0.0025 * sr));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < clearTo; i++) d[i] = 0;
    }
    const s = { key, buf, m: meta.m, c: (meta.c || 0) + (T_TUNE[key] || 0), start: clearTo / sr, on: onS / sr };
    if (meta.ls != null) {
      s.ls = onS / sr + meta.ls;
      s.le = onS / sr + meta.le;
    }
    const m = key.match(/^([A-Z])(\d+)(?:r(\d))?$/);
    if (m) {
      const set = m[1];
      (sets[set] = sets[set] || []).push(s);
      s.rr = m[3] ? +m[3] : 0;
    } else if (key.startsWith('V_')) {
      (AE.voiceClips = AE.voiceClips || []).push(s);
    } else if (key[0] === 'D') {
      sets.D = sets.D || {};
      sets.D[key.slice(1)] = s;
    }
    done++;
    onProgress && onProgress(done / keys.length);
  };
  // 전부 한꺼번에 맡김: 푸는 일 자체는 브라우저가 다른 스레드에서 하므로 무대를 만드는 동안 같이 진행됨
  await Promise.all(keys.map(worker));
  for (const k in sets) if (Array.isArray(sets[k])) sets[k].sort((a, b) => a.m - b.m || a.rr - b.rr);
  AE.sets = sets;
  (AE.at || (AE.at = {})).sets = performance.now(); // 불러오기 시각 기록 (점검용)
  // 합성 소리·잔향 (맨 처음부터 따로 만들고 있던 것을 여기서 받음)
  Object.assign(AE.syn, await synthBegin());
  AE.rev.buffer = AE.syn.ir;
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  AE.noise = nb;
  await prepareCrowdFx();
  AE.decoded = true;
}

function nearestSample(set, midi, rr = 0) {
  const arr = AE.sets[set];
  if (!arr || !arr.length) return null;
  let best = null, bd = 1e9;
  for (const s of arr) {
    if (rr && s.rr && s.rr !== rr) continue;
    const d = Math.abs(s.m - midi) + (s.m < midi ? 0.01 : 0);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

// 한 번 치는 소리
function playOne(sample, midi, when, vel, dest, o = {}) {
  if (!sample) return null;
  const ctx = AE.ctx,
    src = ctx.createBufferSource();
  src.buffer = sample.buf;
  src.playbackRate.value = midi == null ? (o.rate || 1) : rateFor(sample, midi, o.cents || 0);
  const g = ctx.createGain();
  g.gain.value = 0;
  const a = o.attack || 0.003;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(vel, when + a);
  let tail = src;
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lp;
    f.Q.value = 0.5;
    src.connect(f);
    tail = f;
  }
  tail.connect(g);
  let out = g;
  if (o.pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    g.connect(p);
    out = p;
  }
  out.connect(dest);
  trackBandVoice(ctx, src, g, dest);
  const offset = (sample.start || 0) + (o.offset || 0);
  if (o.dur != null) {
    const rel = o.release || 0.08,
      end = when + Math.max(o.dur, a + 0.01);
    g.gain.setValueAtTime(vel, end);
    g.gain.setTargetAtTime(0, end, rel / 3);
    src.start(when, offset);
    src.stop(end + rel * 2.5 + 0.05);
  } else src.start(when, offset);
  src.onended = () => {
    src.disconnect();
    if (tail !== src) tail.disconnect();
    g.disconnect();
    if (out !== g) out.disconnect();
  };
  return { src, g };
}

function playBuf(buf, when, vel, dest, o = {}) {
  const ctx = AE.ctx, src = ctx.createBufferSource();
  src.buffer = buf;
  if (o.rate) src.playbackRate.value = o.rate;
  const g = ctx.createGain();
  g.gain.value = vel;
  src.connect(g);
  let out = g;
  if ((o.pan || o.centerPan) && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(o.pan, -1, 1);
    g.connect(p);
    out = p;
  }
  out.connect(dest);
  trackBandVoice(ctx, src, g, dest);
  src.start(when, o.offset || 0);
  src.onended = () => {
    src.disconnect();
    g.disconnect();
    if (out !== g) out.disconnect();
  };
  return { src, g };
}

// 소리 하나를 지금 바로 짧게 끊음 (놓아준 뒤 꼬리가 남아 있어도)
function cutVoice(v, when, fade = 0.012) {
  if (!v || v.cut || v.ended) return;
  v.cut = true;
  v.dead = true;
  const g = v.g.gain;
  let end = when + fade + 0.005;
  if (g.cancelAndHoldAtTime) {
    g.cancelAndHoldAtTime(when);
    g.linearRampToValueAtTime(0, when + fade);
  } else {
    g.cancelScheduledValues(when);
    g.setTargetAtTime(0, when, fade / 3);
    end = when + fade * 2.5 + 0.005;
  }
  try {
    v.src.stop(end);
  } catch { }
  if (v.lfo) try {
    v.lfo.stop(end);
  } catch { }
}

// 지속 배경음 (방 소리, 박수 바탕)
const bed = new BED(AE);

// Render the existing procedural crowd sounds once, before play. A reaction then
// needs one buffer voice instead of hundreds of live oscillators and formants.
// Keep multiple independently randomized takes, stereo placement and the same mix.
const CROWD_AUDIO = { baking: false, bank: new Map(), live: new Set(), graphs: new Set() };
function fxGraph() {
  const nodes = [], sources = []; let pending = 0;
  const graph = {
    own(node) {
      nodes.push(node);
      if (typeof node.start === 'function') {
        sources.push(node); pending++;
        node.addEventListener('ended', () => {
          if (--pending === 0) cleanup();
        }, { once: true });
      }
      return node;
    },
    stop() {
      for (const node of sources) { try { node.stop(); } catch { } }
      cleanup();
    }
  };
  function cleanup() {
    for (const node of nodes) try { node.disconnect(); } catch { }
    CROWD_AUDIO.graphs.delete(graph);
  }
  if (!CROWD_AUDIO.baking) CROWD_AUDIO.graphs.add(graph);
  return graph;
}

function playBakedFx(key, when, vol = 1, pan = 0) {
  if (CROWD_AUDIO.baking) return false;
  const takes = CROWD_AUDIO.bank.get(key);
  if (!takes || !AE.ctx) return false;
  if (when < AE.ctx.currentTime - 0.25) return true;
  const take = pick(takes), voice = playBuf(take, Math.max(when, AE.ctx.currentTime + 0.004), vol, AE.buses.cheer, { pan, centerPan: take.numberOfChannels === 1, offset: 0.02 });
  CROWD_AUDIO.live.add(voice);
  voice.src.addEventListener('ended', () => CROWD_AUDIO.live.delete(voice), { once: true });
  return true;
}

function bakedCall(type, when, o, defaultVol, kinds) {
  if (CROWD_AUDIO.baking || !CROWD_AUDIO.bank.size) return false;
  // Explicit pitch, gender or duration requests still use the original synth.
  if (Object.keys(o).some(k => !['vol', 'pan', 'kind'].includes(k))) return false;
  const key = kinds ? type + ':' + (o.kind || pick(kinds)) : type;
  return playBakedFx(key, when, o.vol || defaultVol, o.pan != null ? o.pan : rand(-0.8, 0.8));
}

async function prepareCrowdFx() {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline || CROWD_AUDIO.bank.size) return;
  const jobs = [];
  const add = (key, seconds, channels, count, fn) => {
    for (let i = 0; i < count; i++) jobs.push({ key, seconds, channels, fn });
  };
  for (const kind of ['woo', 'hoo', 'ahh', 'yow']) add('whoop:' + kind, 1.6, 1, 4, t => whoop(t, { kind, vol: 1, pan: 0 }));
  for (const kind of ['up', 'wolf', 'trill']) add('whistle:' + kind, 1.3, 1, 3, t => whistleCall(t, { kind, vol: 1, pan: 0 }));
  add('scream', 1.6, 1, 4, t => scream(t, { vol: 1, pan: 0 }));
  add('laugh', 2.0, 1, 4, t => laugh(t, { vol: 1, pan: 0 }));
  for (const n of [26, 30]) add('gasp:' + n, 0.8, 2, 2, t => crowdGasp(t, n));
  for (const [n, dur] of [[14, 1.4], [16, 1.7]]) add('ooh:' + n + ':' + dur, dur * 1.15 + 0.4, 2, 2, t => crowdOoh(t, n, 1, dur));
  for (const n of [24, 28]) add('exhale:' + n, 3.3, 2, 2, t => crowdExhale(t, n));
  add('hey', 0.4, 2, 4, t => heyShout(t));
  for (const job of jobs) {
    // One offline renderer at a time, with a yield between takes. No work is
    // added to the real-time context and the UI can still update loading state.
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const saved = { ctx: AE.ctx, buses: AE.buses, busy: VJOB.busy };
      const ctx = new Offline(job.channels, Math.ceil((job.seconds + 0.02) * saved.ctx.sampleRate), saved.ctx.sampleRate);
      CROWD_AUDIO.baking = true;
      AE.ctx = ctx;
      AE.buses = { cheer: ctx.destination, crowd: ctx.destination };
      VJOB.busy = true;
      try {
        job.fn(0.02);
      } finally {
        AE.ctx = saved.ctx
        AE.buses = saved.buses;
        VJOB.busy = saved.busy;
        CROWD_AUDIO.baking = false;
      }
      const buf = await ctx.startRendering();
      // A centered panner downmixes to mono at -3 dB offline. Undo that once;
      // playBuf applies the normal mono panner again at the requested position.
      if (job.channels === 1) {
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] *= Math.SQRT2;
      }
      const takes = CROWD_AUDIO.bank.get(job.key) || [];
      takes.push(buf);
      CROWD_AUDIO.bank.set(job.key, takes);
    } catch (e) { console.warn('Crowd sample preparation failed; using live synthesis', job.key, e); }
  }
}

function resetCrowdAudio() {
  VJOB.q.length = 0;
  if (VJOB.timer != null) clearTimeout(VJOB.timer);
  VJOB.timer = null;
  const now = AE.ctx.currentTime;
  for (const voice of CROWD_AUDIO.live) {
    const g = voice.g.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    g.linearRampToValueAtTime(0, now + 0.02);
    try { voice.src.stop(now + 0.025); } catch { }
  }
  CROWD_AUDIO.live.clear();
  for (const graph of CROWD_AUDIO.graphs) graph.stop();
}

// ===================== 관객 목소리 (말 없는 환호) =====================
// 수십 명이 "아아아—" 하는 함성 바탕: 모음 포먼트를 통과한 소음 + 음높이 있는 목소리 몇 겹, 끝을 이어 붙여 반복
function synthRoar(ctx, dur) {
  const sr = ctx.sampleRate, n = Math.floor(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const vowels = [[750, 1200, 2600], [550, 1800, 2600], [450, 850, 2500], [650, 1100, 2400]];
  // 톱니 근사(하모닉 8개) 한 주기를 표로 만들어 둠 (표본마다 sin 여덟 번 하던 것을 대신함)
  const SAWN = 2048,
    saw = new Float32Array(SAWN + 1);
  for (let j = 0; j <= SAWN; j++) {
    let x = 0;
    for (let hh = 1; hh <= 8; hh++) x += Math.sin(2 * Math.PI * j / SAWN * hh) / hh;
    saw[j] = x;
  }
  // 목소리 30명: 각자 다른 높이·모음·위치
  for (let v = 0; v < 30; v++) {
    const fem = Math.random() < 0.5,
      f0 = fem ? rand(240, 420) : rand(120, 210),
      vw = pick(vowels);
    const pan = rand(-1, 1),
      gl = Math.sqrt((1 - pan) / 2),
      gr = Math.sqrt((1 + pan) / 2);
    const start = rand(-0.5, dur * 0.6),
      len = rand(1.2, 3.2),
      amp = rand(0.3, 1);
    // 톱니 근사 (하모닉 8개) → 포먼트 3개
    const s0 = Math.max(0, Math.floor(start * sr)),
      s1 = Math.min(n, Math.floor((start + len) * sr));
    if (s1 <= s0) continue;
    const seg = new Float32Array(s1 - s0);
    let ph = 0;
    const glide = rand(0.9, 1.25),
      vib = rand(4, 6.5),
      vibD = rand(0.01, 0.03);
    for (let i = 0; i < seg.length; i++) {
      const t = i / sr,
        k = t / len;
      const f = f0 * (1 + (glide - 1) * Math.sin(Math.PI * Math.min(1, k * 1.4))) * (1 + vibD * Math.sin(2 * Math.PI * vib * t));
      ph += f / sr;
      ph -= Math.floor(ph);
      const q = ph * SAWN,
        j = q | 0,
        x = saw[j] + (saw[j + 1] - saw[j]) * (q - j);
      const env = Math.sin(Math.PI * k) ** 0.7;
      seg[i] = x * env * amp + (Math.random() * 2 - 1) * 0.35 * env * amp;
    }
    const f1 = filt(seg, 'bp', vw[0], 3, sr),
      f2 = filt(seg, 'bp', vw[1], 4, sr),
      f3 = filt(seg, 'bp', vw[2], 5, sr);
    for (let i = 0; i < seg.length; i++) {
      const y = f1[i] + f2[i] * 0.7 + f3[i] * 0.35;
      L[s0 + i] += y * gl;
      R[s0 + i] += y * gr;
    }
  }
  // 넓은 대역 웅성임
  const nzL = filt(filt(noiseArr(n), 'bp', 900, 0.6, sr), 'lp', 3500, 0.7, sr),
    nzR = filt(filt(noiseArr(n), 'bp', 900, 0.6, sr), 'lp', 3500, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const m = 0.6 + 0.4 * Math.sin(i / sr * 1.3) * Math.sin(i / sr * 0.7 + 1);
    L[i] += nzL[i] * 0.5 * m;
    R[i] += nzR[i] * 0.5 * m;
  }
  const xf = Math.floor(0.6 * sr);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    L[i] = L[i] * a + L[n - xf + i] * (1 - a);
    R[i] = R[i] * a + R[n - xf + i] * (1 - a);
  }
  return toBuf(ctx, L.subarray(0, n - xf), 0.8, R.subarray(0, n - xf));
}

function synthStomp(ctx) {
  const sr = ctx.sampleRate, n = Math.floor(0.35 * sr), x = new Float32Array(n), nz = filt(noiseArr(n), 'lp', 600, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = Math.sin(2 * Math.PI * (70 + 40 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14) + nz[i] * Math.exp(-t * 30) * 0.8;
  }
  return toBuf(ctx, x, 0.85);
}
// ---------- 사람 소리 만들기 줄 세우기 ----------
// 환호·"헉" 같은 순간에는 목소리 수십 개를 한꺼번에 예약하는데(하나에 노드 열댓 개), 그걸 한 프레임에 다 만들면 그 프레임이 멈칫함.
// 소리 날 시각 순으로 미리 준비하되, 임박한 소리도 한 작업의 시간·개수 제한을 넘기지 않음.
// 남은 준비는 프레임 사이의 짧은 작업으로 이어 감. 소리의 종류·개수·예약된 재생 시각은 그대로 둠.
const VJOB = {
  q: [],
  busy: false,
  timer: null,
  look: 0.5
};

function vjobWake(delay = 0) {
  if (VJOB.timer != null || !VJOB.q.length || !AE.ctx || AE.ctx.state !== 'running') return;
  VJOB.timer = setTimeout(() => {
    VJOB.timer = null;
    vjobTick();
  }, delay);
}

function vjob(when, fn, o) {
  if (VJOB.busy) return false; // 줄에서 꺼내 만드는 중
  const q = VJOB.q;
  let i = q.length;
  while (i > 0 && q[i - 1].when > when) i--;
  q.splice(i, 0, { when, fn, o });
  // 더 이른 환호가 들어오면 먼 미래 작업의 대기 타이머를 앞당긴다.
  if (i === 0 && VJOB.timer != null) {
    clearTimeout(VJOB.timer);
    VJOB.timer = null;
  }
  vjobWake();
  return true;
}

function vjobTick() {
  if (VJOB.timer != null) {
    clearTimeout(VJOB.timer);
    VJOB.timer = null;
  }
  const q = VJOB.q;
  if (!q.length || !AE.ctx || AE.ctx.state !== 'running') return;
  const t0 = performance.now();
  let made = 0;
  VJOB.busy = true;
  try {
    while (q.length && made < 6 && (made === 0 || performance.now() - t0 < 2)) {
      // 먼 미래의 소리까지 지금 만들지 않는다. 재생 시각·음색·개수는 그대로.
      if (q[0].when > AE.ctx.currentTime + VJOB.look) break;
      const j = q.shift();
      made++;
      if (j.when < AE.ctx.currentTime - 0.25) continue;
      j.fn(Math.max(j.when, AE.ctx.currentTime + 0.004), j.o);
    }
  } finally {
    VJOB.busy = false;
    if (q.length) vjobWake(Math.max(q[0].when < AE.ctx.currentTime + 0.1 ? 0 : 8,
      Math.min(100, (q[0].when - AE.ctx.currentTime - VJOB.look) * 1000)));
  }
}
// 한 사람의 "우—!" / "와—!" (실시간 합성: 톱니 → 포먼트 3개 → 외침 모양 음높이)
const VOWEL = {
  u: [320, 870, 2300],
  o: [470, 900, 2500],
  a: [760, 1250, 2600],
  e: [560, 1750, 2600],
  ae: [700, 1650, 2500]
};

function whoop(when, o = {}) {
  if (bakedCall('whoop', when, o, 0.22, ['woo', 'woo', 'hoo', 'ahh', 'yow'])) return;
  const ctx = AE.ctx;
  if (!ctx || vjob(when, whoop, o)) return;
  const fx = fxGraph();
  const fem = o.fem != null ? o.fem : Math.random() < 0.5;
  const f0 = o.f0 || (fem ? rand(330, 520) : rand(170, 290));
  const kind = o.kind || pick(['woo', 'woo', 'hoo', 'ahh', 'yow']);
  const dur = o.dur || (kind === 'ahh' ? rand(0.7, 1.4) : rand(0.45, 0.9));
  const osc = fx.own(ctx.createOscillator());
  osc.type = 'sawtooth';
  const fr = osc.frequency;
  // 음높이 곡선
  if (kind === 'woo' || kind === 'yow') {
    fr.setValueAtTime(f0 * 0.75, when);
    fr.exponentialRampToValueAtTime(f0 * (kind === 'yow' ? 1.9 : 1.55), when + dur * 0.35);
    fr.exponentialRampToValueAtTime(f0 * 0.9, when + dur);
  } else if (kind === 'hoo') {
    fr.setValueAtTime(f0, when);
    fr.exponentialRampToValueAtTime(f0 * 1.25, when + 0.08);
    fr.exponentialRampToValueAtTime(f0 * 0.8, when + dur);
  } else {
    fr.setValueAtTime(f0 * 1.1, when);
    fr.exponentialRampToValueAtTime(f0 * 1.35, when + dur * 0.2);
    fr.exponentialRampToValueAtTime(f0 * 0.85, when + dur);
  }
  // 떨림
  const lfo = fx.own(ctx.createOscillator());
  lfo.frequency.value = rand(5, 7);
  const lg = fx.own(ctx.createGain());
  lg.gain.value = f0 * 0.025;
  lfo.connect(lg);
  lg.connect(fr);
  const g = fx.own(ctx.createGain());
  g.gain.setValueAtTime(0, when);
  const vol = (o.vol || 0.22) * rand(0.6, 1);
  g.gain.linearRampToValueAtTime(vol, when + 0.04);
  g.gain.setValueAtTime(vol, when + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.001, when + dur);
  const pan = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pan) pan.pan.value = o.pan != null ? o.pan : rand(-0.85, 0.85);
  const out = fx.own(ctx.createGain());
  out.gain.value = 1;
  const v0 = VOWEL[kind === 'woo' ? 'u' : kind === 'hoo' ? 'o' : kind === 'yow' ? 'ae' : 'a'],
    v1 = VOWEL[kind === 'woo' ? 'o' : kind === 'yow' ? 'o' : kind === 'hoo' ? 'u' : 'a'];
  const shift = fem ? 1.12 : 1;
  for (let k = 0; k < 3; k++) {
    const bp = fx.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.Q.value = [5, 7, 9][k];
    bp.frequency.setValueAtTime(v0[k] * shift, when);
    bp.frequency.linearRampToValueAtTime(v1[k] * shift, when + dur * 0.7);
    const fg = fx.own(ctx.createGain());
    fg.gain.value = [1.6, 1.0, 0.5][k];
    osc.connect(bp);
    bp.connect(fg);
    fg.connect(g);
  }
  // 숨소리
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const nb = fx.own(ctx.createBiquadFilter());
  nb.type = 'bandpass';
  nb.frequency.value = v0[1] * shift;
  nb.Q.value = 1.5;
  const ng = fx.own(ctx.createGain());
  ng.gain.value = 0.35;
  ns.connect(nb);
  nb.connect(ng);
  ng.connect(g);
  g.connect(out);
  if (pan) {
    out.connect(pan);
    pan.connect(AE.buses.cheer);
  } else out.connect(AE.buses.cheer);
  osc.start(when);
  lfo.start(when);
  ns.start(when, rand(0, 1));
  const end = when + dur + 0.05;
  osc.stop(end);
  lfo.stop(end);
  ns.stop(end);
}

// 손가락 휘파람: 높은 사인 + 숨소리, 위로 쭉 올렸다 꺾임
function whistleCall(when, o = {}) {
  if (bakedCall('whistle', when, o, 0.07, ['up', 'wolf', 'trill'])) return;
  const ctx = AE.ctx;
  if (!ctx || vjob(when, whistleCall, o)) return;
  const fx = fxGraph();
  const f = o.f || rand(1900, 2700), kind = o.kind || pick(['up', 'wolf', 'trill']);
  const osc = fx.own(ctx.createOscillator());
  osc.type = 'sine';
  const g = fx.own(ctx.createGain());
  g.gain.setValueAtTime(0, when);
  const fr = osc.frequency,
    vol = (o.vol || 0.07) * rand(0.7, 1);
  let dur;
  if (kind === 'up') {
    dur = rand(0.5, 0.8);
    fr.setValueAtTime(f * 0.7, when);
    fr.exponentialRampToValueAtTime(f * 1.15, when + dur * 0.6);
    fr.exponentialRampToValueAtTime(f * 0.95, when + dur);
    g.gain.linearRampToValueAtTime(vol, when + 0.05);
    g.gain.setValueAtTime(vol, when + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, when + dur);
  } else if (kind === 'wolf') {
    dur = 1.1;
    fr.setValueAtTime(f * 0.8, when);
    fr.exponentialRampToValueAtTime(f * 1.25, when + 0.2);
    fr.exponentialRampToValueAtTime(f * 0.75, when + 0.45);
    fr.setValueAtTime(f * 0.9, when + 0.55);
    fr.exponentialRampToValueAtTime(f * 1.3, when + 0.78);
    fr.exponentialRampToValueAtTime(f * 0.6, when + 1.1);
    g.gain.linearRampToValueAtTime(vol, when + 0.03);
    g.gain.setValueAtTime(vol, when + 0.42);
    g.gain.linearRampToValueAtTime(0.0, when + 0.48);
    g.gain.linearRampToValueAtTime(vol, when + 0.56);
    g.gain.linearRampToValueAtTime(0, when + 1.1);
  } else {
    dur = 0.7;
    fr.setValueAtTime(f, when);
    for (let i = 0; i < 9; i++) fr.setValueAtTime(i % 2 ? f * 1.12 : f, when + i * 0.07);
    g.gain.linearRampToValueAtTime(vol, when + 0.03);
    g.gain.setValueAtTime(vol, when + 0.6);
    g.gain.linearRampToValueAtTime(0, when + dur);
  }
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const nb = fx.own(ctx.createBiquadFilter());
  nb.type = 'bandpass';
  nb.frequency.value = f;
  nb.Q.value = 6;
  const ng = fx.own(ctx.createGain());
  ng.gain.value = 0.25;
  ns.connect(nb);
  nb.connect(ng);
  ng.connect(g);
  osc.connect(g);
  const pan = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pan) {
    pan.pan.value = o.pan != null ? o.pan : rand(-0.8, 0.8);
    g.connect(pan);
    pan.connect(AE.buses.cheer);
  } else g.connect(AE.buses.cheer);
  osc.start(when);
  ns.start(when, rand(0, 1));
  osc.stop(when + dur + 0.05);
  ns.stop(when + dur + 0.05);
}

// ===================== 큰 반응용 사람 소리 (말 없음) =====================
// 공용: 톱니 목소리 하나 (포먼트 3개 + 숨소리), 음높이 곡선은 [시간비율, 배수] 목록
function voiceBlip(when, o) {
  const ctx = AE.ctx;
  if (!ctx || !AE.noise || vjob(when, voiceBlip, o)) return;
  const fx = fxGraph();
  const dur = o.dur,
    f0 = o.f0,
    v0 = o.v0 || VOWEL.a,
    v1 = o.v1 || v0,
    sh = o.fem ? 1.12 : 1;
  const osc = fx.own(ctx.createOscillator());
  osc.type = 'sawtooth';
  const fr = osc.frequency;
  fr.setValueAtTime(f0 * (o.curve ? o.curve[0][1] : 1), when);
  if (o.curve)
    for (const [k, m] of o.curve.slice(1)) fr.exponentialRampToValueAtTime(Math.max(30, f0 * m), when + dur * k);
  const lfo = fx.own(ctx.createOscillator());
  lfo.frequency.value = o.vibRate || rand(5, 6.8);
  const lg = fx.own(ctx.createGain());
  lg.gain.value = f0 * (o.vib == null ? 0.025 : o.vib);
  lfo.connect(lg);
  lg.connect(fr);
  const g = fx.own(ctx.createGain());
  g.gain.setValueAtTime(0, when);
  const vol = o.vol,
    att = o.att || 0.04;
  g.gain.linearRampToValueAtTime(vol, when + att);
  g.gain.setValueAtTime(vol, when + dur * (o.hold || 0.6));
  g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
  // 거친 떨림 (비명): 진폭을 빠르게 흔듦
  let amIn = g;
  if (o.rough) {
    const am = fx.own(ctx.createGain());
    am.gain.value = 1 - o.rough * 0.5;
    const r = fx.own(ctx.createOscillator());
    r.frequency.value = rand(24, 36);
    const rg = fx.own(ctx.createGain());
    rg.gain.value = o.rough * 0.5;
    r.connect(rg);
    rg.connect(am.gain);
    r.start(when);
    r.stop(when + dur + 0.05);
    am.connect(g);
    amIn = am;
  }
  for (let k = 0; k < 3; k++) {
    const bp = fx.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.Q.value = (o.q || [5, 7, 9])[k];
    bp.frequency.setValueAtTime(v0[k] * sh, when);
    bp.frequency.linearRampToValueAtTime(v1[k] * sh, when + dur * 0.75);
    const fg = fx.own(ctx.createGain());
    fg.gain.value = [1.6, 1.0, 0.5][k];
    osc.connect(bp);
    bp.connect(fg);
    fg.connect(amIn);
  }
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const nb = fx.own(ctx.createBiquadFilter());
  nb.type = 'bandpass';
  nb.frequency.value = v0[1] * sh;
  nb.Q.value = 1.2;
  const ng = fx.own(ctx.createGain());
  ng.gain.value = o.breath == null ? 0.35 : o.breath;
  ns.connect(nb);
  nb.connect(ng);
  ng.connect(amIn);
  const pan = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pan) {
    pan.pan.value = clamp(o.pan != null ? o.pan : rand(-0.85, 0.85), -1, 1);
    g.connect(pan);
    pan.connect(o.bus || AE.buses.cheer);
  } else g.connect(o.bus || AE.buses.cheer);
  osc.start(when);
  lfo.start(when);
  ns.start(when, rand(0, 1.2));
  const end = when + dur + 0.06;
  osc.stop(end);
  lfo.stop(end);
  ns.stop(end);
}
// 숨 하나: 걸러진 소음 (들숨·날숨)
function breathBlip(when, o) {
  const ctx = AE.ctx;
  if (!ctx || !AE.noise || vjob(when, breathBlip, o)) return;
  const fx = fxGraph();
  const dur = o.dur,
    ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const bp = fx.own(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.Q.value = o.q || 2.2;
  bp.frequency.setValueAtTime(o.f0, when);
  bp.frequency.exponentialRampToValueAtTime(o.f1, when + dur);
  const hp = fx.own(ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 280;
  const g = fx.own(ctx.createGain());
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(o.vol, when + (o.att || 0.03));
  g.gain.setValueAtTime(o.vol, when + dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
  ns.connect(bp);
  bp.connect(hp);
  hp.connect(g);
  const pan = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pan) {
    pan.pan.value = o.pan != null ? o.pan : rand(-0.9, 0.9);
    g.connect(pan);
    pan.connect(AE.buses.cheer);
  } else g.connect(AE.buses.cheer);
  ns.start(when, rand(0, 1.5));
  ns.stop(when + dur + 0.05);
}
// 객석 전체가 "헉!" (짧은 들숨 + 몇 명은 목소리 섞인 헉)
function crowdGasp(when, n = 26, vol = 1) {
  if (playBakedFx('gasp:' + n, when, vol)) return;
  for (let i = 0; i < n; i++) {
    const t = when + rand(0, 0.16);
    breathBlip(t, {
      dur: rand(0.22, 0.42),
      f0: rand(700, 1100),
      f1: rand(1500, 2600),
      q: rand(1.8, 3),
      vol: rand(0.05, 0.11) * vol,
      att: 0.025
    });
    if (Math.random() < 0.45) {
      const fem = Math.random() < 0.5;
      voiceBlip(t + 0.02, {
        dur: rand(0.1, 0.17),
        f0: fem ? rand(330, 460) : rand(170, 250),
        fem,
        v0: VOWEL.o,
        v1: VOWEL.a,
        vol: rand(0.05, 0.1) * vol,
        att: 0.012,
        hold: 0.4,
        curve: [[0, 1], [1, 1.25]],
        breath: 0.6
      });
    }
  }
}
// 놀라서 치솟는 "오오오—!" (여럿이 같이)
function crowdOoh(when, n = 16, vol = 1, dur = 1.7) {
  if (playBakedFx('ooh:' + n + ':' + dur, when, vol)) return;
  for (let i = 0; i < n; i++) {
    const fem = Math.random() < 0.5, f0 = fem ? rand(250, 380) : rand(130, 200), d = dur * rand(0.8, 1.15);
    voiceBlip(when + rand(0, 0.25), {
      dur: d,
      f0,
      fem,
      v0: VOWEL.o,
      v1: VOWEL.u,
      vol: rand(0.06, 0.12) * vol,
      att: 0.18,
      hold: 0.7,
      curve: [[0, 0.82], [0.65, 1.38], [1, 1.12]],
      vib: 0.02,
      breath: 0.3
    });
  }
}
// 한 사람 비명 (거칠게 떨림)
function scream(when, o = {}) {
  if (bakedCall('scream', when, o, 0.2)) return;
  const fem = o.fem != null ? o.fem : Math.random() < 0.55,
    f0 = fem ? rand(560, 780) : rand(300, 430),
    dur = o.dur || rand(0.8, 1.4);
  voiceBlip(when, {
    dur,
    f0,
    fem,
    v0: pick([VOWEL.a, VOWEL.ae]),
    v1: VOWEL.a,
    vol: (o.vol || 0.2) * rand(0.75, 1),
    att: 0.05,
    hold: 0.55,
    curve: [[0, 0.9], [0.25, 1.18], [1, 0.82]],
    vib: 0.03,
    vibRate: rand(6, 7.5),
    rough: 0.45,
    breath: 0.5,
    pan: o.pan,
    q: [4, 6, 8]
  });
}
// 한 사람 "하하하하"
function laugh(when, o = {}) {
  if (bakedCall('laugh', when, o, 0.12)) return;
  const fem = o.fem != null ? o.fem : Math.random() < 0.5,
    f0 = fem ? rand(280, 380) : rand(140, 210),
    n = randi(4, 7),
    rate = rand(4.6, 6.2),
    pan = o.pan != null ? o.pan : rand(-0.8, 0.8);
  for (let i = 0; i < n; i++) {
    const t = when + i / rate,
      k = 1 - i / n * 0.25;
    breathBlip(t, { dur: 0.06, f0: 1200, f1: 1600, vol: (o.vol || 0.12) * 0.6, pan, att: 0.01 });
    voiceBlip(t + 0.02, {
      dur: 0.13,
      f0: f0 * k * (i === 0 ? 1.15 : 1),
      fem,
      v0: VOWEL.a,
      v1: VOWEL.a,
      vol: (o.vol || 0.12) * rand(0.8, 1),
      att: 0.012,
      hold: 0.35,
      curve: [[0, 1.05], [1, 0.92]],
      vib: 0,
      breath: 0.45,
      pan
    });
  }
}
// 참았던 숨을 한꺼번에 "푸하—" + 웃음 몇 개
function crowdExhale(when, n = 24) {
  if (playBakedFx('exhale:' + n, when)) return;
  for (let i = 0; i < n; i++) {
    const t = when + rand(0, 0.2);
    breathBlip(t, { dur: rand(0.45, 0.75), f0: rand(1300, 1800), f1: rand(380, 600), q: rand(1.2, 2), vol: rand(0.06, 0.12), att: 0.02 });
    if (Math.random() < 0.35) {
      const fem = Math.random() < 0.5;
      voiceBlip(t + 0.05, {
        dur: rand(0.3, 0.5),
        f0: fem ? rand(280, 380) : rand(140, 200),
        fem,
        v0: VOWEL.a,
        v1: VOWEL.u,
        vol: rand(0.04, 0.08),
        att: 0.02,
        hold: 0.3,
        curve: [[0, 1.2], [1, 0.75]],
        breath: 0.8
      });
    }
  }
  for (let i = 0; i < 4; i++) laugh(when + rand(0.4, 1.2), {
    vol: rand(0.08, 0.13)
  });
}
// 유리잔 깨짐
function glassCrash(when, o = {}) {
  const ctx = AE.ctx;
  if (!ctx || !AE.noise) return;
  const fx = fxGraph();
  const bus = AE.buses.crowd,
    vol = o.vol || 0.5;
  const pan = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null, out = fx.own(ctx.createGain());
  out.gain.value = vol;
  if (pan) {
    pan.pan.value = o.pan || 0;
    out.connect(pan);
    pan.connect(bus);
  } else out.connect(bus);
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const hp = fx.own(ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 2400;
  const ng = fx.own(ctx.createGain());
  ng.gain.setValueAtTime(0.9, when);
  ng.gain.exponentialRampToValueAtTime(0.001, when + 0.32);
  ns.connect(hp);
  hp.connect(ng);
  ng.connect(out);
  ns.start(when, rand(0, 1));
  ns.stop(when + 0.4);
  for (let i = 0; i < 12; i++) {
    const t = when + rand(0, 0.12) + (i > 8 ? rand(0.12, 0.35) : 0), f = rand(2600, 8500);
    const o2 = fx.own(ctx.createOscillator());
    o2.type = 'sine';
    o2.frequency.value = f;
    const g = fx.own(ctx.createGain());
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(rand(0.08, 0.22), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0008, t + rand(0.05, 0.35));
    o2.connect(g);
    g.connect(out);
    o2.start(t);
    o2.stop(t + 0.4);
  }
  const th = fx.own(ctx.createOscillator());
  th.frequency.setValueAtTime(320, when);
  th.frequency.exponentialRampToValueAtTime(140, when + 0.08);
  const tg = fx.own(ctx.createGain());
  tg.gain.setValueAtTime(0.5, when);
  tg.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
  th.connect(tg);
  tg.connect(out);
  th.start(when);
  th.stop(when + 0.12);
}
// 잔들이 달그락 (페달톤 울림)
function glassRattle(when, dur = 0.7) {
  if (!AE.syn.clinks) return;
  const n = Math.round(dur * 14);
  for (let i = 0; i < n; i++) playBuf(pick(AE.syn.clinks), when + rand(0, dur), rand(0.04, 0.09), AE.buses.crowd, {
    pan: rand(-0.8, 0.8),
    rate: rand(0.9, 1.4)
  });
}
// 마우스피스 버징: 실시간 목소리 하나 (부르르)
function makeBuzz(when) {
  const ctx = AE.ctx;
  const fx = fxGraph();
  const osc = fx.own(ctx.createOscillator());
  osc.type = 'sawtooth';
  osc.frequency.value = 180;
  const sh = fx.own(ctx.createWaveShaper());
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 128 - 1;
    curve[i] = Math.tanh(x * 2.6);
  }
  sh.curve = curve;
  const jit = fx.own(ctx.createOscillator());
  jit.frequency.value = 7.3;
  const jg = fx.own(ctx.createGain());
  jg.gain.value = 6;
  jit.connect(jg);
  jg.connect(osc.frequency);
  const pre = fx.own(ctx.createGain());
  pre.gain.value = 0.7;
  osc.connect(pre);
  pre.connect(sh);
  const f1 = fx.own(ctx.createBiquadFilter());
  f1.type = 'bandpass';
  f1.frequency.value = 780;
  f1.Q.value = 2.2;
  const f2 = fx.own(ctx.createBiquadFilter());
  f2.type = 'bandpass';
  f2.frequency.value = 1550;
  f2.Q.value = 3.5;
  const mix = fx.own(ctx.createGain());
  mix.gain.value = 1;
  const g1 = fx.own(ctx.createGain()), g2 = fx.own(ctx.createGain());
  g1.gain.value = 1.4;
  g2.gain.value = 0.9;
  sh.connect(f1);
  f1.connect(g1);
  g1.connect(mix);
  sh.connect(f2);
  f2.connect(g2);
  g2.connect(mix);
  // 입술 떨림 (부르르): 진폭을 빠르게 흔듦
  const am = fx.own(ctx.createGain());
  am.gain.value = 0.65;
  const tr = fx.own(ctx.createOscillator());
  tr.frequency.value = 27;
  const tg = fx.own(ctx.createGain());
  tg.gain.value = 0.35;
  tr.connect(tg);
  tg.connect(am.gain);
  const g = fx.own(ctx.createGain());
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.42, when + 0.03);
  mix.connect(am);
  am.connect(g);
  g.connect(AE.buses.tp);
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  ns.loop = true;
  const nb = fx.own(ctx.createBiquadFilter());
  nb.type = 'bandpass';
  nb.frequency.value = 2400;
  nb.Q.value = 1;
  const ngn = fx.own(ctx.createGain());
  ngn.gain.value = 0.08;
  ns.connect(nb);
  nb.connect(ngn);
  ngn.connect(g);
  osc.start(when);
  jit.start(when);
  tr.start(when);
  ns.start(when);
  return {
    setPitch(f, t) {
      osc.frequency.setTargetAtTime(f, t, 0.02);
      tr.frequency.setTargetAtTime(20 + f / 18, t, 0.05);
    },
    stop(t) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.03);
      for (const n of [osc, jit, tr, ns]) try {
        n.stop(t + 0.2);
      } catch { }
    },
  };
}
// 공연 전 웅성임 (여러 사람이 떠드는 소리, 끝을 이어 붙여 반복)
function synthBabble(ctx, dur) {
  const sr = ctx.sampleRate,
    n = Math.floor(dur * sr),
    L = new Float32Array(n),
    R = new Float32Array(n);
  const vw = [[730, 1090, 2440], [530, 1840, 2480], [390, 2000, 2550], [570, 840, 2410], [440, 1020, 2240], [300, 870, 2240], [660, 1720, 2410]];
  for (let v = 0; v < 14; v++) {
    const fem = Math.random() < 0.5,
      f0b = fem ? rand(190, 260) : rand(100, 145),
      pan = rand(-1, 1),
      gl = Math.sqrt((1 - pan) / 2),
      gr = Math.sqrt((1 + pan) / 2),
      amp = rand(0.4, 1);
    const seg = new Float32Array(n);
    let ph = 0, t = rand(0, 0.6);
    while (t < dur) {
      // 한 마디(말 덩어리): 음절 3~9개
      const syl = randi(3, 9);
      for (let s = 0; s < syl && t < dur; s++) {
        const sd = rand(0.09, 0.2),
          i0 = Math.floor(t * sr),
          i1 = Math.min(n, Math.floor((t + sd) * sr)),
          f0 = f0b * rand(0.9, 1.2) * (s === 0 ? 1.1 : 1);
        for (let i = i0; i < i1; i++) {
          const k = (i - i0) / (i1 - i0);
          ph += f0 * (1 - k * 0.08) / sr;
          ph -= Math.floor(ph);
          const e = Math.sin(Math.PI * k);
          seg[i] = (2 * ph - 1) * e * e * amp + (Math.random() * 2 - 1) * 0.12 * e * amp;
        }
        t += sd + rand(0.0, 0.05);
      }
      t += rand(0.25, 1.1);
    }
    // 모음 하나로 걸러 사람 목소리 느낌 (말소리라 알아듣지 못하게 흐림)
    const w = pick(vw),
      w2 = pick(vw);
    const a = filt(seg, 'bp', w[0], 2.5, sr),
      b = filt(seg, 'bp', (w[1] + w2[1]) / 2, 3, sr);
    for (let i = 0; i < n; i++) {
      const y = a[i] + b[i] * 0.6;
      L[i] += y * gl;
      R[i] += y * gr;
    }
  }
  const lpL = filt(L, 'lp', 2600, 0.7, sr),
    lpR = filt(R, 'lp', 2600, 0.7, sr);
  const xf = Math.floor(0.6 * sr);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    lpL[i] = lpL[i] * a + lpL[n - xf + i] * (1 - a);
    lpR[i] = lpR[i] * a + lpR[n - xf + i] * (1 - a);
  }
  return toBuf(ctx, lpL.subarray(0, n - xf), 0.7, lpR.subarray(0, n - xf));
}
// 나중에 영어 외침 녹음을 넣을 자리: audio.js 에 'V_' 로 시작하는 이름으로 넣으면 큰 순간에 재생
function playVoiceClip(when, o = {}) {
  const list = AE.voiceClips;
  if (!list || !list.length) return false;
  const s = pick(list);
  playOne(s, null, when, (o.vol || 0.5), AE.buses.cheer, {
    pan: o.pan || 0
  });
  return true;
}

// ===== 20_venue.js =====
// ===================== 공연장: 늦은 오후의 재즈 클럽 (방·무대·객석·바·장식·조명) =====================
// buildVenue(scene) → VENUE { seats, standSpots, barSpots, bartender, sun, lights, setMood, update }
// 좌표는 LAYOUT(06_layout.js) 기준. 관객은 -z, 연주자(카메라)는 무대 뒤 단 위에서 -z 를 본다.

// ---------- 캔버스 텍스처 ----------
function _herringboneTex() {
  const rnd = seeded(11);
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#8a4a22';
    g.fillRect(0, 0, w, h);
    const cols = ['#a35a2b', '#b4683a', '#9a5327', '#c0773f', '#8f4c25', '#ad6334', '#b86f3c'];
    const L = 128,
      T = 32;
    for (let y = -L; y < h + L; y += T * 2)
      for (let x = -L; x < w + L; x += L)
        for (let k = 0; k < 2; k++) {
          g.save();
          g.translate(x + k * T * 2, y + k * T * 2);
          g.rotate(k ? -Math.PI / 4 : Math.PI / 4);
          g.fillStyle = rnd.pick(cols);
          g.fillRect(0, 0, L * 0.985, T * 0.94);
          g.globalAlpha = 0.22;
          g.fillStyle = '#5a2c12';
          for (let i = 0; i < 4; i++) g.fillRect(rnd.range(0, L), rnd.range(2, T - 2), rnd.range(14, 50), 1.2);
          g.globalAlpha = 0.16;
          g.fillStyle = '#ffd9a8';
          g.fillRect(0, 1, L * 0.98, 2);
          g.restore();
          g.globalAlpha = 1;
        }
  }, [6, 7]);
}

function _plankTex(base = '#6b3a1c') {
  const rnd = seeded(5);
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const cols = ['#7a4421', '#6e3b1b', '#86502a', '#653518', '#7f4a26'];
    for (let y = 0; y < h; y += 32) {
      let x = -rnd.range(0, 200);
      while (x < w) {
        const L = rnd.range(160, 320);
        g.fillStyle = rnd.pick(cols);
        g.fillRect(x + 2, y + 2, L - 4, 28);
        g.globalAlpha = 0.25;
        g.fillStyle = '#3d1f0c';
        for (let i = 0; i < 3; i++) g.fillRect(x + rnd.range(0, L), y + rnd.range(4, 28), rnd.range(30, 120), 1);
        g.globalAlpha = 1;
        x += L;
      }
    }
  }, [4, 4]);
}

function _rugTex() {
  // 차분한 깔개: 짙은 붉은 바탕 + 은은한 마름모 격자 + 가는 금선 테두리 + 작은 메달리온 (연주자 시야 바로 아래라 대비를 낮춤)
  return canvasTex(1024, 640, (g, w, h) => {
    g.fillStyle = '#8f1f2a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#9c2c36';
    g.lineWidth = 2;
    for (let x = -h; x < w + h; x += 44) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + h, h);
      g.stroke();
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + h, 0);
      g.stroke();
    }
    const border = (inset, col, lw) => {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    };
    border(16, '#c9962c', 5);
    border(34, '#1f2f6b', 14);
    border(50, '#c9962c', 3);
    g.fillStyle = '#c9962c';
    for (let x = 60; x < w - 40; x += 60)
      for (const y of [41, h - 41]) {
        g.beginPath();
        g.moveTo(x, y - 5);
        g.lineTo(x + 5, y);
        g.lineTo(x, y + 5);
        g.lineTo(x - 5, y);
        g.fill();
      }
    const cx = w / 2,
      cy = h / 2;
    g.fillStyle = '#1f2f6b';
    g.beginPath();
    g.ellipse(cx, cy, 150, 95, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#c9962c';
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(cx, cy, 128, 78, 0, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      g.fillStyle = '#c9962c';
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * 95, cy + Math.sin(a) * 56, 13, 7, a, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#8f1f2a';
    g.beginPath();
    g.ellipse(cx, cy, 34, 20, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#c9962c';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(cx, cy, 34, 20, 0, 0, Math.PI * 2);
    g.stroke();
    for (const [x, y] of [[150, 130], [w - 150, 130], [150, h - 130], [w - 150, h - 130]]) {
      g.strokeStyle = '#c9962c';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y - 26);
      g.lineTo(x + 26, y);
      g.lineTo(x, y + 26);
      g.lineTo(x - 26, y);
      g.closePath();
      g.stroke();
      g.fillStyle = '#1f2f6b';
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
    }
  });
}

function _skyTex() {
  const rnd = seeded(3);
  return canvasTex(256, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#4f9ff0');
    gr.addColorStop(0.45, '#9fd0fb');
    gr.addColorStop(0.72, '#ffe3b0');
    gr.addColorStop(1, '#ffb470');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.9)';
    for (let i = 0; i < 7; i++) {
      const x = rnd.range(0, w),
        y = rnd.range(h * 0.08, h * 0.5),
        s = rnd.range(0.7, 1.3);
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        g.arc(x + k * 13 * s, y + rnd.range(-5, 5), rnd.range(9, 18) * s, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 건너편 건물 실루엣 (따뜻한 역광)
    for (let x = 0; x < w; x += rnd.range(22, 44)) {
      const bh = rnd.range(h * 0.1, h * 0.26),
        bw = rnd.range(22, 46);
      g.fillStyle = rnd.pick(['#d98e62', '#c96f55', '#e4ad7d', '#b8604c', '#c77a4a']);
      g.fillRect(x, h - bh, bw, bh);
      g.fillStyle = 'rgba(255,240,200,.75)';
      for (let yy = h - bh + 8; yy < h - 6; yy += 15)
        for (let xx = x + 4; xx < x + bw - 6; xx += 9) g.fillRect(xx, yy, 4, 6);
    }
    g.fillStyle = '#fff2c4';
    g.beginPath();
    g.arc(w * 0.72, h * 0.6, 26, 0, Math.PI * 2);
    g.fill(); // 낮은 해
  });
}
// 추상화 4장을 한 장의 아틀라스로 (각 256x320). 글자 없음
function _artAtlas() {
  const rnd = seeded(21);
  return canvasTex(1024, 320, (g, W, H) => {
    const pals = [
      ['#f2b531', '#e2452b', '#2346b8', '#fbf1dc', '#11806f'],
      ['#ff8a5b', '#1c1f33', '#f6e3c4', '#3aa6b9', '#f2b531'],
      ['#2346b8', '#fbf1dc', '#e2452b', '#1c1f33', '#9bc53d'],
      ['#7b3fb0', '#ffe36b', '#ff7aa8', '#fff4de', '#13a08a']
    ];
    for (let k = 0; k < 4; k++) {
      const pal = pals[k],
        x0 = k * 256;
      g.save();
      g.beginPath();
      g.rect(x0, 0, 256, H);
      g.clip();
      g.fillStyle = pal[3];
      g.fillRect(x0, 0, 256, H);
      for (let i = 0; i < 10; i++) {
        g.fillStyle = pal[i % 5];
        const r = rnd.range(18, 80);
        if (i % 3 === 0) {
          g.beginPath();
          g.arc(x0 + rnd.range(0, 256), rnd.range(0, H), r, 0, Math.PI * 2);
          g.fill();
        } else if (i % 3 === 1) g.fillRect(x0 + rnd.range(-20, 220), rnd.range(-20, H - 40), rnd.range(40, 150), rnd.range(14, 60));
        else {
          g.beginPath();
          g.moveTo(x0 + rnd.range(0, 256), rnd.range(0, H));
          g.lineTo(x0 + rnd.range(0, 256), rnd.range(0, H));
          g.lineTo(x0 + rnd.range(0, 256), rnd.range(0, H));
          g.fill();
        }
      }
      g.strokeStyle = pal[1];
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(x0 + 20, H * 0.72);
      for (let x = 20; x < 240; x += 18) g.lineTo(x0 + x, H * 0.72 + Math.sin(x / 16 + k) * 20);
      g.stroke();
      g.restore();
    }
  });
}
// 커튼(주름) 텍스처
function _curtainTex() {
  return canvasTex(256, 64, (g, w, h) => {
    for (let x = 0; x < w; x++) {
      const t = (Math.sin(x / w * Math.PI * 2 * 8) + 1) / 2;
      const c = new THREE.Color('#8e1a2a').lerp(new THREE.Color('#d8415a'), t * 0.9);
      g.fillStyle = '#' + c.getHexString();
      g.fillRect(x, 0, 1, h);
    }
  }, [14, 1]);
}

// ---------- 작은 기하 도우미 (venue 전용) ----------
function _vm(parts) {
  return mergeVC(parts.map(p => vcol(p[0], p[1], p[2])));
} // [[geo, color, matrix?], ...] → 꼭짓점색 병합

// 전구·점 조명용 Points (한 번의 드로우콜로 여러 개의 빛 번짐)
function _glowPoints(positions, color, size, opacity = 0.9) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const m = new THREE.PointsMaterial({
    map: glowTexture(),
    color: new THREE.Color(color),
    size,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  });
  return new THREE.Points(geo, m);
}
// 색이 다른 점들을 한 Points 로 (버킷용): items = [{pos:[x,y,z,...], color}]
function _glowPointsVC(items, size, opacity = 0.85) {
  const pos = [],
    col = [],
    c = new THREE.Color();
  for (const it of items) {
    c.set(it.color);
    for (let i = 0; i < it.pos.length; i += 3) {
      pos.push(it.pos[i], it.pos[i + 1], it.pos[i + 2]);
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    map: glowTexture(),
    vertexColors: true,
    size,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  });
  return new THREE.Points(geo, m);
}
// 소품 그룹(makeAmp 등)을 재질 종류별 버킷에 굽기 — 텍스처 메시는 map 별로 따로 모음
function _bakeInto(group, BK) {
  group.updateMatrixWorld(true);
  group.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material,
      g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (m.map) {
      const key = m.map.uuid;
      (BK.textured[key] = BK.textured[key] || {
        mat: m,
        geos: []
      }).geos.push(g);
      return;
    }
    const col = m.color ? '#' + m.color.getHexString() : '#ffffff';
    if (m.isMeshBasicMaterial) BK.unlit.push([g, col]);
    else if (m.isMeshStandardMaterial && m.metalness >= 0.5) BK.metal.push([g, col]);
    else if (m.isMeshStandardMaterial) BK.dark.push([g, col]);
    else BK.toon.push([g, col]);
  });
}
// 아치 창 윤곽 (아래 y0, 직선 꼭대기 y1, 반원 위로)
function _archPath(cx, y0, y1, w, path) {
  const r = w / 2;
  path.moveTo(cx - r, y0);
  path.lineTo(cx + r, y0);
  path.lineTo(cx + r, y1);
  path.absarc(cx, y1, r, 0, Math.PI, false);
  path.lineTo(cx - r, y0);
  return path;
}

// =====================================================================
function buildVenue(scene) {
  const R = LAYOUT.room, pal = STYLE.pal;
  const VENUE = {
    seats: [],
    standSpots: [],
    barSpots: [],
    bartender: null,
    sun: null,
    lights: {},
    anim: {}
  };
  const root = new THREE.Group();
  root.name = 'venue';
  scene.add(root);
  const cx = (R.x0 + R.x1) / 2,
    cz = (R.zFront + R.zBack) / 2,
    W = R.x1 - R.x0,
    D = R.zBack - R.zFront,
    H = R.h;
  const add = (geo, mat, cast = false, recv = false, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = recv;
    if (name) m.name = name;
    root.add(m);
    return m;
  };
  // 공용 재질
  const matWalnut = glossMat('#ffffff', 0.45, {
    vc: true,
    outline: 0.003,
    env: 0.35
  }); // 징두리·들보·가구 (꼭짓점색)
  const matBrass = metalMat(pal.brass, 0.25, {
    outline: 0.003
  });
  const matBrassVC = metalMat('#ffffff', 0.28, {
    vc: true,
    outline: 0.003,
    side: THREE.FrontSide
  });
  // 재질 종류별 병합 버킷 (드로우콜 절감): [geo, color, matrix?] → buildVenue 끝에서 종류마다 메시 1개
  const BK = VENUE._bk = {
    shell: [],
    wood: [],
    metal: [],
    dark: [],
    unlit: [],
    toon: [],
    lit: [],
    textured: {},
    glowS: [],
    glowB: []
  };

  // ---------- 바닥 ----------
  add(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2).translate(cx, 0, cz), toonMat('#ffffff', {
    map: _herringboneTex(),
    outline: 0,
    soft: true
  }), false, true, 'floor');

  // ---------- 벽 (코발트) : 양 옆벽은 창 구멍을 낸 Shape ----------
  const wallParts = [];
  // 뒷벽(관객 뒤, 바) / 무대 뒤 벽
  wallParts.push(new THREE.PlaneGeometry(W, H).translate(cx, H / 2, R.zFront + 0.001));
  wallParts.push(new THREE.PlaneGeometry(W, H).rotateY(Math.PI).translate(cx, H / 2, R.zBack - 0.001));
  // 옆벽: 창 위치 (z 중심, 폭, 창턱, 직선부 꼭대기 → 아치)
  const winL = [-5.6, -8.6, -11.6],
    winR = [-7.2, -10.6],
    winW = 1.5,
    sill = 1.15,
    top = 3.3;
  // 왼벽(x0): 법선 +x 가 되도록 u=-z 로 그려 rotateY(+π/2) ((u,v,0)→(0,v,-u)). 오른벽(x1): u=z, rotateY(-π/2) ((u,v,0)→(0,v,u)), 법선 -x
  const sideWall = (x, wins, left) => {
    const s = left ? -1 : 1,
      u0 = Math.min(s * R.zFront, s * R.zBack),
      u1 = Math.max(s * R.zFront, s * R.zBack);
    const sh = new THREE.Shape();
    sh.moveTo(u0, 0);
    sh.lineTo(u1, 0);
    sh.lineTo(u1, H);
    sh.lineTo(u0, H);
    sh.closePath();
    for (const z of wins) {
      const p = new THREE.Path();
      _archPath(s * z, sill, top, winW, p);
      sh.holes.push(p);
    }
    const geo = new THREE.ShapeGeometry(sh, 12);
    geo.rotateY(left ? Math.PI / 2 : -Math.PI / 2);
    geo.translate(x, 0, 0);
    return geo;
  };
  wallParts.push(sideWall(R.x0 + 0.001, winL, true), sideWall(R.x1 - 0.001, winR, false));
  for (const g of wallParts) BK.shell.push([g, pal.cobalt]);

  // ---------- 징두리(월넛 패널) + 체어레일(크림) + 상단 프리즈(크림) + 코니스 ----------
  const trim = [],
    cream = pal.cream,
    wal = pal.walnut,
    walD = pal.walnutDark;
  const wainH = 1.0,
    railY = 1.0,
    frieze0 = H - 0.42;
  const wallRun = (len, M, hasWins, wins) => { // 벽 한 면의 가로 장식을 로컬(x 방향 길이) 로 만들어 M 로 배치
    trim.push([rbox(len, wainH, 0.06, 0.012, 2).translate(0, wainH / 2, 0.03), wal, M]);
    trim.push([rbox(len, 0.07, 0.1, 0.012, 2).translate(0, railY + 0.035, 0.05), cream, M]);
    trim.push([rbox(len, 0.42, 0.05, 0.012, 2).translate(0, frieze0 + 0.21, 0.025), cream, M]);
    trim.push([rbox(len, 0.06, 0.1, 0.012, 2).translate(0, frieze0 - 0.03, 0.05), cream, M]);
    trim.push([rbox(len, 0.08, 0.04, 0.01, 1).translate(0, 0.04, 0.05), walD, M]); // 걸레받이
    // 징두리 패널 몰딩 (사각 테두리) 0.9 m 간격
    for (let u = -len / 2 + 0.55; u < len / 2 - 0.4; u += 0.9) {
      trim.push([rbox(0.62, 0.03, 0.03, 0.008, 1).translate(u, 0.78, 0.075), walD, M]);
      trim.push([rbox(0.62, 0.03, 0.03, 0.008, 1).translate(u, 0.22, 0.075), walD, M]);
      trim.push([rbox(0.03, 0.59, 0.03, 0.008, 1).translate(u - 0.295, 0.5, 0.075), walD, M]);
      trim.push([rbox(0.03, 0.59, 0.03, 0.008, 1).translate(u + 0.295, 0.5, 0.075), walD, M]);
    }
  };
  wallRun(W, M4([cx, 0, R.zFront], [0, 0, 0])); // 뒷벽: 안쪽(+z)을 봄
  wallRun(W, M4([cx, 0, R.zBack], [0, Math.PI, 0])); // 무대 뒤 벽
  wallRun(D, M4([R.x0, 0, cz], [0, Math.PI / 2, 0])); // 왼벽: 로컬 +z → 월드 +x
  wallRun(D, M4([R.x1, 0, cz], [0, -Math.PI / 2, 0])); // 오른벽
  // 창틀 (크림, 아치) + 창살 + 창턱 + 안쪽 벽두께(리빌)
  const frames = [],
    glassParts = [];
  const winFrame = (x, z, dirIn) => { // dirIn: 방 안쪽 방향 (+1 왼벽, -1 오른벽)
    const M = M4([x, 0, z], [0, dirIn > 0 ? Math.PI / 2 : -Math.PI / 2, 0]); // 로컬 x → 월드 z, 로컬 +z → 방 안쪽
    const r = winW / 2,
      arcY = top;
    // 틀: 두 기둥 + 아치(토러스 반) + 창턱
    frames.push([rbox(0.09, top - sill, 0.14, 0.015, 2).translate(-r - 0.03, (top + sill) / 2, 0.05), cream, M]);
    frames.push([rbox(0.09, top - sill, 0.14, 0.015, 2).translate(r + 0.03, (top + sill) / 2, 0.05), cream, M]);
    frames.push([new THREE.TorusGeometry(r + 0.03, 0.05, 8, 24, Math.PI).translate(0, arcY, 0.05), cream, M]);
    frames.push([rbox(winW + 0.5, 0.08, 0.3, 0.015, 2).translate(0, sill - 0.04, 0.12), cream, M]); // 창턱
    frames.push([rbox(winW + 0.3, 0.06, 0.08, 0.01, 1).translate(0, sill - 0.11, 0.04), walD, M]); // 창턱 밑 몰딩
    // 창살: 세로 1 + 가로 2
    frames.push([rbox(0.035, top - sill, 0.035, 0.008, 1).translate(0, (top + sill) / 2, -0.1), cream, M]);
    frames.push([rbox(winW, 0.035, 0.035, 0.008, 1).translate(0, sill + (top - sill) * 0.42, -0.1), cream, M]);
    frames.push([rbox(winW, 0.035, 0.035, 0.008, 1).translate(0, sill + (top - sill) * 0.78, -0.1), cream, M]);
    frames.push([rbox(0.035, r, 0.035, 0.008, 1).translate(0, arcY + r / 2, -0.1), cream, M]);
    // 리빌(벽 두께 안쪽 면, 크림): 좌우·아래
    frames.push([rbox(0.04, top - sill, 0.3, 0.005, 1).translate(-r - 0.02, (top + sill) / 2, -0.15), cream, M]);
    frames.push([rbox(0.04, top - sill, 0.3, 0.005, 1).translate(r + 0.02, (top + sill) / 2, -0.15), cream, M]);
    // 유리(하늘): 창 모양 Shape, 벽 뒤 0.28 — 기본 재질, 텍스처
    const sh = new THREE.Shape();
    _archPath(0, sill, top, winW + 0.02, sh);
    const gg = new THREE.ShapeGeometry(sh, 16);
    // uv: shape 좌표 → 0..1
    const uv = gg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + r) / winW, (uv.getY(i) - sill) / (top - sill + r));
    gg.translate(0, 0, -0.28);
    gg.applyMatrix4(M);
    glassParts.push(gg);
  };
  for (const z of winL) winFrame(R.x0, z, +1);
  for (const z of winR) winFrame(R.x1, z, -1);
  BK.wood.push(...trim, ...frames);
  const skyMat = basicMat('#ffffff', {
    map: _skyTex(),
    side: THREE.DoubleSide,
    fog: false
  });
  add(mergeGeometries(glassParts.map(q => {
    const g = q.index ? q.toNonIndexed() : q;
    for (const k of Object.keys(g.attributes))
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    return g;
  }), false), skyMat, false, false, 'sky');
  // 햇살 기둥: 왼쪽 창에서 햇빛 방향(sunDir)으로 바닥까지, 가산 혼합 반투명
  const sunDir = V3(0.95, -0.9, -0.55).normalize(); // 빛이 나아가는 방향 (왼쪽 위 뒤 → 오른쪽 아래 앞)
  VENUE.sunDir = sunDir;
  const shaftGeos = [];
  for (const z of winL) {
    const r = winW / 2,
      pts = [];
    const corners = [
      [R.x0, sill, z + r],
      [R.x0, top + r * 0.6, z + r],
      [R.x0, top + r * 0.6, z - r],
      [R.x0, sill, z - r]
    ];
    for (const c of corners) {
      const t = (c[1] - 0.0) / -sunDir.y;
      pts.push(c, [c[0] + sunDir.x * t, 0.005, c[2] + sunDir.z * t]);
    } // 창 모서리와 바닥 도달점
    const pos = [];
    const quad = (a, b, c2, d) => pos.push(...pts[a], ...pts[b], ...pts[c2], ...pts[a], ...pts[c2], ...pts[d]);
    quad(0, 1, 3, 2);
    quad(2, 3, 5, 4);
    quad(4, 5, 7, 6);
    quad(6, 7, 1, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    shaftGeos.push(g);
  }
  const shaftParts = shaftGeos.map(g => [g, '#fff0c0']);
  // 바닥에 떨어지는 햇빛 자국 (밝은 가산 사각형)
  const patchGeos = [];
  for (const z of winL) {
    const t = (sill + 1.0) / -sunDir.y;
    const px = R.x0 + sunDir.x * t,
      pz = z + sunDir.z * t;
    patchGeos.push(new THREE.PlaneGeometry(winW * 1.6, 2.6).rotateX(-Math.PI / 2).rotateY(0.5).translate(px + 0.6, 0.012, pz));
  }
  for (const g of patchGeos) {
    shaftParts.push([g, '#ffe6a8']);
    shaftParts.push([g.clone().translate(0, 0.004, 0), '#ffe6a8']);
  } // 바닥 자국은 두 겹(더 밝게)
  add(_vm(shaftParts), basicMat('#ffffff', {
    vc: true,
    transparent: true,
    opacity: 0.17,
    additive: true,
    depthWrite: false,
    side: THREE.DoubleSide
  }), false, false, 'sunlight').renderOrder = 6;

  // ---------- 천장 + 들보(격자) ----------
  BK.shell.push([new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2).translate(cx, H, cz), '#fff6e4']);
  const beams = [];
  for (let z = R.zBack - 1.3; z > R.zFront; z -= 2.6) beams.push([rbox(W, 0.3, 0.22, 0.03, 2).translate(cx, H - 0.15, z), wal]);
  for (const x of [-5.7, -1.9, 1.9, 5.7]) beams.push([rbox(0.16, 0.2, D, 0.03, 2).translate(x, H - 0.4, cz), wal]);
  beams.push([rbox(W, 0.12, 0.12, 0.02, 1).translate(cx, H - 0.06, R.zFront + 0.06), cream], [rbox(W, 0.12, 0.12, 0.02, 1).translate(cx, H - 0.06, R.zBack - 0.06), cream]);
  beams.push([rbox(0.12, 0.12, D, 0.02, 1).translate(R.x0 + 0.06, H - 0.06, cz), cream], [rbox(0.12, 0.12, D, 0.02, 1).translate(R.x1 - 0.06, H - 0.06, cz), cream]);
  BK.wood.push(...beams);

  VENUE.root = root;
  VENUE._mats = {
    matWalnut,
    matBrass,
    matBrassVC,
    cream,
    wal,
    walD
  };
  _buildStage(VENUE, root, add);
  _buildAudience(VENUE, add);
  _buildBarAndDecor(VENUE, root, add);
  _buildLights(VENUE, scene, root);
  _finishBuckets(VENUE, root, add);
  return VENUE;
}
// 버킷 → 메시 (종류당 1 드로우콜)
function _finishBuckets(VENUE, root, add) {
  const BK = VENUE._bk,
    M = VENUE._mats;
  if (BK.shell.length) add(_vm(BK.shell), toonVC({
    outline: 0,
    soft: true
  }), false, true, 'shell');
  if (BK.wood.length) add(_vm(BK.wood), M.matWalnut, true, true, 'wood');
  if (BK.metal.length) add(_vm(BK.metal), M.matBrassVC, false, false, 'metal');
  if (BK.dark.length) add(_vm(BK.dark), glossMat('#ffffff', 0.5, {
    vc: true,
    outline: 0.003
  }), true, false, 'dark');
  if (BK.toon.length) add(_vm(BK.toon), toonVC({
    outline: 0.0045
  }), true, true, 'toon');
  if (BK.lit.length) add(_vm(BK.lit), toonVC({
    outline: 0.004,
    emissive: '#fff0c8',
    emissiveIntensity: 0.8,
    soft: true
  }), false, false, 'lit');
  if (BK.unlit.length) add(_vm(BK.unlit), basicMat('#ffffff', {
    vc: true
  }), false, false, 'unlit');
  for (const key of Object.keys(BK.textured)) {
    const t = BK.textured[key];
    add(_mergeUV(t.geos), t.mat, false, false, 'textured');
  }
  if (BK.glowS.length) {
    const p = _glowPointsVC(BK.glowS, 0.5, 0.82);
    p.name = 'glowSmall';
    root.add(p);
    VENUE.anim.glowSmall = p;
  }
  if (BK.glowB.length) {
    const p = _glowPointsVC(BK.glowB, 0.95, 0.72);
    p.name = 'glowBig';
    root.add(p);
    VENUE.anim.glowBig = p;
  }
  delete VENUE._bk;
}

// ---------- 무대: 단·연주자 단·깔개·뒤 커튼·소품·조명 트러스 ----------
function _buildStage(VENUE, root, add) {
  const ST = LAYOUT.stage,
    RS = LAYOUT.riser,
    sy = LAYOUT.stageY,
    pal = STYLE.pal
  const sx = (ST.x0 + ST.x1) / 2,
    sz = (ST.zFront + ST.zBack) / 2,
    sw = ST.x1 - ST.x0,
    sd = ST.zBack - ST.zFront;
  // 단 + 연주자 단 (판자 텍스처, uv 유지해 병합)
  const plank = toonMat('#ffffff', {
    map: _plankTex('#6b3a1c'),
    outline: 0,
    soft: true
  });
  const deck = new THREE.BoxGeometry(sw, sy, sd).translate(sx, sy / 2, sz);
  const riser = new THREE.BoxGeometry(RS.w, RS.h, RS.d).translate(RS.x, sy + RS.h / 2, RS.z);
  add(_mergeUV([deck, riser]), plank, true, true, 'stage');
  // 무대 앞면(관객 쪽) 짙은 패널 + 놋쇠 테두리 (앞 모서리·옆 모서리·단 앞)
  const face = [
    [rbox(sw, sy - 0.04, 0.06, 0.01, 1).translate(sx, sy / 2 - 0.02, ST.zFront - 0.02), pal.walnutDark]
  ];
  for (let x = ST.x0 + 0.6; x < ST.x1; x += 1.2) face.push([rbox(0.9, sy - 0.16, 0.025, 0.008, 1).translate(x, sy / 2 - 0.02, ST.zFront - 0.055), pal.walnut]);
  VENUE._bk.wood.push(...face);
  const brassParts = [
    new THREE.CylinderGeometry(0.028, 0.028, sw, 12).rotateZ(Math.PI / 2).translate(sx, sy, ST.zFront),
    new THREE.CylinderGeometry(0.02, 0.02, sd, 10).rotateX(Math.PI / 2).translate(ST.x0, sy, sz),
    new THREE.CylinderGeometry(0.02, 0.02, sd, 10).rotateX(Math.PI / 2).translate(ST.x1, sy, sz),
    new THREE.CylinderGeometry(0.022, 0.022, RS.w, 10).rotateZ(Math.PI / 2).translate(RS.x, sy + RS.h, RS.z - RS.d / 2),
    new THREE.CylinderGeometry(0.018, 0.018, RS.d, 10).rotateX(Math.PI / 2).translate(RS.x - RS.w / 2, sy + RS.h, RS.z),
    new THREE.CylinderGeometry(0.018, 0.018, RS.d, 10).rotateX(Math.PI / 2).translate(RS.x + RS.w / 2, sy + RS.h, RS.z),
  ];
  for (const g of brassParts) VENUE._bk.metal.push([g, pal.brass]);
  // 깔개 (둥근 사각, 밴드 아래)
  {
    const rw = 6.2,
      rd = 3.3,
      rr = 0.45,
      s = new THREE.Shape();
    s.moveTo(-rw / 2 + rr, -rd / 2);
    s.lineTo(rw / 2 - rr, -rd / 2);
    s.quadraticCurveTo(rw / 2, -rd / 2, rw / 2, -rd / 2 + rr);
    s.lineTo(rw / 2, rd / 2 - rr);
    s.quadraticCurveTo(rw / 2, rd / 2, rw / 2 - rr, rd / 2);
    s.lineTo(-rw / 2 + rr, rd / 2);
    s.quadraticCurveTo(-rw / 2, rd / 2, -rw / 2, rd / 2 - rr);
    s.lineTo(-rw / 2, -rd / 2 + rr);
    s.quadraticCurveTo(-rw / 2, -rd / 2, -rw / 2 + rr, -rd / 2);
    const g = new THREE.ShapeGeometry(s, 8);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / rw + 0.5, uv.getY(i) / rd + 0.5);
    g.rotateX(-Math.PI / 2);
    g.translate(-0.3, sy + 0.008, -2.45);
    add(g, toonMat('#ffffff', {
      map: _rugTex(),
      outline: 0,
      soft: true
    }), false, true, 'rug');
  }
  // 무대 뒤 벽 커튼 (진홍 벨벳, 물결 주름) + 금색 밸런스
  {
    const cw = 10.4,
      ch = LAYOUT.room.h - 0.55 - sy,
      seg = 120,
      g = new THREE.PlaneGeometry(cw, ch, seg, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 7.5) * 0.07);
    g.computeVertexNormals();
    g.translate(0, sy + ch / 2, LAYOUT.room.zBack - 0.22);
    add(g, toonMat('#ffffff', {
      map: _curtainTex(),
      outline: 0
    }), false, true, 'curtain');
    const val = [
      [rbox(cw + 0.3, 0.42, 0.26, 0.04, 3).translate(0, LAYOUT.room.h - 0.5, LAYOUT.room.zBack - 0.25), '#c9962c']
    ];
    for (let x = -cw / 2; x <= cw / 2; x += 0.65) val.push([new THREE.SphereGeometry(0.07, 10, 8).translate(x, LAYOUT.room.h - 0.74, LAYOUT.room.zBack - 0.22), '#f2c14e']);
    VENUE._bk.metal.push(...val);
  }
  // 무대 천장 캐노피: 코발트 패널 + 놋쇠 테두리 + 금색 별 + 매입등 (세로 화면 맨 위에 보이는 천장)
  {
    const cz0 = ST.zFront - 0.05,
      cz1 = LAYOUT.room.zBack,
      cw = 10.6,
      cdp = cz1 - cz0,
      ccz = (cz0 + cz1) / 2,
      cy = LAYOUT.room.h - 0.015;
    VENUE._bk.shell.push([new THREE.PlaneGeometry(cw, cdp).rotateX(Math.PI / 2).translate(0, cy, ccz), '#2a4fc4']);
    const tr = [rbox(cw + 0.2, 0.1, 0.12, 0.02, 1).translate(0, cy - 0.03, cz0), rbox(0.12, 0.1, cdp, 0.02, 1).translate(-cw / 2, cy - 0.03, ccz), rbox(0.12, 0.1, cdp, 0.02, 1).translate(cw / 2, cy - 0.03, ccz)];
    for (const z of [cz0 + 1.6, cz0 + 3.6, cz0 + 5.6]) tr.push(rbox(cw, 0.06, 0.08, 0.015, 1).translate(0, cy - 0.02, z));
    for (const g of tr) VENUE._bk.metal.push([g, pal.brass]);
    const stars = [],
      rs = seeded(31);
    const starGeo = (R) => {
      const sh = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2,
          r = i % 2 ? R * 0.45 : R;
        i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      sh.closePath();
      return new THREE.ShapeGeometry(sh).rotateX(Math.PI / 2);
    };
    for (let i = 0; i < 34; i++) stars.push([starGeo(rs.range(0.05, 0.13)).translate(rs.range(-cw / 2 + 0.4, cw / 2 - 0.4), cy - 0.012, rs.range(cz0 + 0.3, cz1 - 0.3)), rs.pick(['#ffd54a', '#ffe9a0', '#f2b531'])]);
    VENUE._bk.unlit.push(...stars);
    const dpos = [];
    for (const [x, z] of [
      [-3.2, -2.6],
      [0, -2.6],
      [3.2, -2.6],
      [-3.2, 0.2],
      [0, 0.2],
      [3.2, 0.2]
    ]) {
      VENUE._bk.unlit.push([new THREE.CylinderGeometry(0.14, 0.14, 0.03, 16).translate(x, cy - 0.01, z), '#fff6dc']);
      VENUE._bk.metal.push([new THREE.TorusGeometry(0.15, 0.015, 6, 20).rotateX(Math.PI / 2).translate(x, cy - 0.02, z), '#c9962c']);
      dpos.push(x, cy - 0.06, z);
    }
    VENUE._bk.glowB.push({
      pos: dpos,
      color: '#ffe6b8'
    });
  }
  // 프로시니엄 헤더: 무대 앞 천장에 걸린 월넛 보 + 놋쇠 몰딩 + 마퀴 전구 (세로 화면 맨 위 천장 띠를 채움)
  {
    const hz = ST.zFront - 0.05,
      hy0 = LAYOUT.room.h - 0.62,
      hw = 10.6;
    const hp = [
      [rbox(hw, 0.62, 0.34, 0.04, 3).translate(0, hy0 + 0.31, hz), pal.walnutDark],
      [rbox(hw - 0.5, 0.34, 0.06, 0.02, 2).translate(0, hy0 + 0.33, hz + 0.19), pal.walnut]
    ];
    for (let x = -hw / 2 + 0.6; x < hw / 2 - 0.3; x += 1.2) hp.push([rbox(0.9, 0.22, 0.04, 0.015, 1).translate(x, hy0 + 0.33, hz + 0.23), '#c9962c']);
    for (const sx of [-1, 1]) {
      hp.push([rbox(0.34, LAYOUT.room.h - 0.62 - sy, 0.34, 0.04, 3).translate(sx * (hw / 2 - 0.17), (hy0 + sy) / 2, hz), pal.walnutDark]);
      hp.push([rbox(0.42, 0.12, 0.42, 0.02, 2).translate(sx * (hw / 2 - 0.17), sy + 0.06, hz), pal.walnut]);
      hp.push([rbox(0.42, 0.12, 0.42, 0.02, 2).translate(sx * (hw / 2 - 0.17), hy0 - 0.06, hz), pal.walnut]);
    }
    VENUE._bk.wood.push(...hp);
    VENUE._bk.metal.push([rbox(hw + 0.1, 0.07, 0.4, 0.02, 2).translate(0, hy0 - 0.035, hz), pal.brass], [rbox(hw + 0.1, 0.06, 0.4, 0.02, 2).translate(0, hy0 + 0.62, hz), pal.brass]);
    const mpos = [];
    for (let x = -hw / 2 + 0.45; x <= hw / 2 - 0.4; x += 0.42) {
      VENUE._bk.unlit.push([new THREE.SphereGeometry(0.045, 10, 8).translate(x, hy0 - 0.11, hz + 0.1), '#fff2cc']);
      mpos.push(x, hy0 - 0.11, hz + 0.1);
    }
    VENUE._bk.glowS.push({
      pos: mpos,
      color: '#ffd890'
    });
  }
  // 소품: 앰프(베이시스트 뒤), 모니터 웨지 3개(앞 가장자리, 가운데 시야 비움), 마이크 스탠드(트롬본 벨 옆)
  const B = LAYOUT.band;
  const amp = makeAmp();
  amp.position.set(-2.55, sy, -2.35);
  amp.rotation.y = 0.55;
  _bakeInto(amp, VENUE._bk);
  for (const [x, z, ry] of [
    [-2.4, -3.55, 0.15],
    [1.95, -3.55, -0.1],
    [3.7, -3.45, -0.35]
  ]) {
    const m = makeMonitor();
    m.position.set(x, sy, z);
    m.rotation.y = ry;
    _bakeInto(m, VENUE._bk);
  }
  const mic = makeMicStand(1.58, 0.36);
  mic.position.set(1.2, sy, -3.42);
  mic.rotation.y = 0.6;
  _bakeInto(mic, VENUE._bk);
  // 조명 바 (무대 앞 위, 천장에 붙은 가는 사다리형 파이프 — 프로시니엄 헤더 뒤에 숨어 그리드가 화면을 가르지 않음), 스팟 5개
  const tz = ST.zFront - 0.42,
    ty = LAYOUT.room.h - 0.3,
    tw = 9.0,
    chrome = [],
    dark = [],
    lensPos = [],
    lensCol = [];
  for (const dz of [-0.11, 0.11]) chrome.push(new THREE.CylinderGeometry(0.022, 0.022, tw, 8).rotateZ(Math.PI / 2).translate(0, ty, tz + dz));
  for (let x = -tw / 2 + 0.3; x < tw / 2; x += 0.9) chrome.push(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6).rotateX(Math.PI / 2).translate(x, ty, tz));
  for (const x of [-3.6, 0, 3.6]) chrome.push(new THREE.CylinderGeometry(0.02, 0.02, LAYOUT.room.h - ty, 8).translate(x, (LAYOUT.room.h + ty) / 2, tz));
  const fixtures = [
    [-3.5, '#ffd27a', [-1.75, 1.2, -1.75]],
    [-1.7, '#ff79b4', [-1.0, 1.3, -3.0]],
    [0.1, '#fff1d8', [0.3, 1.4, -3.0]],
    [1.8, '#7cb3ff', [2.0, 1.2, -1.6]],
    [3.5, '#ffb15c', [1.1, 1.5, -3.2]]
  ];
  VENUE.fixtures = [];
  for (const [x, col, aim] of fixtures) {
    const pos = V3(x, ty - 0.3, tz),
      dir = V3(...aim).sub(pos).normalize();
    dark.push(_bar([x, ty - 0.02, tz], [x, ty - 0.17, tz], 0.018, 8)); // 클램프
    const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), dir.clone().negate());
    dark.push(new THREE.CylinderGeometry(0.09, 0.075, 0.28, 16).applyQuaternion(q).translate(pos.x, pos.y, pos.z));
    dark.push(new THREE.TorusGeometry(0.11, 0.011, 6, 16, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI / 2).translate(pos.x, pos.y + 0.02, pos.z));
    const lens = pos.clone().add(dir.clone().multiplyScalar(0.15));
    lensPos.push(lens.x, lens.y, lens.z);
    lensCol.push(col);
    VENUE.fixtures.push({
      pos,
      dir,
      col
    });
  }
  for (const g of chrome) VENUE._bk.dark.push([g, '#3a3238']);
  for (const g of dark) VENUE._bk.dark.push([g, '#2a2830']);
  // 렌즈: 색 원판(기본 재질, 꼭짓점색) + 번짐 Points
  for (const f of VENUE.fixtures) VENUE._bk.unlit.push([new THREE.CircleGeometry(0.076, 20).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), f.dir)).translate(f.pos.x + f.dir.x * 0.141, f.pos.y + f.dir.y * 0.141, f.pos.z + f.dir.z * 0.141), f.col]);
  const lensGlow = _glowPoints(lensPos, '#ffe9c0', 0.9, 0.75);
  lensGlow.name = 'lensGlow';
  root.add(lensGlow);
  VENUE.anim.lensGlow = lensGlow;
}

// ---------- 객석: 테이블·의자·음료·촛불, 서 있는 자리, 바·스툴 ----------
function _buildAudience(VENUE, add) {
  const C = LAYOUT.crowd,
    pal = STYLE.pal,
    M = VENUE._mats,
    rnd = seeded(42);
  const furn = [],
    glass = [],
    candleGlow = [];
  const stageCenter = V3(0, 0, -2.6);
  const yawTo = (x, z) => Math.atan2(stageCenter.x - x, stageCenter.z - z); // 0 = +z 를 봄 (무대 쪽)
  // 테이블 1개: 둥근 상판(크림 대리석 느낌) + 검정 기둥·받침
  const table = (x, z) => {
    furn.push([new THREE.CylinderGeometry(0.4, 0.4, 0.035, 28).translate(x, 0.75, z), '#f6efe3']);
    furn.push([new THREE.TorusGeometry(0.39, 0.016, 8, 36).rotateX(Math.PI / 2).translate(x, 0.735, z), pal.brassDark]);
    furn.push([new THREE.CylinderGeometry(0.035, 0.035, 0.7, 10).translate(x, 0.37, z), '#22222a']);
    furn.push([new THREE.CylinderGeometry(0.2, 0.26, 0.04, 20).translate(x, 0.02, z), '#22222a']);
    // 촛불 (유리컵 + 불꽃)
    glass.push([new THREE.CylinderGeometry(0.035, 0.03, 0.06, 12).translate(x, 0.8, z), '#ffd9a0']);
    glass.push([new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8).translate(x, 0.83, z), '#fff1c0']);
    candleGlow.push(x, 0.86, z);
  };
  // 의자 1개: 벤트우드 카페 의자 (월넛), yaw 방향을 봄
  const chair = (x, z, yaw) => {
    const Mc = M4([x, 0, z], [0, yaw, 0]),
      c = pal.walnut,
      cd = pal.walnutDark;
    furn.push([new THREE.CylinderGeometry(0.21, 0.19, 0.045, 20).translate(0, 0.45, 0), c, Mc]);
    for (const [dx, dz] of [
      [0.15, 0.15],
      [-0.15, 0.15],
      [0.15, -0.15],
      [-0.15, -0.15]
    ]) furn.push([new THREE.CylinderGeometry(0.016, 0.02, 0.45, 8).translate(dx * 1.05, 0.225, dz * 1.05), cd, Mc]);
    furn.push([new THREE.TorusGeometry(0.19, 0.018, 8, 20, Math.PI).rotateY(Math.PI).translate(0, 0.72, -0.17), cd, Mc]); // 등받이 둥근 호 (뒤쪽 -z)
    for (const dx of [-0.17, 0.17]) furn.push([new THREE.CylinderGeometry(0.016, 0.016, 0.3, 8).translate(dx, 0.6, -0.17), cd, Mc]);
    furn.push([new THREE.TorusGeometry(0.14, 0.014, 8, 16, Math.PI).rotateY(Math.PI).translate(0, 0.62, -0.17), c, Mc]);
    // 등받이가 -z 쪽 → 사람은 +z 를 봄 → 의자 자체도 yaw 로 회전됨
  };
  // 음료 (테이블 위 두 잔)
  const drink = (x, z, kind) => {
    if (kind === 0) {
      glass.push([new THREE.ConeGeometry(0.055, 0.07, 16).rotateX(Math.PI).translate(x, 0.86, z), '#f0f6ff']);
      glass.push([new THREE.ConeGeometry(0.045, 0.045, 16).rotateX(Math.PI).translate(x, 0.868, z), rnd.pick(['#ff7aa8', '#7fe0c4', '#ffe36b'])]);
      glass.push([new THREE.CylinderGeometry(0.005, 0.005, 0.07, 6).translate(x, 0.79, z), '#f0f6ff']);
      glass.push([new THREE.CylinderGeometry(0.03, 0.03, 0.006, 12).translate(x, 0.755, z), '#f0f6ff']);
    } else if (kind === 1) {
      glass.push([new THREE.CylinderGeometry(0.036, 0.03, 0.09, 14).translate(x, 0.8, z), '#f0f6ff']);
      glass.push([new THREE.CylinderGeometry(0.033, 0.028, 0.055, 14).translate(x, 0.79, z), rnd.pick(['#e9a23b', '#c9452f', '#b8702a'])]);
    } else if (kind === 2) {
      glass.push([new THREE.SphereGeometry(0.04, 14, 10).scale(1, 1.15, 1).translate(x, 0.86, z), '#f0f6ff']);
      glass.push([new THREE.SphereGeometry(0.036, 14, 10).scale(1, 0.7, 1).translate(x, 0.845, z), '#9b1c3a']);
      glass.push([new THREE.CylinderGeometry(0.005, 0.005, 0.07, 6).translate(x, 0.79, z), '#f0f6ff']);
      glass.push([new THREE.CylinderGeometry(0.03, 0.03, 0.006, 12).translate(x, 0.755, z), '#f0f6ff']);
    } else {
      glass.push([new THREE.CylinderGeometry(0.04, 0.034, 0.15, 14).translate(x, 0.83, z), '#f0f6ff']);
      glass.push([new THREE.CylinderGeometry(0.037, 0.031, 0.11, 14).translate(x, 0.815, z), '#f3b53a']);
      glass.push([new THREE.CylinderGeometry(0.038, 0.038, 0.025, 14).translate(x, 0.892, z), '#fff8ea']);
    }
  };
  // 테이블 배치: 엇갈린 3줄 (11개 → 좌석 22)
  const rows = [
    [-7.95, [-5.1, -2.55, 0, 2.55, 5.1]],
    [-10.3, [-3.85, -1.3, 1.3, 3.85]],
    [-12.0, [-5.3, 5.3]]
  ];
  for (const [z, xs] of rows)
    for (const x of xs) {
      table(x, z);
      for (const a of [-0.62, 0.62]) {
        const cxp = x + Math.sin(a) * 0.62,
          czp = z - Math.cos(a) * 0.62,
          yaw = yawTo(cxp, czp) + a * 0.25;
        chair(cxp, czp, yaw);
        VENUE.seats.push({
          pos: V3(cxp, 0, czp),
          yaw,
          seatY: 0.47,
          table: V3(x, 0.77, z)
        });
      }
      drink(x - 0.17, z + 0.08, rnd.int(0, 3));
      drink(x + 0.19, z - 0.05, rnd.int(0, 3));
    }
  // 앞줄도 의자에서 시작. 내 솔로가 달아오른 뒤에만 일어난다.
  const frontSeat = (x, z, yaw) => {
    chair(x, z, yaw);
    VENUE.standSpots.push({
      pos: V3(x, 0, z),
      yaw,
      seatY: 0.47
    });
  };
  for (const x of [-4.55, -3.25, -1.95, -0.65, 0.65, 1.95, 3.25, 4.55]) frontSeat(x + rnd.range(-0.08, 0.08), -5.0 + rnd.range(-0.12, 0.12), yawTo(x, -5.0));
  for (const x of [-3.9, -2.6, -1.3, 0, 1.3, 2.6, 3.9, -5.1]) frontSeat(x + rnd.range(-0.08, 0.08), -6.15 + rnd.range(-0.12, 0.12), yawTo(x, -6.15));
  // --- 바 카운터 (오른쪽 뒤): 월넛 앞판 + 검정 상판 + 놋쇠 발걸이·상판 테두리
  const bz = C.barZ,
    bx0 = 0.5,
    bx1 = 6.1,
    bw = bx1 - bx0,
    bcx = (bx0 + bx1) / 2,
    bd = 0.66,
    bzc = bz - 0.1; // 앞면 z = bz + 0.23
  furn.push([rbox(bw, 1.05, bd, 0.03, 3).translate(bcx, 0.525, bzc), pal.walnut]);
  for (let x = bx0 + 0.25; x < bx1 - 0.1; x += 0.46) furn.push([rbox(0.3, 0.8, 0.03, 0.01, 1).translate(x, 0.55, bzc + bd / 2 + 0.01), pal.walnutDark]);
  furn.push([rbox(bw + 0.2, 0.07, bd + 0.26, 0.02, 2).translate(bcx, 1.085, bzc + 0.04), '#2a2a33']);
  const brassBar = [new THREE.CylinderGeometry(0.025, 0.025, bw - 0.2, 12).rotateZ(Math.PI / 2).translate(bcx, 0.22, bzc + bd / 2 + 0.2), new THREE.CylinderGeometry(0.016, 0.016, bw + 0.2, 10).rotateZ(Math.PI / 2).translate(bcx, 1.125, bzc + bd / 2 + 0.17)];
  for (let x = bx0 + 0.5; x < bx1; x += 1.6) brassBar.push(_bar([x, 0.22, bzc + bd / 2 + 0.2], [x, 0.0, bzc + bd / 2 + 0.05], 0.014, 8));
  for (const g of brassBar) VENUE._bk.metal.push([g, pal.brass]);
  // 백바: 벽 앞 월넛 장 + 선반 3단 + 백라이트 패널 + 윗장식
  const wz = LAYOUT.room.zFront + 0.26;
  furn.push([rbox(bw + 0.3, 1.0, 0.5, 0.02, 2).translate(bcx, 0.5, wz), pal.walnut]);
  furn.push([rbox(bw + 0.5, 0.08, 0.6, 0.015, 1).translate(bcx, 1.04, wz), '#2a2a33']);
  for (const sx of [bx0 - 0.1, bx1 + 0.1]) furn.push([rbox(0.22, 2.3, 0.4, 0.02, 2).translate(sx, 2.15, wz), pal.walnut]);
  for (const y of [1.55, 2.05, 2.55]) furn.push([rbox(bw, 0.045, 0.34, 0.01, 1).translate(bcx, y, wz), pal.walnutDark]);
  furn.push([rbox(bw + 0.6, 0.32, 0.5, 0.03, 2).translate(bcx, 3.42, wz), pal.walnut]);
  furn.push([rbox(bw + 0.7, 0.06, 0.56, 0.01, 1).translate(bcx, 3.6, wz), pal.brassDark]);
  VENUE._bk.unlit.push([new THREE.PlaneGeometry(bw - 0.05, 2.2).translate(bcx, 2.2, LAYOUT.room.zFront + 0.08), '#fff0c8']);
  // 병들 (선반 위, 꼭짓점색 토온 + 약한 자체발광)
  const bottles = [],
    bcols = ['#2f9a5a', '#d84a33', '#f0b23a', '#7a46b8', '#3c8de0', '#e8d87a', '#a53a22', '#1f9c8a', '#ff7aa8', '#ffffff'];
  for (const y of [1.57, 2.07, 2.57])
    for (let x = bx0 + 0.12; x < bx1 - 0.08; x += rnd.range(0.14, 0.2)) {
      const h = rnd.range(0.22, 0.34),
        r = rnd.range(0.035, 0.05),
        c = rnd.pick(bcols),
        kind = rnd.int(0, 2);
      if (kind === 0) {
        bottles.push([new THREE.CylinderGeometry(r, r, h, 12).translate(x, y + h / 2, wz + 0.02), c]);
        bottles.push([new THREE.CylinderGeometry(r * 0.35, r * 0.6, 0.09, 10).translate(x, y + h + 0.045, wz + 0.02), c]);
      } else if (kind === 1) {
        bottles.push([new THREE.SphereGeometry(r * 1.15, 12, 10).scale(1, 1.2, 1).translate(x, y + r * 1.3, wz + 0.02), c]);
        bottles.push([new THREE.CylinderGeometry(r * 0.3, r * 0.4, h * 0.6, 10).translate(x, y + r * 2.2 + h * 0.3, wz + 0.02), c]);
      } else {
        bottles.push([rbox(r * 1.8, h, r * 1.2, r * 0.3, 2).translate(x, y + h / 2, wz + 0.02), c]);
        bottles.push([new THREE.CylinderGeometry(r * 0.35, r * 0.5, 0.07, 10).translate(x, y + h + 0.035, wz + 0.02), c]);
      }
      bottles.push([new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.025, 10).translate(x, y + h + (kind === 1 ? h * 0.3 + r * 2.2 - h / 2 : 0) + (kind === 0 ? 0.1 : 0.08), wz + 0.02), rnd.pick(['#f2c14e', '#22222a', '#c9452f'])]);
    }
  add(_vm(bottles), toonVC({
    outline: 0.0025,
    emissive: '#5a4a3a',
    emissiveIntensity: 0.55
  }), false, false, 'bottles');
  // 스툴 4개 (크롬 기둥 + 둥근 방석) → barSpots
  const chromeP = [];
  for (const x of [1.35, 2.45, 3.55, 4.65]) {
    const z = bzc + bd / 2 + 0.6,
      yaw = yawTo(x, z) * 0.6;
    chromeP.push(new THREE.CylinderGeometry(0.022, 0.022, 0.66, 10).translate(x, 0.36, z), new THREE.CylinderGeometry(0.2, 0.24, 0.025, 20).translate(x, 0.012, z), new THREE.TorusGeometry(0.17, 0.012, 8, 20).rotateX(Math.PI / 2).translate(x, 0.26, z));
    furn.push([new THREE.CylinderGeometry(0.19, 0.17, 0.09, 22).translate(x, 0.74, z), rnd.pick(['#c93a44', '#13a08a', '#2f5bd8'])]);
    VENUE.barSpots.push({
      pos: V3(x, 0, z),
      yaw,
      stoolY: 0.785
    });
  }
  for (const g of chromeP) VENUE._bk.metal.push([g, '#dfe5ec']);
  VENUE.bartender = {
    pos: V3(3.1, 0, LAYOUT.room.zFront + 0.75),
    yaw: 0
  };
  // 왼쪽 뒤 벽 앞: 긴 벨벳 뱅킷(장식) + 작은 테이블 2개
  furn.push([rbox(6.0, 0.45, 0.6, 0.06, 3).translate(-4.0, 0.225, LAYOUT.room.zFront + 0.45), '#b3202c']);
  furn.push([rbox(6.0, 0.9, 0.18, 0.06, 3).translate(-4.0, 0.75, LAYOUT.room.zFront + 0.2), '#b3202c']);
  for (let x = -6.6; x < -1.5; x += 0.75) furn.push([new THREE.SphereGeometry(0.06, 8, 6).translate(x, 0.85, LAYOUT.room.zFront + 0.3), '#8e1a2a']);
  table(-5.2, LAYOUT.room.zFront + 1.25);
  table(-2.8, LAYOUT.room.zFront + 1.25);
  drink(-5.0, LAYOUT.room.zFront + 1.2, 3);
  drink(-3.0, LAYOUT.room.zFront + 1.3, 0);
  // 병합
  VENUE._bk.wood.push(...furn);
  add(_vm(glass), glossMat('#ffffff', 0.12, {
    vc: true,
    outline: 0.0022,
    env: 1.0
  }), false, false, 'glasses');
  VENUE._bk.glowS.push({
    pos: candleGlow,
    color: '#ffc070'
  });
}

// ---------- 장식: 화분·전구줄·펜던트·천장 선풍기·액자·네온·벽등 ----------
function _buildBarAndDecor(VENUE, root, add) {
  const R = LAYOUT.room,
    pal = STYLE.pal,
    M = VENUE._mats,
    sy = LAYOUT.stageY,
    rnd = seeded(77),
    H = R.h;
  // --- 화분 (테라코타 + 큰 잎)
  const pots = [],
    leaves = [];
  const plant = (x, y, z, s = 1, n = 9) => {
    pots.push([latheY([
      [0.0001, 0],
      [0.2, 0],
      [0.24, 0.42],
      [0.27, 0.5],
      [0.25, 0.52],
      [0.21, 0.52],
      [0.21, 0.45],
      [0.0001, 0.45]
    ], 20).scale(s, s, s).translate(x, y, z), '#d9683a']);
    pots.push([new THREE.CylinderGeometry(0.2 * s, 0.2 * s, 0.03, 16).translate(x, y + 0.45 * s, z), '#3b2a1c']);
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + rnd.range(-0.25, 0.25),
        h = rnd.range(0.55, 1.25) * s,
        lean = rnd.range(0.25, 0.55),
        col = rnd.pick(['#2f8f4e', '#3fa85e', '#237a45', '#4cb86a']);
      const ex = Math.cos(a) * lean * h,
        ez = Math.sin(a) * lean * h;
      leaves.push([_bar([x, y + 0.42 * s, z], [x + ex, y + 0.42 * s + h, z + ez], 0.014 * s, 6), '#2d6b36']);
      const leaf = new THREE.SphereGeometry(0.3 * s, 12, 8).scale(1.7, 0.1, 0.9);
      leaves.push([leaf.rotateZ(rnd.range(0.35, 0.65)).rotateY(-a + Math.PI).translate(x + ex * 1.25, y + 0.42 * s + h + 0.05, z + ez * 1.25), col]);
    }
  };
  plant(-6.8, 0, -13.0, 1.25, 10);
  plant(6.8, 0, -12.4, 1.2, 10);
  plant(6.9, 0, -4.4, 1.0, 9);
  plant(-6.9, 0, -3.2, 0.95, 9);
  plant(-4.35, sy, 1.35, 0.9, 8);
  plant(4.35, sy, 1.55, 0.95, 8);
  plant(4.4, sy, -3.2, 0.7, 7);
  VENUE._bk.toon.push(...pots);
  add(_vm(leaves), toonVC({
    outline: 0.003,
    side: THREE.DoubleSide
  }), true, false, 'leaves');
  // --- 전구줄 (처진 곡선) : 선(어두운 튜브) + 전구(자체발광 구) + 번짐 Points
  const wires = [],
    bulbs = [],
    bulbPos = [];
  const string = (a, b, sag, step = 0.34) => {
    const A = V3(...a),
      B = V3(...b),
      n = 24,
      pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n,
        p = A.clone().lerp(B, t);
      p.y -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    wires.push(new THREE.TubeGeometry(curve, 48, 0.008, 5, false));
    const L = curve.getLength(),
      k = Math.floor(L / step);
    for (let i = 1; i < k; i++) {
      const p = curve.getPointAt(i / k);
      bulbs.push(new THREE.SphereGeometry(0.03, 8, 6).translate(p.x, p.y - 0.05, p.z));
      bulbs.push(new THREE.CylinderGeometry(0.012, 0.014, 0.04, 6).translate(p.x, p.y - 0.015, p.z));
      bulbPos.push(p.x, p.y - 0.05, p.z);
    }
  };
  string([R.x0 + 0.1, 4.25, -5.3], [R.x1 - 0.1, 4.25, -5.3], 0.55);
  string([R.x0 + 0.1, 4.2, -8.6], [R.x1 - 0.1, 4.2, -8.6], 0.6);
  string([R.x0 + 0.1, 4.25, -11.8], [R.x1 - 0.1, 4.25, -11.8], 0.55);
  string([R.x0 + 0.3, 4.3, -4.2], [R.x1 - 0.3, 4.3, -13.6], 0.75, 0.4);
  for (const g of wires) VENUE._bk.dark.push([g, '#2a2630']);
  for (const g of bulbs) VENUE._bk.unlit.push([g, '#fff3cc']);
  VENUE._bk.glowS.push({
    pos: bulbPos,
    color: '#ffd890'
  });
  // --- 펜던트 (놋쇠 갓 + 전구): 테이블 위 5개(한 그룹), 바 위 2개(한 그룹) — 그룹째 살짝 흔들림
  const pendantGroup = (list, name, shadeR, dropY) => {
    const grp = new THREE.Group();
    grp.name = name;
    grp.position.set(0, H, 0);
    root.add(grp);
    const parts = [],
      glow = [];
    for (const [x, z] of list) {
      parts.push([new THREE.CylinderGeometry(0.006, 0.006, H - dropY, 6).translate(x, -(H - dropY) / 2, z), '#2a2630']);
      parts.push([new THREE.CylinderGeometry(0.06, 0.08, 0.05, 12).translate(x, -0.025, z), pal.brassDark]);
      parts.push([latheY([
        [0.03, 0.2],
        [0.07, 0.17],
        [0.16, 0.08],
        [shadeR, 0.0],
        [shadeR - 0.01, -0.012],
        [0.14, 0.06],
        [0.06, 0.15],
        [0.025, 0.18]
      ], 28).translate(x, -(H - dropY) - 0.2, z), pal.brass]);
      VENUE._bk.lit.push([new THREE.SphereGeometry(0.055, 12, 8).translate(x, H - (H - dropY) - 0.06, z), '#fff4d6']); // 전구는 정적(흔들림 폭이 작아 티 안 남)
      glow.push(x, H - (H - dropY) - 0.07, z);
    }
    grp.add(new THREE.Mesh(_vm(parts), M.matBrassVC));
    VENUE._bk.glowB.push({
      pos: glow,
      color: '#ffd9a0'
    });
    return grp;
  };
  VENUE.anim.pendA = pendantGroup([
    [-2.55, -7.95],
    [2.55, -7.95],
    [-3.85, -10.3],
    [3.85, -10.3],
    [0, -10.3]
  ], 'pendantsTables', 0.26, 2.3);
  VENUE.anim.pendB = pendantGroup([
    [1.6, -13.75],
    [3.3, -13.75],
    [5.0, -13.75]
  ], 'pendantsBar', 0.18, 2.55);
  // 서 있는 구역 위 큰 유리 구 펜던트 3개 (높게)
  {
    const glow = []; // 구 펜던트는 정적 (버킷)
    for (const [x, y, z, r] of [
      [-2.3, 3.75, -5.0, 0.22],
      [0.5, 3.95, -5.9, 0.19],
      [2.7, 3.65, -5.1, 0.24]
    ]) {
      VENUE._bk.dark.push([new THREE.CylinderGeometry(0.006, 0.006, H - y, 6).translate(x, H - (H - y) / 2, z), '#2a2630']);
      VENUE._bk.metal.push([new THREE.CylinderGeometry(0.05, 0.07, 0.05, 12).translate(x, H - 0.025, z), pal.brassDark]);
      VENUE._bk.metal.push([new THREE.CylinderGeometry(0.05, 0.06, 0.07, 12).translate(x, y + 0.02, z), pal.brass]);
      VENUE._bk.lit.push([new THREE.SphereGeometry(r, 24, 16).translate(x, y - r + 0.02, z), '#fff3d8']);
      glow.push(x, y - r + 0.02, z);
    }
    VENUE._bk.glowB.push({
      pos: glow,
      color: '#ffe0a8'
    });
  }
  // --- 천장 선풍기 (월넛 날개 4장)
  {
    const fan = new THREE.Group();
    fan.name = 'fan';
    fan.position.set(0, H - 0.5, -8.6);
    root.add(fan);
    const fp = [
      [new THREE.CylinderGeometry(0.05, 0.05, 0.5, 10).translate(0, 0.25, 0), pal.brassDark],
      [new THREE.CylinderGeometry(0.17, 0.2, 0.2, 20).translate(0, 0.0, 0), pal.brassDark],
      [new THREE.SphereGeometry(0.1, 12, 8).scale(1, 0.6, 1).translate(0, -0.1, 0), pal.brass]
    ];
    for (let i = 0; i < 4; i++) fp.push([rbox(1.1, 0.025, 0.2, 0.03, 2).translate(0.72, -0.02, 0).rotateY(i * Math.PI / 2), pal.walnut]);
    fan.add(new THREE.Mesh(_vm(fp), M.matBrassVC));
    VENUE.anim.fan = fan;
  }
  // --- 액자 (아틀라스 한 장 → 네 그림), 틀은 월넛+금
  const atlas = _artAtlas(),
    artGeos = [],
    frames = [];
  const art = (k, w, h, pos, rotY) => {
    const Ma = M4(pos, [0, rotY, 0]);
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / 4);
    g.applyMatrix4(Ma);
    artGeos.push(g);
    // 틀: 바깥 월넛 네 변 + 안쪽 금색 네 변 (그림은 안쪽에 들어가 보이게 +z 로 0.01)
    const bar4 = (W2, H2, t, dpt, zc, col) => {
      frames.push([rbox(W2 + 2 * t, t, dpt, 0.006, 1).translate(0, H2 / 2 + t / 2, zc), col, Ma]);
      frames.push([rbox(W2 + 2 * t, t, dpt, 0.006, 1).translate(0, -H2 / 2 - t / 2, zc), col, Ma]);
      frames.push([rbox(t, H2, dpt, 0.006, 1).translate(W2 / 2 + t / 2, 0, zc), col, Ma]);
      frames.push([rbox(t, H2, dpt, 0.006, 1).translate(-W2 / 2 - t / 2, 0, zc), col, Ma]);
    };
    bar4(w + 0.08, h + 0.08, 0.07, 0.06, 0.02, pal.walnutDark);
    bar4(w, h, 0.04, 0.03, 0.01, '#f2c14e');
  };
  // 왼벽 창 사이, 오른벽, 뒷벽 왼쪽
  art(0, 0.95, 1.15, [R.x0 + 0.075, 2.35, -7.1], Math.PI / 2);
  art(1, 0.95, 1.15, [R.x0 + 0.075, 2.35, -10.1], Math.PI / 2);
  art(2, 1.3, 0.95, [R.x1 - 0.075, 2.4, -4.9], -Math.PI / 2);
  art(3, 0.9, 1.15, [R.x1 - 0.075, 2.35, -8.9], -Math.PI / 2);
  art(0, 1.0, 1.2, [R.x1 - 0.075, 2.4, -12.9], -Math.PI / 2);
  art(1, 1.1, 1.35, [-6.3, 2.45, R.zFront + 0.075], 0);
  art(3, 1.25, 1.0, [-0.95, 2.4, R.zFront + 0.075], 0);
  add(mergeGeometries(artGeos.map(q => {
    const g = q.index ? q.toNonIndexed() : q;
    for (const k of Object.keys(g.attributes))
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    return g;
  }), false), toonMat('#ffffff', {
    map: atlas,
    outline: 0,
    soft: true
  }), false, false, 'art');
  VENUE._bk.wood.push(...frames);
  // --- 네온: 트럼펫 실루엣(분홍) + 별들(노랑) — 뒷벽 왼쪽 위, 글자 없음
  const neonPink = [],
    neonYellow = [],
    neonGlow = [],
    glowCol = [];
  const neonPath = (pts2d, cx, cy, s, closed, list, col, r = 0.022) => {
    const pts = pts2d.map(p => V3(cx + p[0] * s, cy + p[1] * s, R.zFront + 0.12));
    const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', closed ? 0.5 : 0.3);
    list.push([new THREE.TubeGeometry(curve, pts.length * 4, r, 6, closed), col]);
    const L = curve.getLength(),
      k = Math.max(2, Math.floor(L / 0.18));
    for (let i = 0; i < k; i++) {
      const p = curve.getPointAt(i / k);
      neonGlow.push(p.x, p.y, p.z + 0.02);
    }
  };
  const trumpet = [
    [-0.5, 0.0],
    [-0.44, 0.035],
    [-0.3, 0.052],
    [0.05, 0.062],
    [0.27, 0.085],
    [0.4, 0.17],
    [0.5, 0.27],
    [0.5, -0.27],
    [0.4, -0.17],
    [0.27, -0.085],
    [0.05, -0.068],
    [-0.15, -0.08],
    [-0.34, -0.14],
    [-0.43, -0.06],
    [-0.5, -0.0]
  ];
  const tcx = -3.5,
    tcy = 3.15,
    ts = 2.6;
  neonPath(trumpet, tcx, tcy, ts, true, neonPink, '#ff5fa8');
  for (const vx of [-0.1, 0.0, 0.1]) neonPath([
    [vx, 0.06],
    [vx, 0.2],
    [vx + 0.035, 0.22]
  ], tcx, tcy, ts, false, neonPink, '#ff5fa8', 0.02);
  neonPath([
    [-0.2, -0.08],
    [-0.22, -0.2],
    [-0.05, -0.2],
    [-0.03, -0.07]
  ], tcx, tcy, ts, false, neonPink, '#ff5fa8', 0.018);
  const star = (n = 5, ri = 0.42) => {
    const p = [];
    for (let i = 0; i < n * 2; i++) {
      const a = i / (n * 2) * Math.PI * 2 - Math.PI / 2,
        r = i % 2 ? ri : 1;
      p.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return p;
  };
  for (const [x, y, s] of [
    [-6.4, 4.1, 0.22],
    [-5.5, 2.1, 0.17],
    [-1.1, 4.0, 0.25],
    [-0.35, 3.1, 0.15],
    [1.2, 4.15, 0.18],
    [3.3, 4.2, 0.22],
    [5.6, 4.1, 0.18],
    [6.9, 3.4, 0.14],
    [-2.1, 1.9, 0.14]
  ]) neonPath(star(), x, y, s, true, neonYellow, '#ffe36b', 0.016);
  const neonMat = basicMat('#ffffff', {
    vc: true
  });
  add(_vm(neonPink.concat(neonYellow)), neonMat, false, false, 'neon');
  const ng = _glowPoints(neonGlow, '#ff9ccc', 0.55, 0.5);
  ng.name = 'neonGlow';
  root.add(ng);
  VENUE.anim.neon = {
    mat: neonMat,
    glow: ng
  };
  // --- 벽등 (놋쇠 받침 + 크림 갓): 뒷벽 바 양옆, 무대 뒤 벽 양쪽
  const sconce = [],
    sconceGlow = [];
  const sc = (x, y, z, rotY) => {
    const Ms = M4([x, y, z], [0, rotY, 0]);
    sconce.push([rbox(0.12, 0.3, 0.03, 0.01, 1).translate(0, 0, 0.015), pal.brassDark, Ms]);
    sconce.push([_bar([0, -0.08, 0.02], [0, 0.0, 0.16], 0.012, 8), pal.brass, Ms]);
    sconce.push([latheY([
      [0.03, 0],
      [0.11, 0.2],
      [0.105, 0.21],
      [0.04, 0.02]
    ], 16).translate(0, 0.02, 0.16), pal.cream, Ms]);
    sconceGlow.push(x, y + 0.1, z + 0.2 * Math.cos(rotY));
  };
  sc(0.15, 2.7, R.zFront + 0.03, 0);
  sc(6.6, 2.7, R.zFront + 0.03, 0);
  sc(-7.2, 2.7, R.zFront + 0.03, 0);
  sc(-5.9, 2.9, R.zBack - 0.03, Math.PI);
  sc(5.9, 2.9, R.zBack - 0.03, Math.PI);
  VENUE._bk.metal.push(...sconce);
  VENUE._bk.glowB.push({
    pos: sconceGlow,
    color: '#ffd9a0'
  });
}

// ---------- 조명 + 분위기/애니메이션 ----------
function _buildLights(VENUE, scene, root) {
  const L = VENUE.lights;
  scene.fog = new THREE.Fog('#f6e8d2', 16, 75);
  const hemi = new THREE.HemisphereLight('#dfeeff', '#c08a5a', 1.15);
  scene.add(hemi);
  L.hemi = hemi;
  // 해: 왼쪽 창 쪽에서 (sunDir 방향으로 진행)
  const sun = new THREE.DirectionalLight('#ffe0b0', 3.1);
  const tgt = V3(-0.5, 1.0, -4.5),
    d = VENUE.sunDir;
  sun.position.copy(tgt).addScaledVector(d, -18);
  sun.target.position.copy(tgt);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -9,
    right: 9,
    top: 8,
    bottom: -8,
    near: 2,
    far: 42
  });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);
  VENUE.sun = sun;
  L.sun = sun;
  const spot = (name, color, I, pos, aim, angle, pen = 0.6) => {
    const s = new THREE.SpotLight(color, I, 16, angle, pen, 2.0);
    s.position.set(...pos);
    s.target.position.set(...aim);
    scene.add(s);
    scene.add(s.target);
    L[name] = s;
    s.userData.base = I;
    s.userData.aim = V3(...aim);
    return s;
  };
  spot('key', '#ffd9a8', 48, [0.2, 3.75, -1.2], [0.0, 1.2, -2.8], 0.62, 0.6);
  spot('pink', '#ff6fb0', 34, [-1.7, 4.2, -4.3], [-1.7, 1.0, -1.9], 0.42, 0.7);
  spot('blue', '#6fa8ff', 34, [1.8, 4.2, -4.3], [1.9, 1.0, -1.4], 0.42, 0.7);
  const bar = new THREE.PointLight('#ffb470', 26, 7, 2);
  bar.position.set(3.3, 2.4, LAYOUT.crowd.barZ - 0.6);
  scene.add(bar);
  L.bar = bar;
  // 분위기: 관객 열기(0..1)에 따라 무대 조명 세기·흔들림
  VENUE.setMood = (heat01, t = 0) => {
    const h = clamp(heat01, 0, 1);
    L.key.intensity = (48 + 34 * h) * (VENUE.keyK == null ? 1 : VENUE.keyK);
    L.pink.intensity = 34 + 50 * h;
    L.blue.intensity = 34 + 50 * h;
    L.pink.target.position.set(L.pink.userData.aim.x + Math.sin(t * 1.7) * 0.7 * h, L.pink.userData.aim.y, L.pink.userData.aim.z + Math.cos(t * 1.3) * 0.5 * h);
    L.blue.target.position.set(L.blue.userData.aim.x + Math.sin(t * 1.4 + 1) * 0.7 * h, L.blue.userData.aim.y, L.blue.userData.aim.z + Math.cos(t * 1.9) * 0.5 * h);
    if (VENUE.anim.lensGlow) {
      VENUE.anim.lensGlow.material.size = 0.9 + 0.7 * h;
      VENUE.anim.lensGlow.material.opacity = 0.75 + 0.25 * h;
    }
  };
  const A = VENUE.anim, rnd = seeded(9);
  let flick = 0, flickT = 0;
  VENUE.rumble = k => {
    A.rumble = Math.min(1.4, (A.rumble || 0) + k);
  };
  VENUE.update = (dt, t) => {
    if (A.fan) A.fan.rotation.y += dt * 3.2;
    if (A.rumble > 0.005) {
      A.rumble = Math.max(0, A.rumble - dt * 1.2);
      const r = A.rumble;
      if (!A.glassMesh) A.glassMesh = root.getObjectByName('glasses');
      if (A.glassMesh) A.glassMesh.position.set(Math.sin(t * 61) * 0.008 * r, Math.abs(Math.sin(t * 47)) * 0.018 * r, Math.sin(t * 53 + 1) * 0.008 * r);
      if (A.pendA) A.pendA.position.x = Math.sin(t * 37) * 0.012 * r;
      if (A.pendB) A.pendB.position.x = Math.sin(t * 41 + 1) * 0.012 * r;
    } else if (A.glassMesh && A.glassMesh.position.y !== 0) {
      A.glassMesh.position.set(0, 0, 0);
      if (A.pendA) A.pendA.position.x = 0;
      if (A.pendB) A.pendB.position.x = 0;
    }
    if (A.pendA) A.pendA.rotation.z = Math.sin(t * 0.8) * 0.012, A.pendA.rotation.x = Math.sin(t * 0.63 + 1.2) * 0.008;
    if (A.pendB) A.pendB.rotation.z = Math.sin(t * 0.95 + 2.0) * 0.015;
    if (A.neon) {
      // 가끔 짧게 깜빡이는 네온
      flickT -= dt;
      if (flickT <= 0) {
        flick = rnd.chance(0.25) ? rnd.range(0.35, 0.7) : 1;
        flickT = flick < 1 ? rnd.range(0.04, 0.12) : rnd.range(0.8, 3.5);
      }
      const k = flick * (0.94 + 0.06 * Math.sin(t * 23));
      A.neon.mat.color.setScalar(k);
      A.neon.glow.material.opacity = 0.5 * k;
    }
    if (A.glowSmall) A.glowSmall.material.opacity = 0.78 + 0.06 * Math.sin(t * 2.6) + 0.03 * Math.sin(t * 9.1); // 전구줄·촛불 살짝 일렁임
  };
  VENUE.setMood(0, 0);
}

// ===== 22_instruments.js =====
// ===================== 악기 (실측 미터 단위, 셀 셰이딩용 닫힌 형태) =====================
// 공용 규칙
//  - 모든 나팔(벨)은 안팎 이중 벽으로 닫힌 회전체(bellShell) → 어느 쪽에서 봐도 뚫려 보이지 않음.
//    (OutlineEffect는 뒷면을 검게 밀어내 그리므로, 카메라에 뒷면이 보이는 한 겹짜리 면은 검게 뚫려 보인다)
//  - 금속: metalMat, 나무: glossMat, 나머지: toonMat/toonVC. 정적 부품은 재질별로 1개 메시로 병합.
//  - 손 위치·연주 지점은 anchor()로 이름 붙인 빈 Object3D.

// ---------- 이 파일 전용 도우미 ----------
function _mesh(geo, mat, cast = true, recv = false) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = recv;
  return m;
}
// uv를 보존한 병합 (텍스처 입힐 때). 모든 조각에 uv가 있어야 함
function _mergeUV(list) {
  return mergeGeometries(list.map(g => {
    let q = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(q.attributes))
      if (k !== 'position' && k !== 'normal' && k !== 'uv') q.deleteAttribute(k);
    return q;
  }), false);
}

// z축 방향 원기둥 (zc 중심)
function _cylZ(r, len, x, y, zc, rs = 14, r2) {
  return new THREE.CylinderGeometry(r, r2 == null ? r : r2, len, rs).rotateX(Math.PI / 2).translate(x, y, zc);
}
// x축 방향 원기둥 (xc 중심)
function _cylX(r, len, xc, y, z, rs = 14, r2) {
  return new THREE.CylinderGeometry(r, r2 == null ? r : r2, len, rs).rotateZ(Math.PI / 2).translate(xc, y, z);
}
// y축 방향 원기둥 (yc 중심)
function _cylY(r, len, x, yc, z, rs = 14, r2) {
  return new THREE.CylinderGeometry(r, r2 == null ? r : r2, len, rs).translate(x, yc, z);
}

// 두 점을 잇는 막대 (양 끝에 살짝 두꺼운 플랜지 선택)
function _bar(a, b, r, rs = 10, flange = 0) {
  const A = V3(...a),
    B = V3(...b),
    d = B.clone().sub(A),
    len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, rs);
  const list = [g];
  if (flange) {
    list.push(new THREE.CylinderGeometry(r * 1.7, r * 1.7, flange, rs).translate(0, len / 2 - flange / 2, 0));
    list.push(new THREE.CylinderGeometry(r * 1.7, r * 1.7, flange, rs).translate(0, -len / 2 + flange / 2, 0));
  }
  const geo = mergeGeometries(list.map(q => q.toNonIndexed()), false);
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.clone().normalize());
  geo.applyQuaternion(q);
  geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return geo;
}
// U자 굽이 (반토러스). plane: 'yz' = 수직면(x 고정)에서 ±z 쪽으로 불룩, 'xy' = 수직면(z 고정)에서 ±x 쪽으로 불룩
// 중심 c=[x,y,z], 반지름 R(두 다리 사이 거리/2), 관 반지름 r, dir = 불룩한 방향 부호
function _uBend(plane, c, R, r, dir = -1, rs = 10, ts = 14) {
  const g = new THREE.TorusGeometry(R, r, rs, ts, Math.PI);
  // 기본: XY 평면, 각도 0(+x)에서 시작해 +y 쪽으로 반바퀴 → 다리 양 끝이 (±R, 0)… -90°에서 시작하게 돌려 다리를 y축 상하로
  g.rotateZ(-Math.PI / 2); // 이제 호는 -y 에서 +x 를 지나 +y 로 (불룩한 쪽 +x)
  if (plane === 'yz') g.rotateY(dir < 0 ? Math.PI / 2 : -Math.PI / 2); // +x 를 ∓z 로
  else if (dir < 0) g.rotateY(Math.PI); // xy 평면에서 -x 쪽으로
  g.translate(c[0], c[1], c[2]);
  return g;
}
// 닫힌 나팔(벨) 회전체: 목 반지름 r0 → 테두리 반지름 r1, 길이 len, 축은 +y (목이 y=0, 테두리가 y=len)
// pow: 벌어지는 정도(클수록 끝에서 급히 벌어짐). wall: 두께. 테두리에 둥근 비드, 안쪽 벽은 목까지 내려가 작은 구멍으로 닫힘
function bellShell(len, r0, r1, pow = 3, wall = 0.0025, seg = 48, n = 26) {
  const pts = [];
  const f = t => r0 + (r1 - r0) * (Math.pow(t, pow) * 0.88 + 0.12 * Math.pow(t, 1.4));
  pts.push([f(0), 0]);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    pts.push([f(t), t * len]);
  }
  const b = Math.max(wall * 1.6, 0.0025); // 비드 반지름
  for (let i = 1; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI;
    pts.push([r1 + b * Math.cos(a) - b * 0.2, len + b * Math.sin(a) + b * 0.1]);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    pts.push([Math.max(r0 * 0.55, f(t) - wall), t * len]);
  }
  pts.push([r0 * 0.4, 0.0]);
  pts.push([f(0), 0]);
  return latheY(pts, seg).rotateX(-Math.PI / 2); // 축 +y → -z : 목이 z=0, 테두리가 z=-len
}
// 마우스피스 (잔 모양, 축 +y: 림이 y=0, 생크가 -y 쪽)… 호출 쪽에서 회전
function mouthpieceGeo(rimR, cupDepth, shankLen, shankR, seg = 24) {
  const pts = [
    [shankR * 0.75, -shankLen],
    [shankR, -shankLen * 0.85],
    [shankR * 1.15, -cupDepth * 1.6],
    [rimR * 0.7, -cupDepth * 0.9],
    [rimR * 0.97, -cupDepth * 0.3],
    [rimR, 0],
    [rimR * 0.78, 0.0005],
    [rimR * 0.55, -cupDepth * 0.35],
    [rimR * 0.28, -cupDepth * 0.8],
    [rimR * 0.16, -cupDepth],
    [rimR * 0.16, -cupDepth * 1.3],
    [shankR * 0.4, -shankLen],
    [shankR * 0.75, -shankLen],
  ];
  return latheY(pts, seg);
}
// 관 끝 장식 고리(페룰)
function _ferruleZ(r, len, x, y, zc, rs = 16) {
  return _cylZ(r, len, x, y, zc, rs);
}

// =====================================================================
// a) 트럼펫 — 마우스피스 +z, 벨 -z, 버튼 +y. 원점 = 2번 밸브 몸통 중심
// =====================================================================
function makeTrumpet() {
  const g = new THREE.Group();
  g.name = 'trumpet';
  const brass = metalMat(STYLE.pal.brass, 0.2, {
    outline: 0.0035
  });
  const silver = metalMat('#dfe5ec', 0.15, {
    outline: 0.0035
  });
  const pearl = glossMat('#fbf7f0', 0.3, {
    outline: 0.003
  });
  const cork = toonMat('#b8865a', {
    outline: 0.003
  });
  const B = []; // 놋쇠 조각
  const vz = [0.028, 0, -0.028],
    rc = 0.0118; // 밸브 1·2·3 z 위치 (1번이 입 쪽)
  // 밸브 몸통 + 위아래 캡
  for (const z of vz) {
    B.push(_cylY(rc, 0.11, 0, -0.003, z, 22));
    B.push(_cylY(0.0138, 0.012, 0, 0.058, z, 22)); // 위 캡
    B.push(_cylY(0.0138, 0.012, 0, -0.064, z, 22)); // 아래 캡
    B.push(new THREE.SphereGeometry(0.0105, 14, 8).scale(1, 0.45, 1).translate(0, -0.072, z)); // 아래 캡 둥근 끝
  }
  // 벨 관 (왼쪽 위): 뒤쪽 굽이(백 보우)에서 앞으로
  const bx = -0.017,
    by = 0.040,
    rb = 0.0088;
  B.push(_cylZ(rb, 0.105, bx, by, 0.085 - 0.0525, 16)); // z 0.085 → -0.02
  B.push(_uBend('yz', [bx, (by + -0.016) / 2, 0.085], (by + 0.016) / 2, rb, +1, 10, 16)); // 뒤 굽이 (+z 쪽으로 불룩)
  B.push(_cylZ(rb, 0.085 - 0.028, bx, -0.016, (0.085 + 0.028) / 2, 16)); // 아래 다리: 1번 밸브 → 뒤
  // 벨: 목 z=-0.02 → 테두리 z=-0.215 (길이 0.195, 테두리 반지름 0.062)
  B.push(bellShell(0.195, rb, 0.062, 3.0, 0.0022, 56, 30).translate(bx, by, -0.02));
  B.push(_ferruleZ(rb * 1.25, 0.012, bx, by, -0.018, 16));
  // 리드파이프 (오른쪽): 입 쪽 리시버에서 앞으로 → 앞 튜닝 슬라이드 U → 아래 다리로 3번 밸브
  const lx = 0.019,
    ly = 0.012,
    rl = 0.0078,
    ty = -0.034;
  B.push(_cylZ(rl, 0.205 + 0.05, lx, ly, (0.205 - 0.05) / 2, 14)); // z 0.205 → -0.05
  B.push(_cylZ(0.0098, 0.04, lx, ly, 0.185, 16)); // 리시버
  B.push(_cylZ(0.0115, 0.006, lx, ly, 0.206, 16)); // 리시버 끝 고리
  // 튜닝 슬라이드 (조금 굵음): 두 다리 z -0.05 → -0.105 + U
  B.push(_cylZ(0.0086, 0.06, lx, ly, -0.078, 14));
  B.push(_cylZ(0.0086, 0.06, lx, ty, -0.078, 14));
  B.push(_uBend('yz', [lx, (ly + ty) / 2, -0.105], (ly - ty) / 2, 0.0086, -1, 10, 16));
  B.push(_ferruleZ(0.0105, 0.01, lx, ly, -0.05, 16));
  B.push(_ferruleZ(0.0105, 0.01, lx, ty, -0.05, 16));
  B.push(_cylZ(rl, 0.05 - 0.028 + 0.006, lx, ty, (-0.05 - 0.028) / 2 + 0.003, 14)); // 아래 다리 → 3번 밸브
  B.push(_bar([lx, ly - 0.004, -0.09], [lx, ty + 0.004, -0.09], 0.0022, 8, 0.002)); // 슬라이드 가로 버팀
  // 밸브 슬라이드들 (두 다리 + U). 1번: 뒤(+z), 2번: 오른쪽(+x), 3번: 앞(-z)
  const sy1 = -0.028,
    sy2 = -0.052,
    rs = 0.0062,
    R = (sy1 - sy2) / 2,
    yc = (sy1 + sy2) / 2;
  B.push(_cylZ(rs, 0.105 - 0.028, 0, sy1, (0.105 + 0.028) / 2, 12));
  B.push(_cylZ(rs, 0.105 - 0.028, 0, sy2, (0.105 + 0.028) / 2, 12));
  B.push(_uBend('yz', [0, yc, 0.105], R, rs, +1, 10, 14));
  B.push(_cylX(rs, 0.04, 0.02, sy1, 0, 12));
  B.push(_cylX(rs, 0.04, 0.02, sy2, 0, 12));
  B.push(_uBend('xy', [0.04, yc, 0], R, rs, +1, 10, 14));
  B.push(_cylZ(rs, 0.135 - 0.028, 0, sy1, -(0.135 + 0.028) / 2, 12));
  B.push(_cylZ(rs, 0.135 - 0.028, 0, sy2, -(0.135 + 0.028) / 2, 12));
  B.push(_uBend('yz', [0, yc, -0.135], R, rs, -1, 10, 14));
  for (const z of [0.07, -0.07, -0.115]) B.push(_bar([0, sy1 - 0.002, z], [0, sy2 + 0.002, z], 0.002, 8, 0.0015)); // 슬라이드 버팀
  // 3번 슬라이드 고리, 1번 엄지 안장
  B.push(new THREE.TorusGeometry(0.0105, 0.0017, 8, 20).translate(0, sy1 + 0.0105 + 0.004, -0.1));
  {
    const sad = new THREE.TorusGeometry(0.008, 0.0016, 8, 12, Math.PI);
    sad.translate(0, sy1 + 0.009, 0.075);
    B.push(sad);
  } // 1번 엄지 안장
  // 새끼손가락 고리 (리드파이프 위, 밸브 앞)
  B.push(new THREE.TorusGeometry(0.0095, 0.0016, 8, 14, Math.PI).rotateY(Math.PI / 2).translate(lx, ly + 0.004, -0.045));
  // 버팀대: 벨관 ↔ 리드파이프
  B.push(_bar([bx + 0.005, by - 0.004, -0.075], [lx - 0.004, ly + 0.004, -0.075], 0.0028, 8, 0.0025));
  B.push(_bar([bx + 0.005, by - 0.004, 0.06], [lx - 0.004, ly + 0.004, 0.06], 0.0028, 8, 0.0025));
  B.push(_bar([bx + 0.003, -0.016 + 0.003, 0.1], [lx - 0.003, ly - 0.003, 0.1], 0.0024, 8, 0.002)); // 뒤 굽이 아래다리 ↔ 리드파이프
  // 워터키 (튜닝 슬라이드 U 아래, 3번 슬라이드 U 아래): 레버 + 코르크 컵
  const wk = (x, y, z) => {
    B.push(rbox(0.006, 0.004, 0.03, 0.0015, 1).translate(x, y, z));
    B.push(_cylY(0.0045, 0.004, x, y - 0.002, z + 0.012, 10));
  };
  wk(lx, ty - 0.0105, -0.095);
  wk(0, sy2 - 0.0085, -0.12);
  const body = _mesh(mergeVC(B.map(q => vcol(q, '#ffffff'))), brass);
  body.name = 'trumpetBrass';
  g.add(body);
  // 마우스피스 (은색): 림이 +z 끝 (z=0.268)
  const mp = mouthpieceGeo(0.0135, 0.014, 0.065, 0.0062, 24).rotateX(Math.PI / 2).translate(lx, ly, 0.268);
  g.add(_mesh(mp, silver));
  // 코르크 두 개 (워터키 컵)
  g.add(_mesh(mergeVC([vcol(_cylY(0.0035, 0.003, lx, ty - 0.0105 - 0.0035, -0.083, 8), '#ffffff'), vcol(_cylY(0.0035, 0.003, 0, sy2 - 0.0085 - 0.0035, -0.108, 8), '#ffffff')]), cork));
  // 밸브 버튼 (눌러서 내려가는 부분): 줄기 + 놋쇠 고리 + 진주 단추
  g.userData.valves = [];
  for (const z of vz) {
    const v = new THREE.Object3D();
    v.position.set(0, 0.064, z);
    g.add(v);
    const stem = _mesh(_cylY(0.003, 0.02, 0, 0.01, 0, 10), brass);
    v.add(stem);
    const ring = _mesh(mergeVC([vcol(_cylY(0.0108, 0.004, 0, 0.0205, 0, 20), '#ffffff'), vcol(new THREE.TorusGeometry(0.0096, 0.0016, 8, 20).rotateX(Math.PI / 2).translate(0, 0.0245, 0), '#ffffff')]), brass);
    v.add(ring);
    const cap = _mesh(latheY([
      [0.0001, 0.0225],
      [0.0082, 0.0225],
      [0.0095, 0.0245],
      [0.0088, 0.0285],
      [0.005, 0.0305],
      [0.0001, 0.031]
    ], 20), pearl);
    v.add(cap);
    g.userData.valves.push(v);
  }
  anchor(g, 'gripR', 0.014, 0.078, 0.0);
  anchor(g, 'gripL', -0.03, -0.022, -0.004);
  anchor(g, 'mouth', lx, ly, 0.268);
  anchor(g, 'bell', bx, by, -0.215);
  g.userData.length = 0.483;
  g.userData.bellR = 0.062;
  return g;
}

// =====================================================================
// b) 테너 트롬본 — 마우스피스 림이 원점(+z = 입술 쪽), 슬라이드는 -z. 벨 섹션은 슬라이드 위·왼쪽(-x)
//    연주자는 -z 를 보고 있으므로 연주자의 왼쪽 = -x
// =====================================================================
function makeTrombone() {
  const g = new THREE.Group();
  g.name = 'trombone';
  const brass = metalMat(STYLE.pal.brass, 0.2, {
    outline: 0.0035
  });
  const silver = metalMat('#dfe5ec', 0.15, {
    outline: 0.0035
  });
  const rubber = toonMat('#2a2630', {
    outline: 0.003
  });
  const S = 0.075; // 슬라이드 두 관 간격 (위 관 y=0, 아래 관 y=-S)
  const rIn = 0.0068,
    rOut = 0.0082; // 안쪽 관·바깥 관 반지름
  const bxx = -0.045,
    byy = 0.09; // 벨 관 축 (x, y)
  const nyy = -0.03; // 넥파이프(튜닝 슬라이드 아래 다리) y
  const zCrook = 0.25,
    zRim = -0.45;
  const B = [];
  // --- 고정 슬라이드(안쪽 관) 두 개: z 0.02 → -0.72, 끝에 스타킹(살짝 굵음)
  for (const y of [0, -S]) {
    B.push(_cylZ(rIn, 0.74, 0, y, -0.35, 14));
    B.push(_cylZ(rIn * 1.18, 0.09, 0, y, -0.675, 14)); // 스타킹
  }
  B.push(_cylZ(0.0105, 0.05, 0, 0, -0.005, 16)); // 마우스피스 리시버
  B.push(_cylZ(0.0125, 0.006, 0, 0, 0.018, 16));
  B.push(_cylZ(0.0115, 0.028, 0, -S, 0.0, 16)); // 슬라이드 리시버 (벨 섹션 연결) + 잠금 고리
  B.push(_cylZ(0.0135, 0.008, 0, -S, 0.012, 16));
  B.push(_bar([0, -0.004, -0.085], [0, -S + 0.004, -0.085], 0.0032, 10, 0.003)); // 안쪽 슬라이드 버팀대 (왼손)
  B.push(_bar([0, -0.004, -0.03], [0, -S + 0.004, -0.03], 0.0025, 10, 0.0025));
  // --- 넥파이프: 아래 슬라이드 관 리시버에서 왼쪽 위로 휘어 뒤(+z)로
  B.push(tubeAlong([
    [0, -S, 0.02],
    [-0.012, -S + 0.008, 0.06],
    [-0.034, nyy - 0.012, 0.11],
    [bxx, nyy, 0.16],
    [bxx, nyy, zCrook - 0.02]
  ], 0.0082, 30, 12));
  // --- 튜닝 슬라이드 (뒤 굽이, 머리 뒤로 넘어감): 두 다리 + 크룩
  const Rc = (byy - nyy) / 2,
    yc = (byy + nyy) / 2;
  B.push(_cylZ(0.0092, 0.12, bxx, nyy, zCrook - 0.06, 14));
  B.push(_cylZ(0.0092, 0.12, bxx, byy, zCrook - 0.06, 14));
  B.push(_uBend('yz', [bxx, yc, zCrook], Rc, 0.0092, +1, 12, 20));
  B.push(_ferruleZ(0.011, 0.012, bxx, nyy, zCrook - 0.12, 16));
  B.push(_ferruleZ(0.011, 0.012, bxx, byy, zCrook - 0.12, 16));
  B.push(_bar([bxx, nyy + 0.005, zCrook - 0.02], [bxx, byy - 0.005, zCrook - 0.02], 0.0028, 8, 0.0025)); // 크룩 버팀
  // 균형추 (튜닝 슬라이드 크룩 위 작은 통)
  B.push(_cylZ(0.016, 0.03, bxx, byy, zCrook - 0.03, 16));
  // --- 벨 관: 뒤 굽이에서 앞으로, 서서히 굵어지다 벨 목으로
  B.push(_cylZ(0.0085, 0.24 + 0.13, bxx, byy, (zCrook - 0.12 - 0.13) / 2, 14, 0.011)); // z 0.13 → -0.13 (테이퍼)
  B.push(_cylZ(0.011, 0.06, bxx, byy, -0.15, 16, 0.014)); // z -0.12 → -0.18 목
  B.push(bellShell(0.27, 0.014, 0.11, 2.5, 0.0024, 64, 32).translate(bxx, byy, -0.18)); // 테두리 z=-0.45
  B.push(_ferruleZ(0.0125, 0.012, bxx, byy, -0.118, 16));
  // --- 벨 버팀대 두 개 (벨 관 ↔ 넥파이프), 슬라이드 섹션 ↔ 벨 섹션 연결 버팀
  B.push(_bar([bxx, byy - 0.006, 0.0], [bxx, nyy + 0.006, 0.0], 0.0032, 10, 0.003));
  B.push(_bar([bxx, byy - 0.006, 0.17], [bxx, nyy + 0.006, 0.17], 0.0028, 10, 0.0025));
  B.push(_bar([bxx + 0.005, byy - 0.004, -0.08], [0, 0.004, -0.08], 0.0028, 10, 0.0025)); // 벨 관 ↔ 위 슬라이드 관 (왼손 엄지 자리)
  B.push(_bar([bxx + 0.004, nyy - 0.004, 0.02], [-0.004, -S + 0.006, 0.02], 0.0026, 10, 0.0025));
  const body = _mesh(mergeVC(B.map(q => vcol(q, '#ffffff'))), brass);
  body.name = 'tromboneBrass';
  g.add(body);
  // 마우스피스 (은색): 림이 z=0 (+z 방향으로 컵이 열림), 생크는 -z 로 리시버 안으로
  g.add(_mesh(mouthpieceGeo(0.0175, 0.02, 0.08, 0.0075, 26).rotateX(Math.PI / 2), silver));
  // --- 움직이는 바깥 슬라이드 (1포지션 기준): 두 관 z -0.11 → -0.75, 끝 크룩, 범퍼, 버팀대(오른손), 워터키
  const sl = new THREE.Group();
  sl.name = 'slide';
  g.add(sl);
  g.userData.slide = sl;
  const Ssl = [];
  for (const y of [0, -S]) {
    Ssl.push(_cylZ(rOut, 0.64, 0, y, -0.43, 14));
    Ssl.push(_cylZ(rOut * 1.3, 0.014, 0, y, -0.115, 16));
  }
  Ssl.push(_uBend('yz', [0, -S / 2, -0.75], S / 2, rOut, -1, 12, 20));
  Ssl.push(_bar([0, -0.004, -0.2], [0, -S + 0.004, -0.2], 0.0032, 10, 0.003)); // 바깥 슬라이드 버팀대 (오른손)
  Ssl.push(rbox(0.006, 0.004, 0.034, 0.0015, 1).translate(0, -S - 0.011, -0.7));
  Ssl.push(_cylY(0.005, 0.004, 0, -S - 0.013, -0.69, 10)); // 워터키
  sl.add(_mesh(mergeVC(Ssl.map(q => vcol(q, '#ffffff'))), brass));
  sl.add(_mesh(_cylZ(0.012, 0.012, 0, -S / 2, -0.788, 14), rubber)); // 슬라이드 범퍼
  anchor(sl, 'gripR', 0.0, -S / 2, -0.2);
  anchor(g, 'gripL', -0.022, -0.012, -0.05);
  anchor(g, 'mouth', 0, 0, 0);
  anchor(g, 'bell', bxx, byy, zRim);
  g.userData.bellR = 0.11;
  g.userData.slideSpacing = S;
  return g;
}

// =====================================================================
// c) 콘트라베이스 — 원점 = 엔드핀 바닥 접점, +y 로 서고, 앞면(현·f홀)이 +z
//    앞에서 볼 때(+z 에서 -z 방향으로) 굵은 E현이 +x 쪽(관객 기준 오른쪽)
// =====================================================================
// 바이올린족 몸통 반쪽 윤곽을 좌우 대칭 Shape 로 (v: 0=아래 끝, 길이 L)
function _violinShape(L, s) {
  // 반쪽 점 (half-width, v) — 아래 바우트 → 아래 코너 → C바우트 → 위 코너 → 위 바우트
  const lo = [
    [0, 0],
    [0.11, 0.004],
    [0.22, 0.04],
    [0.29, 0.14],
    [0.3, 0.25],
    [0.285, 0.34],
    [0.262, 0.41],
    [0.252, 0.438]
  ];
  const cb = [
    [0.252, 0.438],
    [0.19, 0.452],
    [0.16, 0.5],
    [0.15, 0.575],
    [0.16, 0.65],
    [0.195, 0.69],
    [0.226, 0.7]
  ];
  const up = [
    [0.226, 0.7],
    [0.228, 0.745],
    [0.222, 0.83],
    [0.195, 0.92],
    [0.14, 0.995],
    [0.07, 1.05],
    [0, 1.08]
  ];
  const P = (p, sx) => new THREE.Vector2(p[0] * sx * s, p[1] / 1.08 * L);
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.splineThru(lo.slice(1).map(p => P(p, 1)));
  sh.splineThru(cb.slice(1).map(p => P(p, 1)));
  sh.splineThru(up.slice(1).map(p => P(p, 1)));
  const r = a => a.slice(0, -1).reverse();
  sh.splineThru(r(up).map(p => P(p, -1)));
  sh.splineThru(r(cb).map(p => P(p, -1)));
  sh.splineThru(r(lo).map(p => P(p, -1)));
  sh.closePath();
  return sh;
}
// 법선 방향으로 색 입히기 (앞판/뒤판/옆판)
function _colorByNormal(geo, front, back, side) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes))
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const n = g.attributes.normal,
    cnt = g.attributes.position.count,
    a = new Float32Array(cnt * 3);
  const cf = new THREE.Color(front),
    cb = new THREE.Color(back),
    cs = new THREE.Color(side),
    c = new THREE.Color();
  for (let i = 0; i < cnt; i++) {
    const nz = n.getZ(i),
      w = smooth01((Math.abs(nz) - 0.25) / 0.5);
    c.copy(cs).lerp(nz > 0 ? cf : cb, w);
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
// f홀 한 개 (앞판 위의 검정 납작 도형). 중심선 베지어 + 양 끝 눈
function _fHole(p0, c1, c2, p3, w, rTop, rBot, z) {
  const cv = new THREE.CubicBezierCurve(new THREE.Vector2(...p0), new THREE.Vector2(...c1), new THREE.Vector2(...c2), new THREE.Vector2(...p3));
  const pts = cv.getPoints(16),
    L = [],
    R = [];
  for (let i = 0; i < pts.length; i++) {
    const t = cv.getTangent(i / (pts.length - 1)).normalize(),
      nx = -t.y,
      ny = t.x;
    const ww = w * (0.7 + 0.3 * Math.sin(i / (pts.length - 1) * Math.PI));
    L.push(new THREE.Vector2(pts[i].x + nx * ww, pts[i].y + ny * ww));
    R.push(new THREE.Vector2(pts[i].x - nx * ww, pts[i].y - ny * ww));
  }
  const sh = new THREE.Shape([...L, ...R.reverse()]);
  const list = [new THREE.ShapeGeometry(sh), new THREE.CircleGeometry(rTop, 18).translate(p0[0], p0[1], 0), new THREE.CircleGeometry(rBot, 18).translate(p3[0], p3[1], 0)];
  // 가운데 작은 홈 두 개
  const mid = cv.getPoint(0.5),
    tg = cv.getTangent(0.5).normalize();
  for (const s of [-1, 1]) list.push(new THREE.CircleGeometry(w * 0.9, 8).translate(mid.x - tg.y * s * w * 1.4, mid.y + tg.x * s * w * 1.4, 0));
  return mergeGeometries(list.map(q => q.toNonIndexed()), false).translate(0, 0, z);
}

function makeDoubleBass() {
  const g = new THREE.Group();
  g.name = 'doubleBass';
  const woodVC = glossMat('#ffffff', 0.3, {
    vc: true,
    outline: 0.005,
    env: 0.7
  });
  const ebony = glossMat('#17120f', 0.35, {
    outline: 0.004
  });
  const maple = glossMat('#d6a05a', 0.4, {
    outline: 0.004
  });
  const steel = metalMat('#cfd5dc', 0.25, {
    outline: 0.002
  });
  const brass = metalMat(STYLE.pal.brass, 0.25, {
    outline: 0.003
  });
  const rubber = toonMat('#2a2630', {
    outline: 0.003
  });
  const yBot = 0.22,
    L = 1.08,
    depth = 0.19,
    bev = 0.034;
  // --- 몸통: 윤곽 돌출 + 베벨(판의 아치). 앞판 가문비 / 뒤·옆판 단풍
  const sh = _violinShape(L, 1.0);
  const bodyGeo = new THREE.ExtrudeGeometry(sh, {
    depth,
    bevelEnabled: true,
    bevelThickness: bev,
    bevelSize: 0.026,
    bevelSegments: 5,
    curveSegments: 10
  });
  bodyGeo.translate(0, yBot, -depth / 2);
  const zF = depth / 2 + bev; // 앞판 평평한 면 z
  const body = _mesh(_colorByNormal(bodyGeo, '#e39a4c', '#b8652c', '#c4702f'), woodVC, true, true);
  body.name = 'bassBody';
  g.add(body);
  // --- 검정 부품(에보니): 퍼플링(앞·뒤 테두리 선), f홀, 지판, 테일피스, 새들, 엔드핀 소켓, 너트
  const E = [];
  const purf = (z, flip) => { // 윤곽을 안쪽으로 살짝 줄인 가는 띠
    const outer = sh.getPoints(10),
      cy = L / 2;
    const inner = outer.map(p => new THREE.Vector2(p.x * 0.915, cy + (p.y - cy) * 0.945));
    const inner2 = outer.map(p => new THREE.Vector2(p.x * 0.9, cy + (p.y - cy) * 0.935));
    const s2 = new THREE.Shape(inner);
    s2.holes.push(new THREE.Path(inner2.reverse()));
    const q = new THREE.ShapeGeometry(s2);
    if (flip) q.rotateY(Math.PI);
    q.translate(0, yBot, z);
    return q;
  };
  E.push(purf(zF + 0.0008, false), purf(-zF - 0.0008, true));
  for (const s of [-1, 1]) E.push(_fHole([s * 0.072, yBot + 0.655], [s * 0.06, yBot + 0.56], [s * 0.135, yBot + 0.44], [s * 0.12, yBot + 0.345], 0.011, 0.017, 0.021, zF + 0.001));
  // 지판: 너트(y=1.62) 아래로 기울어진 축을 따라. 표면 선: (y 1.0, z 0.262) → (y 1.62, z 0.19)
  const P0 = V3(0, 0.98, 0.264),
    P1 = V3(0, 1.62, 0.19),
    axis = P1.clone().sub(P0),
    fbLen = axis.length(),
    dir = axis.clone().normalize();
  const nrm = V3(0, 1, 0).cross(dir).cross(dir).negate().normalize(); // 표면 법선 (+z 쪽)
  if (nrm.z < 0) nrm.negate();
  const qFB = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), dir);
  const fbShape = new THREE.Shape();
  fbShape.moveTo(-0.048, 0);
  fbShape.lineTo(0.048, 0);
  fbShape.lineTo(0.031, fbLen);
  fbShape.lineTo(-0.031, fbLen);
  fbShape.closePath();
  const fb = new THREE.ExtrudeGeometry(fbShape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.006,
    bevelSegments: 3,
    curveSegments: 2
  });
  fb.translate(0, 0, -0.014 - 0.012 - 0.002); // 표면이 z≈-0.002 → 축 기준 아래
  fb.applyQuaternion(qFB);
  fb.translate(P0.x, P0.y, P0.z);
  E.push(fb);
  E.push(rbox(0.056, 0.012, 0.022, 0.004, 2).applyQuaternion(qFB).translate(P1.x, P1.y + 0.004, P1.z + 0.004)); // 너트
  // 테일피스 (위가 넓음), 테일거트, 새들, 엔드핀 소켓
  const tpShape = new THREE.Shape();
  tpShape.moveTo(-0.028, 0);
  tpShape.lineTo(0.028, 0);
  tpShape.lineTo(0.05, 0.25);
  tpShape.quadraticCurveTo(0, 0.285, -0.05, 0.25);
  tpShape.closePath();
  const tp = new THREE.ExtrudeGeometry(tpShape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.006,
    bevelSegments: 3,
    curveSegments: 6
  });
  tp.rotateX(-0.14);
  tp.translate(0, yBot + 0.08, zF + 0.028);
  E.push(tp);
  E.push(rbox(0.07, 0.03, 0.03, 0.008, 2).translate(0, yBot + 0.004, zF - 0.004)); // 새들
  E.push(_cylY(0.024, 0.05, 0, yBot - 0.012, 0, 18, 0.02)); // 엔드핀 소켓
  g.add(_mesh(mergeVC(E.map(q => vcol(q, '#ffffff'))), ebony));
  // --- 단풍나무 부품: 넥·힐, 페그박스, 스크롤(소용돌이), 브리지
  const Mp = [];
  {
    const neck = rbox(0.05, 0.4, 0.042, 0.018, 3).applyQuaternion(qFB),
      mid = P0.clone().lerp(P1, 0.72),
      off = nrm.clone().multiplyScalar(-0.047);
    Mp.push(neck.translate(mid.x + off.x, mid.y + off.y, mid.z + off.z));
  }
  Mp.push(rbox(0.062, 0.1, 0.17, 0.028, 3).translate(0, yBot + L, zF - 0.03)); // 힐 블록 (넥 → 몸통 위 테두리)
  // 페그박스: 너트 위, 뒤로 더 꺾임
  const pbDir = V3(0, 0.955, -0.3).normalize(),
    qPB = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), pbDir),
    pb0 = P1.clone().add(V3(0, 0.01, -0.02));
  const pbShape = new THREE.Shape();
  pbShape.moveTo(-0.03, 0);
  pbShape.lineTo(0.03, 0);
  pbShape.lineTo(0.036, 0.17);
  pbShape.lineTo(-0.036, 0.17);
  pbShape.closePath();
  const pb = new THREE.ExtrudeGeometry(pbShape, {
    depth: 0.064,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.006,
    bevelSegments: 2
  });
  pb.translate(0, 0, -0.032 - 0.008);
  pb.applyQuaternion(qPB);
  pb.translate(pb0.x, pb0.y, pb0.z);
  Mp.push(pb);
  // 스크롤: 나선 띠를 x 방향으로 돌출
  const sp = new THREE.Shape();
  const N = 60,
    turns = 2.1,
    r0 = 0.007,
    k = 0.0078;
  for (let i = 0; i <= N; i++) {
    const t = i / N,
      th = t * turns * Math.PI * 2,
      r = r0 + k * th;
    const x = Math.cos(th) * r,
      y = Math.sin(th) * r;
    i ? sp.lineTo(x, y) : sp.moveTo(x, y);
  }
  for (let i = N; i >= 8; i--) {
    const t = i / N,
      th = t * turns * Math.PI * 2,
      r = r0 + k * th - 0.021;
    sp.lineTo(Math.cos(th) * r, Math.sin(th) * r);
  }
  sp.closePath();
  const scroll = new THREE.ExtrudeGeometry(sp, {
    depth: 0.07,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 4
  });
  scroll.translate(0, 0, -0.035 - 0.006);
  scroll.rotateY(Math.PI / 2); // 나선 평면 yz, 폭은 x
  {
    const top = pb0.clone().add(pbDir.clone().multiplyScalar(0.19));
    scroll.translate(top.x, top.y + 0.02, top.z - 0.05);
    Mp.push(scroll);
  }
  // 브리지 (판 위에 서 있음): xy 로 그려 z 로 세움
  const br = new THREE.Shape();
  const half = [
    [0.088, 0],
    [0.088, 0.018],
    [0.062, 0.022],
    [0.052, 0.05],
    [0.07, 0.068],
    [0.06, 0.1],
    [0.072, 0.128],
    [0.058, 0.15],
    [0.03, 0.165],
    [0, 0.172]
  ];
  br.moveTo(-0.088, 0);
  for (const p of half.slice().reverse()) br.lineTo(-p[0], p[1]);
  for (const p of half) br.lineTo(p[0], p[1]);
  br.closePath();
  const hole = (x, y, r) => {
    const h = new THREE.Path();
    h.absellipse(x, y, r, r * 1.3, 0, Math.PI * 2, false, 0);
    br.holes.push(h);
  };
  hole(0, 0.09, 0.012);
  hole(-0.038, 0.045, 0.01);
  hole(0.038, 0.045, 0.01);
  const brG = new THREE.ExtrudeGeometry(br, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.002,
    bevelSegments: 1,
    curveSegments: 6
  });
  brG.rotateX(Math.PI / 2);
  brG.translate(0, yBot + 0.5 + 0.009, zF - 0.002);
  Mp.push(brG);
  g.add(_mesh(mergeVC(Mp.map(q => vcol(q, '#ffffff'))), maple));
  // --- 줄감개 (놋쇠): 페그박스 양옆에 2개씩 — 판, 웜 기어, 축, 납작 키
  const T = [];
  for (const s of [-1, 1]) {
    const plate = rbox(0.004, 0.11, 0.034, 0.002, 1);
    plate.applyQuaternion(qPB);
    const pc = pb0.clone().add(pbDir.clone().multiplyScalar(0.095)).add(V3(s * 0.04, 0, -0.02));
    T.push(plate.translate(pc.x, pc.y, pc.z));
    for (const u of [0.055, 0.135]) {
      const c = pb0.clone().add(pbDir.clone().multiplyScalar(u)).add(V3(0, 0, -0.02));
      T.push(_cylX(0.0045, 0.17, 0, 0, 0, 10).applyQuaternion(qPB).translate(c.x, c.y, c.z)); // 축 (양쪽 관통)
      T.push(_cylX(0.012, 0.012, s * 0.046, 0, 0, 14).applyQuaternion(qPB).translate(c.x, c.y, c.z)); // 웜 기어 통
      const key = rbox(0.006, 0.058, 0.016, 0.003, 2).translate(0, -0.024, 0).rotateX(s * 0.9 + (u > 0.1 ? 0.4 : -0.2)).translate(s * 0.085, 0, 0);
      T.push(key.applyQuaternion(qPB).translate(c.x, c.y, c.z));
    }
  }
  g.add(_mesh(mergeVC(T.map(q => vcol(q, '#ffffff'))), brass));
  // --- 엔드핀 (강철) + 고무 팁
  g.add(_mesh(_cylY(0.007, yBot + 0.01, 0, (yBot + 0.01) / 2, 0, 10), steel));
  g.add(_mesh(_cylY(0.013, 0.035, 0, 0.0175, 0, 12, 0.009), rubber));
  // --- 현 4개 (브리지 위 → 너트), 테일피스 쪽 짧은 구간은 정적으로 병합
  const strX = [0.042, 0.014, -0.014, -0.042],
    nutX = [0.0135, 0.0045, -0.0045, -0.0135],
    rad = [0.0024, 0.0021, 0.0018, 0.0015];
  const brTop = yBot + 0.5 + 0.17,
    zBr = zF + 0.17 + 0.002,
    nutTop = P1.clone().add(nrm.clone().multiplyScalar(0.012));
  g.userData.strings = [];
  const tail = [];
  for (let i = 0; i < 4; i++) {
    const a = V3(strX[i], brTop, zBr),
      b = V3(nutX[i], nutTop.y, nutTop.z);
    const sm = _mesh(_bar(a.toArray(), b.toArray(), rad[i], 8), steel, false);
    sm.name = 'string' + i;
    g.add(sm);
    g.userData.strings.push(sm);
    tail.push(_bar([strX[i] * 0.8, yBot + 0.31, zF + 0.045], a.toArray(), rad[i], 6));
  }
  tail.push(_bar([0, yBot + 0.075, zF + 0.028], [0, yBot + 0.012, zF + 0.012], 0.004, 8)); // 테일거트
  g.add(_mesh(mergeVC(tail.map(q => vcol(q, '#ffffff'))), steel, false));
  // --- 기준점
  const at = (t, h) => P0.clone().lerp(P1, t).add(nrm.clone().multiplyScalar(h));
  const nt = at(0.9, 0.03),
    nl = at(0.48, 0.03);
  anchor(g, 'neckTop', nt.x, nt.y, nt.z);
  anchor(g, 'neckLow', nl.x, nl.y, nl.z);
  anchor(g, 'pluck', 0, 0.93, zBr - 0.02);
  anchor(g, 'bodyBack', 0, yBot + 0.86, -zF);
  g.userData.height = 1.86;
  g.userData.frontZ = zF;
  return g;
}

// =====================================================================
// d) 그랜드 피아노 — 원점 = 건반 앞 가장자리 중앙(바닥). 건반이 +z 를 향함(연주자는 +z 쪽에 앉아 -z 를 봄). 뚜껑 7° (짧은 받침대, 시야를 가리지 않게)
//    -z 를 보는 사람의 오른쪽은 +x → 고음(오른손)이 +x, 저음이 -x. 직선 변(저음 쪽) = -x, 곡선 변 = +x, 뚜껑은 -x 변에 경첩
// =====================================================================
function _pianoPlan(inset = 0) {
  // (x, d): d = 앞에서 뒤로 들어간 깊이(양수). 돌출 후 rotateX(-90°)로 d → -z
  const s = new THREE.Shape(),
    i = inset,
    W = 0.75 - i;
  s.moveTo(-W, 0.2 + i);
  s.lineTo(W, 0.2 + i);
  s.lineTo(W, 0.66);
  s.bezierCurveTo(W, 1.08, 0.36 - i * 0.5, 1.02, 0.1, 1.36 - i);
  s.bezierCurveTo(-0.12, 1.66 - i, -0.4, 1.9 - i, -0.6, 1.76 - i);
  s.bezierCurveTo(-0.75 + i, 1.64 - i, -W, 1.3, -W, 0.2 + i);
  s.closePath();
  return s;
}

function makeGrandPiano() {
  const g = new THREE.Group();
  g.name = 'grandPiano';
  const black = glossMat('#15131a', 0.12, {
    outline: 0.005
  });
  const ivory = glossMat('#f8f5ee', 0.35, {
    outline: 0.0022
  });
  const ebonyKeys = glossMat('#1a1719', 0.3, {
    outline: 0.0022
  });
  const brass = metalMat(STYLE.pal.brass, 0.25, {
    outline: 0.003
  });
  const felt = toonMat('#8c1f2e', {
    outline: 0.003
  });
  const gold = metalMat('#d9a441', 0.4, {
    outline: 0.003,
    side: THREE.FrontSide
  });
  const spruce = toonMat('#e4b06a', {
    outline: 0
  });
  const steel = basicMat('#d8dde4');
  const yBed = 0.72,
    rimH = 0.28,
    yTop = yBed + rimH; // 림 윗면 y=1.0
  // --- 케이스 림(몸통): 평면도 돌출. 밑판 포함
  const K = [];
  const rim = new THREE.ExtrudeGeometry(_pianoPlan(0), {
    depth: rimH,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 3,
    curveSegments: 24
  });
  rim.rotateX(-Math.PI / 2);
  rim.translate(0, yBed + 0.012, 0);
  K.push(rim);
  // 앞쪽 양 볼(cheek)과 건반 아래 키베드, 건반 뒤 폴보드(눕힌 판)
  for (const s of [-1, 1]) K.push(rbox(0.13, rimH, 0.24, 0.012, 2).translate(s * 0.685, yBed + rimH / 2, -0.09));
  K.push(rbox(1.5, 0.09, 0.3, 0.012, 2).translate(0, yBed - 0.045, -0.06)); // 키베드 앞 판(키슬립 포함)
  K.push(rbox(1.24, 0.05, 0.1, 0.01, 2).translate(0, yBed + 0.025 + 0.005, -0.2)); // 건반 뒤 폴보드 받침
  K.push(rbox(1.24, 0.26, 0.03, 0.01, 2).rotateX(-0.35).translate(0, yBed + 0.16, -0.235)); // 폴보드(열려서 뒤로 젖힘)
  // 보면대 (건반 위 뒤쪽, 뒤로 기울어진 검은 판 + 받침턱)
  K.push(rbox(0.7, 0.3, 0.02, 0.01, 2).rotateX(-0.3).translate(0, yTop + 0.17, -0.42));
  K.push(rbox(0.72, 0.03, 0.06, 0.008, 1).translate(0, yTop + 0.03, -0.4));
  // 다리 3개 + 페달 리라
  const legAt = (x, z) => {
    K.push(rbox(0.11, yBed - 0.06, 0.11, 0.03, 3).scale(1, 1, 1).translate(x, (yBed - 0.06) / 2 + 0.05, z));
    K.push(rbox(0.15, 0.06, 0.15, 0.03, 2).translate(x, yBed - 0.02, z));
  };
  legAt(-0.63, -0.3);
  legAt(0.63, -0.3);
  legAt(-0.45, -1.5);
  for (const s of [-1, 1]) K.push(rbox(0.05, yBed - 0.16, 0.05, 0.012, 2).rotateX(0.0).translate(s * 0.14, (yBed - 0.16) / 2 + 0.14, -0.48)); // 리라 기둥
  K.push(rbox(0.46, 0.09, 0.14, 0.02, 2).translate(0, 0.14, -0.46)); // 페달 상자
  K.push(rbox(0.36, 0.03, 0.03, 0.01, 1).translate(0, 0.4, -0.48)); // 리라 가로대
  const caseMesh = _mesh(mergeVC(K.map(q => vcol(q, '#ffffff'))), black, true, true);
  caseMesh.name = 'pianoCase';
  g.add(caseMesh);
  // --- 캐스터(놋쇠) + 페달 3개
  const Bz = [];
  for (const [x, z] of [
    [-0.63, -0.3],
    [0.63, -0.3],
    [-0.45, -1.5]
  ]) {
    Bz.push(new THREE.SphereGeometry(0.038, 16, 12).translate(x, 0.04, z));
    Bz.push(_cylY(0.03, 0.03, x, 0.07, z, 14));
  }
  for (const x of [-0.08, 0, 0.08]) Bz.push(rbox(0.03, 0.012, 0.11, 0.005, 2).rotateX(-0.25).translate(x, 0.13, -0.37));
  Bz.push(_cylY(0.012, 0.03, -0.52, yTop + 0.015, -0.5, 10));
  Bz.push(_cylY(0.012, 0.03, 0.4, yTop + 0.015, -0.5, 10)); // 경첩 장식 두 개
  g.add(_mesh(mergeVC(Bz.map(q => vcol(q, '#ffffff'))), brass));
  // --- 내부: 향판(밝은 나무) + 금색 프레임 + 현
  const inner = new THREE.ShapeGeometry(_pianoPlan(0.07), 20);
  inner.rotateX(-Math.PI / 2);
  inner.translate(0, yBed + 0.06, 0);
  g.add(_mesh(inner, spruce, false, true));
  {
    const plate = _pianoPlan(0.1);
    const hole = (x, d, r) => {
      const h = new THREE.Path();
      h.absellipse(x, d, r, r * 1.6, 0, Math.PI * 2, false, 0);
      plate.holes.push(h);
    };
    hole(-0.42, 1.1, 0.1);
    hole(-0.1, 0.95, 0.11);
    hole(0.25, 0.75, 0.09);
    hole(-0.15, 1.4, 0.07);
    const pg = new THREE.ExtrudeGeometry(plate, {
      depth: 0.03,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.006,
      bevelSegments: 2,
      curveSegments: 16
    });
    pg.rotateX(-Math.PI / 2);
    pg.translate(0, yBed + 0.1, 0);
    g.add(_mesh(pg, gold, false, false));
  } {
    const S = [];
    for (let i = 0; i < 46; i++) {
      const t = i / 45,
        x = -0.6 + t * 1.2,
        d1 = 0.3,
        d2 = 1.72 - t * 1.05 - 0.15 * Math.sin(t * 3);
      S.push(new THREE.BoxGeometry(0.0022, 0.003, d2 - d1).translate(x, yBed + 0.142, -(d1 + d2) / 2));
    }
    g.add(_mesh(mergeVC(S.map(q => vcol(q, '#ffffff'))), steel, false));
  }
  g.add(_mesh(rbox(1.26, 0.03, 0.09, 0.008, 1).translate(0, yBed + 0.13, -0.33), felt)); // 댐퍼 펠트 선
  // --- 건반 88개 (흰 52 / 검 36). 중앙 정렬, 흰건반 폭 0.0235
  const wW = 0.0235,
    nW = 52,
    x0 = -nW * wW / 2,
    keyX = {},
    whites = [],
    blacks = [];
  let w = 0;
  for (let m = 21; m <= 108; m++) {
    const pc = m % 12,
      isBlack = [1, 3, 6, 8, 10].includes(pc);
    if (!isBlack) {
      const x = x0 + (w + 0.5) * wW;
      keyX[m] = x;
      whites.push(rbox(wW - 0.0015, 0.018, 0.15, 0.003, 1).translate(x, yBed + 0.011, -0.075));
      w++;
    } else {
      const x = x0 + w * wW + (pc === 1 || pc === 6 ? -0.0025 : pc === 3 || pc === 10 ? 0.0025 : 0);
      keyX[m] = x;
      blacks.push(rbox(0.0115, 0.013, 0.095, 0.0025, 1).translate(x, yBed + 0.02 + 0.0065, -0.1125));
    }
  }
  g.add(_mesh(mergeVC(whites.map(q => vcol(q, '#ffffff'))), ivory, false));
  g.add(_mesh(mergeVC(blacks.map(q => vcol(q, '#ffffff'))), ebonyKeys, false));
  g.userData.keyX = midi => {
    const m = clamp(Math.round(midi), 21, 108);
    return keyX[m];
  };
  g.userData.keyTopY = yBed + 0.02;
  // --- 뚜껑: -x 직선 변에 경첩, 25° 열림. 앞 덮개는 뚜껑 위로 접어 올림. 받침대(하프 스틱)
  const LID_ANG = 7 * Math.PI / 180; // 낮게 (짧은 받침대) — 시야를 가리는 검은 판이 되지 않게
  const lid = new THREE.Group();
  lid.name = 'lid';
  lid.position.set(-0.75, yTop, 0);
  lid.rotation.z = LID_ANG;
  g.add(lid);
  g.userData.lid = lid;
  const lidGeo = new THREE.ExtrudeGeometry(_pianoPlan(0.0), {
    depth: 0.03,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 2,
    curveSegments: 24
  });
  lidGeo.rotateX(-Math.PI / 2);
  lidGeo.translate(0.75, 0.008, 0);
  const flap = rbox(1.5, 0.03, 0.42, 0.01, 2).translate(0.75, 0.054, -0.41 - 0.21 + 0.0); // 앞 덮개 접힌 것
  lid.add(_mesh(mergeVC([vcol(lidGeo, '#ffffff'), vcol(flap, '#ffffff')]), black, true, false));
  {
    const base = V3(0.64, yTop, -0.8),
      top = V3(0.58 + 0.75, 0, -0.78).applyAxisAngle(V3(0, 0, 1), LID_ANG).add(V3(-0.75, yTop, 0)); // 뚜껑 밑면 위 점
    g.add(_mesh(_bar(base.toArray(), top.toArray(), 0.016, 10), black));
    g.add(_mesh(_cylY(0.03, 0.02, base.x, yTop + 0.01, base.z, 12), brass));
  }
  // --- 의자 (별도 그룹, 연주자 자리) — 검정 다리 + 짙은 가죽 방석
  const bench = new THREE.Group();
  bench.name = 'bench';
  bench.position.set(0, 0, 0.52);
  g.add(bench);
  const Bn = [rbox(0.9, 0.05, 0.34, 0.012, 2).translate(0, 0.435, 0)];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ]) Bn.push(rbox(0.06, 0.42, 0.06, 0.015, 2).translate(sx * 0.4, 0.21, sz * 0.13));
  bench.add(_mesh(mergeVC(Bn.map(q => vcol(q, '#ffffff'))), black, true, false));
  bench.add(_mesh(rbox(0.86, 0.06, 0.32, 0.025, 3).translate(0, 0.49, 0), glossMat('#3a2320', 0.5, {
    outline: 0.004
  })));
  anchor(bench, 'seat', 0, 0.52, 0);
  anchor(g, 'keysFront', 0, yBed + 0.02, 0);
  g.userData.size = {
    w: 1.5,
    d: 1.9
  };
  return g;
}

// =====================================================================
// e) 재즈 드럼 — 원점 = 의자(스론) 바닥점, 드러머는 -z 를 봄(오른쪽 = +x). 하이햇 -x, 플로어탐·라이드 +x
// =====================================================================
// 드럼 통: 옆면 = 쉘 색, 위아래 = 헤드 색 (꼭짓점 색)
function _drumShell(R, depth, shell, head, seg = 40) {
  const g = new THREE.CylinderGeometry(R, R, depth, seg, 1, false).toNonIndexed();
  for (const k of Object.keys(g.attributes))
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const n = g.attributes.normal,
    cnt = g.attributes.position.count,
    a = new Float32Array(cnt * 3),
    cs = new THREE.Color(shell),
    ch = new THREE.Color(head),
    c = new THREE.Color();
  for (let i = 0; i < cnt; i++) {
    c.copy(Math.abs(n.getY(i)) > 0.5 ? ch : cs);
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
// 심벌: 가운데 구멍·종(벨)·완만한 경사, 닫힌 두 겹 회전체 (축 +y, 테두리 y=0)
function _cymbalGeo(R, bellR = R * 0.22, thick = 0.0025, seg = 56) {
  const prof = t => (1 - t) * (1 - t) * 0.028 * (R / 0.25); // 테두리(t=1)에서 0, 중심 쪽으로 올라감
  const pts = [
    [0.008, prof(0) + 0.028]
  ];
  for (let i = 1; i <= 6; i++) {
    const t = i / 6,
      a = Math.PI / 2 * (1 - t);
    pts.push([0.008 + (bellR - 0.008) * t, prof(bellR / R) + 0.03 * Math.sin(a) * (1 - t * 0.15)]);
  }
  for (let i = 1; i <= 10; i++) {
    const r = bellR + (R - bellR) * i / 10;
    pts.push([r, prof(r / R)]);
  }
  pts.push([R + thick * 0.8, -thick * 0.4]);
  for (let i = 10; i >= 0; i--) {
    const r = bellR + (R - bellR) * i / 10;
    pts.push([r, prof(r / R) - thick]);
  }
  for (let i = 5; i >= 0; i--) {
    const t = i / 6,
      a = Math.PI / 2 * (1 - t);
    pts.push([0.008 + (bellR - 0.008) * t, prof(bellR / R) + 0.03 * Math.sin(a) * (1 - t * 0.15) - thick * 1.4]);
  }
  pts.push([0.008, prof(0) + 0.028]);
  return latheY(pts, seg);
}

function makeDrumKit() {
  const g = new THREE.Group();
  g.name = 'drumKit';
  const shellC = '#d8252f', headC = '#f6eedc';
  const shellMat = glossMat('#ffffff', 0.2, {
    vc: true,
    outline: 0.005
  });
  const chrome = metalMat('#dfe5ec', 0.15, {
    outline: 0.003
  });
  const cymMat = metalMat('#d9a441', 0.3, {
    outline: 0.0035
  });
  const black = glossMat('#1d1a20', 0.45, {
    outline: 0.004
  });
  const feltMat = toonMat('#d9c6a8', {
    outline: 0.003
  });
  const Sh = [],
    Ch = [],
    Bk = [];
  const P = g.userData.pieces = {};
  const strike = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    g.add(o);
    P[name] = o;
    return o;
  };
  // 통 하나: 쉘 + 후프 두 개 + 러그 (M: 배치 행렬)
  const drum = (R, depth, M, lugs = 8, twoHoops = true) => {
    Sh.push(_drumShell(R, depth, shellC, headC).applyMatrix4(M));
    const hoop = y => Ch.push(new THREE.TorusGeometry(R + 0.004, 0.006, 8, 48).rotateX(Math.PI / 2).translate(0, y, 0).applyMatrix4(M));
    hoop(depth / 2 - 0.002);
    if (twoHoops) hoop(-depth / 2 + 0.002);
    for (let i = 0; i < lugs; i++) {
      const a = i / lugs * Math.PI * 2 + 0.2;
      Ch.push(rbox(0.022, Math.min(0.09, depth * 0.45), 0.02, 0.006, 2).translate(0, 0, R + 0.008).rotateY(a).applyMatrix4(M));
    }
  };
  // --- 베이스드럼 18"x14": 축이 z. 배터 헤드(+z, 드러머 쪽), 앞 헤드(-z, 엠블럼)
  const kR = 0.229,
    kD = 0.36,
    kC = V3(0.14, kR + 0.03, -0.8);
  drum(kR, kD, M4(kC.toArray(), [Math.PI / 2, 0, 0]), 10);
  for (const s of [-1, 1]) {
    Ch.push(_bar([kC.x + s * 0.12, kC.y - 0.12, kC.z - 0.06], [kC.x + s * 0.26, 0.02, kC.z - 0.12], 0.008, 8));
    Bk.push(new THREE.SphereGeometry(0.02, 10, 8).scale(1, 0.7, 1).translate(kC.x + s * 0.26, 0.02, kC.z - 0.12));
  } // 스퍼(다리)
  // 앞 헤드 엠블럼 (글자 없는 동심원 배지)
  const emblemTex = canvasTex(256, 256, (c, w) => {
    c.fillStyle = '#f6eedc';
    c.fillRect(0, 0, w, w);
    const ring = (r, col) => {
      c.fillStyle = col;
      c.beginPath();
      c.arc(w / 2, w / 2, r, 0, Math.PI * 2);
      c.fill();
    };
    ring(w * 0.26, '#1f2f6b');
    ring(w * 0.2, '#f2b531');
    ring(w * 0.14, '#d8252f');
    ring(w * 0.06, '#fff4de');
    c.strokeStyle = '#1f2f6b';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(w / 2, w / 2, w * 0.3, 0, Math.PI * 2);
    c.stroke();
  });
  const front = _mesh(new THREE.CircleGeometry(kR - 0.003, 48), toonMat('#ffffff', {
    map: emblemTex,
    outline: 0
  }), false);
  front.position.set(kC.x, kC.y, kC.z - kD / 2 - 0.0015);
  front.rotation.y = Math.PI;
  g.add(front);
  strike('kick', kC.x, kC.y, kC.z + kD / 2);
  // 킥 페달: 판 + 기둥 + 비터
  const pedalZ = kC.z + kD / 2;
  Ch.push(rbox(0.09, 0.012, 0.27, 0.004, 2).rotateX(-0.2).translate(kC.x, 0.035, pedalZ + 0.17));
  Ch.push(rbox(0.11, 0.02, 0.06, 0.005, 2).translate(kC.x, 0.012, pedalZ + 0.32));
  for (const s of [-1, 1]) Ch.push(_cylY(0.007, 0.14, kC.x + s * 0.05, 0.07, pedalZ + 0.03, 8));
  Ch.push(_cylX(0.008, 0.12, kC.x, 0.14, pedalZ + 0.03, 8));
  Ch.push(_bar([kC.x, 0.14, pedalZ + 0.03], [kC.x, kC.y - 0.02, pedalZ + 0.045], 0.006, 8));
  const beater = _mesh(new THREE.SphereGeometry(0.03, 14, 10), feltMat);
  beater.position.set(kC.x, kC.y - 0.02, pedalZ + 0.04);
  g.add(beater);
  anchor(g, 'kickPedal', kC.x, 0.05, pedalZ + 0.2);
  // --- 스네어 14"x5.5" (드러머 왼쪽 무릎 사이), 살짝 드러머 쪽으로 기울임
  const sR = 0.178,
    sD = 0.14,
    sC = V3(-0.2, 0.7, -0.44),
    sM = M4(sC.toArray(), [0.12, 0, 0]);
  drum(sR, sD, sM, 10);
  Ch.push(rbox(0.26, 0.012, 0.04, 0.003, 1).rotateX(0.12).translate(sC.x, sC.y, sC.z + sR + 0.003)); // 스트레이너(옆 장치) 대용 띠
  strike('snare', sC.x, sC.y + sD / 2 + 0.005, sC.z + 0.02);
  // 스네어 스탠드: 바구니 + 기둥 + 삼발이
  const stand = (x, z, h, legLen = 0.32, legR = 0.26) => {
    Ch.push(_cylY(0.013, h * 0.55, x, h * 0.275, z, 10));
    Ch.push(_cylY(0.009, h * 0.5, x, h * 0.75, z, 10));
    Ch.push(_cylY(0.02, 0.035, x, h * 0.55, z, 12));
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2 + 0.5;
      Ch.push(_bar([x, 0.12, z], [x + Math.cos(a) * legR, 0.012, z + Math.sin(a) * legR], 0.007, 8));
      Bk.push(new THREE.SphereGeometry(0.016, 8, 6).scale(1, 0.6, 1).translate(x + Math.cos(a) * legR, 0.01, z + Math.sin(a) * legR));
    }
  };
  stand(sC.x, sC.z, sC.y - 0.1, 0.3, 0.24);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 1.0;
    Ch.push(_bar([sC.x, sC.y - 0.1, sC.z], [sC.x + Math.cos(a) * (sR - 0.01), sC.y - 0.055, sC.z + Math.sin(a) * (sR - 0.01)], 0.006, 8));
  }
  // --- 랙탐 12"x8" (킥 위, 드러머 쪽으로 기울임) + 마운트 암
  const tR = 0.152,
    tD = 0.2,
    tC = V3(0.1, 0.92, -0.74),
    tM = M4(tC.toArray(), [0.32, 0, 0]);
  drum(tR, tD, tM, 6);
  Ch.push(_bar([kC.x, kC.y + kR - 0.02, kC.z], [kC.x, kC.y + kR + 0.14, kC.z], 0.011, 10));
  Ch.push(_bar([kC.x, kC.y + kR + 0.14, kC.z], [tC.x, tC.y - 0.06, tC.z - 0.02], 0.009, 8));
  strike('tom1', tC.x, tC.y + tD / 2 * Math.cos(0.32) + 0.004, tC.z + tD / 2 * Math.sin(0.32) + 0.02);
  // --- 플로어탐 14"x14" (오른쪽) + 다리 3개
  const fR = 0.178,
    fD = 0.35,
    fC = V3(0.55, 0.57, -0.44);
  drum(fR, fD, M4(fC.toArray(), [0.06, 0, 0]), 8);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.3;
    const bx = fC.x + Math.cos(a) * (fR + 0.015),
      bz = fC.z + Math.sin(a) * (fR + 0.015);
    Ch.push(_bar([bx, fC.y + 0.02, bz], [bx + Math.cos(a) * 0.05, 0.012, bz + Math.sin(a) * 0.05], 0.007, 8));
    Bk.push(new THREE.SphereGeometry(0.016, 8, 6).scale(1, 0.6, 1).translate(bx + Math.cos(a) * 0.05, 0.01, bz + Math.sin(a) * 0.05));
  }
  strike('tom2', fC.x, fC.y + fD / 2 + 0.004, fC.z + 0.02);
  // --- 심벌 공통: 스탠드 끝에 피벗 그룹, 안에 기울어진 심벌 + 틸터·펠트·윙너트
  const cymbal = (name, R, pos, tilt, standBase, boom) => {
    const grp = new THREE.Group();
    grp.name = name;
    grp.position.copy(pos);
    g.add(grp);
    P[name] = grp;
    const inner = new THREE.Group();
    inner.rotation.set(tilt[0], 0, tilt[1]);
    grp.add(inner);
    const cm = _mesh(_cymbalGeo(R), cymMat);
    cm.position.y = -0.004;
    inner.add(cm);
    inner.add(_mesh(mergeVC([vcol(_cylY(0.012, 0.024, 0, 0.038, 0, 10), '#ffffff'), vcol(_cylY(0.007, 0.02, 0, 0.062, 0, 8), '#ffffff'), vcol(new THREE.SphereGeometry(0.011, 10, 8).translate(0, 0.078, 0), '#ffffff')]), chrome));
    inner.add(_mesh(mergeVC([vcol(_cylY(0.02, 0.012, 0, 0.03, 0, 12), '#ffffff'), vcol(_cylY(0.02, 0.012, 0, -0.014, 0, 12), '#ffffff')]), feltMat));
    // 스탠드: 삼발이 + 기둥 (+ 붐 암)
    const [bx, bz] = standBase, top = boom ? boom : [pos.x, pos.y - 0.02, pos.z];
    const h = boom ? boom[1] : pos.y - 0.02;
    Ch.push(_cylY(0.013, h * 0.45, bx, h * 0.225, bz, 10));
    Ch.push(_cylY(0.01, h * 0.58, bx, h * 0.71, bz, 10));
    Ch.push(_cylY(0.019, 0.03, bx, h * 0.45, bz, 12));
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2 + 0.9;
      Ch.push(_bar([bx, 0.13, bz], [bx + Math.cos(a) * 0.3, 0.012, bz + Math.sin(a) * 0.3], 0.007, 8));
      Bk.push(new THREE.SphereGeometry(0.016, 8, 6).scale(1, 0.6, 1).translate(bx + Math.cos(a) * 0.3, 0.01, bz + Math.sin(a) * 0.3));
    }
    if (boom) {
      Ch.push(_cylY(0.02, 0.05, bx, h, bz, 12));
      Ch.push(_bar([bx, h, bz], [pos.x, pos.y - 0.03, pos.z], 0.009, 8));
      Ch.push(new THREE.SphereGeometry(0.03, 10, 8).scale(1.4, 1, 1).translate(bx - (pos.x - bx) * 0.35, h + (h - pos.y + 0.03) * 0.35, bz - (pos.z - bz) * 0.35));
    } // 붐 균형추
    return grp;
  };
  cymbal('ride', 0.254, V3(0.58, 1.08, -0.9), [0.28, -0.12], [0.78, -1.08], [0.78, 0.9, -1.08]);
  cymbal('crash', 0.2, V3(-0.36, 1.32, -0.98), [0.32, 0.16], [-0.62, -1.2], [-0.62, 1.0, -1.2]);
  // --- 하이햇: 아래 심벌 그룹(hihat) + 위 심벌 그룹(hihatTop, y 로 움직임) + 로드·페달
  const hC = V3(-0.5, 0.9, -0.54);
  const hat = new THREE.Group();
  hat.name = 'hihat';
  hat.position.copy(hC);
  g.add(hat);
  P.hihat = hat;
  const hb = _mesh(_cymbalGeo(0.178, 0.04), cymMat);
  hb.rotation.x = Math.PI;
  hb.position.y = 0.0;
  hat.add(hb); // 아래 심벌 (뒤집힘)
  const hatTop = new THREE.Group();
  hatTop.name = 'hihatTop';
  hatTop.position.y = 0.03;
  hat.add(hatTop);
  P.hihatTop = hatTop;
  hatTop.add(_mesh(_cymbalGeo(0.178, 0.04), cymMat));
  hatTop.add(_mesh(mergeVC([vcol(_cylY(0.011, 0.03, 0, 0.045, 0, 10), '#ffffff'), vcol(new THREE.SphereGeometry(0.012, 10, 8).translate(0, 0.066, 0), '#ffffff')]), chrome));
  hatTop.add(_mesh(_cylY(0.02, 0.014, 0, 0.034, 0, 12), feltMat));
  hat.add(_mesh(_cylY(0.0055, 0.2, 0, 0.05, 0, 8), chrome)); // 로드
  Ch.push(_cylY(0.014, hC.y - 0.1, hC.x, (hC.y - 0.1) / 2, hC.z, 10));
  Ch.push(_cylY(0.02, 0.03, hC.x, hC.y - 0.1, hC.z, 12));
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.3;
    Ch.push(_bar([hC.x, 0.16, hC.z], [hC.x + Math.cos(a) * 0.3, 0.012, hC.z + Math.sin(a) * 0.3], 0.007, 8));
    Bk.push(new THREE.SphereGeometry(0.016, 8, 6).scale(1, 0.6, 1).translate(hC.x + Math.cos(a) * 0.3, 0.01, hC.z + Math.sin(a) * 0.3));
  }
  Ch.push(rbox(0.085, 0.012, 0.26, 0.004, 2).rotateX(-0.22).translate(hC.x, 0.045, hC.z + 0.17));
  Ch.push(rbox(0.1, 0.02, 0.05, 0.005, 2).translate(hC.x, 0.012, hC.z + 0.31));
  anchor(g, 'hatPedal', hC.x, 0.06, hC.z + 0.2);
  // --- 스론: 삼발이 + 기둥 + 검정 방석
  stand(0, 0, 0.42, 0.3, 0.24);
  Bk.push(latheY([
    [0.0001, 0],
    [0.16, 0],
    [0.185, 0.03],
    [0.18, 0.07],
    [0.12, 0.085],
    [0.0001, 0.088]
  ], 32).translate(0, 0.44, 0));
  anchor(g, 'seat', 0, 0.53, 0);
  // --- 병합
  g.add(_mesh(mergeVC(Sh), shellMat));
  g.add(_mesh(mergeVC(Ch.map(q => vcol(q, '#ffffff'))), chrome));
  g.add(_mesh(mergeVC(Bk.map(q => vcol(q, '#ffffff'))), black));
  return g;
}
// f) 스틱 / 와이어 브러시 — 원점 = 쥐는 점, 축 +y, 길이 ≈ 0.4
function makeStick(brush = false) {
  const g = new THREE.Group();
  g.name = brush ? 'brush' : 'stick';
  if (!brush) {
    const wood = glossMat('#e8cfa0', 0.5, {
      outline: 0.0025
    });
    g.add(_mesh(latheY([
      [0.0001, -0.06],
      [0.0075, -0.06],
      [0.0078, 0.0],
      [0.0075, 0.2],
      [0.0055, 0.3],
      [0.0035, 0.335],
      [0.0048, 0.345],
      [0.0045, 0.355],
      [0.0001, 0.36]
    ], 14), wood));
  } else {
    const handle = toonMat('#2a2630', {
      outline: 0.0025
    }),
      wire = basicMat('#c9cdd2');
    g.add(_mesh(latheY([
      [0.0001, -0.06],
      [0.0085, -0.06],
      [0.009, 0.0],
      [0.0085, 0.2],
      [0.006, 0.22],
      [0.0001, 0.22]
    ], 14), handle));
    const W = [];
    const rnd = seeded(7);
    for (let i = 0; i < 14; i++) {
      const a = rnd.range(0, Math.PI * 2),
        r = rnd.range(0.012, 0.035);
      W.push(_bar([0, 0.21, 0], [Math.cos(a) * r, 0.4, Math.sin(a) * r], 0.0007, 4));
    }
    g.add(_mesh(mergeVC(W.map(q => vcol(q, '#ffffff'))), wire, false));
  }
  anchor(g, 'tip', 0, brush ? 0.39 : 0.355, 0);
  return g;
}

// =====================================================================
// 무대 소품 — 마이크 스탠드(붐), 베이스 앰프, 모니터 스피커
// =====================================================================
// 마이크 스탠드: 원점 = 바닥 중심. 붐 암이 -z 쪽으로 뻗고 마이크 헤드가 끝에 (높이 ≈ 1.5)
function makeMicStand(h = 1.45, boom = 0.55) {
  const g = new THREE.Group();
  g.name = 'micStand';
  const black = glossMat('#23212a', 0.4, {
    outline: 0.0035
  });
  const chrome = metalMat('#dfe5ec', 0.15, {
    outline: 0.003
  });
  const grille = metalMat('#9aa3ad', 0.5, {
    outline: 0.003
  });
  const K = [],
    C = [];
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + Math.PI / 6;
    K.push(_bar([0, 0.09, 0], [Math.cos(a) * 0.3, 0.012, Math.sin(a) * 0.3], 0.009, 8));
    K.push(new THREE.SphereGeometry(0.018, 8, 6).scale(1, 0.6, 1).translate(Math.cos(a) * 0.3, 0.01, Math.sin(a) * 0.3));
  }
  K.push(_cylY(0.015, h * 0.55, 0, h * 0.275, 0, 10));
  C.push(_cylY(0.011, h * 0.5, 0, h * 0.75, 0, 10));
  K.push(_cylY(0.022, 0.04, 0, h * 0.55, 0, 12));
  // 붐: 꼭대기 관절에서 -z 로 앞으로 살짝 내려감, 뒤쪽 균형추
  const top = V3(0, h, 0),
    tip = V3(0, h - 0.08, -boom);
  K.push(_cylY(0.024, 0.05, 0, h, 0, 12));
  C.push(_bar(top.toArray(), tip.toArray(), 0.009, 8));
  K.push(_bar(top.toArray(), [0, h + 0.03, 0.2], 0.009, 8));
  K.push(new THREE.SphereGeometry(0.03, 10, 8).scale(1, 1, 1.4).translate(0, h + 0.03, 0.2));
  // 마이크: 클립 + 몸통(검정) + 그릴(은회색 공)
  const mp = tip.clone().add(V3(0, -0.01, -0.03));
  K.push(rbox(0.03, 0.03, 0.05, 0.008, 2).translate(mp.x, mp.y + 0.01, mp.z + 0.02));
  K.push(_cylZ(0.016, 0.13, mp.x, mp.y, mp.z - 0.05, 14, 0.019));
  g.add(_mesh(mergeVC(K.map(q => vcol(q, '#ffffff'))), black));
  g.add(_mesh(mergeVC(C.map(q => vcol(q, '#ffffff'))), chrome));
  g.add(_mesh(new THREE.SphereGeometry(0.03, 16, 12).scale(1, 1, 1.15).translate(mp.x, mp.y, mp.z - 0.13), grille));
  anchor(g, 'mic', mp.x, mp.y, mp.z - 0.13);
  return g;
}
// 베이스 앰프 (콤보): 원점 = 바닥 중심, 앞면 +z. 크림 톨렉스 + 검정 그릴 + 크롬 손잡이·노브
function makeAmp(w = 0.62, h = 0.72, d = 0.42) {
  const g = new THREE.Group();
  g.name = 'amp';
  const tolex = toonMat('#f3e3bf', {
    outline: 0.0045
  });
  const black = glossMat('#1d1b22', 0.45, {
    outline: 0.0035
  });
  const chrome = metalMat('#dfe5ec', 0.2, {
    outline: 0.003
  });
  const grilleTex = canvasTex(128, 128, (c, W) => {
    c.fillStyle = '#1a1a22';
    c.fillRect(0, 0, W, W);
    c.strokeStyle = '#5a5248';
    c.lineWidth = 3;
    for (let i = -W; i < W * 2; i += 10) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i + W, W);
      c.stroke();
      c.beginPath();
      c.moveTo(i, W);
      c.lineTo(i + W, 0);
      c.stroke();
    }
  }, [3, 3]);
  const grille = toonMat('#ffffff', {
    map: grilleTex,
    outline: 0
  });
  g.add(_mesh(rbox(w, h, d, 0.03, 3).translate(0, h / 2, 0), tolex, true, true));
  g.add(_mesh(new THREE.PlaneGeometry(w - 0.08, h - 0.2).translate(0, h / 2 - 0.04, d / 2 + 0.001), grille, false));
  const K = [rbox(w - 0.06, 0.012, 0.01, 0.003, 1).translate(0, h - 0.08, d / 2 + 0.004), rbox(w - 0.06, 0.012, 0.01, 0.003, 1).translate(0, 0.06, d / 2 + 0.004)];
  for (const sx of [-1, 1]) K.push(new THREE.SphereGeometry(0.02, 8, 6).scale(1, 0.5, 1).translate(sx * (w / 2 - 0.06), 0.012, d / 2 - 0.08), new THREE.SphereGeometry(0.02, 8, 6).scale(1, 0.5, 1).translate(sx * (w / 2 - 0.06), 0.012, -d / 2 + 0.08));
  K.push(rbox(w - 0.12, 0.05, d - 0.1, 0.01, 2).translate(0, h - 0.045, 0)); // 윗면 컨트롤 패널
  g.add(_mesh(mergeVC(K.map(q => vcol(q, '#ffffff'))), black));
  const C = [];
  for (let i = 0; i < 6; i++) C.push(_cylY(0.013, 0.02, -w / 2 + 0.1 + i * 0.075, h - 0.01, 0.04, 10));
  C.push(new THREE.TorusGeometry(0.075, 0.009, 8, 20, Math.PI).translate(0, h + 0.005, -0.03)); // 손잡이
  g.add(_mesh(mergeVC(C.map(q => vcol(q, '#ffffff'))), chrome));
  return g;
}
// 모니터 웨지: 원점 = 바닥 중심, 경사면이 +z 를 향함(연주자 쪽). 검정 몸통 + 그릴 (그릴 텍스처는 인스턴스끼리 공유 → 병합 가능)
let _monGrilleTex = null;

function makeMonitor(w = 0.5, hBack = 0.3, d = 0.4) {
  const g = new THREE.Group();
  g.name = 'monitor';
  const black = glossMat('#24222b', 0.5, {
    outline: 0.0045
  });
  _monGrilleTex = _monGrilleTex || canvasTex(64, 64, (c, W) => {
    c.fillStyle = '#1b1a20';
    c.fillRect(0, 0, W, W);
    c.fillStyle = '#4a4650';
    for (let y = 4; y < W; y += 8)
      for (let x = 4; x < W; x += 8) {
        c.beginPath();
        c.arc(x, y, 2.2, 0, Math.PI * 2);
        c.fill();
      }
  }, [6, 4]);
  const grille = toonMat('#ffffff', {
    map: _monGrilleTex,
    outline: 0
  });
  // 사다리꼴 단면 (xz 로 그려 y 로 돌출 → 돌려 세움)
  const sh = new THREE.Shape();
  sh.moveTo(-d / 2, 0);
  sh.lineTo(d / 2, 0);
  sh.lineTo(d / 2, hBack);
  sh.lineTo(-d / 2 + 0.06, hBack * 0.3);
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, {
    depth: w,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 2
  });
  geo.translate(0, 0, -w / 2);
  geo.rotateY(-Math.PI / 2); // 돌출(z) → x, 단면 x → -z … 경사면이 +z 쪽
  geo.rotateY(Math.PI);
  g.add(_mesh(geo, black, true, true));
  // 경사면 그릴 (앞쪽 윗면)
  const a = Math.atan2(hBack - hBack * 0.3, d - 0.06);
  const gp = new THREE.PlaneGeometry(w - 0.06, Math.hypot(hBack * 0.7, d - 0.06) - 0.06);
  gp.rotateX(-Math.PI / 2 + a);
  gp.translate(0, hBack * 0.65 + 0.012, 0.02 - 0.0);
  const gm = _mesh(gp, grille, false);
  gm.position.z = 0.0;
  g.add(gm);
  g.add(_mesh(new THREE.TorusGeometry(0.06, 0.008, 8, 20, Math.PI).rotateX(-Math.PI / 2).rotateZ(0).translate(0, hBack + 0.004, -d / 2 + 0.08), black));
  return g;
}

// ===== 30_people.js =====
// ===================== 사람: 뼈대 하나 + 메시 하나 (표정·팔 IK·앉기/서기/점프) =====================
// 모든 부품을 뼈에 붙여 한 메시로 합침 → 사람 하나 = 그리기 2번(몸·얼굴) + 외곽선
// 기준 자세: 서서 팔을 내린 자세, 얼굴은 +z

const UPY = new THREE.Vector3(0, 1, 0);

const SKINS = ['#ffdcc0', '#f6c9a2', '#eab48a', '#d79a6c', '#b97a4f', '#93593a', '#6e3f27', '#f9d7bc', '#c98d63'];
const HAIR_COLORS = ['#1e1a1e', '#3a2418', '#5c3a22', '#8a5530', '#c99552', '#e8d9c0', '#2a2b33', '#9a3a22', '#d65a2a', '#4a2a6a'];
const TOP_COLORS = ['#ee4a2c', '#2f5bd8', '#ffbf2e', '#13a08a', '#ff8a5c', '#7b3fb0', '#3ab0d0', '#fff4de', '#8ac43a', '#ff5f95', '#22244a', '#ffd84a', '#e8e8f0', '#c23a5a'];
const PANTS_COLORS = ['#22244a', '#2b2d3a', '#3a4f8a', '#5c3a22', '#2f5a42', '#6b2a2a', '#44445a', '#c9b48a'];

// ---------- 기하 조립기 ----------

// 손 월드 회전: 손가락 방향, 손바닥이 향하는 방향
function handQuat(fingerDir, palmDir, side) {
  const Y = fingerDir.clone().normalize().negate();
  let X = palmDir.clone().normalize();
  if (side === 'L') X.negate();
  X.sub(Y.clone().multiplyScalar(X.dot(Y))).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

// ---------- 표정 ----------
// open: 입 벌림(턱이 같이 내려감), pupil: 눈동자 크기(작을수록 놀람), pop: 눈알 커짐, skew: 눈썹 짝짝이(+면 왼쪽이 올라감)

function initPeopleMaterials() {
  PEOPLE_MAT.body = toonVC({
    outline: 0.0055
  });
  PEOPLE_MAT.face = toonVC({
    outline: 0.0026,
    soft: true
  });
  PEOPLE_MAT.decal = toonVC({
    outline: 0
  });
}

// 무작위 손님 외모 (시드 고정)
function randomLook(seed) {
  const r = seeded(seed * 7919 + 13);
  const fem = r.chance(0.5);
  const hairs = fem ? ['long', 'bob', 'bun', 'pony', 'curly', 'afro', 'short', 'long'] : ['short', 'side', 'buzz', 'pomp', 'curly', 'afro', 'bald', 'short', 'mohawk'];
  const hair = r.pick(hairs);
  const styles = fem ? ['tee', 'dress', 'sweater', 'blazer', 'shirt', 'tank', 'tee', 'hoodie'] : ['tee', 'shirt', 'jacket', 'sweater', 'polo', 'hoodie', 'tee', 'blazer'];
  const topStyle = r.pick(styles);
  const L = {
    seed,
    fem,
    hair,
    hairColor: hair === 'bald' ? r.pick(['#e8d9c0', '#5c3a22', '#2a2b33']) : r.pick(HAIR_COLORS),
    skin: r.pick(SKINS),
    top: r.pick(TOP_COLORS),
    topStyle,
    pants: r.pick(PANTS_COLORS),
    shoes: r.pick(['#2a1e1a', '#f4ead8', '#8a2f1d', '#22244a', '#ee4a2c']),
    h: r.range(0.93, 1.06) * (fem ? 0.96 : 1),
    w: r.range(0.92, 1.12),
    belly: r.chance(0.25) ? r.range(0.4, 1) : 0,
    headScale: r.range(1.62, 1.82),
    nose: r.range(0.85, 1.35),
    eye: r.pick(['#2a1a14', '#3a2a1a', '#1e2a3a', '#2a3a1e']),
  };
  if (topStyle === 'jacket' || topStyle === 'blazer') {
    L.jacket = r.pick(['#22244a', '#6b3a1e', '#2f5a42', '#7a2f1d', '#c99552', '#2f5bd8', '#ee4a2c', '#7b3fb0']);
    L.shirt = r.pick(['#fff4de', '#ffd84a', '#ff8a5c', '#8cc8ff']);
    if (!fem && r.chance(0.5)) L.tie = r.pick(['#ee4a2c', '#2f5bd8', '#ffbf2e', '#13a08a']);
  }
  if (topStyle === 'dress') {
    L.dress = L.top;
    L.tights = r.chance(0.3) ? '#22244a' : null;
  }
  if (r.chance(0.3) && (topStyle === 'tee' || topStyle === 'sweater')) L.stripe = r.pick(['#fff4de', '#22244a', '#ffbf2e', '#ee4a2c']);
  if (r.chance(0.26)) L.glasses = r.pick(['#1e1a1e', '#c79a3b', '#7a2f1d', '#2f5bd8']);
  if (!fem && r.chance(0.28)) {
    if (r.chance(0.5)) L.beard = true;
    else if (r.chance(0.5)) L.mustache = true;
    else L.goatee = true;
  }
  if (r.chance(0.16) && hair !== 'afro' && hair !== 'bun' && hair !== 'mohawk') {
    L.hat = r.pick(['beret', 'fedora', 'cap', 'beanie']);
    L.hatColor = r.pick(['#22244a', '#3a2a1e', '#ee4a2c', '#2f5bd8', '#ffbf2e', '#13a08a']);
  }
  if (fem && r.chance(0.4)) L.earring = r.pick(['#ffbf2e', '#e8e8f0']);
  if (fem) L.mouthColor = r.pick(['#8a1830', '#a01c36', '#6a1824']);
  return L;
}

// 보정 모드: 손가락 위치(연속 음높이) → 지금 화음에 맞는 음
// o: { strong, cur(지금 울리는 음), nextCh, lo, hi, ok(허용 음 판정: 블루노트·접근음까지) }
function snapPitch(target, ch, o = {}) {
  const key = o.strong ? 'S' : 'W',
    ok = o.ok || (m => inSet(m, ch, key));
  const lo = o.lo || 48,
    hi = o.hi || 90;
  let best = null,
    bs = Infinity;
  for (let m = Math.max(lo, Math.floor(target) - 6); m <= Math.min(hi, Math.ceil(target) + 6); m++) {
    if (!ok(m)) continue;
    let s = Math.abs(m - target) * 1.0;
    if (!inSet(m, ch, key)) s += 0.18; // 블루노트·접근음은 손가락이 그 자리에 가까울 때만
    if (o.strong && isChordTone(m, ch)) s -= 0.35;
    if (isGuide(m, ch)) s -= 0.25;
    if (o.nextCh && o.nextCh !== ch && !inSet(m, o.nextCh, 'W')) s += 0.3;
    if (s < bs) {
      bs = s;
      best = m;
    }
  }
  if (best == null) best = nearestAllowed(target, ch, key);
  // 히스테리시스: 지금 음이 여전히 맞고 손가락이 많이 안 움직였으면 유지
  if (o.cur != null && o.cur !== best && ok(o.cur) && Math.abs(target - o.cur) < Math.abs(target - best) + 0.45) return o.cur;
  return best;
}
// 피아노 왼손 보이싱 (앞 보이싱에서 가장 덜 움직이는 것)
function voicingFor(ch, prev, lo = 50, hi = 77) {
  const forms = QUAL[ch.q].v,
    cands = [];
  for (const f of forms)
    for (let base = lo - 12; base <= hi; base++) {
      if (mod12(base) !== ch.root) continue;
      const v = f.map(i => base + i);
      if (v[0] < lo || v[v.length - 1] > hi) continue;
      cands.push(v);
    }
  if (!cands.length) return forms[0].map(i => 48 + mod12(ch.root) + i);
  if (!prev) return pick(cands);
  let best = cands[0],
    bd = 1e9;
  for (const v of cands) {
    let d = 0;
    for (let i = 0; i < Math.min(v.length, prev.length); i++) d += Math.abs(v[i] - prev[i]);
    d += Math.random() * 2.5;
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}
// 멜로디 표기 해석: "C4/1 D4/.5 r/.5 F4/2~ | F4/1 ..." → [{bar, pos, dur, midi, who}]
function parsePitch(tok) {
  const m = tok.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) return null;
  return PC[m[1] + (m[2] || '')] + (parseInt(m[3], 10) + 1) * 12 + ((m[1] + (m[2] || '')) === 'B#' ? 12 : 0) - ((m[1] + (m[2] || '')) === 'Cb' ? 12 : 0);
}

function parseDur(d) {
  if (d.includes('/')) {
    const [a, b] = d.split('/').map(Number);
    return a / b;
  }
  return parseFloat(d);
}

function parseMelody(str) {
  const bars = str.split('|').map(b => b.trim());
  const out = [];
  let tieFrom = null;
  bars.forEach((b, bi) => {
    if (!b.length) return;
    let pos = 0;
    for (let tok of b.split(/\s+/)) {
      let who = 't';
      if (tok.startsWith('b:')) {
        who = 'b';
        tok = tok.slice(2);
      } else if (tok.startsWith('t:')) tok = tok.slice(2);
      const tie = tok.endsWith('~');
      if (tie) tok = tok.slice(0, -1);
      const sl = tok.indexOf('/');
      const p = tok.slice(0, sl),
        d = parseDur(tok.slice(sl + 1));
      if (p !== 'r') {
        const midi = parsePitch(p);
        if (tieFrom && tieFrom.midi === midi && pos < 1e-6) {
          tieFrom.dur += d;
          if (!tie) tieFrom = null;
        } else {
          const n = {
            bar: bi,
            pos,
            dur: d,
            midi,
            who
          };
          out.push(n);
          tieFrom = tie ? n : null;
        }
      } else tieFrom = null;
      pos += d;
    }
  });
  return out;
}

// ===== 42_band.js =====
// ===================== 밴드 소리: 리듬 섹션 6가지 느낌 + 솔로이스트 + 테마 =====================
// 마디 기록 b: { t0, spb, swing, chords:[{root,q,at,len}], feel, fb, phase, abs, beat0 }
const VQ = [];
const vq = (t, who, type, data = {}) => {
  const e = {
    t,
    ...data,
    who,
    type
  };
  VQ.push(e);
  if (who === 'song' && MUS.onSongEvent) MUS.onSongEvent(e);
  return e;
};
const MUS = {
  running: false,
  timer: null,
  look: 0.34,
  bars: [],
  nextT: 0,
  song: null,
  gap: null,
  dyn: 0.85,
  dynT: 0.85,
  energy: 0.4,
  brushes: false,
  brushT: false,
  fermata: null,
  soloH: [],
  soloWho: null,
  beatBase: 0,
  setPos: 0,
  setOrder: [],
  songsPlayed: 0,
};
// 박 위치 → 시간 (스윙: 8분 뒷박을 늦춤)
function pt(b, pos) {
  const w = Math.floor(pos + 1e-6), f = pos - w;
  const ff = Math.abs(f - 0.5) < 1e-6 ? b.swing : f;
  return b.t0 + (w + ff) * b.spb;
}

function barAtTime(t) {
  const B = MUS.bars;
  for (let i = B.length - 1; i >= 0; i--)
    if (B[i].t0 <= t + 1e-6) return B[i];
  return B[0] || null;
}

function chordAtTime(t) {
  if (MUS.fermata && !MUS.fermata.cut && t >= MUS.fermata.t) return MUS.fermata.ch;
  const b = barAtTime(t);
  if (!b || t > b.t0 + 4 * b.spb + 0.05) return MUS.gapChord || parseChord('C6');
  return chordAt(b, clamp((t - b.t0) / b.spb, 0, 3.999));
}

function beatPosAt(t) {
  const b = barAtTime(t);
  if (!b) return 0;
  return (t - b.t0) / b.spb;
}

function isStrongTime(t) {
  const p = beatPosAt(t),
    f = p - Math.floor(p);
  return f < 0.2 || f > 0.88;
}
// 화면용 박 (끊기지 않게): 마디 시작 박 + 진행
function beatAt(t) {
  const b = barAtTime(t);
  if (!b) return MUS.beatBase + (t - (MUS.beatT || 0)) * 2;
  if (t > b.t0 + 4 * b.spb) return b.beat0 + 4 + (t - b.t0 - 4 * b.spb) / (MUS.gapSpb || b.spb);
  return b.beat0 + (t - b.t0) / b.spb;
}
const curSpb = () => {
  const b = barAtTime(AE.ctx ? AE.ctx.currentTime : 0);
  return b ? b.spb : 0.45;
};

// ---------- 악기 소리 ----------
const vel = v => clamp(v * MUS.dyn, 0, 1.25);

function bassNote(t, midi, dur, v, o = {}) {
  const s = nearestSample('K', midi);
  const h = playOne(s, midi, t, vel(v) * (o.ghost ? 0.35 : 1), AE.buses.bass, {
    dur: o.ghost ? 0.06 : dur,
    release: o.ghost ? 0.03 : (o.rel || 0.12),
    lp: o.ghost ? 600 : (o.lp || 2600)
  });
  vq(t, 'bass', 'pluck', {
    midi,
    ghost: !!o.ghost,
    solo: !!o.solo
  });
  return h;
}

function pianoNotes(t, notes, dur, v, hand = 'L', roll = 0.012, o = {}) {
  const hs = [];
  notes.forEach((m, i) => {
    const s = nearestSample('P', m);
    hs.push(playOne(s, m, t + i * roll * rand(0.6, 1.3), vel(v) * rand(0.88, 1.05), AE.buses.pno, {
      dur,
      release: o.rel || 0.35
    }));
  });
  vq(t, 'pno', 'hit', {
    notes,
    hand,
    dur,
    solo: !!o.solo
  });
  return hs;
}
const DR = {
  ride: -0.28,
  ridebell: -0.28,
  crash: 0.25,
  snare: 0.04,
  ghost: 0.04,
  xstick: 0.04,
  hat: 0.22,
  hatOpen: 0.22,
  kick: 0,
  tomHi: -0.05,
  tomLo: -0.18,
  brush: 0.05,
  btap: 0.04,
  stick: 0
};

function drum(piece, t, v, limb) {
  if (limb === 'L' && (piece === 'ghost' || piece === 'snare') && DIR.drPhone && NOW.t < DIR.drPhone.until) return null;
  const D = AE.sets.D,
    S = AE.syn,
    bus = AE.buses.drums,
    pan = DR[piece] || 0;
  const vv = vel(v);
  let h = null;
  switch (piece) {
    case 'ride':
      h = playBuf(D.ride.buf, t, vv * 0.55, bus, {
        pan,
        offset: D.ride.start,
        rate: rand(0.985, 1.015)
      });
      break;
    case 'ridebell':
      h = playBuf(D.ridebell.buf, t, vv * 0.5, bus, {
        pan,
        offset: D.ridebell.start
      });
      break;
    case 'crash':
      h = playBuf(D.crash.buf, t, vv * 0.55, bus, {
        pan,
        offset: D.crash.start
      });
      break;
    case 'snare':
      h = playBuf(D.snare.buf, t, vv * 0.6, bus, {
        pan,
        offset: D.snare.start
      });
      break;
    case 'ghost':
      h = playBuf(D.ghost.buf, t, vv * 0.5, bus, {
        pan,
        offset: D.ghost.start,
        rate: rand(0.97, 1.03)
      });
      break;
    case 'xstick':
      h = playBuf(D.xstick.buf, t, vv * 0.5, bus, {
        pan,
        offset: D.xstick.start
      });
      break;
    case 'kick':
      h = playBuf(S.kick, t, vv * 0.85, bus, {
        pan
      });
      break;
    case 'hat':
      h = playBuf(S.hat, t, vv * 0.32, bus, {
        pan
      });
      break;
    case 'hatOpen':
      h = playBuf(S.hatOpen, t, vv * 0.22, bus, {
        pan
      });
      break;
    case 'tomHi':
      h = playBuf(S.tomHi, t, vv * 0.55, bus, {
        pan
      });
      break;
    case 'tomLo':
      h = playBuf(S.tomLo, t, vv * 0.6, bus, {
        pan
      });
      break;
    case 'brush':
      h = playBuf(S.brush, t, vv * 0.32, bus, {
        pan: rand(-0.15, 0.2),
        rate: rand(0.92, 1.08)
      });
      break;
    case 'btap':
      h = playBuf(S.btap, t, vv * 0.45, bus, {
        pan
      });
      break;
    case 'stick':
      h = playBuf(S.stick, t, vv * 0.7, bus, {
        pan: 0
      });
      break;
  }
  vq(t, 'drums', 'hit', {
    piece,
    v,
    limb
  });
  return h;
}
// 트롬본
const TBN_PARTIALS = [34, 46, 53, 58, 62, 65, 70, 72, 74, 77];

function slidePos(m) {
  let best = 1;
  for (const p of TBN_PARTIALS) {
    const k = p - m + 1;
    if (k >= 1 && k <= 7) {
      best = k;
      break;
    }
  }
  return best;
}

function tbnNote(t, m, dur, v = 0.9, o = {}) {
  const s = nearestSample('B', m);
  const vo = new SusVoice(AE.ctx, s, m, t, AE.buses.tbn, {
    level: vel(v) * 0.9,
    fadeIn: o.fadeIn || 0.022,
    scoop: o.scoop != null ? o.scoop : (Math.random() < 0.22 ? -0.6 : 0),
    scoopTime: 0.05,
    offset: s.start + 0.01
  });
  if (dur > (o.vibAfter || 0.5)) vo.vibrato(o.vib || 12, t + Math.min(0.35, dur * 0.5), 0.3);
  if (o.fall) {
    vo.bend(-5, t + dur - 0.05, 0.25);
    vo.release(t + dur + 0.18, 0.12);
  } else vo.release(t + dur, o.rel || 0.07);
  vq(t, 'tbn', 'note', {
    midi: m,
    dur,
    slide: slidePos(m),
    solo: !!o.solo
  });
  return vo;
}

// ---------- 리듬 섹션 ----------
const BASS = {
  last: 41
};
const PNO = {
  voicing: null
};

// 스윙: 워킹 베이스
function bassWalk(b, next) {
  const out = [],
    chs = b.chords;
  for (let a = 0; a < chs.length; a++) {
    const ch = chs[a],
      b0 = ch.at,
      len = ch.len;
    const nextRoot = a + 1 < chs.length ? chs[a + 1].root : next.root;
    const prev = out.length ? out[out.length - 1][1] : BASS.last;
    let first = nearestPC(ch.root, prev, 31, 50);
    if (Math.random() < 0.12 && len >= 4) first = nearestPC(mod12(ch.root + QUAL[ch.q].tones[1]), prev, 31, 50);
    out.push([b0, first]);
    const target = nearestPC(nextRoot, first, 29, 52);
    const appr = Math.random() < 0.68 ? target + (target > first ? -1 : 1) : (Math.random() < 0.5 ? target + 7 : target - 5);
    if (len >= 4) {
      const dir = Math.sign(appr - first) || (Math.random() < 0.5 ? 1 : -1);
      let cur = first;
      for (let k = 1; k <= 2; k++) {
        const cand = [];
        for (let m = cur + dir; Math.abs(m - cur) < 6; m += dir)
          if (inSet(m, ch, Math.random() < 0.6 ? 'S' : 'W')) cand.push(m);
        let n = cand.length ? cand[Math.min(cand.length - 1, randi(0, 1))] : cur + dir * 2;
        if (n === appr) n = cur + dir;
        out.push([b0 + k, clamp(n, 28, 55)]);
        cur = n;
      }
      out.push([b0 + 3, clamp(appr, 28, 55)]);
    } else if (len >= 2) out.push([b0 + 1, clamp(appr, 28, 55)]);
    else if (len < 2 && a === chs.length - 1) { }
  }
  out.forEach(([p, m], i) => {
    const acc = p % 4 === 0 ? 1.0 : (p % 2 === 0 ? 0.92 : 0.86);
    bassNote(pt(b, p), m, b.spb * 0.9, acc * rand(0.92, 1.04));
    if (p % 2 === 1 && Math.random() < 0.08) bassNote(pt(b, p + 2 / 3), m, 0.05, 0.5, {
      ghost: true
    });
  });
  BASS.last = out.length ? out[out.length - 1][1] : BASS.last;
}

function bassTwo(b, next) {
  const chs = b.chords,
    c0 = chs[0],
    c1 = chs.length > 1 ? chs[chs.length > 2 ? 2 : 1] : null;
  const r = nearestPC(c0.root, BASS.last, 29, 48);
  bassNote(pt(b, 0), r, b.spb * 1.8, 0.95);
  const n3 = c1 ? nearestPC(c1.root, r, 29, 50) : (Math.random() < 0.5 ? r + 7 : r - 5);
  if (Math.random() < 0.3) bassNote(pt(b, 1.5), clamp(n3 + (Math.random() < 0.5 ? 2 : -1), 28, 52), b.spb * 0.35, 0.7);
  bassNote(pt(b, 2), clamp(n3, 28, 52), b.spb * 1.4, 0.88);
  if (Math.random() < 0.4) bassNote(pt(b, 3.5), nearestPC(next.root, n3, 29, 50) + (Math.random() < 0.5 ? 1 : -1), b.spb * 0.4, 0.75);
  BASS.last = clamp(n3, 28, 52);
}

function bassBossa(b, next) {
  const chs = b.chords;
  for (const ch of chs) {
    const r = nearestPC(ch.root, BASS.last, 31, 45),
      f = r + 7 <= 50 ? r + 7 : r - 5;
    if (ch.len >= 4) {
      bassNote(pt(b, ch.at), r, b.spb * 1.4, 0.95);
      bassNote(pt(b, ch.at + 1.5), r, b.spb * 0.45, 0.7);
      bassNote(pt(b, ch.at + 2), f, b.spb * 1.4, 0.88);
      bassNote(pt(b, ch.at + 3.5), f, b.spb * 0.45, 0.68);
    } else {
      bassNote(pt(b, ch.at), r, b.spb * 1.4, 0.92);
      bassNote(pt(b, ch.at + 1.5), f, b.spb * 0.45, 0.7);
    }
    BASS.last = r;
  }
}

function bassTumbao(b, next) {
  // 2&에 5도, 4박에 다음 화음 근음(앞당김)
  const ch = b.chords[b.chords.length - 1];
  const r = nearestPC(b.chords[0].root, BASS.last, 31, 45);
  bassNote(pt(b, 1.5), r + 7 <= 52 ? r + 7 : r - 5, b.spb * 1.3, 0.92);
  const nr = nearestPC(next.root, r, 31, 45);
  bassNote(pt(b, 3), nr, b.spb * 1.5, 1.0);
  if (Math.random() < 0.25) bassNote(pt(b, 0.5), r, b.spb * 0.4, 0.6);
  BASS.last = nr;
  void ch;
}

function bassShuffle(b, odd) {
  // 부기 워킹: R 3 5 6 | b7 6 5 3 (셋잇단 셔플 앞꾸밈)
  const ch = b.chords[0];
  const r = nearestPC(ch.root, 36, 31, 43);
  const pat = (ch.q.startsWith('m')) ? (odd ? [0, 3, 7, 9] : [10, 9, 7, 3]) : (odd ? [0, 4, 7, 9] : [10, 9, 7, 4]);
  pat.forEach((iv, k) => {
    bassNote(pt(b, k), r + iv, b.spb * 0.75, k === 0 ? 1 : 0.86);
    if (Math.random() < 0.35) bassNote(pt(b, k + 2 / 3), r + iv, b.spb * 0.25, 0.55);
  });
  BASS.last = r;
}
const BOOG = [
  [
    [0, 0, 0.75],
    [1, 0, 0.45],
    [1.5, 7, 0.45],
    [2, 10, 0.45],
    [2.5, 12, 0.45],
    [3, 10, 0.4],
    [3.5, 7, 0.45]
  ],
  [
    [0, 0, 0.9],
    [1.5, 0, 0.45],
    [2, 3, 0.4],
    [2.5, 4, 0.45],
    [3, 7, 0.9]
  ]
];

function bassBoogaloo(b, odd) {
  const ch = b.chords[0],
    r = nearestPC(ch.root, 36, 31, 42);
  for (const [p, iv, d] of BOOG[odd ? 0 : 1]) bassNote(pt(b, p), r + iv, b.spb * d, p === 0 ? 1 : 0.85, {
    lp: 1800
  });
  BASS.last = r;
}

function bassBallad(b, next) {
  const chs = b.chords;
  for (const ch of chs) {
    const r = nearestPC(ch.root, BASS.last, 29, 47);
    bassNote(pt(b, ch.at), r, b.spb * Math.min(ch.len, 2) * 0.95, 0.9, {
      rel: 0.3
    });
    if (ch.len >= 4) {
      const n = Math.random() < 0.5 ? r + 7 : nearestPC(next.root, r, 29, 48) + (Math.random() < 0.5 ? 1 : -1);
      bassNote(pt(b, ch.at + 2), clamp(n, 28, 52), b.spb * 1.8, 0.82, {
        rel: 0.3
      });
    }
    BASS.last = r;
  }
}

// 드럼
function drumsSwing(b, last, first) {
  const e = MUS.energy,
    fast = 60 / b.spb > 190;
  if (!MUS.brushes) {
    const R = fast ? [
      [0, 0.62],
      [1, 0.75],
      [2, 0.62],
      [3, 0.75],
      [3.5, 0.4]
    ] : [
      [0, 0.62],
      [1, 0.78],
      [1.5, 0.45],
      [2, 0.62],
      [3, 0.78],
      [3.5, 0.45]
    ];
    for (const [p, v] of R) {
      const bell = e > 0.78 && (p === 1 || p === 3) && Math.random() < 0.35;
      drum(bell ? 'ridebell' : 'ride', pt(b, p) + rand(-0.004, 0.004), v * rand(0.9, 1.05), 'R');
    }
    drum('hat', pt(b, 1), 0.7, 'LF');
    drum('hat', pt(b, 3), 0.75, 'LF');
    for (let k = 0; k < 4; k++)
      if (Math.random() < 0.8) drum('kick', pt(b, k), 0.15 + (k === 0 ? 0.05 : 0), 'RF');
    if (!last) {
      const n = Math.random() < 0.2 ? 0 : randi(1, 1 + Math.round(e * 3));
      for (const s of shuffle([0.5, 1.5, 2.5, 3.5, 1, 3, 2 + 2 / 3, 1 + 2 / 3]).slice(0, n)) {
        const acc = Math.random() < 0.18 + e * 0.25;
        drum(acc ? 'snare' : 'ghost', pt(b, s), acc ? 0.5 + e * 0.2 : rand(0.25, 0.38), 'L');
        if (acc && Math.random() < 0.3 + e * 0.3) drum('kick', pt(b, s), 0.45 + e * 0.25, 'RF');
      }
    }
  } else drumsBrush(b);
  if (first) drum('crash', pt(b, 0), MUS.brushes ? 0.35 : 0.7, 'R');
  if (last) drumFill(b, MUS.brushes ? 0.5 : 0.75);
}

function drumsBrush(b) {
  for (let k = 0; k < 4; k++) drum('brush', pt(b, k) - 0.04, 0.72, 'L');
  drum('btap', pt(b, 1), 0.62, 'R');
  drum('btap', pt(b, 3), 0.62, 'R');
  if (Math.random() < 0.4) drum('btap', pt(b, 2.5), 0.38, 'R');
  drum('hat', pt(b, 1), 0.5, 'LF');
  drum('hat', pt(b, 3), 0.55, 'LF');
  drum('kick', pt(b, 0), 0.12, 'RF');
}

function drumsBossa(b, odd) {
  for (let k = 0; k < 8; k++) drum('hat', pt(b, k * 0.5), k % 2 ? 0.42 : 0.6, 'R');
  for (const p of odd ? [0, 1.5, 3] : [1, 2.5]) drum('xstick', pt(b, p), 0.62, 'L');
  drum('kick', pt(b, 0), 0.5, 'RF');
  drum('kick', pt(b, 1.5), 0.3, 'RF');
  drum('kick', pt(b, 2), 0.45, 'RF');
  drum('kick', pt(b, 3.5), 0.3, 'RF');
}

function drumsLatin(b, odd) {
  const cas = odd ? [0, 1, 1.5, 2.5, 3.5] : [0, 1, 2, 2.5, 3.5];
  for (const p of cas) drum('ridebell', pt(b, p), p % 1 === 0 ? 0.62 : 0.5, 'R');
  for (const p of odd ? [1, 2] : [0, 1.5, 3]) drum('xstick', pt(b, p), 0.6, 'L');
  drum('kick', pt(b, 1.5), 0.45, 'RF');
  drum('kick', pt(b, 3), 0.55, 'RF');
  drum('hat', pt(b, 1), 0.5, 'LF');
  drum('hat', pt(b, 3), 0.5, 'LF');
  if (Math.random() < 0.3) {
    drum('tomHi', pt(b, 3.5), 0.45, 'L');
  }
}

function drumsShuffle(b, last) {
  for (let k = 0; k < 4; k++) {
    drum('ride', pt(b, k), k % 2 ? 0.72 : 0.6, 'R');
    drum('ride', pt(b, k + 2 / 3), 0.42, 'R');
  }
  drum('snare', pt(b, 1), 0.78, 'L');
  drum('snare', pt(b, 3), 0.82, 'L');
  drum('kick', pt(b, 0), 0.7, 'RF');
  drum('kick', pt(b, 2), 0.6, 'RF');
  if (Math.random() < 0.4) drum('kick', pt(b, 2 + 2 / 3), 0.4, 'RF');
  drum('hat', pt(b, 1), 0.6, 'LF');
  drum('hat', pt(b, 3), 0.6, 'LF');
  if (Math.random() < 0.5) drum('ghost', pt(b, 1 + 2 / 3), 0.3, 'L');
  if (last) drumFill(b, 0.7);
}

function drumsBoogaloo(b, last, odd) {
  for (let k = 0; k < 8; k++) drum(k === 7 && odd ? 'hatOpen' : 'hat', pt(b, k * 0.5), k % 2 ? 0.48 : 0.7, 'R');
  drum('snare', pt(b, 1), 0.85, 'L');
  drum('snare', pt(b, 3), 0.85, 'L');
  for (const p of odd ? [0, 1.5, 2.5] : [0, 0.75, 2, 2.5]) drum('kick', pt(b, p), p === 0 ? 0.9 : 0.65, 'RF');
  if (Math.random() < 0.4) drum('ghost', pt(b, 2.25), 0.3, 'L');
  if (last) drumFill(b, 0.75);
}

function drumFill(b, v, from = 2) {
  const pieces = ['snare', 'snare', 'tomHi', 'tomHi', 'tomLo', 'tomLo'];
  let k = 0;
  const step = b.swing > 0.55 ? 1 / 3 : 0.25;
  for (let p = from; p < 4 - 1e-6; p += step) {
    if (Math.random() < 0.2 && k > 0) {
      k++;
      continue;
    }
    const piece = MUS.brushes ? (k % 2 ? 'btap' : 'snare') : pieces[Math.min(pieces.length - 1, Math.floor(k / 1.2))];
    drum(piece, b.t0 + p * b.spb, v * (0.6 + k * 0.05), k % 2 ? 'L' : 'R');
    k++;
  }
  drum('kick', b.t0 + (4 - step) * b.spb, v * 0.8, 'RF');
}

function countOff(b, full) {
  const beats = full ? [0, 1, 2, 3] : [0, 2];
  for (const k of beats) drum('stick', pt(b, k), 0.8, 'LR');
  vq(b.t0, 'drums', 'count', {
    full
  });
}

// 피아노 컴핑
function compHit(b, pos, ch, durBeats, v, o = {}) {
  PNO.voicing = voicingFor(ch, PNO.voicing, o.lo || 50, o.hi || 77);
  return pianoNotes(pt(b, pos), PNO.voicing, durBeats * b.spb, v, 'L', o.roll == null ? 0.012 : o.roll);
}
const COMP1 = [
  [
    [0, 1.6]
  ],
  [
    [1.5, 0.45]
  ],
  [
    [2.5, 1.2]
  ],
  [
    [0, 0.5],
    [1.5, 0.45]
  ],
  [
    [1, 0.45],
    [2.5, 0.45]
  ],
  [
    [0.5, 0.4],
    [2.5, 1.0]
  ],
  [
    [1.5, 0.4],
    [3, 0.6]
  ],
  [
    [3.5, 0.5, 'a']
  ]
];

function compSwing(b, next, density) {
  const chs = b.chords,
    v = 0.42 + MUS.energy * 0.12;
  if (chs.length > 1) {
    const a = pick([[0, 1.0], [0.5, 0.45], [-0.5, 0.45]]), bb = pick([[2, 0.9], [2.5, 0.45], [1.5, 0.45]]);
    const pa = Math.max(0, a[0]);
    compHit(b, pa, chs[0], a[1], v);
    if (Math.random() < 0.3 + density * 0.6) compHit(b, bb[0], chordAt(b, Math.max(bb[0], chs[1].at)), bb[1], v * 0.95);
    return;
  }
  let pat = pick(COMP1);
  if (density < 0.35 && Math.random() < 0.6) pat = [pick(pat)];
  if (density > 0.7 && Math.random() < 0.5) pat = pat.concat([[3.5, 0.4, 'a']]);
  for (const [pos, d, ant] of pat) compHit(b, pos, ant ? next : chordAt(b, pos), d, v * rand(0.9, 1.05));
}

function compBallad(b) {
  for (const ch of b.chords) {
    PNO.voicing = voicingFor(ch, PNO.voicing, 50, 76);
    const bassn = nearestPC(ch.root, 40, 36, 47);
    pianoNotes(pt(b, ch.at), [bassn, ...PNO.voicing], b.spb * ch.len * 0.98, 0.4, 'L', 0.045, {
      rel: 0.8
    });
    if (ch.len >= 4 && Math.random() < 0.5) {
      const top = PNO.voicing[PNO.voicing.length - 1] + 12;
      pianoNotes(pt(b, ch.at + 2.5), [top, top - 3 + randi(0, 2)], b.spb * 1.2, 0.26, 'R', 0.06, {
        rel: 0.6
      });
    }
  }
}

function compBossa(b, next, odd) {
  const pat = odd ? [[0, 1.0], [1.5, 0.45], [3, 0.5]] : [[1, 0.45], [2.5, 0.9]];
  for (const [p, d] of pat) compHit(b, p, chordAt(b, p), d, 0.4, { roll: 0.006 });
  if (!odd && Math.random() < 0.6) compHit(b, 3.5, next, 0.45, 0.36, { roll: 0.006 });
}

function compMontuno(b, next, odd) {
  const ch = b.chords[0],
    r = ch.root,
    T = QUAL[ch.q].tones;
  const pos = odd ? [0, 1, 1.5, 2.5, 3, 3.5] : [0.5, 1.5, 2, 3, 3.5];
  pos.forEach((p, i) => {
    const c = chordAt(b, p),
      tt = QUAL[c.q].tones,
      base = 60 + mod12(c.root - 0);
    const a = nearestPC(c.root + tt[(i + 1) % tt.length], 70, 64, 79),
      bb = nearestPC(c.root + tt[(i + 2) % tt.length], a + 3, a + 2, a + 9);
    pianoNotes(pt(b, p), [a, bb, a + 12], b.spb * 0.38, 0.36, 'R', 0.003, {
      rel: 0.12
    });
    void base;
  });
  void r;
  void T;
}

function compShuffle(b) {
  const ch = b.chords[0];
  for (const p of [1, 3]) compHit(b, p, chordAt(b, p), 0.5, 0.42, {
    roll: 0.005
  });
  if (Math.random() < 0.5) compHit(b, 2 + 2 / 3, chordAt(b, 3), 0.3, 0.34, {
    roll: 0.005
  });
  void ch;
}

function compBoogaloo(b, next, odd) {
  const pat = odd ? [0.5, 1.5, 2.5] : [0.5, 2, 3.5];
  for (const p of pat) compHit(b, p, p >= 3.5 ? next : chordAt(b, p), 0.28, 0.42, {
    roll: 0.003,
    lo: 55,
    hi: 79
  });
}

// 솔로 음표를 소리로 + 끊을 수 있게 기억
function rememberSolo(h, t) {
  if (h) MUS.soloH.push({ h, t });
}

function playSoloLine(who, b, notes) {
  for (const n of notes) {
    const t = pt(b, n.pos),
      d = n.dur * b.spb;
    if (who === 'tb') {
      const long = n.dur >= 1;
      rememberSolo(tbnNote(t, n.m, d * (n.dur <= 0.5 ? 0.82 : 0.94), 0.92 * n.v, {
        solo: true,
        scoop: long && Math.random() < 0.3 ? -1 : 0,
        vib: 14
      }), t);
    } else if (who === 'pn') {
      const s = nearestSample('P', n.m);
      rememberSolo(playOne(s, n.m, t, vel(0.58 * n.v) * rand(0.9, 1.05), AE.buses.pno, {
        dur: d < 0.3 ? d * 0.8 : d * 0.95,
        release: 0.2
      }), t);
      vq(t, 'pno', 'hit', {
        notes: [n.m],
        hand: 'R',
        dur: d,
        solo: true
      });
    } else if (who === 'bs') {
      rememberSolo(bassNote(t, n.m, d * 0.92, 1.05 * n.v, {
        solo: true,
        lp: 3200
      }), t);
    }
  }
}
// 드럼 솔로 (주고받기 4마디)
function drumSoloBar(b, k, of) {
  const step = b.swing > 0.55 ? 1 / 3 : 0.5, build = (k + 1) / of;
  const pieces = ['snare', 'tomHi', 'tomLo', 'snare', 'kick'];
  for (let p = 0; p < 4 - 1e-6; p += step) {
    if (Math.random() < 0.28 - build * 0.12) continue;
    const pc = pick(pieces);
    drum(pc, b.t0 + (Math.abs(p - Math.round(p)) < 1e-6 ? p : (step === 1 / 3 ? p : Math.floor(p) + b.swing)) * b.spb, 0.5 + build * 0.4 + rand(-0.1, 0.1), pc === 'kick' ? 'RF' : (Math.round(p / step) % 2 ? 'L' : 'R'));
  }
  if (k === 0) drum('crash', b.t0, 0.85, 'R');
  if (k === of - 1) drum('crash', b.t0 + 3 * b.spb, 0.9, 'R');
  drum('hat', pt(b, 1), 0.5, 'LF');
  drum('hat', pt(b, 3), 0.5, 'LF');
}

// ===== 44_conductor.js =====
// ===================== 공연 진행: 셋리스트 · 곡 흐름 · 솔로 넘기기 =====================
// 곡마다: (카운트) → (인트로) → 테마 → 솔로 → 테마 → 엔딩 → 박수 → 다음 곡
// - 내가 불면 그때부터 내 솔로 (남의 솔로는 즉시, 테마는 그 4마디 프레이즈 끝에서)
// - 내가 3~5초 쉬면 다음 마디(짝수 마디)에서 밴드가 받음. 밴드가 다 돌면 테마로
// - 내가 계속 불면 곡은 끝나지 않음 (엔딩 태그도 계속 돎)
const SET_ORDER = ['f-blues', 'autumn-g', 'bossa-c', 'rhythm-bb', 'ballad-eb', 'modal-d', 'shuffle-bb', 'latin-f', 'things-ab', 'boogaloo-f', 'train-c', 'minor-blues-c', 'tuneup-d', 'georgia-f', 'closer-bb'];
const FEEL_SWING = {
  swing: 0.63,
  ballad: 0.6,
  bossa: 0.5,
  latin: 0.5,
  shuffle: 0.67,
  boogaloo: 0.5
};

function tuneById(id) {
  return TUNES.find(t => t.id === id);
}

function buildSetOrder(first) {
  const ids = TUNES.map(t => t.id);
  if (first) return SET_ORDER.filter(id => ids.includes(id)).concat(ids.filter(id => !SET_ORDER.includes(id)));
  // 두 번째 바퀴부터: 섞되 같은 느낌이 연달아 오지 않게, 마무리 곡은 끝에
  for (let tries = 0; tries < 50; tries++) {
    const a = shuffle(ids.filter(id => id !== 'closer-bb'));
    let ok = true;
    for (let i = 1; i < a.length; i++)
      if (tuneById(a[i]).feel === tuneById(a[i - 1]).feel && tuneById(a[i]).feel !== 'swing') ok = false;
    if (ok) return ids.includes('closer-bb') ? a.concat(['closer-bb']) : a;
  }
  return shuffle(ids.slice());
}

function compileSong(tune, idx) {
  const form = parseForm(tune.form),
    N = form.length;
  const secs = [];
  let s0 = 0;
  for (const tok of tune.sections.trim().split(/\s+/)) {
    const m = tok.match(/^([A-Z])(\d+)$/);
    secs.push({ label: m[1], start: s0, len: +m[2] });
    s0 += +m[2];
  }
  const head = parseMelody(tune.head.mel),
    headByBar = [];
  for (const n of head) (headByBar[n.bar] = headByBar[n.bar] || []).push(n);
  let swing = FEEL_SWING[tune.feel] || 0.62;
  if (tune.feel === 'swing') swing = lerp(0.66, 0.57, clamp((tune.bpm - 110) / 120, 0, 1));
  const keyPc = PC[tune.key];
  // 으뜸화음 (끝 화음): 마지막 두 마디에서 같은 근음의 화음을 찾음
  let tonic = null;
  for (let i = N - 1; i >= Math.max(0, N - 3) && !tonic; i--)
    for (const c of form[i])
      if (c.root === keyPc) {
        tonic = c;
        break;
      }
  const minor = tonic ? tonic.q.startsWith('m') : form[0][0].q.startsWith('m');
  const final = parseChord(tune.key + (minor ? 'm9' : '69'));
  const ballad = tune.feel === 'ballad';
  return {
    tune,
    idx,
    N,
    form,
    secs,
    headByBar,
    headInst: tune.head.inst,
    passes: tune.head.passes || 1,
    bpm: tune.bpm,
    spb: 60 / tune.bpm,
    swing,
    minor,
    final,
    keyPc,
    unit: ballad ? 16 : N,
    minSolo: ballad ? 16 : (N <= 16 ? 2 * N : N),
    phase: 'count',
    countLeft: 0,
    introLeft: 0,
    fb: 0,
    pass: 0,
    chorus: 0,
    abs: 0,
    floor: null,
    queue: (tune.solos || ['tb', 'pn']).map(x => x === 'tbn' ? 'tb' : x === 'pno' ? 'pn' : x === 'bass' ? 'bs' : x),
    soloBars: 0,
    meBars: 0,
    filler: false,
    pending: null,
    toHead: false,
    wantYield: false,
    cued: false,
    attacks: [],
    tradesDone: !tune.trades,
    trade: null,
    tagIdx: 0,
    tagN: 0,
    tagBars: null,
    brk: null,
    imp: {},
    ended: false,
  };
}

function sectionAt(S, fb) {
  for (const s of S.secs)
    if (fb >= s.start && fb < s.start + s.len) return s;
  return S.secs[0];
}

function feelAt(S, fb) {
  const s = sectionAt(S, fb);
  return (s.label === 'B' && S.tune.feelB) ? S.tune.feelB : S.tune.feel;
}

function swingFor(S, feel) {
  return feel === S.tune.feel ? S.swing : (FEEL_SWING[feel] || 0.62);
}

// ---------- 시작·멈춤 ----------
function startSet(o = {}) {
  MUS.setOrder = buildSetOrder(true);
  MUS.setPos = 0;
  MUS.songsPlayed = 0;
  MUS.round = 0;
  MUS.bars.length = 0;
  MUS.beatCount = 0;
  VQ.length = 0;
  MUS.soloH.length = 0;
  MUS.fermata = null;
  MUS.gap = null;
  MUS.dyn = 0.82;
  MUS.brushes = false;
  BASS.last = 41;
  PNO.voicing = null;
  MUS.running = true;
  const S = compileSong(tuneById(MUS.setOrder[0]), 0);
  startSong(S, AE.ctx.currentTime + 0.1, !o.count);
  if (MUS.timer) clearInterval(MUS.timer);
  MUS.timer = setInterval(schedTick, 25);
  schedTick();
}

function stopSet() {
  MUS.running = false;
  if (MUS.timer) clearInterval(MUS.timer);
  MUS.timer = null;
}

function startSong(S, t0, first) {
  MUS.song = S;
  MUS.nextT = t0;
  MUS.gapChord = null;
  const f = S.tune.feel;
  S.countLeft = first ? 0 : (f === 'ballad' ? 0 : 2);
  S.introLeft = first ? 0 : (f === 'bossa' || f === 'latin' || f === 'boogaloo') ? 4 : f === 'ballad' ? 2 : (S.N >= 32 && S.bpm < 200 && Math.random() < 0.6) ? 4 : 0;
  S.introType = f === 'ballad' ? 'piano' : S.introLeft ? (f === 'swing' ? 'turn' : 'vamp') : null;
  S.phase = S.countLeft ? 'count' : S.introLeft ? 'intro' : 'head';
  for (const w of ['tb', 'pn', 'bs']) S.imp[w] = makeImprov(w, S);
  vq(t0, 'song', 'tuneStart', {
    idx: S.idx,
    id: S.tune.id,
    feel: f,
    first
  });
  autoOnSong();
}

function makeImprov(who, S) {
  const blue = /blues|shuffle|boogaloo/.test(S.tune.id) || S.tune.feel === 'shuffle';
  if (who === 'tb') return new Improviser({
    lo: 50,
    hi: 70,
    busy: S.bpm > 190 ? 0.35 : 0.5,
    trip: 0.1,
    blue,
    maxLeap: 6
  });
  if (who === 'pn') return new Improviser({
    lo: 62,
    hi: 88,
    busy: S.bpm > 190 ? 0.55 : 0.7,
    trip: 0.12,
    blue,
    maxLeap: 7
  });
  return new Improviser({
    lo: 36,
    hi: 55,
    busy: 0.55,
    trip: 0.06,
    blue,
    maxLeap: 7,
    longEnd: false
  });
}

// ---------- 내 연주 상태 ----------
const quietSec = S => clamp(1.5 * 4 * S.spb, 3.0, 5.0);
// 자동일 때는 소리가 아니라 자동 연주의 계획으로 판단 (솔로 중이면 붙잡고 있고, 다 불면 바로 넘김)
function meQuiet(now, S) {
  if (AUTO.on) return AUTO.state === 'rest';
  return !TP.blowing && now - TP.lastSoundT > quietSec(S);
}

function meActive(now) {
  if (AUTO.on) return AUTO.state === 'solo';
  return TP.blowing || now - TP.lastSoundT < 1.3;
}
// 내 음 하나가 시작될 때 (트럼펫이 부름)
function musicOnMyAttack(now) {
  const S = MUS.song;
  if (!S) return;
  S.attacks.push(now);
  while (S.attacks.length && S.attacks[0] < now - 3) S.attacks.shift();
  if (S.phase === 'solo' || S.phase === 'trades') {
    if (S.floor !== 'me') takeover(now);
  } else if ((S.phase === 'head' || S.phase === 'outhead' || S.phase === 'intro') && S.attacks.length >= 2) S.wantYield = true;
}

function musicOnMyHold(now, held) {
  const S = MUS.song;
  if (S && held > 0.6 && (S.phase === 'head' || S.phase === 'outhead' || S.phase === 'intro')) S.wantYield = true;
}

function takeover(now) {
  const S = MUS.song, prev = S.floor;
  cancelSoloNotes(now);
  if (prev && prev !== 'dr' && prev !== 'me' && S.soloBars < 4 && !S.filler) S.queue.unshift(prev);
  if (S.phase === 'trades') S.tradesDone = true;
  S.phase = 'solo';
  S.floor = 'me';
  S.pending = null;
  S.toHead = false;
  S.filler = false;
  S.cued = false;
  MUS.soloWho = 'me';
  // A queued theme/band-solo cue belongs to the floor we just interrupted.
  // Keep tuneStart, but let its reset run before the new player takeover.
  let reactionAt = now;
  for (let i = VQ.length - 1; i >= 0; i--) {
    const e = VQ[i];
    if (e.who !== 'song') continue;
    if (e.type === 'tuneStart') reactionAt = Math.max(reactionAt, e.t);
    else if (['seg', 'solo', 'soloEnd', 'cue', 'takeover'].includes(e.type)) VQ.splice(i, 1);
  }
  vq(reactionAt, 'song', 'takeover', { from: prev });
}

function cancelSoloNotes(now) {
  for (const { h } of MUS.soloH) {
    try {
      const g = MUS.soloH.g?.gain ?? null;
      if (g) {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, 0.02);
      }
      if (h.lg) {
        h.lg.gain.cancelScheduledValues(now);
      }
    } catch { }
  }
  MUS.soloH.length = 0;
  for (let i = VQ.length - 1; i >= 0; i--) {
    const e = VQ[i];
    if (e.t > now && e.solo) VQ.splice(i, 1);
  }
}

// ---------- 시계 ----------
function schedTick() {
  if (!MUS.running || !AE.ctx || (AE.ctx.state !== 'running' && !AE.offline)) return;
  const now = AE.ctx.currentTime;
  if (MUS.gap) gapTick(now);
  if (MUS.nextT < now - 0.04 && MUS.song && MUS.song.phase !== 'done') MUS.nextT = now + 0.04;
  let guard = 0;
  while (MUS.song && MUS.song.phase !== 'done' && MUS.nextT < now + MUS.look && guard++ < 4) stepBar(MUS.song, now);
  if (MUS.song && MUS.song.phase === 'done' && !MUS.fermata) endSong(now);
  fermataTick(now);
  if (MUS.song && TP.blowing) musicOnMyHold(now, now - TP.noteT0);
  while (MUS.bars.length > 32) MUS.bars.shift();
  while (MUS.soloH.length && MUS.soloH[0].t < now - 6) MUS.soloH.shift();
}

function stepBar(S, now) {
  decide(S, now);
  if (S.phase === 'done') return;
  const b = makeBar(S);
  MUS.bars.push(b);
  genBar(S, b);
  MUS.nextT = b.t0 + 4 * b.spb;
  advance(S, now);
}

function makeBar(S) {
  let chords, feel = feelAt(S, S.fb),
    spb = S.spb,
    fb = S.fb;
  switch (S.phase) {
    case 'count':
      chords = S.form[0];
      break;
    case 'intro': {
      const k = S.introTotal ? S.introTotal - S.introLeft : 0;
      if (S.introType === 'piano' || S.introType === 'turn') {
        fb = S.N - S.introLeft;
        chords = S.form[fb];
      } else {
        chords = S.form[S.tune.feel === 'latin' ? (k % 2) : 0];
        fb = 0;
      }
      break;
    }
    case 'tag':
      chords = S.tagBars[S.tagIdx];
      fb = S.N - S.tagBars.length + S.tagIdx;
      break;
    case 'final':
      chords = [{
        ...S.final,
        at: 0,
        len: 4
      }];
      break;
    default:
      chords = S.form[S.fb];
  }
  // 발라드 끝: 마지막 두 마디 느려짐
  if (S.phase === 'outhead' && S.tune.ending === 'rit' && S.pass >= S.passes - 1 && S.fb >= S.N - 2 && !meActive(AE.ctx.currentTime)) spb *= S.fb === S.N - 2 ? 1.15 : 1.38;
  const b = {
    t0: MUS.nextT,
    spb,
    swing: swingFor(S, feel),
    chords,
    feel,
    fb,
    phase: S.phase,
    abs: S.abs,
    beat0: MUS.beatCount,
    floor: S.floor,
    song: S.idx
  };
  MUS.beatCount += 4;
  return b;
}

// ---------- 마디 시작 전 결정 ----------
function decide(S, now) {
  if (AUTO.on && AUTO.wantTake && (S.phase === 'solo' || S.phase === 'trades') && S.floor !== 'me') {
    AUTO.wantTake = false;
    takeover(now);
  }
  switch (S.phase) {
    case 'count':
      if (S.countLeft <= 0) {
        S.phase = S.introLeft > 0 ? 'intro' : 'head';
        S.introTotal = S.introLeft;
        S.fb = 0;
        S.pass = 0;
      }
      break;
    case 'intro':
      if (S.introTotal == null) S.introTotal = S.introLeft;
      if (S.introLeft <= 0) {
        S.phase = 'head';
        S.fb = 0;
        S.pass = 0;
        segEvent(S, 'head');
      }
      break;
    case 'head':
    case 'outhead':
      if (S.wantYield && S.fb % 4 === 0 && !(S.phase === 'head' && S.pass === 0 && S.fb === 0)) {
        S.wantYield = false;
        enterSolo(S, 'me', 'yield');
      }
      break;
    case 'solo':
      decideSolo(S, now);
      break;
    case 'trades':
      decideTrades(S, now);
      break;
  }
}

function decideSolo(S, now) {
  if (S.floor === 'me') {
    if (AUTO.on && AUTO.state === 'solo' && AUTO.sol && MUS.beatCount >= AUTO.sol.endB - 1e-6) autoSoloEnd(); // 자동: 정한 코러스를 다 불었으면 바로 넘김
    if (meQuiet(now, S)) {
      if (S.queue.length) {
        const who = S.queue.shift();
        if (S.fb % 2 === 0) startBandSolo(S, who);
        else {
          S.floor = null;
          S.pending = {
            who,
            fb: (S.fb + 1) % S.N
          };
          segEvent(S, 'wait');
        }
      } else {
        S.toHead = true;
        const left = S.unit - (S.fb % S.unit);
        if (S.fb % S.unit === 0) {
          S.toHead = false;
          enterOuthead(S);
          return;
        }
        if (left >= 6) startBandSolo(S, 'pn', true);
        else {
          S.floor = null;
          segEvent(S, 'wait');
        }
        vq(MUS.nextT, 'song', 'cue', {
          kind: 'tophead'
        });
      }
    }
    return;
  }
  if (S.floor === null) {
    if (S.pending && S.fb === S.pending.fb) {
      startBandSolo(S, S.pending.who);
      S.pending = null;
    } else if (S.toHead && S.fb % S.unit === 0) {
      S.toHead = false;
      enterOuthead(S);
    }
    return;
  }
  // 밴드 솔로 중
  if (S.toHead && S.fb % S.unit === 0) {
    S.toHead = false;
    S.filler = false;
    enterOuthead(S);
    return;
  }
  if (!S.filler && S.soloBars >= S.minSolo && S.fb % S.unit === 0) {
    nextAfterBandSolo(S);
    return;
  }
  const left = S.unit - (S.fb % S.unit);
  if (!S.cued && !S.filler && S.soloBars + left >= S.minSolo && left <= 2) {
    S.cued = true;
    vq(MUS.nextT, 'song', 'cue', {
      kind: 'invite',
      player: S.floor
    });
  }
}

function decideTrades(S, now) {
  const k = Math.floor(S.trade.n / 4);
  const who = k % 2 === 0 ? S.trade.horns[(k / 2) % S.trade.horns.length] : 'dr';
  if (S.trade.n % 4 === 0) {
    S.floor = who;
    S.soloBars = 0;
    MUS.soloWho = who;
    vq(MUS.nextT, 'song', 'solo', {
      player: who,
      trade: true
    });
    if (who !== 'dr') S.imp[who] = makeImprov(who, S);
  }
}

function advance(S, now) {
  S.abs++;
  switch (S.phase) {
    case 'count':
      S.countLeft--;
      break;
    case 'intro':
      S.introLeft--;
      break;
    case 'tag':
      S.tagIdx++;
      if (S.tagIdx >= S.tagBars.length) {
        S.tagIdx = 0;
        S.tagN++;
        if ((S.tagN >= S.tagMin && !meActive(now)) || S.tagN > 40) enterFinal(S);
      }
      break;
    case 'final':
      S.phase = 'done';
      break;
    case 'head':
    case 'outhead':
    case 'solo':
    case 'trades':
      if (S.phase === 'solo') {
        if (S.floor === 'me') S.meBars++;
        else if (S.floor) S.soloBars++;
      }
      if (S.phase === 'trades') {
        S.trade.n++;
        if (S.trade.n >= S.trade.len) {
          S.tradesDone = true;
          S.fb++;
          if (S.fb >= S.N) S.fb = 0;
          enterOuthead(S);
          return;
        }
      }
      S.fb++;
      if (S.fb >= S.N) {
        S.fb = 0;
        S.chorus++;
        onFormEnd(S, now);
      }
      break;
  }
}

function onFormEnd(S, now) {
  if (S.phase === 'head') {
    S.pass++;
    if (S.pass >= S.passes) {
      const me = meActive(now) || S.wantYield || autoWantsSolo();
      S.wantYield = false;
      enterSolo(S, me ? 'me' : nextBand(S), 'afterHead');
    }
  } else if (S.phase === 'outhead') {
    S.pass++;
    if (S.pass >= S.passes) {
      if (meActive(now) || S.wantYield) {
        S.wantYield = false;
        enterSolo(S, 'me', 'outheadYield');
      } else enterEnding(S);
    }
  }
}

function nextBand(S) {
  return S.queue.length ? S.queue.shift() : null;
}

function enterSolo(S, who, why) {
  S.phase = 'solo';
  S.toHead = false;
  S.pending = null;
  if (who === 'me') {
    S.floor = 'me';
    MUS.soloWho = 'me';
    segEvent(S, 'solo', {
      player: 'me',
      why
    });
  } else if (who) startBandSolo(S, who);
  else { // 솔로할 사람이 없으면 바로 테마
    enterOuthead(S);
  }
}

function startBandSolo(S, who, filler = false) {
  S.phase = 'solo';
  S.floor = who;
  S.soloBars = 0;
  S.filler = filler;
  S.cued = false;
  MUS.soloWho = who;
  S.imp[who] = makeImprov(who, S);
  vq(MUS.nextT, 'song', 'solo', {
    player: who,
    filler
  });
  segEvent(S, 'solo', {
    player: who
  });
}

function nextAfterBandSolo(S) {
  const prev = S.floor;
  vq(MUS.nextT, 'song', 'soloEnd', {
    player: prev
  });
  if (S.queue.length) {
    startBandSolo(S, S.queue.shift());
    return;
  }
  if (!S.tradesDone) {
    enterTrades(S);
    return;
  }
  enterOuthead(S);
}

function enterTrades(S) {
  S.phase = 'trades';
  S.trade = {
    n: 0,
    len: S.N <= 16 ? S.N * 2 : S.N,
    horns: shuffle(['tb', 'pn'])
  };
  decideTrades(S);
  segEvent(S, 'trades');
}

function enterOuthead(S) {
  S.phase = 'outhead';
  S.floor = null;
  S.pass = 0;
  S.toHead = false;
  MUS.soloWho = null;
  vq(MUS.nextT, 'song', 'cue', {
    kind: 'head'
  });
  segEvent(S, 'outhead');
}

function enterEnding(S) {
  const e = S.tune.ending || 'tag';
  if (e === 'tag' || e === 'vampfade') {
    const n = e === 'tag' ? 4 : 2;
    S.tagBars = S.form.slice(S.N - n);
    S.tagIdx = 0;
    S.tagN = 0;
    S.tagMin = e === 'tag' ? 2 : 3;
    S.tagType = e;
    S.phase = 'tag';
    segEvent(S, 'tag');
  } else enterFinal(S);
}

function enterFinal(S) {
  S.phase = 'final';
  segEvent(S, 'final');
}

function segEvent(S, phase, data = {}) {
  vq(MUS.nextT, 'song', 'seg', {
    phase,
    floor: S.floor,
    tune: S.tune.id,
    ...data
  });
}

// ---------- 마디 내용 ----------
function genBar(S, b) {
  const ph = S.phase;
  if (ph === 'count') {
    countOff(b, S.countLeft <= 1);
    return;
  }
  if (ph === 'final') {
    genFinal(S, b);
    return;
  }
  autoOnBar(S, b);
  updateMood(S, b);
  const next = nextChordAfter(S, b);
  // 절정 브레이크
  if (S.brk && b.abs >= S.brk.from && b.abs <= S.brk.to) {
    if (b.abs === S.brk.from) {
      drum('crash', b.t0, 0.85, 'R');
      drum('kick', b.t0, 0.8, 'RF');
      bassNote(b.t0, nearestPC(b.chords[0].root, 36, 29, 41), b.spb * 0.5, 1);
      compHit(b, 0, b.chords[0], 0.4, 0.6);
      vq(b.t0, 'song', 'break', { on: true });
    }
    return;
  }
  if (S.brk && b.abs === S.brk.to + 1) {
    drum('crash', b.t0, 0.95, 'R');
    drum('kick', b.t0, 0.9, 'RF');
    vq(b.t0, 'song', 'break', { on: false });
    S.brk = null;
  }
  const floor = (ph === 'solo' || ph === 'trades') ? S.floor : null;
  if (floor === 'dr') {
    drumSoloBar(b, (S.trade ? S.trade.n : 0) % 4, 4);
    return;
  }
  const headBass = (ph === 'head' || ph === 'outhead') && S.headByBar[S.fb] && S.headByBar[S.fb].some(n => n.who === 'b');
  const odd = (b.abs % 2) === 0;
  const firstOfChorus = (ph === 'solo' || ph === 'head' || ph === 'outhead') && S.fb === 0;
  const lastOfSection = (S.fb + 1) % 8 === 0 || S.fb === S.N - 1;
  // 베이스
  if (floor === 'bs') playSoloLine('bs', b, S.imp.bs.bar(b, MUS.energy));
  else if (!headBass) {
    switch (b.feel) {
      case 'ballad':
        bassBallad(b, next);
        break;
      case 'bossa':
        bassBossa(b, next);
        break;
      case 'latin':
        bassTumbao(b, next);
        break;
      case 'shuffle':
        bassShuffle(b, odd);
        break;
      case 'boogaloo':
        bassBoogaloo(b, odd);
        break;
      default: {
        const two = (ph === 'head' && S.bpm < 175 && S.N >= 32 && sectionAt(S, S.fb).label === 'A' && S.fb < 16) || (ph === 'intro' && S.introType === 'turn' && false);
        if (MUS.doubleUntil > b.t0 && ph !== 'head' && ph !== 'outhead') bassWalkDouble(b, next);
        else if (two) bassTwo(b, next);
        else bassWalk(b, next);
      }
    }
  }
  // 드럼
  const lite = floor === 'bs';
  switch (b.feel) {
    case 'ballad':
      drumsBrush(b);
      if (lastOfSection && Math.random() < 0.4) drum('btap', pt(b, 3.5), 0.5, 'R');
      break;
    case 'bossa':
      drumsBossa(b, odd);
      break;
    case 'latin':
      drumsLatin(b, odd);
      break;
    case 'shuffle':
      drumsShuffle(b, lastOfSection);
      break;
    case 'boogaloo':
      drumsBoogaloo(b, lastOfSection, odd);
      break;
    default:
      if (lite) drumsBrush(b);
      else if (MUS.doubleUntil > b.t0 && ph !== 'head' && ph !== 'outhead') drumsDouble(b, lastOfSection, firstOfChorus);
      else drumsSwing(b, lastOfSection && ph !== 'intro', firstOfChorus);
  }
  // 피아노
  const pnoHead = (ph === 'head' || ph === 'outhead') && (S.headInst === 'pno' || S.headInst === 'tbn+pno');
  if (floor === 'pn') {
    playSoloLine('pn', b, S.imp.pn.bar(b, MUS.energy));
    const sh = b.chords.length > 1 ? [
      [0, 0.8],
      [2, 0.8]
    ] : pick([
      [
        [0, 1.2]
      ],
      [
        [1.5, 0.5]
      ],
      [
        [0.5, 0.5],
        [2.5, 0.8]
      ],
      [
        [2, 1.0]
      ]
    ]);
    for (const [p, d] of sh) {
      const h = compHit(b, p, chordAt(b, p), d, 0.34);
      h.forEach(x => rememberSolo(x, b.t0));
    }
  } else {
    const act = floor === 'me' ? myActivity(4 * b.spb) : 0.45;
    const density = pnoHead ? 0.25 : clamp(1 - act + 0.15, 0.1, 1);
    if ((MUS.pianoRestUntil || 0) > b.t0 && !pnoHead) {
      /* 피아노가 손 떼고 쳐다봄 */
    } else switch (b.feel) {
      case 'ballad':
        compBallad(b);
        break;
      case 'bossa':
        compBossa(b, next, odd);
        break;
      case 'latin':
        compMontuno(b, next, odd);
        break;
      case 'shuffle':
        compShuffle(b);
        break;
      case 'boogaloo':
        compBoogaloo(b, next, odd);
        break;
      default:
        compSwing(b, next, density);
    }
    // 내가 쉬면 빈자리 채우기
    if ((floor === 'me' || floor === null) && ph === 'solo' && act < 0.15 && !TP.blowing && Math.random() < 0.5) {
      if (!PNO.fill) PNO.fill = new Improviser({
        lo: 66,
        hi: 84,
        busy: 0.4
      });
      const notes = PNO.fill.bar(b, 0.3, 2).slice(0, 5);
      for (const n of notes) {
        const s = nearestSample('P', n.m);
        playOne(s, n.m, pt(b, n.pos), vel(0.4), AE.buses.pno, {
          dur: b.spb * n.dur * 0.8,
          release: 0.2
        });
        vq(pt(b, n.pos), 'pno', 'hit', {
          notes: [n.m],
          hand: 'R',
          dur: 0.2
        });
      }
    }
  }
  // 테마
  if (ph === 'head' || ph === 'outhead') playHeadBar(S, b);
  if (ph === 'intro' && S.introType === 'piano') {
    const ln = (S.imp.pn).bar(b, 0.2);
    for (const n of ln.slice(0, 6)) {
      const s = nearestSample('P', n.m);
      playOne(s, n.m, pt(b, n.pos), vel(0.42), AE.buses.pno, {
        dur: b.spb * n.dur * 1.1,
        release: 0.4
      });
      vq(pt(b, n.pos), 'pno', 'hit', {
        notes: [n.m],
        hand: 'R',
        dur: 0.3
      });
    }
  }
  // 밴드 솔로 선율
  if (floor === 'tb') playSoloLine('tb', b, S.imp.tb.bar(b, MUS.energy));
  // 태그 끝 마디·바막: 장식
  if (ph === 'tag' && S.tagType === 'vampfade') MUS.dynT = Math.max(0.45, 0.95 - S.tagN * 0.12);
}

function nextChordAfter(S, b) {
  if (S.phase === 'tag') return S.tagBars[(S.tagIdx + 1) % S.tagBars.length][0];
  if (S.phase === 'intro') return S.form[0][0];
  return S.form[(S.fb + 1) % S.N][0];
}

function playHeadBar(S, b) {
  const notes = S.headByBar[S.fb];
  if (!notes) return;
  const inst = S.headInst;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i],
      t = pt(b, n.pos);
    const d = n.dur * b.spb * (n.dur <= 0.5 ? 0.82 : 0.95);
    if (n.who === 'b') {
      bassNote(t, n.midi, d, 1.05, {
        lp: 3000
      });
      continue;
    }
    if (inst === 'pno') pianoNotes(t, [n.midi, n.midi + 12], d, 0.62, 'R', 0.004, {
      rel: 0.25
    });
    else if (inst === 'tbn+pno') {
      tbnNote(t, n.midi, d, 0.9);
      pianoNotes(t, [n.midi + 12], d, 0.5, 'R', 0, {
        rel: 0.2
      });
    } else tbnNote(t, n.midi, d, 0.92, {
      vib: S.tune.feel === 'ballad' ? 18 : 12,
      fall: n.dur >= 2 && S.tune.feel !== 'ballad' && Math.random() < 0.15
    });
  }
}

function updateMood(S, b) {
  let d = {
    intro: 0.78,
    head: 0.9,
    solo: 0.84,
    trades: 0.95,
    outhead: 0.95,
    tag: 1.0
  }[S.phase] || 0.85;
  if (S.phase === 'solo' && S.floor === 'me') d += (REACT.heat / 100) * 0.2;
  if (S.floor === 'bs') d *= 0.8;
  if (b.feel === 'ballad') d *= 0.78;
  else if (b.feel === 'bossa') d *= 0.85;
  MUS.dynT = d;
  MUS.dyn = lerp(MUS.dyn, MUS.dynT, 0.6);
  const brushes = b.feel === 'ballad' || S.floor === 'bs';
  if (brushes !== MUS.brushes) {
    MUS.brushes = brushes;
    vq(b.t0, 'drums', 'swap', {
      brushes
    });
  }
  MUS.energy = clamp(0.3 + (S.floor === 'me' ? REACT.heat / 100 * 0.7 : 0.18) + (S.phase === 'tag' ? 0.2 : 0), 0, 1);
}

function myActivity(win) {
  const now = AE.ctx.currentTime;
  if (TP.blowing) return 1;
  let n = 0;
  for (let i = TP.notes.length - 1; i >= 0 && TP.notes[i].t > now - win; i--) n++;
  return clamp(n / 6, 0, 1);
}

// ---------- 끝 화음 ----------
function genFinal(S, b) {
  const t = b.t0,
    ch = S.final,
    e = S.tune.ending;
  const root = nearestPC(ch.root, 34, 28, 40);
  if ((e === 'button' || e === 'cold') && !S.showEnd) {
    drum('crash', t, e === 'cold' ? 0.6 : 1.0, 'R');
    drum('kick', t, 0.9, 'RF');
    drum('snare', t, 0.7, 'L');
    bassNote(t, root, 0.3, 1.0);
    PNO.voicing = voicingFor(ch, PNO.voicing, 55, 79);
    pianoNotes(t, [root + 12, ...PNO.voicing], 0.35, 0.75, 'L', 0.004);
    tbnNote(t, nearestPC(ch.root + QUAL[ch.q].tones[1], 60, 55, 67), 0.35, 1.0, { scoop: 0 });
    vq(t, 'song', 'cut', { button: true });
    MUS.endAt = t + 0.6;
    autoFinal(S, t, 'button');
    return;
  }
  drum('crash', t, 0.9, 'R');
  drum('kick', t, 0.8, 'RF');
  bassNote(t, root, 3.0, 1.0);
  PNO.voicing = voicingFor(ch, PNO.voicing, 52, 79);
  pianoNotes(t, [root + 12, ...PNO.voicing], 3.2, 0.6, 'L', 0.02);
  const tm = nearestPC(ch.root + QUAL[ch.q].tones[1], 60, 55, 67),
    s = nearestSample('B', tm);
  const tv = new SusVoice(AE.ctx, s, tm, t, AE.buses.tbn, {
    level: vel(0.85),
    fadeIn: 0.03,
    offset: s.start + 0.01
  });
  tv.vibrato(14, t + 0.4, 0.4);
  vq(t, 'tbn', 'note', {
    midi: tm,
    dur: 99,
    slide: slidePos(tm)
  });
  MUS.fermata = {
    t,
    tv,
    ch,
    root,
    nextRoll: t + 0.1,
    nextPiano: t + 2.4,
    nextBass: t + 1.9,
    rollV: 0.05,
    cut: null,
    wasBlowing: TP.blowing
  };
  const autoCut = autoFinal(S, t, 'fermata');
  if (autoCut) MUS.fermata.autoCutAt = autoCut; // 자동: 끝음 길이에 맞춰 같이 끊음
  vq(t, 'song', 'fermata', {});
}

function fermataTick(now) {
  const F = MUS.fermata;
  if (!F || F.cut) {
    if (F && F.cut && now > F.cut + 0.8) MUS.fermata = null;
    return;
  }
  if (TP.blowing) F.wasBlowing = true;
  const age = now - F.t;
  while (F.nextRoll < now + 0.15) {
    F.rollV = Math.min(0.42, F.rollV + 0.006);
    playBuf(AE.sets.D.ride.buf, F.nextRoll, F.rollV * 0.5 * MUS.dyn, AE.buses.drums, {
      offset: AE.sets.D.ride.start,
      pan: -0.2,
      rate: rand(0.97, 1.03)
    });
    F.nextRoll += 0.075;
  }
  if (now > F.nextPiano - 0.1) {
    pianoNotes(F.nextPiano, voicingFor(F.ch, null, 62, 86), 2.6, 0.3, 'R', 0.05);
    F.nextPiano += 2.4;
  }
  if (now > F.nextBass - 0.1) {
    bassNote(F.nextBass, F.root, 2.0, 0.55);
    F.nextBass += 1.9;
  }
  const myHold = TP.blowing && F.wasBlowing;
  if (F.autoCutAt && !FIN.manualWaiting) {
    if (now >= F.autoCutAt - 0.12 || age > 16) fermataCut(Math.max(now + 0.02, F.autoCutAt));
    return;
  }
  if (FIN.manualWaiting) {
    if (FIN.manualPlayed && FIN.manualReleased && !TP.blowing && age > 0.2) fermataCut(now + 0.04);
  } else if ((!myHold && age > 2.6) || age > 16) fermataCut(now + 0.04);
}

function fermataCut(t) {
  const F = MUS.fermata;
  if (!F || F.cut) return;
  F.cut = t;
  drum('crash', t, 1.0, 'R');
  drum('kick', t, 1.0, 'RF');
  drum('snare', t, 0.8, 'L');
  bassNote(t, F.root, 0.25, 1.0);
  pianoNotes(t, [F.root + 12, ...voicingFor(F.ch, null, 55, 80)], 0.3, 0.75, 'L', 0.004);
  F.tv.release(t, 0.08);
  vq(t, 'song', 'cut', {});
  MUS.endAt = t + 0.4;
}

// ---------- 곡 사이 ----------
function advanceSetPosition() {
  MUS.songsPlayed++;
  MUS.setPos++;
  if (MUS.setPos >= MUS.setOrder.length) {
    MUS.setOrder = buildSetOrder(false);
    MUS.setPos = 0;
    MUS.round++;
  }
}

function nextSong() {
  if (!UI.playing || !MUS.running || !AE.ctx || (!MUS.song && !MUS.gap) || FIN.req || FIN.on) return;
  const now = AE.ctx.currentTime;
  if (now < (MUS.skipUntil || 0)) return;
  MUS.skipUntil = now + 0.6;
  releaseAllInput();
  fingerVisual(null);
  if (REACT.meSolo) {
    REACT.meSolo = false;
    myApplause();
  }
  if (ITL.cur) itlEnd();
  stopBandVoices(now);
  // During the applause gap, setPos already points to the upcoming tune.
  if (!MUS.gap) advanceSetPosition();
  MUS.gap = null;
  MUS.fermata = null;
  MUS.endAt = 0;
  MUS.bars.length = 0;
  MUS.soloH.length = 0;
  VQ.length = 0;
  MUS.beatCount = 0;
  MUS.soloWho = null;
  _later.length = 0;
  DIR.hits.L.length = 0;
  DIR.hits.R.length = 0;
  DIR.tbLastNote = now;
  DIR.tbState = 'rest';
  DIR.countOff = 0;
  DIR.pnPress.L = 0;
  DIR.pnPress.R = 0;
  DIR.pluck = 0;
  REACT.timers.length = 0;
  REACT.inBreak = false;
  REACT.phrase = null;
  REACT.prevPhrase = null;
  REACT.onsets.length = 0;
  REACT.riffN = 0;
  TP.notes.length = 0;
  TP.lastSoundT = -9;
  TP.cur = null;
  BASS.last = 41;
  PNO.voicing = null;
  UI.marksKey = '';
  const S = compileSong(tuneById(MUS.setOrder[MUS.setPos]), MUS.setPos);
  // A manual skip starts the new theme immediately, without another count-in.
  startSong(S, now + 0.12, true);
  schedTick();
  UI.el.nextSong.disabled = true;
}

function endSong(now) {
  const S = MUS.song;
  if (!S || S.ended) return;
  if (MUS.endAt && now < MUS.endAt) return;
  S.ended = true;
  MUS.song = null;
  advanceSetPosition();
  const nextTune = tuneById(MUS.setOrder[MUS.setPos]);
  const nf = parseForm(nextTune.form);
  MUS.gapChord = nf[0][0];
  MUS.gapSpb = 60 / nextTune.bpm;
  MUS.gap = {
    t0: now,
    minEnd: now + 4.2,
    maxEnd: now + 13,
    next: nextTune,
    idx: MUS.setPos
  };
  MUS.beatBase = MUS.beatCount;
  MUS.beatT = now;
  vq(now, 'song', 'gap', { next: nextTune.id });
  if (FIN.req || FIN.on) MUS.gap.hold = true;
  else itlOnGap(); // 공연을 끝내는 중이면 다음 곡으로 넘어가지 않음
  afterSave();
}

function gapTick(now) {
  const G = MUS.gap;
  if (G.hold) return;
  if (now < G.minEnd) return;
  if (meActive(now) && now < G.maxEnd) return;
  MUS.gap = null;
  const S = compileSong(G.next, G.idx);
  BASS.last = 41;
  PNO.voicing = null;
  startSong(S, now + 0.15, false);
}

// ---------- 반응 쪽에서 부르는 것 ----------
function requestBreak() {
  const S = MUS.song;
  if (!S || S.phase !== 'solo' || S.floor !== 'me' || S.brk) return false;
  S.brk = {
    from: S.abs,
    to: S.abs + 1
  };
  return true;
}

function bandAccents(times, big = false) {
  for (const t of times) {
    if (t < AE.ctx.currentTime + 0.02) continue;
    if (MUS.brushes) {
      drum('btap', t, 0.8, 'R');
      drum('kick', t, 0.4, 'RF');
    } else {
      drum('snare', t, 0.75, 'L');
      drum('kick', t, 0.7, 'RF');
    }
  }
  if (big && times.length) {
    const t = times[times.length - 1];
    if (t > AE.ctx.currentTime) drum('crash', t, MUS.brushes ? 0.4 : 0.8, 'R');
  }
}

function nextSlot(after) {
  const b = barAtTime(after);
  if (!b) return after;
  for (let i = 0; i <= 9; i++) {
    const t = pt(b, i / 2);
    if (t >= after) return t;
  }
  return b.t0 + 4 * b.spb;
}

// ===== 50_trumpet.js =====
// ===================== 내 트럼펫: 오타마톤식 띠 하나 =====================
// 띠를 누르면 소리, 위치가 높낮이. 떼면 멈춤. 누른 채 움직이면 음이 바뀜 (슬러: 밸브 바꾸듯 또렷하게).
// 다른 손가락으로 짚으면 그 자리로 혀를 쳐서 뛰고, 그 손가락을 떼면 남아 있는 손가락 자리로 슬러.
// 보정 모드: 지금 화음에 맞는 음으로 붙음 (블루스 곡은 블루노트, 움직이는 동안 뒷박엔 반음 접근음도).
//            손가락이 그대로면 한 번 맞춘 음을 유지함 (8분음표마다 다시 고르지 않음).
// 자유 모드: 멈추면 가장 가까운 반음으로 끌어당김. 천천히 밀면 글리산도, 빠르게 옮기면 도착한 음으로 또렷하게, 멀리 빠르게 훑으면 립.
// 셈여림은 자동: 뒷박·프레이즈 첫 음·높은 음은 세고 밝게, 촘촘한 줄의 정박·낮은 경과음은 여리게.
const TP = {
  mode: 'snap',
  lo: 52,
  hi: 86, // 콘서트 음높이 (E3 ~ D6)
  pos: 0.4,
  target: 66,
  blowing: false,
  voice: null,
  cur: null,
  curF: null,
  chord: null,
  noteT0: 0,
  pitchT0: 0,
  lastAttackT: -9,
  lastSoundT: -9,
  lastMoveT: 0,
  lastMovingT: 0,
  rr: 1,
  notes: [],
  listeners: [],
  air: [],
  shake: null,
  vibOn: false,
  in: null,
  pendingMove: false,
  discrete: false,
  lastPitchUpdate: -99,
  lastRevoiceT: -99,
  all: [], // 아직 울리고 있을 수 있는 내 트럼펫 소리들
  d: 0.74,
  lastOffT: -9,
  lastRec: null, // 지금 음의 셈여림 · 마지막으로 뗀 때
  mv: {
    st: 'rest',
    from: 0,
    movT: 0,
    at0: 0
  }, // 손가락 움직임 판정
  semi: null, // 자유 모드: 붙어 있는 반음
  passing: false,
  passT: 0, // 보정 모드: 지나가는 중인 반음 접근음
  key: '', // 보정 모드: 손가락 그대로 맞춰 둔 화음·박
};
const tpEmit = (type, d) => {
  for (const f of TP.listeners) f(type, d);
};
// 트럼펫은 한 대: 새 음을 낼 때 앞에서 남은 소리를 전부 끊기 위해 기록
function tpTrack(v) {
  if (!v) return v;
  if (!(v instanceof SusVoice)) v.src.addEventListener('ended', () => v.ended = true);
  for (let i = TP.all.length - 1; i >= 0; i--)
    if (TP.all[i].ended) TP.all.splice(i, 1);
  TP.all.push(v);
  return v;
}

function tpCutAll(t, fade) {
  for (const v of TP.all) cutVoice(v, t, fade);
  TP.all.length = 0;
  if (SPX.voice2) {
    cutVoice(SPX.voice2, t, fade);
    SPX.voice2 = null;
  }
  SPX.revoiceDue = false;
}
const posToPitch = p => TP.lo + clamp(p, 0, 1) * (TP.hi - TP.lo);
const pitchToPos = m => clamp((m - TP.lo) / (TP.hi - TP.lo), 0, 1);

function initTrumpet() {
  const ctx = AE.ctx;
  TP.in = ctx.createGain();
  TP.in.gain.value = 1;
  TP.lp = ctx.createBiquadFilter();
  TP.lp.type = 'lowpass';
  TP.lp.frequency.value = 16000;
  TP.lp.Q.value = 0.5;
  TP.in.connect(TP.lp);
  TP.lp.connect(AE.buses.tp);
  try {
    const m = localStorage.getItem('egotrip.mode');
    if (m === 'free' || m === 'snap') TP.mode = m;
  } catch { }
}

function setMode(m) {
  if (AUTO.on) setAuto(false);
  TP.mode = m;
  try {
    localStorage.setItem('egotrip.mode', m);
  } catch { }
}
const canPlay = () => !!AE.ctx;

// ---------- 소리 ----------
// 셈여림 d (0 ~ 1.15)가 크기와 밝기를 같이 바꿈 (금관은 세게 불수록 밝아짐). 높은 음일수록 조금 크게

// 음 하나의 몸통: 지속음 고리 샘플 + 셈여림 필터
function hornVoice(m, t, d, o = {}) {
  const s = nearestSample('T', m);
  if (!s || !AE.ctx) return null;
  const f = AE.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.45;
  f.frequency.setValueAtTime(dynCut(d), Math.max(0, t - 0.002));
  const off = o.body ? s.start + 0.11 : o.offset != null ? o.offset : s.start;
  const v = new SusVoice(AE.ctx, s, m, t, o.dest || TP.in, {
    level: dynGain(m, d),
    fadeIn: o.fadeIn || 0.005,
    offset: Math.min(off, s.ls != null ? s.ls - 0.05 : off),
    scoop: o.scoop || 0,
    scoopTime: o.scoopTime || 0.07,
    filter: f
  });
  v.f = f;
  v.d = d;
  return v;
}
// 혀 치는 머리: 스타카토 녹음으로 또렷하게 시작하고 곧바로 지속음 몸통으로 넘김
function hornHead(m, t, d) {
  TP.rr = 3 - TP.rr;
  const a = nearestSample('A', m, TP.rr);
  if (!a || Math.abs(a.m - m) > 4) return false;
  tpTrack(playOne(a, m, t, dynGain(m, d) * 0.95, TP.in, {
    dur: 0.085,
    release: 0.025
  }));
  return true;
}
// 끝내기: 그냥 / 폴(아래로 떨어뜨림) / 두잇(위로 튕김)
function hornRelease(v, t, flick, rel = 0.06) {
  if (!v) return;
  if (flick === 'fall') {
    v.vibrato(0, t, 0.02);
    v.bend(-pick([7, 9, 12]), t, 0.34);
    v.release(t + 0.16, 0.24);
    if (v.f) {
      v.f.frequency.cancelScheduledValues(t);
      v.f.frequency.setTargetAtTime(900, t + 0.04, 0.12);
    }
  } else if (flick === 'doit') {
    v.vibrato(0, t, 0.02);
    v.bend(5, t, 0.2);
    v.release(t + 0.1, 0.16);
  } else v.release(t, rel);
}
// 셰이크: 윗음과 빠르게 왔다 갔다 (iv = 반음 수)
function shakeOn(v, t, iv) {
  if (!v) return;
  v.src.playbackRate.setTargetAtTime(v.rate * Math.pow(2, iv / 24), t, 0.012);
  v.lfo.frequency.setTargetAtTime(7.3, t, 0.02);
  v.lg.gain.cancelScheduledValues(t);
  v.lg.gain.setTargetAtTime(v.rate * (Math.pow(2, iv / 24) - 1), t, 0.03);
}

function shakeOff(v, t) {
  if (!v) return;
  v.lg.gain.cancelScheduledValues(t);
  v.lg.gain.setTargetAtTime(0, t, 0.02);
  v.src.playbackRate.setTargetAtTime(v.rate, t, 0.015);
  v.lfo.frequency.setTargetAtTime(5.4, t + 0.06, 0.05);
}
// 셈여림 자동: 뒷박·프레이즈 첫 음·높은 음은 세게, 촘촘한 줄의 정박·낮은 경과음은 여리게
function autoDyn(t, m, o = {}) {
  let d = 0.74;
  const N = TP.notes,
    sl = phraseSlot(t),
    spb = curSpb();
  const dense = N.length > 0 && t - N[N.length - 1].t < spb * 0.8;
  if (o.first) d += 0.12;
  if (sl && dense) d += sl.strong ? -0.06 : 0.1;
  let hi = -1;
  for (let i = N.length - 1; i >= 0 && N[i].t > t - 2; i--) hi = Math.max(hi, N[i].m);
  if (hi > 0 && m > hi + 0.5) d += 0.1;
  if (m >= 79) d += 0.06;
  if (dense && hi > 0 && m < hi - 7) d -= 0.07;
  return clamp(d, 0.45, 1.1);
}

function recordNote(t, m, kind) {
  TP.notes.push({ t, m, kind });
  if (TP.notes.length > 300) TP.notes.splice(0, 100);
}

// ---------- 보정 모드: 어떤 음을 허용하나 ----------
// 블루스 곡: 으뜸·버금딸림 화음 위에서 조의 ♭5는 뒷박에, ♭3은 뒷박에 (으뜸 화음에선 정박에도)
function bluesOk(m, ch, strong) {
  const S = MUS.song;
  if (!S || !S.tune.blues) return false;
  const rel = mod12(ch.root - S.keyPc);
  if (rel !== 0 && rel !== 5) return false;
  const pc = mod12(m - S.keyPc);
  if (pc === 6) return !strong;
  if (pc === 3) return !strong || rel === 0;
  return false;
}
// 움직이는 동안 뒷박: 화음음 반음 아래 접근음
const passingOk = (m, ch) => isChordTone(m + 1, ch);

function noteOk(m, ch, strong, o = {}) {
  return inSet(m, ch, strong ? 'S' : 'W') || bluesOk(m, ch, strong) || (!!o.moving && !strong && passingOk(m, ch));
}

function snapNow(t, cur, o = {}) {
  const ch = chordAtTime(t + 0.02);
  const nb = barAtTime(t);
  const nextCh = nb ? chordAtTime(t + nb.spb * 0.6) : null;
  const strong = o.strong != null ? o.strong : isStrongTime(t);
  return snapPitch(TP.target, ch, {
    strong,
    cur,
    nextCh,
    lo: TP.lo,
    hi: TP.hi,
    ok: m => noteOk(m, ch, strong, o)
  });
}

function slotKey(t) {
  const sl = phraseSlot(t);
  return chordAtTime(t + 0.01).name + '|' + (sl ? sl.id : '');
}

function phraseSlot(t) {
  const b = barAtTime(t);
  if (!b) return null;
  const p = Math.max(0, (t - b.t0) / b.spb),
    beat = Math.floor(p);
  const off = p - beat >= b.swing;
  return {
    id: b.beat0 * 2 + beat * 2 + (off ? 1 : 0),
    strong: !off,
    next: pt(b, off ? beat + 1 : beat + 0.5)
  };
}
// 손가락이 그대로일 때: 화음이 바뀌어 지금 음이 안 맞거나, 뒷박 색깔음을 문 채 정박이 오면 한 번만 맞춤 (되돌아가지 않음)
function heldHarmonyTick(now) {
  const slot = phraseSlot(now);
  if (!slot) return;
  const ch = chordAtTime(now + 0.01), key = ch.name + '|' + slot.id;
  if (TP.key === key) return;
  const changed = TP.chord !== ch.name;
  TP.chord = ch.name;
  TP.key = key;
  if (TP.passing) return;
  const strong = !!FIN.req || slot.strong, cur = Math.round(TP.cur);
  if (noteOk(cur, ch, strong)) return;
  const out = snapNow(now, cur, { strong });
  if (out !== TP.cur) moveTo(out, changed ? 'chord' : 'resolve', now + 0.003);
}

// ---------- 소리 시작 (혀를 침) ----------
function noteOn(kind = 'touch') {
  if (!canPlay()) return;
  const now = AE.ctx.currentTime,
    t = now + 0.004;
  if (FIN.manualWaiting && kind !== 'auto') {
    FIN.manualPlayed = true;
    FIN.manualReleased = false;
  }
  TP.key = slotKey(t);
  TP.passing = false;
  TP.mv = {
    st: 'rest',
    from: 0,
    movT: 0,
    at0: 0
  };
  const out = TP.mode === 'free' ? clamp(Math.round(TP.target), TP.lo, TP.hi) : snapNow(t, null);
  const fast = t - TP.lastAttackT < 0.28;
  const d = autoDyn(t, out, {
    first: kind === 'touch' && t - TP.lastOffT > 0.34
  });
  if (TP.shake) endShake(t);
  // 한 대만 울리게: 앞 음에서 남은 소리를 전부 짧게 끊고 시작
  tpCutAll(t, fast ? 0.008 : 0.014);
  TP.voice = null;
  TP.lp.frequency.cancelScheduledValues(t);
  TP.lp.frequency.setValueAtTime(16000, t);
  let at = t,
    body = false;
  if ((fast || d >= 0.9) && hornHead(out, t, d)) {
    at = t + 0.077;
    body = true;
  }
  const v = tpTrack(hornVoice(out, at, d, {
    body,
    fadeIn: body ? 0.02 : 0.004
  }));
  if (!v) return;
  if (SPX.active && SPX.k > 0.4) spVoiceStart(at, out, dynGain(out, d));
  TP.voice = v;
  TP.cur = out;
  TP.curF = out;
  TP.d = d;
  TP.semi = TP.mode === 'free' ? out : null;
  TP.chord = chordAtTime(t).name;
  TP.noteT0 = t;
  TP.pitchT0 = t;
  TP.lastAttackT = t;
  TP.vibOn = false;
  TP.lastSoundT = t;
  TP.lastRevoiceT = t;
  TP.lastRec = out;
  recordNote(t, out, kind);
  tpEmit('attack', {
    t,
    m: out,
    kind
  });
  musicOnMyAttack(now);
}
// 음 바꾸기 (끊지 않고). kind: slur·land(또렷하게) / gliss·magnet(이어서) / chord·resolve(화음 따라 저절로)
function moveTo(out, kind, t) {
  const v = TP.voice;
  if (!v || v.dead) return;
  const prev = TP.cur,
    cont = kind === 'gliss' || kind === 'magnet';
  if (out === prev) return;
  const d = (kind === 'slur' || kind === 'land') ? autoDyn(t, out) : TP.d;
  let voice = v;
  // 샘플에서 멀어지면 가까운 샘플로 바꿔 끼움 (음색이 늘어지지 않게)
  if (Math.abs(out - v.s.m) > (cont ? 3.5 : 2.6) && t - TP.lastRevoiceT >= 0.06) {
    const s = nearestSample('T', out);
    if (s && s !== v.s) {
      const nv = tpTrack(hornVoice(out, t, d, {
        offset: s.start + 0.12,
        fadeIn: cont ? 0.022 : 0.01
      }));
      if (nv) {
        if (cont) v.glideTo(out, t, 0.02);
        else v.stepTo(out, t);
        cutVoice(v, t + 0.002, cont ? 0.022 : 0.012);
        voice = nv;
        TP.voice = nv;
        TP.lastRevoiceT = t;
        TP.vibOn = false;
      }
    }
  }
  if (voice === v) {
    if (cont) v.glideTo(out, t, kind === 'magnet' ? 0.09 : 0.028);
    else v.stepTo(out, t, d);
  }
  if (!cont) TP.d = d;
  if (SPX.voice2) spVoiceMove(t, out, cont ? 'gliss' : kind);
  TP.cur = out;
  TP.curF = out;
  if (!cont || Math.abs(out - prev) >= 0.75) {
    TP.pitchT0 = t;
    if (TP.vibOn) voice.vibrato(0, t, 0.025);
    TP.vibOn = false;
  }
  const last = TP.lastRec ?? out;
  if (cont ? Math.abs(out - last) >= 1 : Math.round(out) !== Math.round(last)) {
    TP.lastRec = out;
    recordNote(t, out, kind);
    tpEmit('legato', {
      t,
      m: out,
      prev,
      kind
    });
  }
}

function noteOff(flick) {
  if (!TP.voice) return;
  const t = AE.ctx.currentTime + 0.003,
    v = TP.voice,
    dur = t - TP.noteT0;
  if (TP.shake) endShake(t);
  hornRelease(v, t, flick);
  spVoiceStop(t, 0.06, flick);
  TP.voice = null;
  TP.lastSoundT = t + (flick ? 0.3 : 0.05);
  TP.lastOffT = t;
  tpEmit('release', {
    t,
    dur,
    m: TP.cur,
    flick
  });
}
// ---------- 셰이크: 빠르게 떨면 윗음과 왔다 갔다 ----------
function startShake(t) {
  if (!TP.voice) return;
  const base = Math.round(TP.cur);
  let iv = 3;
  if (TP.mode === 'snap') {
    const up = stepAllowed(base, 1, chordAtTime(t), 'W');
    iv = clamp(up - base, 2, 4);
  }
  TP.shake = { t0: t, iv, base };
  shakeOn(TP.voice, t, iv);
  tpEmit('shake', { t, on: true });
}

function endShake(t) {
  const sh = TP.shake;
  TP.shake = null;
  if (!sh) return;
  const v = TP.voice;
  if (v && !v.dead) shakeOff(v, t);
  TP.vibOn = false;
  TP.pitchT0 = t;
  tpEmit('shake', {
    t,
    on: false,
    dur: t - sh.t0
  });
}
// ---------- 입력 (0~1 위치) ----------
function airReset(pos) {
  const tn = performance.now();
  TP.air = [{ t: tn, pos }];
  TP.lastAirT = tn;
  TP.lastPos = pos;
  TP.lastMoveT = tn;
  TP.lastMovingT = 0;
}

function ribbonDown(pos) {
  if (!AE.ctx || GAME.phase === 'finale') return;
  if (AUTO.on) setAuto(false, true);
  if (GAME.phase === 'pre') {
    preBuzzDown(pos);
    return;
  }
  if (!UI.touched) {
    UI.touched = true;
    UI.el.stem.classList.remove('hint');
  }
  airReset(pos);
  TP.pendingMove = false;
  TP.discrete = false;
  TP.lastPitchUpdate = -99;
  TP.pos = pos;
  TP.target = posToPitch(pos);
  TP.blowing = true;
  noteOn('touch');
}
// 다른 손가락으로 짚음: 그 자리로 혀를 쳐서 뜀
function ribbonJump(pos) {
  if (!AE.ctx || GAME.phase === 'finale') return;
  if (GAME.phase === 'pre') {
    preBuzzMove(pos);
    return;
  }
  if (!TP.blowing) {
    ribbonDown(pos);
    return;
  }
  airReset(pos);
  TP.pendingMove = false;
  TP.discrete = false;
  TP.pos = pos;
  TP.target = posToPitch(pos);
  noteOn('jump');
}
// 짚던 손가락을 뗐는데 다른 손가락이 남아 있음: 남은 자리로 슬러
function ribbonBack(pos) {
  if (!AE.ctx || GAME.phase === 'finale') return;
  if (GAME.phase === 'pre') {
    preBuzzMove(pos);
    return;
  }
  if (!TP.blowing || !TP.voice) {
    ribbonDown(pos);
    return;
  }
  airReset(pos);
  TP.pendingMove = false;
  TP.discrete = false;
  TP.pos = pos;
  TP.target = posToPitch(pos);
  const t = AE.ctx.currentTime + 0.003;
  if (TP.shake) endShake(t);
  TP.key = slotKey(t);
  TP.passing = false;
  TP.mv = {
    st: 'rest',
    from: 0,
    movT: 0,
    at0: 0
  };
  const out = TP.mode === 'free' ? clamp(Math.round(TP.target), TP.lo, TP.hi) : snapNow(t, null);
  TP.semi = TP.mode === 'free' ? out : null;
  moveTo(out, 'slur', t);
}

function ribbonMove(pos, o = {}) {
  if (GAME.phase === 'finale') return;
  if (GAME.phase === 'pre') {
    preBuzzMove(pos);
    return;
  }
  const tn = performance.now();
  // Keep a time window for gestures; raw device polling rate must not grow the work.
  const last = TP.air[TP.air.length - 1];
  if (last && tn - TP.lastAirT < 8) TP.air[TP.air.length - 1] = { t: tn, pos };
  else {
    TP.air.push({ t: tn, pos });
    TP.lastAirT = tn;
  }
  while (TP.air.length > 96 || (TP.air.length && tn - TP.air[0].t > 750)) TP.air.shift();
  TP.pos = pos;
  TP.target = posToPitch(pos);
  if (Math.abs(pos - (TP.lastPos ?? pos)) > 0.0005) TP.lastMoveT = tn;
  const h = (UI.inputRect && UI.inputRect.height) || 480;
  if (Math.abs(fingerSpeed(tn) * h) >= MV.REST) TP.lastMovingT = tn;
  TP.lastPos = pos;
  TP.pendingMove = true;
  if (o.discrete) TP.discrete = true;
  flushRibbonMove();
}

function flushRibbonMove(force = false) {
  if (!TP.pendingMove || !TP.blowing || !TP.voice || !AE.ctx) return;
  const now = AE.ctx.currentTime;
  if (!force && now - TP.lastPitchUpdate < 1 / 60) return;
  TP.pendingMove = false;
  TP.lastPitchUpdate = now;
  const t = now + 0.003, tn = performance.now();
  if (TP.discrete) { // 키보드: 한 칸씩 곧바로
    TP.discrete = false;
    if (TP.shake) endShake(t);
    TP.mv.st = 'rest'; 
    TP.key = slotKey(t);
    TP.passing = false;
    const out = TP.mode === 'free' ? clamp(Math.round(TP.target), TP.lo, TP.hi) : snapNow(t, null);
    TP.semi = TP.mode === 'free' ? out : null;
    moveTo(out, 'slur', t);
    return;
  }
  detectShake(tn);
  if (TP.shake) return;
  fingerStep(t, tn);
}
// ---------- 손가락 움직임 판정 (CSS px/초) ----------
// 멈춤 / 천천히(자유: 글리산도, 보정: 한 음씩) / 빠르게(도착한 음으로 또렷하게. 반음 다섯 개 넘게 가면 자유는 립, 보정은 훑기)
const MV = {
  REST: 60,
  FAST: 240,
  LAND: 140,
  RIP: 5,
  GLISS_T: 90,
  GLISS_D: 1.0,
  REST_MS: 70
};

function fingerSpeed(tn, win = 45) { // 띠 길이/초 (위가 +)
  const a = TP.air;
  if (a.length < 2) return 0;
  const l = a[a.length - 1];
  if (tn - l.t > 90) return 0;
  let i = a.length - 1;
  while (i > 0 && l.t - a[i - 1].t <= win) i--;
  if (i === a.length - 1) { // 바로 앞 기록이 오래됨 = 멈춰 있다가 막 움직임: 마지막 20ms 사이에 움직인 걸로
    const q = a[a.length - 2];
    return (l.pos - q.pos) / Math.max(0.008, Math.min(0.02, (l.t - q.t) / 1000));
  }
  const dt = (l.t - a[i].t) / 1000;
  if (dt < 0.004) return 0;
  return (l.pos - a[i].pos) / dt;
}

function fingerStep(t, tn) {
  const h = (UI.inputRect && UI.inputRect.height) || 480;
  const av = Math.abs(fingerSpeed(tn) * h),
    M = TP.mv,
    tgt = clamp(TP.target, TP.lo, TP.hi);
  if (M.st === 'rest' && av >= MV.FAST) {
    M.st = 'jump';
    M.from = TP.cur;
  }
  if (M.st === 'jump') {
    if (Math.abs(tgt - M.from) >= MV.RIP) M.st = TP.mode === 'free' ? 'gliss' : 'run';
    else if (av < MV.LAND) {
      M.st = 'rest';
      M.movT = 0;
      landAt(t, tgt);
      return;
    } else return; // 가는 중: 앞 음을 그대로 물고 있음
  }
  if (TP.mode === 'free') {
    if (M.st === 'gliss') {
      moveTo(tgt, 'gliss', t);
      return;
    }
    // 멈춤 근처: 반음에 붙어 있다가, 같은 방향으로 꾸준히 밀면 글리산도로
    if (av >= MV.REST) {
      if (!M.movT) {
        M.movT = tn;
        M.at0 = tgt;
      }
      if (tn - M.movT >= MV.GLISS_T && Math.abs(tgt - M.at0) >= MV.GLISS_D) {
        M.st = 'gliss';
        moveTo(tgt, 'gliss', t);
        return;
      }
    } else M.movT = 0;
    const s = semiFor(tgt);
    if (s !== TP.semi) {
      TP.semi = s;
      moveTo(s, 'slur', t);
    }
    return;
  }
  // 보정 모드: 지나가는 음도 하나씩 또렷하게
  snapTo(t, av >= MV.REST);
  if (M.st === 'run' && av < MV.REST) M.st = 'rest';
}

function semiFor(tgt) {
  const c = TP.semi;
  if (c != null && Math.abs(tgt - c) < 0.68) return c;
  return clamp(Math.round(tgt), TP.lo, TP.hi);
}

function landAt(t, tgt) {
  if (TP.mode === 'free') {
    const s = clamp(Math.round(tgt), TP.lo, TP.hi);
    TP.semi = s;
    moveTo(s, 'land', t);
  } else snapTo(t, false, 'land');
}

function snapTo(t, moving, kind = 'slur') {
  let out = snapNow(t, Math.round(TP.cur), { moving });
  // 미는 방향과 거꾸로 한 칸 되돌아가는 건 막음 (박이 바뀌며 허용 음이 달라져도 올라가는 중엔 올라가기만)
  if (moving && out !== TP.cur && Math.abs(out - TP.cur) <= 2) {
    const dir = Math.sign(fingerSpeed(performance.now()));
    if (dir && Math.sign(out - TP.cur) === -dir && noteOk(Math.round(TP.cur), chordAtTime(t + 0.02), false, { moving: true })) out = TP.cur;
  }
  TP.key = slotKey(t);
  TP.passing = moving && !noteOk(out, chordAtTime(t + 0.02), isStrongTime(t));
  if (TP.passing) TP.passT = t;
  if (out !== TP.cur) moveTo(out, kind, t);
}
// 매 프레임: (빠르게 가다 멈춤) 도착 · (자유) 멈추면 반음으로 끌어당김 · (보정) 지나가던 음을 화음에 맞춤 · 손가락이 멈추면 셰이크 끝
function fingerTick(now, tn) {
  const M = TP.mv,
    t = now + 0.003,
    restFor = tn - TP.lastMovingT;
  if (TP.shake) {
    if (tn - TP.lastMoveT > 260) endShake(t);
    return;
  }
  if (M.st === 'jump' && tn - TP.lastMoveT > 40) {
    M.st = 'rest';
    M.movT = 0;
    landAt(t, clamp(TP.target, TP.lo, TP.hi));
    return;
  }
  if (TP.mode === 'free') {
    if (M.st === 'gliss' && restFor > MV.REST_MS) {
      M.st = 'rest';
      M.movT = 0;
      const s = clamp(Math.round(TP.target), TP.lo, TP.hi);
      TP.semi = s;
      moveTo(s, 'magnet', t);
    }
  } else {
    if (M.st === 'run' && restFor > MV.REST_MS) M.st = 'rest';
    if (TP.passing && restFor > 90 && now - TP.passT > 0.08) {
      TP.passing = false;
      const out = snapNow(t, null);
      if (out !== TP.cur) moveTo(out, 'resolve', t);
    }
  }
}

function ribbonUp() {
  if (GAME.phase === 'finale' && !TP.blowing) return;
  if (GAME.phase === 'pre') {
    preBuzzUp();
    return;
  }
  flushRibbonMove(true);
  const sp = ribbonSpeed(110);
  TP.blowing = false;
  TP.pendingMove = false;
  TP.discrete = false;
  let flick = null;
  if (sp < -2.2 && TP.cur > 60) flick = 'fall';
  else if (sp > 2.6) flick = 'doit';
  noteOff(flick);
  if (FIN.manualWaiting && FIN.manualPlayed) FIN.manualReleased = true;
}

function ribbonSpeed(ms) { // 띠 길이/초
  const a = TP.air;
  if (a.length < 2 || performance.now() - a[a.length - 1].t > ms) return 0;
  const tn = a[a.length - 1].t;
  let i = a.length - 1;
  while (i > 0 && tn - a[i - 1].t < ms) i--;
  const dt = (tn - a[i].t) / 1000;
  if (dt < 0.012) return 0;
  return (a[a.length - 1].pos - a[i].pos) / dt;
}

function detectShake(tn) {
  const a = TP.air,
    rev = [];
  let dir = 0,
    anchor = a.length ? a[0].pos : 0,
    lo = 9,
    hi = -9;
  for (const s of a) {
    if (tn - s.t > 700) {
      anchor = s.pos;
      continue;
    }
    lo = Math.min(lo, s.pos);
    hi = Math.max(hi, s.pos);
    const d = s.pos - anchor;
    if (Math.abs(d) > 0.008) {
      const nd = Math.sign(d);
      if (dir && nd !== dir) rev.push(s.t);
      dir = nd;
      anchor = s.pos;
    }
  }
  const recent = rev.filter(t => tn - t < 600);
  if (!TP.shake && recent.length >= 4 && hi - lo < 0.09 && TP.cur >= 62) startShake(AE.ctx.currentTime + 0.003);
  else if (TP.shake && (rev.length === 0 || tn - rev[rev.length - 1] > 240)) endShake(AE.ctx.currentTime + 0.003);
}

function releaseAllInput() {
  if (typeof PRE !== 'undefined' && PRE.buzz) preBuzzUp();
  TP.pendingMove = false;
  TP.discrete = false;
  if (TP.blowing) {
    TP.blowing = false;
    noteOff(null);
  }
  if (UI.cancelInput) UI.cancelInput();
}

function trumpetTick() {
  const now = AE.ctx.currentTime;
  if (AUTO.on) {
    autoRender(now);
    autoEvents(now);
    autoSide(now);
    if (TP.blowing) TP.lastSoundT = now;
    return;
  }
  flushRibbonMove();
  const tn = performance.now();
  if (TP.blowing && TP.voice && !TP.voice.dead) fingerTick(now, tn);
  if (TP.blowing) TP.lastSoundT = now;
  let v = TP.voice;
  if (!TP.blowing || !v || v.dead || TP.shake) return;
  // 화음이 바뀌거나 정박이 오면 (보정 모드) 맞는 음으로 한 번 옮김
  if (TP.mode === 'snap') heldHarmonyTick(now);
  v = TP.voice;
  if (!v || v.dead) return;
  // 오래 끌면 비브라토
  const still = tn - TP.lastMovingT > 250;
  if (!TP.vibOn && still && now - TP.pitchT0 > 0.4 && TP.mv.st === 'rest') {
    TP.vibOn = true;
    v.vibrato(TP.cur >= 76 ? 17 : 13, now, 0.35);
  } else if (TP.vibOn && !still) {
    TP.vibOn = false;
    v.vibrato(0, now, 0.05);
  }
}
// 1인칭 트럼펫 밸브 모양 (실제 운지, 기보 = 콘서트+2)
const FINGER = { 54: 7, 55: 5, 56: 6, 57: 3, 58: 1, 59: 2, 60: 0, 61: 7, 62: 5, 63: 6, 64: 3, 65: 1, 66: 2, 67: 0, 68: 6, 69: 3, 70: 1, 71: 2, 72: 0, 73: 3, 74: 1, 75: 2, 76: 0, 77: 1, 78: 2, 79: 0, 80: 6, 81: 3, 82: 1, 83: 2, 84: 0, 85: 3, 86: 1, 87: 2, 88: 0, 89: 1, 90: 2 };
const fingeringFor = m => FINGER[clamp(Math.round(m) + 2, 54, 90)] || 0;

// ===== 52_soloist.js =====
// ===================== 자동 연주: 숨 쉬는 프레이즈 · 박엔 코드톤 · 반음 접근과 감싸기 · 동기 반복 · 코러스 흐름 · 넘겨주기 =====================
// 테마가 끝나면 솔로를 받아 1분 남짓(코러스 단위) 불고 손을 놓음 → 밴드 솔로·테마·엔딩·박수 → 다음 곡. 엔딩 태그엔 짧게 받아치고, 마지막 늘임표 음도 붊.
// 음은 밴드처럼 오디오 시계로 미리 예약하고(0.13초 앞), 화면·관객 쪽 상태(지금 부는 음 등)는 그 음이 실제로 나는 순간에 바꿈.

function autoSync() {
  const key = [UI.playing, GAME.phase, FIN.req, AUTO.on].join('|');
  if (AUTO.uiKey === key) return;
  AUTO.uiKey = key;
  const el = document.getElementById('autoMode');
  el.style.display = UI.playing && GAME.phase === 'play' && !FIN.req ? 'inline-flex' : 'none';
  el.querySelectorAll('button').forEach(b => {
    const on = (b.dataset.auto === 'on') === AUTO.on;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  if (FIGHT.on || METEOR.on) UI.el.hudMode.style.display = 'none';
  else UI.el.hudMode.style.display = GAME.phase === 'play' && !AUTO.on ? 'inline-flex' : 'none';
}

function setAuto(on, keepInput = false) {
  if (on && (!UI.playing || GAME.phase !== 'play' || FIN.req || FIN.on)) return;
  if (AUTO.on === on) return;
  const now = AE.ctx ? AE.ctx.currentTime : 0;
  if (on) {
    releaseAllInput();
    Object.assign(AUTO, {
      on: true,
      state: 'wait',
      sol: null,
      soloDone: false,
      wantTake: false,
      lastT: 0
    });
    AUTO.notes.length = 0;
    AUTO.ev.length = 0;
    const S = MUS.song;
    if (S && !S.ended) {
      if (['count', 'intro', 'head', 'outhead'].includes(S.phase)) S.wantYield = true; // 테마의 4마디 프레이즈 끝에서 솔로를 받음
      else if (S.phase === 'solo' || S.phase === 'trades') {
        if (S.floor !== 'me') AUTO.wantTake = true;
      } // 다음 마디부터 가져옴 (내 솔로 중이었으면 그대로 이어 붊)
      else AUTO.soloDone = true; // 끝나 가는 곡: 다음 곡 테마 뒤에
    }
    UI.touched = true;
    UI.el.stem.classList.remove('hint');
  } else {
    autoFlush(now);
    if (MUS.fermata) MUS.fermata.autoCutAt = null;
    Object.assign(AUTO, {
      on: false,
      state: 'off',
      sol: null,
      wantTake: false
    });
    if (!keepInput) {
      releaseAllInput();
      fingerVisual(null);
    }
    spPress(false);
  }
  syncMode();
  autoSync();
}
// 예약해 둔 소리·상태를 전부 거둠
function autoFlush(now) {
  AUTO.notes.length = 0;
  AUTO.ev.length = 0;
  tpCutAll(now + 0.004, 0.02);
  AUTO.voice = null;
  AUTO.open = false;
  AUTO.voiceEnd = 0;
  AUTO.lastT = 0;
  TP.shake = null;
  if (AUTO.sounding || TP.blowing) {
    AUTO.sounding = false;
    TP.blowing = false;
    TP.voice = null;
    TP.lastSoundT = now;
    TP.lastOffT = now;
    fingerVisual(null);
    tpEmit('release', {
      t: now,
      dur: now - TP.noteT0,
      m: TP.cur,
      flick: null
    });
  }
}

// ---------- 곡 흐름에 붙는 곳 ----------
function autoOnSong() {
  if (!AUTO.on) return;
  autoFlush(AE.ctx.currentTime);
  Object.assign(AUTO, {
    state: 'wait',
    sol: null,
    soloDone: false,
    wantTake: false
  });
}
const autoWantsSolo = () => AUTO.on && !AUTO.soloDone && (AUTO.state === 'wait' || AUTO.state === 'solo');

function autoSoloEnd() {
  AUTO.state = 'rest';
  AUTO.soloDone = true;
  AUTO.sol = null;
  if (SPX.held) spPress(false);
}
// 마디가 만들어질 때 (밴드 소리를 짜는 순간, 그 마디보다 0.3초 남짓 앞)
function autoOnBar(S, b) {
  if (!AUTO.on) return;
  const ph = S.phase;
  // 테마 마지막 마디: 솔로로 들어가는 못갖춘 프레이즈부터
  if (ph === 'head' && AUTO.state === 'wait' && !AUTO.soloDone && S.pass >= S.passes - 1 && S.fb === S.N - 1) {
    autoStartSolo(S, b, true);
    return;
  }
  if (ph === 'solo' && S.floor === 'me') {
    if (AUTO.state === 'wait') autoStartSolo(S, b, false);
    if (AUTO.state === 'solo' && AUTO.sol) {
      if (S.brk && b.abs === S.brk.from) AUTO.sol.breakAt(b.beat0);
      AUTO.sol.ensure(b.beat0 + 8);
    }
    return;
  }
  // 엔딩 태그 · 페이드 반복: 사이사이 짧게 받아침
  if (ph === 'tag' && AUTO.state === 'rest' && S.tagIdx === 0 && !AUTO.notes.length && Math.random() < 0.7) autoFill(S, b);
}
// 솔로 길이: 1분 안팎, 코러스(발라드는 16마디) 끝에서 넘김
function autoSoloBars(S, fb0) {
  const unit = S.unit,
    barSec = 4 * S.spb,
    remain = unit - (fb0 % unit),
    target = rand(52, 72);
  let bars = remain;
  if (remain < unit * 0.5) bars += unit;
  while ((bars + unit) * barSec <= target + unit * barSec * 0.45 && bars + unit <= unit * 6) bars += unit;
  return bars;
}

function autoStartSolo(S, b, pickup) {
  const startBar = pickup ? b.beat0 + 4 : b.beat0;
  const bars = autoSoloBars(S, pickup ? 0 : b.fb);
  const sol = new Soloist({
    ctx: songCtx(S, b),
    startB: startBar,
    endB: startBar + bars * 4,
    bpm: S.bpm,
    blues: !!S.tune.blues,
    keyPc: S.keyPc,
    straight: S.swing <= 0.52,
    mode: 'solo'
  });
  sol.cursor = pickup ? b.beat0 + pick([2, 2.5, 3]) : b.beat0 + pick([0, 0.5, 0.5, 1]);
  AUTO.sol = sol;
  AUTO.state = 'solo';
  sol.ensure(b.beat0 + 8);
}
// 곡 안의 박 → 화음 · 시간 (시간은 실제로 만들어진 마디에서 읽음)
function songCtx(S, b) {
  const ref = {
    beat0: b.beat0,
    fb: b.fb
  };
  const at = B => {
    const r = B - ref.beat0,
      k = Math.floor(r / 4 + 1e-9);
    return {
      fb: ((ref.fb + k) % S.N + S.N) % S.N,
      pos: r - 4 * k
    };
  };
  const chordOf = (fb, pos) => {
    const bar = S.form[fb];
    let c = bar[0];
    for (const x of bar)
      if (pos >= x.at - 1e-6) c = x;
    return c;
  };
  return {
    chord(B) {
      const a = at(B);
      return chordOf(a.fb, a.pos);
    },
    isChange(B) {
      const a = at(B), c = chordOf(a.fb, a.pos);
      if (Math.abs(a.pos - c.at) > 1e-6) return false;
      const p = at(B - 0.01);
      return chordOf(p.fb, p.pos).name !== c.name;
    },
    barStart(B) {
      return ref.beat0 + 4 * Math.ceil((B - ref.beat0) / 4 - 1e-9);
    },
    time: songTime,
    spb: () => S.spb,
  };
}

function songTime(B, straight) {
  const L = MUS.bars;
  if (!L.length) return null;
  if (B < L[0].beat0 - 1e-6) return -1;
  for (let i = L.length - 1; i >= 0; i--) {
    const b = L[i];
    if (B >= b.beat0 - 1e-6) {
      if (B > b.beat0 + 4 + 1e-6) return null;
      const r = B - b.beat0;
      return straight ? b.t0 + r * b.spb : pt(b, r);
    }
  }
  return null;
}

function autoFill(S, b) {
  const tb = S.tagBars,
    n = tb.length,
    ref = b.beat0;
  const ctx = {
    chord(B) {
      const r = B - ref,
        k = Math.floor(r / 4 + 1e-9),
        bar = tb[((k % n) + n) % n],
        pos = r - 4 * k;
      let c = bar[0];
      for (const x of bar)
        if (pos >= x.at - 1e-6) c = x;
      return c;
    },
    isChange: () => false,
    barStart: B => ref + 4 * Math.ceil((B - ref) / 4 - 1e-9),
    time: songTime,
    spb: () => S.spb,
  };
  const sol = new Soloist({
    ctx,
    startB: ref + 4,
    endB: ref + 4 * n - 1,
    bpm: S.bpm,
    blues: !!S.tune.blues,
    keyPc: S.keyPc,
    straight: S.swing <= 0.52,
    mode: 'fill',
    fixedI: S.tagType === 'vampfade' ? 0.3 : 0.5
  });
  sol.cursor = ref + 4 + pick([0.5, 1, 1.5]);
  sol.fillOne(6);
}
// 곡 끝: 늘임표 화음 위로 높은 음을 길게 (가끔은 다 같이 숨을 참을 만큼 오래) 불고 밴드와 같이 끊음. 버튼 엔딩은 밴드와 같이 짧게 한 방.
function autoFinal(S, t, kind) {
  if (!AUTO.on || S.showEnd || !AE.ctx) return null;
  const ch = S.final;
  autoFlush(AE.ctx.currentTime);
  if (kind === 'button') {
    autoDirect({
      t: t + 0.006,
      m: nearestPC(ch.root + pick([0, 7]), 76, 70, 82),
      end: t + 0.3,
      d: 1.06,
      head: true,
      rel: 0.05
    });
    return null;
  }
  const c = [];
  for (let m = 77; m <= 84; m++)
    if (isChordTone(m, ch) || inSet(m, ch, 'S')) c.push(m);
  const hiC = c.filter(m => m >= 79),
    H = hiC.length ? pick(hiC) : c.length ? pick(c) : 79;
  const endless = (REACT.songPeak >= 70 || REACT.awes >= 2) && Math.random() < 0.3;
  const hold = endless ? rand(10.5, 12.2) : rand(3.3, 4.6),
    t0 = t + 0.03,
    tEnd = t0 + hold;
  const style = endless ? 'shake' : pick(['shake', 'shake', 'swell', 'fall']);
  autoDirect({
    t: t0,
    m: H,
    end: tEnd,
    d: style === 'swell' ? 0.86 : 1.02,
    scoop: -2,
    scoopT: 0.12,
    vib: true,
    vibAt: 0.4,
    rel: 0.04,
    shake: style === 'shake' ? {
      t: tEnd - Math.min(1.3, hold * 0.35),
      len: Math.min(1.1, hold * 0.3)
    } : null,
    swell: style === 'swell' ? 0.24 : 0,
    flick: style === 'fall' ? 'fall' : null
  });
  return tEnd;
}
// 곡 사이 폰 녹음: 팬이 폰을 내밀면 짧은 릭 하나
function autoSide(now) {
  const c = ITL.cur;
  if (!c || c.kind !== 'sign' || c.stage !== 'aim' || c.autoLick || !MUS.gap || NOW.t - c.stageT < 0.6) return;
  c.autoLick = true;
  const spb = MUS.gapSpb || 0.45,
    ch = MUS.gapChord || parseChord('C6'),
    t0 = now + 0.12;
  const ctx = {
    chord: () => ch,
    isChange: () => false,
    barStart: B => 4 * Math.ceil(B / 4 - 1e-9),
    spb: () => spb,
    time: (B, straight) => {
      const w = Math.floor(B + 1e-6),
        f = B - w,
        ff = !straight && Math.abs(f - 0.5) < 1e-6 ? 0.62 : f;
      return t0 + (w + ff) * spb;
    },
  };
  const sol = new Soloist({
    ctx,
    startB: 0,
    endB: 7,
    bpm: 60 / spb,
    blues: false,
    keyPc: ch.root,
    straight: false,
    mode: 'lick',
    fixedI: 0.55
  });
  sol.cursor = 0.5;
  sol.fillOne(5);
}

// ---------- 소리 내기 (예약) ----------
function autoEv(e) {
  const E = AUTO.ev;
  let i = E.length;
  while (i > 0 && E[i - 1].t > e.t) i--;
  E.splice(i, 0, e);
}

function autoDropRelease(v, t) {
  const E = AUTO.ev;
  for (let i = E.length - 1; i >= 0; i--)
    if (E[i].voice === v && E[i].t >= t - 0.006 && (E[i].type === 'release' || E[i].type === 'shake')) E.splice(i, 1);
}

function autoRender(now) {
  if (!AUTO.on || !AE.ctx) return;
  const N = AUTO.notes;
  let g = 0;
  while (N.length && g++ < 48) {
    const n = N[0],
      t = n.ctx.time(n.B, n.straight);
    if (t == null) break;
    if (t !== -1 && t > now + AUTO_LOOK) break;
    N.shift();
    if (t === -1 || t < now - 0.08) continue; // 놓친 음은 건너뜀
    autoPlay(n, Math.max(t, now + 0.005));
  }
}

function autoPlay(n, t0) {
  const A = AUTO,
    ctx = n.ctx,
    spb = ctx.spb();
  if (n.rest) { // 여기서 손을 놓음 (물고 있던 음이 있으면)
    if (A.open && A.voice && !A.voice.dead) {
      hornRelease(A.voice, t0, null, 0.06);
      if (SPX.voice2) spVoiceStop(t0, 0.06);
      A.open = false;
      A.voiceEnd = t0 + 0.02;
      autoEv({
        t: t0,
        type: 'release',
        flick: null,
        voice: A.voice
      });
    }
    return;
  }
  // 사람처럼: 정박은 아주 살짝 뒤에 (레이백), 뒷박은 거의 제자리
  const hum = n.straight ? rand(-0.002, 0.004) : n.strong ? 0.011 + rand(-0.004, 0.006) : 0.003 + rand(-0.004, 0.005);
  const t = Math.max(t0 + hum, A.lastT + 0.022);
  A.lastT = t;
  const e1 = ctx.time(n.B + n.len, n.straight);
  const tEnd = Math.max(t + 0.06, (e1 != null && e1 !== -1 ? e1 : t + n.len * spb) + hum);
  const m = n.m,
    d = n.d ?? 0.75,
    m0 = n.grace ? m + n.grace : m; // m0: 꺾어 들어가는 꾸밈음부터
  let v = A.voice,
    type;
  const live = v && !v.cut && t < A.voiceEnd - 0.002;
  if (n.art === 'slur' && live && A.open && !v.dead) {
    // 이어 부는 음: 밸브 바꾸듯 또렷하게 (샘플에서 멀면 바꿔 끼움)
    v.vibrato(0, t - 0.012, 0.012);
    if (Math.abs(m0 - v.s.m) > 2.6) {
      const s = nearestSample('T', m0);
      if (s && s !== v.s) {
        const nv = tpTrack(hornVoice(m0, t, d, {
          offset: s.start + 0.12,
          fadeIn: 0.01
        }));
        if (nv) {
          v.stepTo(m0, t);
          cutVoice(v, t + 0.002, 0.012);
          v = nv;
        }
      }
    }
    if (v === A.voice) v.stepTo(m0, t, d);
    type = 'legato';
    if (SPX.voice2) spVoiceMove(t, m0, 'slur');
  } else {
    // 혀를 침: 앞 음이 아직 울리면 아주 짧게 끊고
    if (live) {
      cutVoice(v, t - 0.005, 0.01);
      autoDropRelease(v, t);
    }
    let at = t,
      body = false;
    if ((n.len * spb < 0.32 || d >= 0.92) && !n.ghost && !n.grace && hornHead(m0, t, d)) {
      at = t + 0.077;
      body = true;
    }
    v = tpTrack(hornVoice(m0, at, d, {
      body,
      fadeIn: body ? 0.02 : 0.005,
      scoop: n.scoop || 0,
      scoopTime: n.scoopT || 0.07
    }));
    if (!v) return;
    type = 'attack';
    if (SPX.active) spVoiceStart(at, m0, dynGain(m0, d));
  }
  A.voice = v;
  A.open = true;
  A.voiceEnd = 1e9;
  autoEv({
    t,
    type,
    m: m0,
    voice: v
  });
  if (n.grace) {
    const tg = t + Math.min(0.06, n.len * spb * 0.3);
    v.stepTo(m, tg, d);
    if (SPX.voice2) spVoiceMove(tg, m, 'slur');
    autoEv({
      t: tg,
      type: 'legato',
      m,
      voice: v
    });
  }
  if (n.vib) v.vibrato(n.vibDepth || (m >= 76 ? 18 : 14), t + (n.vibAt ?? 0.22), 0.28);
  if (n.swell) v.setDyn(Math.min(1.12, d + n.swell), t + 0.06, Math.max(0.1, (tEnd - t) * 0.7));
  if (n.shake) {
    const s0 = t + n.shake.at * spb,
      s1 = Math.min(tEnd - 0.05, s0 + n.shake.len * spb);
    if (s1 > s0 + 0.15) {
      shakeOn(v, s0, n.shake.iv || 3);
      shakeOff(v, s1);
      autoEv({
        t: s0,
        type: 'shake',
        on: true,
        voice: v
      });
      autoEv({
        t: s1,
        type: 'shake',
        on: false,
        dur: s1 - s0,
        voice: v
      });
      if (n.vib) v.vibrato(16, s1 + 0.06, 0.2);
    }
  }
  if (n.ripTo) v.glideTo(n.ripTo, tEnd - 0.12, 0.1); // 립: 다음 높은 음까지 끌어올림
  if (n.end) {
    const flick = n.end === 'fall' || n.end === 'doit' ? n.end : null,
      len = tEnd - t;
    const tr = n.stacc ? t + len * 0.5 : flick ? tEnd - Math.min(0.14, len * 0.3) : tEnd - Math.min(0.07, len * 0.15);
    hornRelease(v, tr, flick, n.end === 'cut' ? 0.03 : 0.07);
    if (SPX.voice2) spVoiceStop(tr, 0.06, flick);
    A.open = false;
    A.voiceEnd = tr + (flick ? 0.3 : 0.02);
    autoEv({
      t: tr,
      type: 'release',
      flick,
      voice: v
    });
  }
  if (n.special) autoEv({
    t,
    type: 'special'
  });
}
// 시간을 바로 정해서 내는 음 (곡 끝 늘임표 · 버튼)
function autoDirect(o) {
  const A = AUTO,
    t = o.t,
    m = o.m,
    d = o.d ?? 1;
  if (A.voice && !A.voice.cut && t < A.voiceEnd) {
    cutVoice(A.voice, t - 0.005, 0.01);
    autoDropRelease(A.voice, t);
  }
  let at = t,
    body = false;
  if (o.head && hornHead(m, t, d)) {
    at = t + 0.077;
    body = true;
  }
  const v = tpTrack(hornVoice(m, at, d, {
    body,
    fadeIn: body ? 0.02 : 0.006,
    scoop: o.scoop || 0,
    scoopTime: o.scoopT || 0.07
  }));
  if (!v) return;
  if (SPX.active) spVoiceStart(at, m, dynGain(m, d));
  A.voice = v;
  A.lastT = t;
  autoEv({
    t,
    type: 'attack',
    m,
    voice: v
  });
  if (o.vib) v.vibrato(m >= 76 ? 18 : 15, t + (o.vibAt ?? 0.3), 0.35);
  if (o.shake) {
    const s0 = o.shake.t,
      s1 = s0 + o.shake.len;
    shakeOn(v, s0, 3);
    shakeOff(v, s1);
    autoEv({
      t: s0,
      type: 'shake',
      on: true,
      voice: v
    });
    autoEv({
      t: s1,
      type: 'shake',
      on: false,
      dur: s1 - s0,
      voice: v
    });
    if (o.vib) v.vibrato(16, s1 + 0.05, 0.2);
  }
  if (o.swell) v.setDyn(Math.min(1.12, d + o.swell), t + 0.3, (o.end - t) * 0.7);
  hornRelease(v, o.end, o.flick || null, o.rel ?? 0.05);
  if (SPX.voice2) spVoiceStop(o.end, 0.05, o.flick || null);
  A.open = false;
  A.voiceEnd = o.end + (o.flick ? 0.3 : 0.02);
  autoEv({
    t: o.end,
    type: 'release',
    flick: o.flick || null,
    voice: v
  });
}
// 음이 실제로 나는 순간: 지금 부는 음·손가락 표시·관객 반응
function autoEvents(now) {
  const E = AUTO.ev;
  while (E.length && E[0].t <= now) {
    const e = E.shift();
    if (e.type === 'attack' || e.type === 'legato') {
      const prev = TP.cur;
      TP.blowing = true;
      TP.voice = e.voice;
      TP.cur = e.m;
      TP.curF = e.m;
      TP.pitchT0 = e.t;
      TP.lastSoundT = e.t;
      AUTO.sounding = true;
      if (e.type === 'attack') {
        TP.noteT0 = e.t;
        TP.lastAttackT = e.t;
      }
      recordNote(e.t, e.m, 'auto');
      fingerVisual(pitchToPos(e.m));
      tpEmit(e.type, {
        t: e.t,
        m: e.m,
        prev,
        kind: 'auto'
      });
      if (e.type === 'attack') musicOnMyAttack(now);
    } else if (e.type === 'release') {
      TP.blowing = false;
      TP.voice = null;
      TP.lastSoundT = e.t + (e.flick ? 0.3 : 0.05);
      TP.lastOffT = e.t;
      AUTO.sounding = false;
      fingerVisual(null);
      tpEmit('release', {
        t: e.t,
        dur: e.t - TP.noteT0,
        m: TP.cur,
        flick: e.flick
      });
    } else if (e.type === 'shake') tpEmit('shake', {
      t: e.t,
      on: e.on,
      dur: e.dur
    });
    else if (e.type === 'special') {
      if (SPX.g >= 0.999 && !SPX.active && !SPX.held) spPress(true);
    }
  }
}

// ===== 70_director.js =====
// ===================== 밴드 연출: 악기 잡기·연주 동작·나를 돌아보기 =====================
const BAND = {};
const DIR = {
  tbPlay: 0,
  tbState: 'rest',
  tbLastNote: 0,
  slide: 0,
  slideT: 0,
  pluck: 0,
  bassM: 40,
  pnX: {
    L: -0.2,
    R: 0.2
  },
  pnPress: {
    L: 0,
    R: 0
  },
  pnTarget: {
    L: null,
    R: null
  },
  hits: {
    L: [],
    R: []
  },
  countOff: 0,
  brushes: false,
  hatClose: 0
};
const BANDLOOKS = {
  tb: {
    name: 'tb',
    hair: 'bald',
    hairColor: '#e8e2d6',
    skin: '#8a5233',
    beard: true,
    mustache: true,
    beardColor: '#eeeae2',
    hat: 'beret',
    hatColor: '#1e2140',
    topStyle: 'jacket',
    jacket: '#16806c',
    shirt: '#fff4de',
    tie: '#ee4a2c',
    pants: '#24263a',
    shoes: '#4a2a18',
    h: 1.02,
    w: 1.08,
    belly: 0.5,
    headScale: 1.72,
    nose: 1.25
  },
  pn: {
    name: 'pn',
    fem: true,
    hair: 'bun',
    hairColor: '#1e1a1e',
    skin: '#ffd8bc',
    glasses: '#c79a3b',
    topStyle: 'blazer',
    jacket: '#ee4a2c',
    shirt: '#ffd84a',
    pants: '#1f2f6b',
    shoes: '#1f2f6b',
    h: 0.97,
    headScale: 1.75,
    earring: '#ffbf2e',
    mouthColor: '#a01c36'
  },
  bs: {
    name: 'bs',
    hair: 'afro',
    hairColor: '#24160f',
    skin: '#a8673e',
    topStyle: 'shirt',
    top: '#7b3fb0',
    shirt: '#7b3fb0',
    pants: '#2f4f8a',
    shoes: '#f4ead8',
    h: 1.05,
    headScale: 1.7,
    goatee: true
  },
  dr: {
    name: 'dr',
    hair: 'buzz',
    hairColor: '#5a3a22',
    skin: '#f2c3a0',
    beard: true,
    topStyle: 'tee',
    top: '#fff4de',
    stripe: '#2f5bd8',
    pants: '#22244a',
    shoes: '#1e1a1e',
    h: 1.0,
    w: 1.1,
    headScale: 1.72,
    nose: 1.15
  },
};
const _d1 = new THREE.Vector3(),
  _d2 = new THREE.Vector3(),
  _d3 = new THREE.Vector3(),
  _dq = new THREE.Quaternion(),
  _dq2 = new THREE.Quaternion();
const wpos = (o, out = new THREE.Vector3()) => {
  o.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(o.matrixWorld);
};
const findA = (g, name) => g.getObjectByName(name);
const yawToward = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

function setupBand(scene) {
  const L = LAYOUT.band,
    Y = LAYOUT.stageY;
  // ----- 드럼 -----
  const kit = makeDrumKit();
  kit.position.set(L.dr.pos[0], Y, L.dr.pos[2]);
  kit.rotation.y = L.dr.yaw + Math.PI;
  scene.add(kit);
  const seatA = findA(kit, 'seat');
  const seatY = seatA ? wpos(seatA).y - Y : 0.5;
  const dr = new Person(BANDLOOKS.dr, {
    seated: true,
    seatY,
    feetFwd: 0.5
  });
  dr.root.position.set(L.dr.pos[0], Y, L.dr.pos[2]);
  dr.root.rotation.y = L.dr.yaw;
  scene.add(dr.root);
  dr.sticks = {
    L: makeStick(false),
    R: makeStick(false),
    bL: makeStick(true),
    bR: makeStick(true)
  };
  for (const k in dr.sticks) {
    scene.add(dr.sticks[k]);
    dr.sticks[k].visible = k.length === 1;
  }
  dr.kit = kit;
  // ----- 베이스 -----
  const bs = new Person(BANDLOOKS.bs);
  bs.root.position.set(L.bs.pos[0], Y, L.bs.pos[2]);
  bs.root.rotation.y = L.bs.yaw;
  scene.add(bs.root);
  const bass = makeDoubleBass();
  scene.add(bass);
  bs.inst = bass;
  // ----- 피아노 -----
  const piano = makeGrandPiano();
  piano.rotation.y = L.pn.yaw + Math.PI;
  piano.position.set(0, 0, 0);
  scene.add(piano);
  piano.updateMatrixWorld(true);
  const ps = findA(piano, 'seat');
  const sp = ps ? wpos(ps) : V3(0, 0.5, 0.6);
  piano.position.set(L.pn.pos[0] - sp.x, Y, L.pn.pos[2] - sp.z);
  piano.updateMatrixWorld(true);
  const sp2 = ps ? wpos(ps) : V3(L.pn.pos[0], Y + 0.5, L.pn.pos[2]);
  const pn = new Person(BANDLOOKS.pn, {
    seated: true,
    seatY: sp2.y - Y,
    feetFwd: 0.38
  });
  pn.root.position.set(sp2.x, Y, sp2.z);
  pn.root.rotation.y = L.pn.yaw;
  scene.add(pn.root);
  pn.piano = piano;
  // ----- 트롬본 (리더) -----
  const tb = new Person(BANDLOOKS.tb);
  tb.root.position.set(L.tb.pos[0], Y, L.tb.pos[2]);
  tb.root.rotation.y = L.tb.yaw;
  scene.add(tb.root);
  const horn = makeTrombone();
  scene.add(horn);
  tb.horn = horn;
  Object.assign(BAND, {
    tb,
    pn,
    bs,
    dr,
    piano,
    kit,
    bass,
    members: [pn, bs, dr, tb]
  });
  for (const k of ['tb', 'pn', 'bs', 'dr']) {
    const m = BAND[k];
    m.key = k;
    m.baseYaw = L[k].yaw;
    m.turn = 0;
    m.stare = null;
    m.express('calm', -1);
    m.c.groove = 0.45;
    m.c.nod = 0.4;
  }
  tb.c.sway = 0.25;
  bs.c.sway = 0.35;
  dr.c.sway = 0.1;
  pn.c.sway = 0.2;
}

// ---------- 소리 → 동작 이벤트 ----------
function handleVQ(e) {
  switch (e.who) {
    case 'tbn':
      if (e.type === 'note') {
        DIR.tbState = 'play';
        DIR.slideT = (e.slide - 1) / 6;
        DIR.tbLastNote = e.t + Math.min(e.dur, 30);
        BAND.tb.express('blow', Math.min(e.dur + 0.3, 30));
      }
      break;
    case 'bass':
      if (!e.ghost) {
        DIR.pluck = 1;
        DIR.bassM = e.midi;
      }
      break;
    case 'pno': {
      const hand = e.hand === 'R' ? 'R' : 'L';
      const avg = e.notes.reduce((a, b) => a + b, 0) / e.notes.length;
      DIR.pnTarget[hand] = avg;
      DIR.pnPress[hand] = 1;
      break;
    }
    case 'drums':
      if (e.type === 'hit') {
        const P = BAND.kit.userData.pieces || {};
        if ((e.piece === 'ride' || e.piece === 'ridebell') && P.ride) wob(P.ride, 2.2 * e.v);
        if (e.piece === 'crash' && P.crash) wob(P.crash, 4.5 * e.v);
        if (e.piece === 'hat') DIR.hatClose = 1;
        if (e.piece === 'stick') DIR.countOff = 0.6;
      } else if (e.type === 'swap') {
        DIR.brushes = e.brushes;
        const s = BAND.dr.sticks;
        s.L.visible = s.R.visible = !e.brushes;
        s.bL.visible = s.bR.visible = e.brushes;
      } else if (e.type === 'count') DIR.countOff = 1.0;
      break;
    case 'song':
      bandOnSong(e);
      reactOnSong(e);
      break;
  }
}

function wob(c, v) {
  c.userData.wv = (c.userData.wv || 0) + v;
}

function peekDrumHits() {
  for (const e of VQ) {
    if (e._seen || e.who !== 'drums' || e.type !== 'hit') continue;
    e._seen = true;
    const limb = e.limb === 'L' ? 'L' : e.limb === 'R' ? 'R' : null;
    if (!limb) continue;
    DIR.hits[limb].push({
      t: e.t,
      piece: e.piece,
      v: e.v
    });
    if (DIR.hits[limb].length > 40) DIR.hits[limb].splice(0, 20);
  }
}

function processVQ(now) {
  peekDrumHits();
  let i = 0;
  while (i < VQ.length) {
    if (VQ[i].t <= now) {
      const e = VQ[i];
      VQ.splice(i, 1);
      try {
        handleVQ(e);
      } catch (err) {
        console.error('VQ', e.who, e.type, err);
      }
    } else i++;
  }
  if (VQ.length > 4000) VQ.splice(0, VQ.length - 2000);
}

// ---------- 곡 진행 → 밴드 몸짓 ----------
function bandOnSong(e) {
  const tb = BAND.tb;
  if (e.type === 'cue') {
    if (e.kind === 'invite') {
      stare(tb, 2.6, 'ask', 0.5);
      later(1.5, () => tb.express('smile', 1.6));
      tb.cueNod = NOW.t + 2.6;
    } else if (e.kind === 'tophead') {
      tb.headTap = NOW.t + 1.6;
      stare(tb, 1.6, 'ask', 0.3);
    } else if (e.kind === 'head') {
      tb.express('focus', 1.2);
    }
  } else if (e.type === 'takeover') {
    // 솔로하던 사람이 비켜 주며 "얘 뭐야?" 하고 나를 봄
    const m = BAND[e.from];
    if (m) {
      stare(m, 2.2, 'disbelief', 0.5);
      headShake(m, 0.5, 1.7);
      later(1.5, () => m.express('stunlaugh', 1.4));
    }
    for (const k of ['pn', 'bs', 'dr'])
      if (k !== e.from && Math.random() < 0.5) {
        glanceMe(BAND[k], 1.0);
        BAND[k].express('wow', 1.1);
      }
  } else if (e.type === 'solo') {
    if (e.player && BAND[e.player])
      for (const k of ['pn', 'bs', 'dr', 'tb'])
        if (k !== e.player) BAND[k].lookAtMember = {
          who: e.player,
          until: NOW.t + 2.5
        };
  } else if (e.type === 'seg' && e.phase === 'solo' && e.player === 'me') {
    stare(tb, 1.8, 'smile', 0.5);
    tb.presenting = NOW.t + 1.8;
  } else if (e.type === 'break') {
    // 밴드가 멈추고 다 같이 돌아봄: 입이 떡 벌어진 채 굳었다가 절레절레
    if (e.on)
      for (const m of BAND.members) {
        stare(m, curSpb() * 8, 'jawdrop', 1.0);
        headShake(m, curSpb() * 3.5, curSpb() * 8);
      }
    else
      for (const m of BAND.members) {
        m.express('stunlaugh', 1.7);
        later(1.7, () => m.express('grin', 1.4));
      }
  } else if (e.type === 'fermata') {
    for (const m of BAND.members) stare(m, 30, 'focus', 0.7);
  } else if (e.type === 'cut') {
    for (const m of BAND.members) {
      m.stare = null;
      m.express('grin', 4);
    }
    later(0.4, () => {
      tb.presenting = NOW.t + 4;
      stare(tb, 4, 'grin', 1.0);
    });
  } else if (e.type === 'tuneStart') {
    for (const m of BAND.members) {
      m.stare = null;
      m.shakeUntil = 0;
    }
    if (!e.first) {
      tb.lookAtMember = {
        who: 'dr',
        until: NOW.t + 1.5
      };
    }
  } else if (e.type === 'gap') {
    for (const m of BAND.members) m.express('smile', 3);
  }
}
const _later = [];

function later(sec, fn) {
  _later.push({
    t: NOW.t + sec,
    fn
  });
}
// 돌아서 나를 봄 (turn: 0~1, 서 있는 사람은 몸까지 돌림)
function stare(m, dur, face = 'awe', turn = 1) {
  m.stare = {
    until: NOW.t + dur,
    turn
  };
  if (face) m.express(face, dur);
}

function glanceMe(m, dur) {
  m.glance = NOW.t + dur;
}
// 느린 절레절레 ("미쳤네…"): from초 뒤부터 until초까지
function headShake(m, from, until) {
  m.shakeFrom = NOW.t + from;
  m.shakeUntil = NOW.t + until;
}
// 경이 순간 (반응 규칙에서): 입이 떡 벌어진 채 돌아봄 → 절레절레 → 어이없어 웃음
function bandAwe(ev) {
  const m = BAND[ev.who];
  if (!m) return;
  const go = (w, turn = 1) => {
    stare(w, 3.6, 'jawdrop', turn);
    headShake(w, 1.2, 3.3);
    later(2.6, () => w.express('stunlaugh', 1.5));
    later(4.1, () => w.express('grin', 1.2));
  };
  if (ev.other && BAND[ev.other]) {
    // 둘이 먼저 마주 보며 "방금 들었어?"
    const o = BAND[ev.other];
    m.lookAtMember = {
      who: ev.other,
      until: NOW.t + 0.75
    };
    o.lookAtMember = {
      who: ev.who,
      until: NOW.t + 0.75
    };
    m.express('disbelief', 0.8);
    o.express('disbelief', 0.8);
    later(0.75, () => {
      go(m);
      later(0.2, () => go(o, 0.9));
    });
  } else go(m);
}

// ---------- 매 프레임 ----------
function makeBandCrazy() {
  if (!UI.playing || (GAME.phase !== 'play' && GAME.phase !== 'pre') || FIGHT.on || METEOR.on) return;
  BAND_CRAZY.until = NOW.t + 9;
  for (const m of BAND.members) {
    m.crazyNext = 0;
    m.express(pick(['grin', 'stunlaugh', 'wow']), 1.5);
  }
}

function directorUpdate(dt, t, now, beat) {
  for (let i = _later.length - 1; i >= 0; i--)
    if (_later[i].t <= t) {
      const f = _later[i].fn;
      _later.splice(i, 1);
      f();
    }
  for (const ev of REACT.events) {
    if (ev._band) continue;
    ev._band = true;
    if (ev.kind === 'awe') bandAwe(ev);
    else if (ev.kind === 'gesture') bandGesture(ev);
    else if (ev.kind === 'small') {
      const m = ev.g === 'pedal' ? BAND.bs : pick(BAND.members);
      m.express('smile', 1.2);
    }
  }
  DIR.countOff = Math.max(0, DIR.countOff - dt);
  if (DIR.tbState === 'play' && now > DIR.tbLastNote + curSpb() * 2.5) DIR.tbState = 'rest';
  const me = SC.camera.position;
  const H = REACT.heat / 100,
    solo = REACT.meSolo;
  for (const k of ['tb', 'pn', 'bs', 'dr']) {
    const m = BAND[k];
    // 시선
    let look = null,
      turnW = 0;
    if (t < BAND_CRAZY.until) {
      if (!m.crazyNext || t >= m.crazyNext) {
        m.crazyLook = V3(rand(-7, 7), rand(0.8, 3.2), rand(-13, -2));
        m.crazyNext = t + rand(0.22, 0.7);
        if (!m.exUntil || Math.random() < 0.45) m.express(pick(['grin', 'stunlaugh', 'wow', 'jawdrop']), rand(0.45, 1.1));
      }
      look = m.crazyLook;
    } else if (m.stare && t < m.stare.until) {
      look = me;
      turnW = m.stare.turn;
    } else {
      m.stare = null;
      if (m.glance && t < m.glance) {
        look = me;
        turnW = 0.3;
      } else if (m.lookAtMember && t < m.lookAtMember.until) look = BAND[m.lookAtMember.who].headWorld(_d1).clone();
      else if (solo && t > (m.nextGlance || 0)) {
        m.nextGlance = t + rand(2.5, 6) * (1.25 - H * 0.75);
        m.glance = t + rand(0.8, 1.5);
        // 달아오를수록 힐끗 볼 때도 기가 막힌 얼굴
        if (H > 0.45 && !m.exUntil && Math.random() < 0.3 + H * 0.5) {
          const face = pick(H > 0.75 ? ['jawdrop', 'disbelief', 'gasp', 'stunlaugh'] : ['wow', 'disbelief']);
          m.express(face, m.glance - t + 0.4);
          if (face === 'disbelief' || face === 'jawdrop') headShake(m, 0.3, m.glance - t + 0.3);
        }
      }
    }
    m.c.disbelief = t >= (m.shakeFrom || 0) && t < (m.shakeUntil || 0) ? 1 : 0;
    if (!look) look = defaultLook(k, t);
    m.c.look.copy(look);
    // 몸 돌리기: 나를 볼 때 (서 있는 사람은 발까지)
    const toMe = yawToward(m.root.position, me);
    let dYaw = toMe - m.baseYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const wantTurn = look === me ? turnW : 0;
    m.turn = damp(m.turn, wantTurn, wantTurn > m.turn ? 3.2 : 2.2, dt);
    if (k === 'tb') {
      m.root.rotation.y = m.baseYaw + dYaw * 0.82 * smooth01(m.turn);
      m.c.twist = 0;
    } else if (k === 'bs') {
      m.root.rotation.y = m.baseYaw + dYaw * 0.25 * smooth01(m.turn);
      m.c.twist = clamp(dYaw * 0.55, -1.2, 1.2) * smooth01(m.turn);
    } else {
      m.c.twist = clamp(dYaw * 0.5, -1.15, 1.15) * smooth01(m.turn);
    }
    if (t < BAND_CRAZY.until) {
      m.c.twist += Math.sin(t * 9 + m.c.phase) * 0.32;
      m.c.headTilt = Math.sin(t * 11 + m.c.phase) * 0.22;
    }
    m.c.groove = 0.45 + (solo ? H * 0.4 : 0.1);
    m.c.nod = 0.35 + (solo ? H * 0.45 : 0);
    if (!m.exUntil) m.setBase(k === 'tb' && DIR.tbState === 'play' ? 'blow' : (solo && H > 0.55 ? 'grin' : (k === 'pn' || k === 'dr') ? 'focus' : 'calm'));
  }
  BAND.tb.c.nod = DIR.tbState === 'play' ? 0.15 : BAND.tb.c.nod;
  if (BAND.tb.cueNod && t < BAND.tb.cueNod) BAND.tb.c.nod = 1.3;
  updateTrombone(dt, t);
  updateBassist(dt, t);
  updatePianist(dt, t);
  updateDrummer(dt, now);
  for (const m of BAND.members) m.update(dt, t, beat);
  // 악기 위치는 사람 뼈가 움직인 뒤에
  placeTromboneAfter();
  placeSticksAfter();
}

function defaultLook(k, t) {
  const B = BAND,
    aud = _d2.set(0, 1.4, -8);
  if (k === 'tb') return DIR.tbState === 'play' ? aud.set(Math.sin(t * 0.3) * 2, 1.6, -9) : (REACT.floor && REACT.floor !== 'me' && B[REACT.floor] && REACT.floor !== 'tb' ? B[REACT.floor].headWorld(_d1).clone() : aud.set(-1 + Math.sin(t * 0.2) * 3, 1.5, -8));
  if (k === 'pn') {
    const keys = wpos(findA(B.piano, 'keysFront') || B.piano, _d1).clone();
    const s = Math.sin(t * 0.3);
    return s > 0.55 ? B.dr.headWorld(_d3).clone() : (s < -0.8 ? SC.camera.position.clone() : keys);
  }
  if (k === 'bs') return Math.sin(t * 0.23 + 1) > 0 ? B.dr.headWorld(_d1).clone() : (Math.sin(t * 0.17) > 0 ? B.pn.headWorld(_d3).clone() : aud.set(0.5, 1.4, -7));
  if (k === 'dr') return Math.sin(t * 0.2) > 0.2 ? B.bs.headWorld(_d1).clone() : B.tb.headWorld(_d3).clone();
  return aud;
}

function bandGesture(ev) {
  const g = ev.g;
  if (g === 'run') {
    BAND.pn.glance = NOW.t + 1.3;
    BAND.pn.express(pick(['disbelief', 'gasp']), 1.3);
  } else if (g === 'riff') BAND.dr.express('grin', 2);
  else if (g === 'space') {
    BAND.bs.express('smile', 1.2);
    BAND.bs.c.nod = 1.2;
  } else if (g === 'pedal') {
    BAND.bs.glance = NOW.t + 1.8;
    BAND.bs.express('stunlaugh', 1.8);
  } else if (g === 'high') {
    const t = nextSlot(meNow() + 0.03);
    drum('crash', t, MUS.brushes ? 0.35 : 0.75, 'R');
    drum('kick', t, 0.5, 'RF');
    BAND.tb.glance = NOW.t + 1.6;
    BAND.tb.express('jawdrop', 1.6);
  } else if (g === 'shake' || g === 'gliss') {
    const t = nextSlot(meNow() + 0.03);
    drum(MUS.brushes ? 'btap' : 'ridebell', t, 0.8, 'R');
    BAND.tb.express('stunlaugh', 1.3);
  }
}

// ---------- 트롬본 ----------
function tbMouthFrame(tb) {
  const hb = tb.bones[BONE.head];
  hb.updateWorldMatrix(true, false);
  const q = hb.getWorldQuaternion(new THREE.Quaternion());
  const mouth = tb.mouthP, p = V3(0, mouth.y, mouth.z + 0.02).applyMatrix4(hb.matrixWorld);
  return { p, q };
}

function updateTrombone(dt, t) {
  const tb = BAND.tb,
    horn = tb.horn;
  DIR.tbPlay = damp(DIR.tbPlay, DIR.tbState === 'play' ? 1 : 0, 6, dt);
  DIR.slide = damp(DIR.slide, DIR.slideT, 16, dt);
  if (horn.userData.slide) horn.userData.slide.position.z = -DIR.slide * 0.6 * smooth01(DIR.tbPlay);
  // 손 목표는 지난 프레임 악기 위치 기준 (악기는 사람 뼈를 따라 마지막에 놓음)
  const gl = findA(horn, 'gripL'),
    gr = findA(horn, 'gripR');
  if (gl && gr) {
    tb.reach('L', wpos(gl, _d1), tb.local(0.6, 1.0, -0.4), null, 'grip');
    if (DIR.tbPlay > 0.3 || !(tb.presenting && t < tb.presenting) && !(tb.headTap && t < tb.headTap)) tb.reach('R', wpos(gr, _d2), tb.local(-0.7, 0.9, -0.3), null, 'grip');
  }
  if (tbWorshipPose(tb, dt, t)) return;
  if (finBandPose('tb', tb, t)) return;
  if (ITL.cur && ITL.cur.kind === 'intro') itlTrombone(tb, dt, t);
  else if (tb.slapUntil && t < tb.slapUntil && DIR.tbPlay < 0.3) tb.reach('R', facePoint(tb, -tb.R * 0.3, tb.R * 0.62, tb.R * 0.72), null, null, 'flat');
  else if (DIR.tbPlay < 0.3) {
    if (tb.presenting && t < tb.presenting) {
      const F = frameOf(tb);
      const dir = SC.camera.position.clone().sub(F.c).normalize();
      tb.reach('R', F.c.clone().addScaledVector(dir, 0.5).addScaledVector(UPY, 0.08), null, null, 'flat');
    } else if (tb.headTap && t < tb.headTap) {
      const hw = tb.headWorld(_d3);
      tb.reach('R', hw.clone().add(V3(0, tb.R * 1.25 + Math.abs(Math.sin(t * 9)) * 0.04, 0)), null, null, 'flat');
    }
  }
}

function placeTromboneAfter() {
  const tb = BAND.tb,
    horn = tb.horn,
    k = smooth01(DIR.tbPlay);
  const f = tbMouthFrame(tb);
  // 연주 자세: 마우스피스가 입에, 슬라이드는 앞쪽 살짝 아래
  // 악기 좌표: 마우스피스 +z(입 쪽), 슬라이드 -z → 머리 앞쪽(+z)으로 돌려 놓음
  const playQ = f.q.clone().multiply(_dq.setFromEuler(new THREE.Euler(0.22, Math.PI, 0)));
  const playP = f.p;
  // 쉬는 자세: 왼손에 들고 슬라이드를 아래로
  tb.root.updateMatrixWorld(true);
  const restQ = tb.root.getWorldQuaternion(new THREE.Quaternion()).multiply(_dq2.setFromEuler(new THREE.Euler(1.05, Math.PI + 0.25, 0)));
  const restP = tb.local(0.2, 1.32, 0.22);
  horn.position.lerpVectors(restP, playP, k);
  horn.quaternion.slerpQuaternions(restQ, playQ, k);
  // 멤버 소개 중: 트롬본을 바닥에 세워 둠
  const fk = smooth01(tb.floorK || 0);
  if (fk > 0.001) {
    const fq = tb.root.getWorldQuaternion(new THREE.Quaternion()).multiply(_dq2.setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.12, 0, 0.1)));
    horn.position.lerp(tb.local(0.42, 0.62, 0.18), fk);
    horn.quaternion.slerp(fq, fk);
  }
  horn.updateMatrixWorld(true);
}
// ---------- 베이스 ----------
// 연주자 기준 악기 자리. 머리가 크고 아프로가 넓어서 넥과 줄감개는 왼쪽 어깨 바깥 앞으로 지나가게 세움 (전에는 넥 끝이 머리 한가운데를 뚫고 지나갔음)
//   pos: 엔드핀 자리 (x 왼쪽, z 앞) · rot: 뒤로 기울기 / 앞판이 보는 방향 / 옆 기울기 · twist, lean: 몸을 악기 쪽으로 틀고 숙이는 정도 · pluckUp: 뜯는 자리(지판 끝)
const BASS_POSE = {
  pos: [0.35, 0, 0.42],
  rot: [-0.2, -0.42, 0],
  twist: 0.7,
  lean: 0.16,
  pluckUp: 0.1
};
// 넥 위쪽의 점들 [x, y, z, 머리에서 떨어져야 할 거리]: 너트, 줄감개 두 줄(옆으로 10cm쯤 나옴), 소용돌이
const BASS_GUARD = [
  [0, 1.62, 0.19, 0.08],
  [0, 1.685, 0.134, 0.15],
  [0, 1.76, 0.11, 0.15],
  [0, 1.835, 0.065, 0.11]
];
const _bsA = new THREE.Vector3(),
  _bsB = new THREE.Vector3(),
  _bsC = new THREE.Vector3(),
  _bsD = new THREE.Vector3(),
  _bsE = new THREE.Euler(),
  _bsM = new THREE.Matrix4();
// 고개를 돌리거나 끄덕여 머리(아프로)가 넥 쪽으로 오면, 모자란 만큼 악기 위쪽을 바깥으로 기울여 비켜 줌
function bassAvoidHead(bs, b, dt, fast) {
  const hb = bs.bones[BONE.head],
    R = bs.R,
    hc = bs.headC;
  hb.updateWorldMatrix(true, false);
  b.updateMatrixWorld(true);
  const inv = _bsM.copy(hb.matrixWorld).invert();
  // 머리 뼈 기준 덩어리 둘: 아프로(buildHair의 afro와 같은 자리·크기, 울퉁불퉁한 만큼 여유), 얼굴·귀
  const vols = [
    [0, hc.y + R * 0.75, hc.z - R * 0.36, R * 1.52, R * 1.2, R * 1.35],
    [0, hc.y, hc.z, R * 1.12, R * 1.06, R * 1.02]
  ];
  let need = 0;
  _bsD.set(0, 0, 0);
  for (const g of BASS_GUARD) {
    const pw = _bsA.set(g[0], g[1], g[2]).applyMatrix4(b.matrixWorld),
      pl = _bsB.copy(pw).applyMatrix4(inv);
    for (const v of vols) {
      const dx = pl.x - v[0],
        dy = pl.y - v[1],
        dz = pl.z - v[2],
        len = Math.hypot(dx, dy, dz) || 1e-6;
      const q = Math.hypot(dx / v[3], dy / v[4], dz / v[5]) || 1e-6; // 1이면 겉면
      const lack = g[3] - (q - 1) * len / q; // 겉면까지 거리가 모자란 만큼
      if (lack > need) {
        need = lack;
        _bsD.set(v[0], v[1], v[2]).applyMatrix4(hb.matrixWorld).sub(pw).negate().setY(0);
      }
    }
  }
  if (!DIR.bassPush) DIR.bassPush = new THREE.Vector3();
  const want = need > 0 && _bsD.lengthSq() > 1e-8 ? _bsD.normalize().multiplyScalar(Math.min(need, 0.24)) : _bsD.set(0, 0, 0);
  DIR.bassPush.lerp(want, fast ? 1 : 1 - Math.exp(-dt * (want.lengthSq() > DIR.bassPush.lengthSq() ? 14 : 4)));
  const push = DIR.bassPush.length();
  if (push > 0.0015) {
    // 엔드핀을 축으로 위쪽이 push만큼 밀려나게
    const axis = _bsC.crossVectors(UPY, _bsA.copy(DIR.bassPush).normalize());
    b.quaternion.premultiply(_dq2.setFromAxisAngle(axis, push / 1.72));
  }
}

function updateBassist(dt, t) {
  const bs = BAND.bs,
    b = bs.inst,
    P = BASS_POSE;
  // 몸은 악기 쪽(왼쪽)으로 틀어 서서 오른손이 줄에 닿게. 나를 돌아볼 때는 풀림
  bs.c.twist += P.twist * (1 - smooth01(bs.turn));
  bs.c.lean = P.lean;
  bs.root.updateMatrixWorld(true);
  b.position.copy(bs.local(P.pos[0], P.pos[1], P.pos[2]));
  b.quaternion.copy(bs.root.getWorldQuaternion(_dq)).multiply(_dq2.setFromEuler(_bsE.set(P.rot[0], P.rot[1], P.rot[2], 'YXZ')));
  // 박수 받을 때 베이스를 한 바퀴 휙 (넥이 축에서 앞으로 나와 있어 돌 때 머리 쪽으로 휘둘리므로, 비키기는 돌린 뒤 자세로 계산)
  let spinning = false;
  if (DIR.bassSpin) {
    const k = (NOW.t - DIR.bassSpin.t0) / DIR.bassSpin.dur;
    if (k >= 1) DIR.bassSpin = null;
    else if (k > 0) {
      spinning = true;
      b.quaternion.multiply(_dq2.setFromAxisAngle(UPY, smooth01(k) * Math.PI * 2));
    }
  }
  bassAvoidHead(bs, b, dt, spinning);
  b.updateMatrixWorld(true);
  DIR.pluck = Math.max(0, DIR.pluck - dt * 9);
  const top = findA(b, 'neckTop'),
    low = findA(b, 'neckLow'),
    pl = findA(b, 'pluck');
  if (top && low && pl) {
    const k = clamp((DIR.bassM - 28) / 26, 0, 1);
    const lh = wpos(top, _d1).clone().lerp(wpos(low, _d2), k);
    const towardMe = bs.local(0, 1.2, -0.3).sub(lh).normalize().multiplyScalar(0.05);
    bs.reach('L', lh.add(towardMe), bs.local(0.9, 1.1, -0.2), null, 'grip');
    // 오른손: 지판 끝 줄 위에 손끝이 닿게 (손목은 팔 방향으로 손 길이만큼 뒤). 뜯는 순간 줄을 오른쪽으로 당겼다 놓음
    const upB = _bsA.set(0, 1, 0).transformDirection(b.matrixWorld),
      right = _bsB.copy(bs.local(0, 0, 0)).sub(bs.local(1, 0, 0));
    const pt = wpos(pl, _d3).clone().addScaledVector(upB, P.pluckUp);
    const sh = bs.bones[BONE.upperR].getWorldPosition(_bsC),
      arm = _bsD.copy(pt).sub(sh).normalize();
    const rp = pt.addScaledVector(arm, -0.085).addScaledVector(right, DIR.pluck * 0.035).add(V3(0, DIR.pluck * 0.02, 0));
    bs.reach('R', rp, bs.local(-0.9, 0.7, -0.4), null, DIR.pluck > 0.3 ? 'point' : 'relax');
    if (spinning) bs.reach('R', bs.local(-0.34, 1.78, 0.2), null, null, 'spread');
  }
  finBandPose('bs', bs, t);
  if (b.userData.strings)
    for (const s of b.userData.strings) s.scale.x = 1 + DIR.pluck * 0.6 * Math.sin(t * 90);
}
// ---------- 피아노 ----------
function updatePianist(dt, t) {
  const pn = BAND.pn,
    P = BAND.piano,
    kx = P.userData.keyX,
    ky = P.userData.keyTopY || 0.72;
  pn.c.stand = pn.standUntil && t < pn.standUntil ? 1 : 0;
  if (finBandPose('pn', pn, t)) return;
  if (pn.standUntil && t < pn.standUntil) {
    const a = pn.standUntil - t;
    if (a > 4.5) cheekHands(pn);
    else headHands(pn);
    if (!pn.exUntil) pn.express(a > 4.5 ? 'jawdrop' : 'stunlaugh', 1);
    pn.c.disbelief = a < 4.5 && a > 2 ? 1 : 0;
    return;
  }
  if (pn.handsOffUntil && t < pn.handsOffUntil) {
    pn.reach('L', pn.local(0.12, pn.seatY + 0.2, 0.3), null, null, 'relax');
    pn.reach('R', pn.local(-0.12, pn.seatY + 0.2, 0.3), null, null, 'relax');
    return;
  }
  const kf = findA(P, 'keysFront');
  for (const s of PERSON_SIDES) {
    DIR.pnPress[s] = Math.max(0, DIR.pnPress[s] - dt * 7);
    const m = DIR.pnTarget[s] != null ? DIR.pnTarget[s] : (s === 'L' ? 52 : 72);
    const x = kx ? kx(m) : (s === 'L' ? -0.2 : 0.2);
    DIR.pnX[s] = damp(DIR.pnX[s], x, 12, dt);
    const kz = kf ? kf.position.z : 0;
    const p = V3(DIR.pnX[s], ky + 0.035 - DIR.pnPress[s] * 0.022 + Math.sin(t * 3 + (s === 'L' ? 0 : 2)) * 0.003, kz - 0.09).applyMatrix4(P.matrixWorld);
    const fwd = V3(0, 0, -1).transformDirection(P.matrixWorld), down = V3(0, -1, 0);
    pn.reach(s, p, pn.local(s === 'L' ? 0.8 : -0.8, 0.6, -0.3), handQuat(fwd.clone().addScaledVector(down, 0.6), down, s), 'relax');
  }
}
// ---------- 드럼 ----------
function updateDrummer(dt, now) {
  const dr = BAND.dr,
    kit = BAND.kit,
    P = kit.userData.pieces || {};
  finBandPose('dr', dr, NOW.t);
  for (const s of PERSON_SIDES) {
    const Hh = DIR.hits[s];
    while (Hh.length > 1 && Hh[1].t <= now) Hh.shift();
    const cur = Hh[0],
      nx = Hh.find(h => h.t > now);
    let tgtObj = s === 'R' ? (DIR.brushes ? P.snare : P.ride) : P.snare,
      lift = 0.1;
    if (nx) {
      tgtObj = pieceFor(nx.piece) || tgtObj;
      const to = nx.t - now,
        last = cur && cur.t <= now ? now - cur.t : 9;
      lift = Math.min(clamp(last / 0.09, 0, 1), clamp(to / 0.11, 0, 1)) * (0.06 + nx.v * 0.09);
    }
    const tgt = tgtObj ? wpos(tgtObj, _d1).clone() : dr.local(s === 'L' ? 0.2 : -0.2, 1.0, 0.45);
    if (DIR.brushes && s === 'L' && P.snare) {
      const a = beatAt(now) * Math.PI,
        sn = wpos(P.snare, _d2);
      tgt.copy(sn).add(V3(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.05));
      lift = 0;
    }
    // 손은 북 위 뒤쪽으로 (채가 북을 때리게)
    const back = dr.local(0, tgt.y - dr.root.position.y, 0).sub(tgt).setY(0).normalize();
    const hand = tgt.clone().addScaledVector(back, 0.3).add(V3(0, 0.1 + lift, 0));
    if (DIR.countOff > 0) hand.copy(dr.local(s === 'L' ? 0.1 : -0.1, 1.45 + (Math.sin(now * 22) > 0 ? 0.03 : 0), 0.4));
    if (s === 'R' && DIR.stickToss) hand.copy(dr.local(-0.26, 1.42, 0.36)); // 던진 스틱 받으려고 손을 들고 있음
    if (FIN.band) hand.copy(dr.local(s === 'L' ? 0.24 : -0.24, 1.6 + Math.sin(NOW.t * 13 + (s === 'L' ? 0 : 1.6)) * 0.07, 0.32)); // 공연 끝: 스틱을 머리 위로 흔듦
    if (!DIR['dh' + s]) DIR['dh' + s] = hand.clone();
    DIR['dh' + s].lerp(hand, 1 - Math.exp(-dt * 20));
    DIR['dt' + s] = FIN.band ? DIR['dh' + s].clone().add(dr.local(s === 'L' ? -0.12 : 0.12, 0.5, 0.05).sub(dr.local(0, 0, 0))) : tgt;
    dr.reach(s, DIR['dh' + s], dr.local(s === 'L' ? 0.9 : -0.9, 0.7, -0.5), null, 'fist');
  }
  // 필살기: 왼손으로 폰을 꺼내 나를 찍음 (오른손은 라이드 계속). 몸을 내 쪽으로 돌리고, 폰은 얼굴 옆(왼손 쪽)에 세워 들어 얼굴이 가리지 않게
  const F = DIR.drPhone,
    film = !!F && NOW.t < F.until;
  if (!DIR.drPhoneProp) DIR.drPhoneProp = makeCrowdProp({
    props: {},
    p: dr
  }, 'phone');
  dr.sticks.L.visible = !film && !DIR.brushes;
  dr.sticks.bL.visible = !film && DIR.brushes;
  if (film) {
    const age = NOW.t - F.t0,
      D = F.until - F.t0;
    const k = smoothstep(0.05, 0.6, age) * (1 - smoothstep(D - 0.65, D - 0.1, age)); // 꺼내 들기 · 끝나면 내려 넣기
    dr.stare = {
      until: NOW.t + 0.25,
      turn: 0.75
    };
    if (!F.faced) {
      F.faced = true;
      dr.express('jawdrop', 1.5);
      later(1.5, () => dr.express('stunlaugh', 2.4));
      later(3.9, () => dr.express('grin', 5.6));
    }
    const hw = dr.headWorld(_d3),
      toMe = _dph1.copy(SC.camera.position).sub(hw).normalize();
    const side = _dph2.crossVectors(UPY, toMe).normalize(); // 내가 볼 때 오른쪽 = 그의 왼손 쪽
    // 폰 가운데: 무릎 위에서 → 얼굴 옆 앞
    const c = dr.local(0.16, dr.seatY + 0.2, 0.26).lerp(hw.clone().addScaledVector(toMe, 0.3).addScaledVector(side, DRPHONE.side).add(_dph3.set(0, DRPHONE.up, 0)), k);
    // 손목은 폰 아래. 손바닥이 폰 뒷면(나를 보는 면)을 받치고 손가락은 위로
    const wrist = c.clone().addScaledVector(UPY, -DRPHONE.grip).addScaledVector(toMe, 0.024).addScaledVector(side, 0.012);
    dr.reach('L', wrist, wrist.clone().addScaledVector(UPY, -0.6).addScaledVector(side, 0.3), handQuat(UPY, _dph3.copy(toMe).negate(), 'L'), 'relax');
    F.on = true;
  } else if (DIR.drPhoneProp) {
    DIR.drPhoneProp.visible = false;
    if (F) F.on = false;
  }
  // 심벌 흔들림
  for (const c of [P.ride, P.crash, P.hihat]) {
    if (!c) continue;
    const u = c.userData;
    u.wob = u.wob || 0;
    u.wv = u.wv || 0;
    u.wv += (-u.wob * 90 - u.wv * 3.5) * dt;
    u.wob += u.wv * dt;
    c.rotation.x = u.wob * 0.16;
    c.rotation.z = u.wob * 0.1;
  }
  DIR.hatClose = Math.max(0, DIR.hatClose - dt * 10);
  if (P.hihatTop) {
    if (P.hihatTop.userData.y0 == null) P.hihatTop.userData.y0 = P.hihatTop.position.y;
    P.hihatTop.position.y = P.hihatTop.userData.y0 - DIR.hatClose * 0.024;
  }
}

function pieceFor(name) {
  const P = BAND.kit.userData.pieces || {};
  return name === 'ride' || name === 'ridebell' ? P.ride : name === 'crash' ? P.crash : name === 'tomHi' ? P.tom1 : name === 'tomLo' ? P.tom2 : name === 'hat' || name === 'hatOpen' ? P.hihat : P.snare;
}
const DRPHONE = {
  side: 0.23,
  up: -0.02,
  grip: 0.15
}; // 얼굴 옆으로 · 위아래 · 손목에서 폰 가운데까지
const _dph1 = new THREE.Vector3(),
  _dph2 = new THREE.Vector3(),
  _dph3 = new THREE.Vector3();

function placeDrummerPhone() {
  const F = DIR.drPhone,
    ph = DIR.drPhoneProp;
  if (!ph || !F || !F.on) return;
  const hb = BAND.dr.bones[BONE.handL];
  hb.updateWorldMatrix(true, false);
  const hp = _dph1.setFromMatrixPosition(hb.matrixWorld),
    toMe = _dph2.copy(SC.camera.position).sub(hp).normalize(),
    side = _dph3.crossVectors(UPY, toMe).normalize();
  ph.visible = true;
  ph.position.copy(hp).addScaledVector(UPY, DRPHONE.grip).addScaledVector(toMe, -0.024).addScaledVector(side, -0.012);
  ph.lookAt(SC.camera.position); // 렌즈 있는 뒷면이 나를 봄
}

function placeSticksAfter() {
  const dr = BAND.dr;
  placeDrummerPhone();
  for (const s of PERSON_SIDES) {
    const hb = dr.bones[BONE['hand' + s]];
    hb.updateWorldMatrix(true, false);
    const hp = V3(0, -0.06, 0.012).applyMatrix4(hb.matrixWorld);
    const tgt = DIR['dt' + s] || dr.local(0, 1.0, 0.6);
    const dir = tgt.clone().sub(hp).normalize();
    for (const k of [s, 'b' + s]) {
      const st = dr.sticks[k];
      st.position.copy(hp).addScaledVector(dir, -0.05);
      st.quaternion.setFromUnitVectors(UPY, dir);
    }
    // 스틱 던져 받기: 빙글빙글 돌며 올라갔다 손으로 떨어짐
    if (s === 'R' && DIR.stickToss) {
      const k = (NOW.t - DIR.stickToss.t0) / DIR.stickToss.dur;
      if (k >= 1) DIR.stickToss = null;
      else if (k > 0) {
        const st = dr.sticks.R;
        st.position.copy(hp).add(_d1.set(0, 4 * k * (1 - k) * 1.05, 0));
        st.quaternion.setFromAxisAngle(_d2.set(1, 0, 0), k * Math.PI * 6);
      }
    }
  }
}

// ===== 72_crowd.js =====
// ===================== 관객: 홀짝임 → 그루브 → 일어서기 → 광기 =====================
const CROWD = {
  list: [],
  bartender: null,
  me: new THREE.Vector3(),
  stageC: new THREE.Vector3(0, 1.9, -2.4),
  lastWhoop: 0,
  lastWhistle: 0,
  roar: 0,
  clapBed: 0
};
const FIGHT = { on: false, t0: 0, fall: 0, booUntil: 0 };
const BAND_CRAZY = { until: 0 };
const METEOR = { on: false, impacted: false, t0: 0, impactT: 0, bodyPhysics: [], debris: [], basePos: new THREE.Vector3(), baseQuat: new THREE.Quaternion(), start: new THREE.Vector3(), target: new THREE.Vector3(), flight: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), shake: 0, group: null, light: null };
const _cv1 = new THREE.Vector3(),
  _cv2 = new THREE.Vector3(),
  _cv3 = new THREE.Vector3();

function setupCrowd(scene) {
  const spots = [];
  const V = (typeof VENUE !== 'undefined' && VENUE) ? VENUE : null;
  if (V) {
    for (const s of V.standSpots) spots.push({
      kind: 'front',
      pos: s.pos.clone(),
      yaw: s.yaw,
      seatY: s.seatY || 0.47
    });
    for (const s of V.seats) spots.push({
      kind: 'seat',
      pos: s.pos.clone(),
      yaw: s.yaw,
      seatY: s.seatY,
      table: s.table
    });
    for (const s of (V.barSpots || [])) spots.push({
      kind: 'bar',
      pos: s.pos.clone(),
      yaw: s.yaw,
      seatY: s.stoolY
    });
  } else {
    for (let i = 0; i < 14; i++) spots.push({
      kind: 'front',
      seatY: 0.47,
      pos: V3(-4.5 + (i % 7) * 1.5 + rand(-0.3, 0.3), 0, -4.8 - Math.floor(i / 7) * 1.1),
      yaw: 0
    });
    for (let i = 0; i < 16; i++) spots.push({
      kind: 'seat',
      pos: V3(-5 + (i % 8) * 1.4, 0, -8 - Math.floor(i / 8) * 2),
      yaw: 0,
      seatY: 0.46
    });
  }
  let seed = 101;
  for (const sp of spots) {
    const look = randomLook(seed++);
    look.movableGlasses = !!look.glasses;
    const far = sp.pos.z < -9.5;
    const p = new Person(look, {
      seated: true,
      seatY: sp.seatY || 0.46,
      lod: far ? 2 : 1,
      feetFwd: sp.kind === 'bar' ? 0.3 : 0.42
    });
    p.root.position.copy(sp.pos);
    p.root.rotation.y = sp.yaw;
    p.mesh.castShadow = false;
    scene.add(p.root);
    const r = seeded(seed * 31);
    const m = {
      p,
      kind: sp.kind,
      spot: sp,
      watch: r(),
      wild: r(),
      act: null,
      nextAct: rand(0, 2),
      friend: null,
      far,
      standWish: 0,
      phase0: r() * 2
    };
    { // 일어섰을 때 설 자리 (자리 기준 이동량, 월드)
      const f = V3(Math.sin(sp.yaw), 0, Math.cos(sp.yaw)),
        left = V3(f.z, 0, -f.x);
      if (sp.table) {
        const side = sp.table.clone().sub(sp.pos).setY(0).dot(left) > 0 ? -1 : 1;
        m.standOff = f.clone().multiplyScalar(0.2).addScaledVector(left, 0.26 * side);
      } else m.standOff = f.clone().multiplyScalar(sp.kind === 'bar' ? 0.3 : 0.34);
    }
    p.c.phase = m.phase0;
    p.c.groove = 0.035;
    p.c.nod = 0.04;
    p.c.sway = 0.025;
    const roles = ['mouthFreeze', 'phone', 'stankSlap', 'laughFold', 'filmPro', 'mouthFreeze', 'phone', 'riseStun'];
    m.signature = sp.kind === 'front' ? roles[CROWD.list.length % roles.length] : ['drinkFreeze', 'friendTap', 'convert', 'friendLean'][CROWD.list.length % 4];
    if (look.glasses && CROWD.list.length % 2 === 0) m.signature = 'glassesDouble';
    m.nextScene = 0;
    m.sceneCount = 0;
    m.pending = null;
    m.props = {};
    m.reserved = m.signature === 'convert';
    m.converted = false;
    m.standDelay = r() * 1.65;
    m.standThreshold = 0.65 + r() * 0.2;
    m.animDt = r() / 30;
    p.update(0, NOW.t, 0);
    CROWD.list.push(m);
    if (look.movableGlasses) makeCrowdProp(m, 'glasses');
  }
  // 옆 사람이 친구
  for (const m of CROWD.list) {
    let best = null,
      bd = 2.2;
    for (const o of CROWD.list) {
      if (o === m) continue;
      const d = o.p.root.position.distanceTo(m.p.root.position);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    m.friend = best;
  }
  if (V && V.bartender) {
    const bt = new Person({
      name: 'bt',
      hair: 'pomp',
      hairColor: '#1e1a1e',
      mustache: true,
      skin: '#d79a6c',
      topStyle: 'jacket',
      jacket: '#2f5a42',
      shirt: '#fff4de',
      tie: '#ee4a2c',
      pants: '#22244a',
      h: 1.0
    }, { lod: 1 });
    bt.root.position.copy(V.bartender.pos);
    bt.root.rotation.y = V.bartender.yaw;
    scene.add(bt.root);
    CROWD.bartender = {
      p: bt,
      kind: 'bar',
      shaking: true,
      props: {},
      act: null,
      pending: null,
      nextScene: 0,
      sceneCount: 0
    };
    makeCrowdProp(CROWD.bartender, 'cup');
    makeCrowdProp(CROWD.bartender, 'cloth');
  }
}
// 몸 기준 틀 (가슴 위치, 앞·오른쪽·위)
function frameOf(p) {
  const c = p.chestWorld(_cv1).clone();
  const yaw = p.root.rotation.y + p.s.twist;
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const r = new THREE.Vector3(-f.z, 0, f.x); // 사람 기준 오른쪽 (+z를 볼 때 -x)
  return { c, f, r, up: UPY };
}
const at = (F, fw, rt, up) => F.c.clone().addScaledVector(F.f, fw).addScaledVector(F.r, rt).addScaledVector(UPY, up);

// ---------- 동작 ----------
function crowdAct(m, k, dur, extra = {}) {
  // A musical accent must not cut a person's little scene in half.
  if (m.act && m.act.story && NOW.t < m.act.until) return;
  m.act = {
    k,
    t0: NOW.t,
    until: NOW.t + dur,
    ...extra
  };
}
// 턱을 괴고 감상: 주먹을 턱 밑에 받치고(고개가 돌아간 쪽 손), 팔꿈치는 가슴 앞으로 내림. 반대 팔은 배 앞으로 가로질러 그 팔꿈치를 받침
function chinPose(p, a, F) {
  const R = p.R;
  if (!a.hand) a.hand = facePoint(p, 0, -R, R).sub(F.c).dot(F.r) < -0.03 ? 'L' : 'R'; // 동작 하나가 끝날 때까지 같은 손
  const side = a.hand,
    other = side === 'R' ? 'L' : 'R',
    sg = side === 'R' ? 1 : -1;
  p.reach(side, facePoint(p, -sg * R * 0.1, -R * 1.28, R * 0.68), at(F, 0.5, sg * 0.1, -0.5), null, 'fist');
  const el = p.bones[BONE['fore' + side]].getWorldPosition(_cv3);
  p.reach(other, el.clone().addScaledVector(F.r, -sg * 0.06).addScaledVector(UPY, -0.035), at(F, 0.1, -sg * 0.5, -0.3), null, 'flat');
}

function runCrowdAct(m, t, beat) {
  const p = m.p,
    a = m.act,
    F = frameOf(p);
  if (a.story) {
    runCrowdScene(m, t);
    return;
  }
  switch (a.k) {
    case 'beckon': {
      // 손바닥 위로, 손가락 까딱까딱 ("얼른 불어")
      const k = Math.sin((t - a.t0) * 15) > 0;
      p.reach('R', at(F, 0.42, 0.14, 0.12), null, palmQ(p, 'R', true), k ? 'grip' : 'flat');
      p.rest('L');
      break;
    }
    case 'lookDown': {
      // 바닥이 울려 발밑을 내려다봄
      const st = p.s.stand > 0.6;
      p.c.lean = 0.42;
      p.c.look.copy(p.local(0, 0, 0.9));
      p.reach('L', p.local(0.16, st ? 0.55 * p.h : p.seatY + 0.14, 0.28), null, null, 'flat');
      p.reach('R', p.local(-0.16, st ? 0.55 * p.h : p.seatY + 0.14, 0.28), null, null, 'flat');
      break;
    }
    case 'shimmy': {
      // 같이 어깨 털기
      p.c.side = Math.sin(t * 19) * 0.16;
      p.c.twist = Math.sin(t * 19 + 1) * 0.14;
      p.reach('L', at(F, 0.18, -0.28, -0.12), null, null, 'fist');
      p.reach('R', at(F, 0.18, 0.28, -0.12), null, null, 'fist');
      break;
    }
    case 'clap': {
      const ph = a.dbl ? beat : (a.onBeat ? (((beat + 1) % 2 + 2) % 2) / 2 * 2 : (t - a.t0) * (a.rate || 4.6));
      const sep = 0.035 + Math.max(0, Math.cos(ph * Math.PI * 2)) * 0.11;
      const up = a.high ? 0.55 : 0.08;
      p.reach('L', at(F, 0.3, -sep, up), null, null, 'flat');
      p.reach('R', at(F, 0.3, sep, up), null, null, 'flat');
      // 가까운 사람 박수 소리
      const n = Math.floor(ph);
      if (a.sound && n !== a.lastN && AE.decoded) {
        a.lastN = n;
        playBuf(pick(AE.syn.claps), AE.ctx.currentTime + 0.004, a.sound * rand(0.7, 1), AE.buses.crowd, {
          pan: clamp(p.root.position.x / 5, -0.9, 0.9)
        });
      }
      break;
    }
    case 'armsUp': {
      const w = Math.sin((t - a.t0) * 5 + m.phase0 * 3) * 0.12;
      p.reach('L', at(F, 0.12, -0.26 - w, 0.62), null, null, a.fist ? 'fist' : 'spread');
      p.reach('R', at(F, 0.12, 0.26 - w, 0.62), null, null, a.fist ? 'fist' : 'spread');
      break;
    }
    case 'pump': {
      const bp = ((beat % 1) + 1) % 1,
        up = 0.45 + Math.max(0, Math.cos(bp * Math.PI * 2)) * 0.22;
      p.reach(a.side || 'R', at(F, 0.2, (a.side === 'L' ? -0.2 : 0.2), up), null, null, 'fist');
      if (!a.both) p.rest(a.side === 'L' ? 'R' : 'L');
      else p.reach(a.side === 'L' ? 'R' : 'L', at(F, 0.2, (a.side === 'L' ? 0.2 : -0.2), up), null, null, 'fist');
      break;
    }
    case 'point': {
      const dir = CROWD.me.clone().sub(F.c).normalize();
      p.reach('R', F.c.clone().addScaledVector(dir, 0.58).addScaledVector(UPY, 0.12).addScaledVector(F.r, 0.12), null, null, 'point');
      p.rest('L');
      break;
    }
    case 'wave': {
      const w = Math.sin((t - a.t0) * 7) * 0.16;
      p.reach('R', at(F, 0.15, 0.25 + w, 0.6), null, null, 'flat');
      p.rest('L');
      break;
    }
    case 'headHands':
      headHands(p);
      break;
    case 'cheeks':
      cheekHands(p);
      break;
    case 'throw':
      actThrow(m, p, a, F, t);
      break;
    case 'popper':
      actPopper(m, p, a, F, t);
      break;
    case 'whistle': {
      // 두 손가락을 입에 물고 휘파람: 손은 (고개가 돌아가 있어도) 입을 따라가고 팔꿈치는 옆으로
      const R = p.R;
      p.reach('R', facePoint(p, -R * 0.35, -R * 0.7, R * 0.85), at(F, 0.1, 0.5, -0.05), null, 'pinch');
      p.rest('L');
      break;
    }
    case 'snap': {
      // 2·4박에 손가락 튕기기: 팔꿈치는 옆구리에 붙이고 손만 어깨 앞에서 까딱
      const ph = ((beat + 1) % 2 + 2) % 2,
        hit = Math.exp(-Math.pow((ph - 1) / 0.14, 2));
      p.reach('R', at(F, 0.2, 0.24, 0.08 + hit * 0.05), at(F, 0.05, 0.36, -0.5), null, hit > 0.5 ? 'point' : 'pinch');
      p.rest('L');
      break;
    }
    case 'sip': {
      // 잔을 들어 한 모금 (잔이 손에 보이고, 고개가 돌아가 있어도 입으로 감)
      const ph = clamp((t - a.t0) / (a.until - a.t0), 0, 1),
        up2 = smooth01(Math.sin(ph * Math.PI) * 1.3),
        R = p.R;
      p.reach('R', at(F, 0.3, 0.14, -0.14).lerp(facePoint(p, -R * 0.2, -R * 1.45, R * 1.05), up2), at(F, 0.15, 0.42, -0.45), palmQ(p, 'R'), 'grip');
      p.rest('L');
      makeCrowdProp(m, 'cup').visible = true;
      break;
    }
    case 'talk': {
      const ph = (t - a.t0) * 3;
      p.reach('R', at(F, 0.3, 0.18, 0.0 + Math.sin(ph) * 0.05), null, null, 'relax');
      p.rest('L');
      break;
    }
    case 'chin':
      chinPose(p, a, F);
      break;
    case 'conduct': {
      const bp = ((beat % 1) + 1) % 1;
      p.reach('R', at(F, 0.3, 0.22 + Math.sin(bp * Math.PI * 2) * 0.08, 0.2 + Math.cos(bp * Math.PI * 2) * 0.1), at(F, 0, 0.45, -0.4), null, 'pinch');
      p.rest('L');
      break;
    }
    case 'airhorn': {
      // 트럼펫 부는 시늉: 고개를 살짝 돌려 치켜들고, 주먹 둘을 입 앞에 앞뒤로 대고 밸브 누르듯 손가락을 까딱
      const R = p.R,
        sh = Math.sin(t * 8) * 0.012,
        k = Math.floor(t * 9 + m.phase0 * 7) % 3,
        sd = m.phase0 > 1 ? 1 : -1;
      p.c.look.copy(CROWD.me).addScaledVector(F.r, sd * 2.2).add(_cv3.set(0, 1.3, 0));
      p.reach('L', facePoint(p, R * 0.08, -R * 0.62 + sh, R * 1.25), at(F, 0.1, -0.5, -0.15), null, 'grip');
      p.reach('R', facePoint(p, -R * 0.1, -R * 0.5 + sh, R * 1.9), at(F, 0.1, 0.5, -0.15), null, ['grip', 'relax', 'pinch'][k]);
      break;
    }
    case 'slap': {
      const ph = (t - a.t0) * 6,
        d = Math.abs(Math.sin(ph * Math.PI));
      if (m.spot.table) p.reach('R', m.spot.table.clone().add(V3(0, 0.05 + d * 0.15, 0)).lerp(F.c, 0.25), null, null, 'flat');
      p.rest('L');
      break;
    }
    default:
      p.rest('L');
      p.rest('R');
  }
}
// Short, staggered audience scenes; their clocks stop with the game.
const CROWD_SCENES = {
  mouthFreeze: 6.8,
  phone: 8.4,
  filmPro: 8.8,
  friendTap: 5.8,
  friendLean: 6.2,
  stankSlap: 5.5,
  drinkFreeze: 7.4,
  riseStun: 6.5,
  convert: 8.1,
  glassesDouble: 7.8,
  laughFold: 6.1,
  buddy: 6.2,
};

function sceneFor(m, f) {
  if (f < 0.3) return null;
  if (f < 0.55) return /^(phone|filmPro)$/.test(m.signature) ? 'phone' : null;
  if (f < 0.72 && /^(convert|riseStun|friendLean|filmPro)$/.test(m.signature)) return 'stankSlap';
  if (m.reserved && !m.converted && f > 0.5) return 'convert';
  if (f > 0.72 && Math.random() < 0.45) {
    const h = hypeScene(m, f);
    if (h) return h;
  }
  if (m.sceneCount % 3 !== 2) return m.signature;
  return pick(m.kind === 'seat' ? ['mouthFreeze', 'drinkFreeze', 'riseStun', 'laughFold'] : ['mouthFreeze', 'stankSlap', 'laughFold', 'phone']);
}

function queueCrowdScene(m, k, delay = 0, extra = {}) {
  const t = NOW.t;
  if (!k || m.pending || (m.act && m.act.story) || t < m.nextScene) return false;
  const busy = CROWD.list.filter(o => o.pending || (o.act && o.act.story && o.act.k !== 'reserved')).length;
  if (busy >= 14) return false;
  if ((k === 'phone' || k === 'filmPro') && CROWD.list.filter(o => /^(phone|filmPro)$/.test(o.pending?.k || o.act?.k)).length >= 4) k = 'mouthFreeze';
  if (k === 'glassesDouble' && !m.p.look.movableGlasses) k = 'mouthFreeze';
  if (k === 'friendTap' || k === 'friendLean') {
    const friend = m.friend;
    if (!friend || friend.p.root.position.distanceTo(m.p.root.position) > 0.98 || friend.pending || (friend.act && friend.act.story)) k = 'mouthFreeze';
    else extra.friend = friend;
  }
  if (k === 'hugJump') extra.friend = m.friend;
  m.pending = {
    k,
    at: t + delay,
    dur: CROWD_SCENES[k] || 6,
    extra
  };
  return true;
}

function startCrowdScene(m, k, dur = CROWD_SCENES[k], extra = {}) {
  const t = NOW.t;
  if (k === 'shakeFriend' && !extra.friend) extra = {
    ...extra,
    friend: m.friend
  };
  const fBusy = f => f.override || f.pending || (f.act?.story && f.act.k !== 'freeze');
  if (extra.friend && fBusy(extra.friend)) {
    if (extra.force) {
      k = 'handsTop';
      extra = { force: true };
    } else {
      k = 'mouthFreeze';
      extra = {};
    }
    dur = CROWD_SCENES[k];
  }
  m.act = {
    k,
    t0: t,
    until: t + dur,
    story: true,
    seat: m.p.s.stand > 0.7 ? 1 : 0,
    ...extra
  };
  m.sceneCount++;
  m.nextScene = t + dur + rand(7, 15);
  if (extra.friend) {
    const f = extra.friend;
    f.act = {
      k: k === 'shakeFriend' ? 'shaken' : k === 'hugJump' ? 'hugged' : 'buddy',
      t0: t,
      until: t + dur,
      story: true,
      friend: m,
      source: k,
      seat: f.p.s.stand > 0.7 ? 1 : 0
    };
    f.nextScene = t + dur + rand(6, 12);
  }
  if (k === 'faint') startFaint(m);
}

function finishCrowdScene(m, t) {
  if (m.spot) resetBigPose(m);
  if (m.act?.k === 'convert') m.converted = true;
  m.act = null;
  m.nextAct = t + rand(0.8, 2.4);
  m.p.exUntil = 0;
  m.p.express('smile', 0.4);
  if (m.props)
    for (const [k, prop] of Object.entries(m.props))
      if (k !== 'glasses') prop.visible = false;
}

function resetCrowdScenes() {
  for (const m of [...CROWD.list, CROWD.bartender].filter(Boolean)) {
    m.pending = null;
    m.nextScene = 0;
    m.sceneCount = 0;
    m.converted = false;
    m.standWish = 0;
    m.standNow = 0;
    m.standAt = 0;
    m.standHoldUntil = 0;
    finishCrowdScene(m, NOW.t);
    m.p.c.headShake = 0;
    m.p.c.headTilt = 0;
    m.p.c.side = 0;
    m.animElapsed = 0;
    if (m.p.seated) {
      m.p.c.stand = 0;
      m.p.s.stand = 0;
      m.rush = 0;
      if (m.spot) m.p.root.position.copy(m.spot.pos);
      m.p.update(0, NOW.t, 0);
    }
  }
}

function crowdStill(p, groove = 0) {
  p.c.groove = groove;
  p.c.nod = 0;
  p.c.sway = 0;
  p.c.bounce = 0;
  p.c.jump = 0;
  p.c.headBang = 0;
  p.c.headShake = 0;
  p.c.disbelief = 0;
}

function sceneFace(p, k) {
  if (p.curFace !== k || p.exUntil < NOW.t + 0.2) p.express(k, 0.6);
}

function facePoint(p, x, y, z = 0) {
  const hb = p.bones[BONE.head];
  hb.updateWorldMatrix(true, false);
  return V3(x, p.headC.y + y, p.headC.z + z).applyMatrix4(hb.matrixWorld);
}

function palmQ(p, side, up = false) {
  const F = frameOf(p);
  return handQuat(up ? UPY : UPY.clone().negate(), F.f.clone().negate(), side);
}
// 양손으로 볼 감싸기 (입은 가리지 않음)
function cheekHands(p) {
  const F = frameOf(p);
  for (const side of PERSON_SIDES) {
    const sx = side === 'L' ? 1 : -1;
    const pt = facePoint(p, sx * p.R * 1.0, -p.R * 0.4, p.R * 0.32);
    const fingers = UPY.clone().addScaledVector(F.f, -0.3);
    p.reach(side, pt, p.local(sx * 0.45, 0.95 * p.h, 0.35), handQuat(fingers, F.r.clone().multiplyScalar(sx), side), 'flat');
  }
}
// 머리 감싸 쥐기 ("미쳤다…")
function headHands(p, only = null) {
  for (const side of only ? [only] : PERSON_SIDES) {
    const sx = side === 'L' ? 1 : -1;
    p.reach(side, facePoint(p, sx * p.R * 0.62, p.R * 0.8, p.R * 0.05), p.local(sx * 0.75, 1.45 * p.h, 0.15), null, 'flat');
  }
}

function pointAtMe(p, F, side = 'R') {
  const dir = CROWD.me.clone().sub(F.c).normalize();
  p.reach(side, F.c.clone().addScaledVector(dir, 0.58).addScaledVector(UPY, 0.12).addScaledVector(F.r, side === 'R' ? 0.12 : -0.12), null, null, 'point');
}

function sceneClap(p, F, t, high = false) {
  const sep = 0.028 + Math.max(0, Math.cos(t * 27)) * 0.13;
  p.reach('L', at(F, 0.27, -sep, high ? 0.62 : 0.12), null, null, 'flat');
  p.reach('R', at(F, 0.27, sep, high ? 0.62 : 0.12), null, null, 'flat');
}
// 소품 모양은 종류별로 한 번만 만들어 두고(모양·재질을 같이 씀) 사람마다는 복제만 함.
// 전에는 꺼낼 때마다 모양을 처음부터 다시 만들어서, 여럿이 한꺼번에 소품을 꺼내는 큰 장면에서 화면이 멈칫했음
const PROP_TPL = {};

function crowdPropKey(m, kind) {
  if (kind === 'glasses') return null; // 사람마다 크기가 달라 따로 만듦 (처음에 한 번)
  if (kind === 'towel') return kind + '|' + ((m.p.look && m.p.look.top) || ''); // 수건 띠는 옷 색
  if (kind === 'bouquet') return kind + '|' + ((m.p.look.seed || 0) % 3);
  return kind;
}

function crowdPropTemplate(kind, m = { props: {}, p: { look: {} } }) {
  const key = crowdPropKey(m, kind);
  if (PROP_TPL[key]) return PROP_TPL[key];
  const g = PROP_TPL[key] = buildCrowdProp(m, kind);
  SC.scene.add(g); // 본은 늘 숨겨 둠 (미리 그리기 때 셰이더·버퍼가 올라가도록 장면에만 넣어 둠)
  return g;
}

function makeCrowdProp(m, kind) {
  if (m.props[kind]) return m.props[kind];
  const key = crowdPropKey(m, kind);
  const g = key ? crowdPropTemplate(kind, m).clone(true) : buildCrowdProp(m, kind);
  if (kind === 'card') {
    const f = g.getObjectByName('cardFace');
    f.material = f.material.clone();
    g.userData = {
      face: f,
      text: '10'
    };
  } // 점수판 숫자는 판마다 다름
  SC.scene.add(g);
  m.props[kind] = g;
  return g;
}

function buildCrowdProp(m, kind) {
  const g = new THREE.Group();
  g.name = 'audience-' + kind;
  g.visible = false;
  const add = (geo, col, pos = [0, 0, 0], basic = false) => {
    const mesh = new THREE.Mesh(geo, basic ? new THREE.MeshBasicMaterial({ color: col }) : toonMat(col, { outline: 0.003 }));
    mesh.position.set(...pos);
    g.add(mesh);
    return mesh;
  };
  if (kind === 'phone') {
    add(rbox(0.105, 0.2, 0.022, 0.012, 2), '#221a2b');
    add(new THREE.PlaneGeometry(0.082, 0.164), '#99d9ed', [0, 0, -0.012], true).rotation.y = Math.PI;
    add(new THREE.SphereGeometry(0.013, 8, 6), '#11151d', [-0.03, 0.065, 0.014]);
    add(new THREE.SphereGeometry(0.006, 6, 4), '#a8c8e0', [-0.03, 0.065, 0.025]);
    add(new THREE.SphereGeometry(0.006, 6, 4), '#ee4a2c', [0.026, 0.064, -0.014]);
  } else if (kind === 'cup') {
    add(new THREE.CylinderGeometry(0.043, 0.034, 0.13, 10), '#d6e8e5');
    add(new THREE.CylinderGeometry(0.038, 0.038, 0.008, 10), '#d68c36', [0, 0.064, 0]);
    add(new THREE.TorusGeometry(0.041, 0.004, 4, 12), '#fffaf0', [0, 0.066, 0]).rotation.x = Math.PI / 2;
  } else if (kind === 'cloth') {
    add(rbox(0.16, 0.2, 0.012, 0.015, 2), '#fff4de');
  } else if (kind === 'glasses') {
    const p = m.p,
      E = p.eyeP,
      col = p.look.glasses;
    for (const sx of [1, -1]) {
      const rim = add(new THREE.TorusGeometry(E.r * 1.35, E.r * 0.1, 5, 14), col, [sx * E.x, 0, 0]);
      rim.scale.y = 0.95;
      add(new THREE.CylinderGeometry(0.004, 0.004, p.R * 0.9, 5), col, [sx * p.R * 0.82, 0, -p.R * 0.4]).rotation.x = Math.PI / 2;
    }
    add(new THREE.CylinderGeometry(0.004, 0.004, E.x, 5), col).rotation.z = Math.PI / 2;
  } else hypeProp(kind, add, m);
  // Keep each small prop cheap on mobile, including the existing outline pass.
  const solids = g.children.filter(o => o.isMesh && !o.material.isMeshBasicMaterial);
  if (solids.length > 1) {
    for (const o of solids) o.updateMatrix();
    const packed = _vm(solids.map(o => [o.geometry, o.material.color, o.matrix]));
    for (const o of solids) {
      g.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    g.add(new THREE.Mesh(packed, PROP_TPL.mat || (PROP_TPL.mat = toonVC({ outline: 0.003 }))));
  }
  return g;
}

function phonePose(m, F, t, pro) {
  const p = m.p,
    age = t - m.act.t0;
  const lift = smoothstep(0, 1.1, age),
    drop = pro || REACT.frenzy < 0.55 ? 0 : smoothstep(2.7, 5.2, age) * (1 - smoothstep(6, 6.65, age));
  const roll = pro ? -Math.PI / 2 * smoothstep(1.8, 2.8, age) : -drop * 0.24;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(drop * 0.8, p.root.rotation.y + p.s.twist, roll, 'YXZ'));
  const pocket = smoothstep(m.act.until - m.act.t0 - 1.1, m.act.until - m.act.t0 - 0.15, age);
  const center = at(F, lerp(0.3, 0.08, pocket), pro ? 0.02 : 0.13, lerp(-0.3, 0.3, lift) - drop * 0.48 - pocket * 0.6);
  const turn = pro ? smoothstep(1.8, 2.8, age) : 0;
  const gripR = V3(lerp(-0.052, 0, turn), lerp(-0.015, -0.085, turn), 0).applyQuaternion(q);
  const gripL = V3(lerp(0.052, 0, turn), lerp(-0.015, 0.085, turn), 0).applyQuaternion(q);
  p.reach('R', center.clone().add(gripR), null, q, 'grip');
  if (pro && age > 1.3) p.reach('L', center.clone().add(gripL), null, q, 'grip');
  else p.rest('L');
  m.act.phoneQ = q;
  m.act.phoneOffset = gripR.clone().negate();
  m.act.phoneVisible = pocket < 0.98;
  makeCrowdProp(m, 'phone').visible = m.act.phoneVisible;
  crowdStill(p, 0.12);
  p.c.lean = pro && age > 3 ? 0.24 : 0.04;
  if (pro && p.s.stand > 0.8) p.c.stand = 1 - 0.13 * smoothstep(3, 4, age);
  // 찍다가 넋이 나가 폰이 내려가면 입이 떡
  sceneFace(p, drop > 0.2 ? 'jawdrop' : (age > 6 ? 'grin' : 'focus'));
}

function runCrowdScene(m, t) {
  const p = m.p,
    a = m.act,
    age = t - a.t0,
    F = frameOf(p),
    R = p.R;
  crowdStill(p);
  p.c.look.copy(CROWD.me);
  p.c.lean = 0.04;
  p.c.stand = a.seat;
  p.rest('L');
  p.rest('R');
  switch (a.k) {
    case 'reserved':
      p.c.stand = 0;
      p.c.groove = 0.15;
      p.c.step = 0.5;
      p.reach('L', at(F, 0.12, 0.14, 0.08), null, null, 'relax');
      p.reach('R', at(F, 0.15, -0.14, 0.02), null, null, 'relax');
      sceneFace(p, 'calm');
      break;
    case 'mouthFreeze':
      // 헉 → 볼 감싸고 입 떡 → 머리 쥐고 절레절레 → 어이없어 웃으며 나를 가리킴
      if (age < 0.4) {
        sceneFace(p, 'gasp');
        p.c.lean = -0.14;
      } else if (age < 2.9) {
        sceneFace(p, 'jawdrop');
        cheekHands(p);
        p.c.lean = -0.06;
      } else if (age < 5.4) {
        sceneFace(p, age < 4.4 ? 'jawdrop' : 'disbelief');
        headHands(p);
        p.c.disbelief = 1;
      } else {
        sceneFace(p, 'stunlaugh');
        headHands(p, 'L');
        pointAtMe(p, F);
        p.c.headTilt = 0.12;
      }
      break;
    case 'phone':
    case 'filmPro':
      phonePose(m, F, t, a.k === 'filmPro');
      break;
    case 'drinkFreeze': {
      // 마시려던 잔이 턱 밑에서 멈춤 (입은 떡 벌어진 채)
      const lift = smoothstep(0, 1.0, age),
        lower = smoothstep(4.6, 6.5, age);
      const from = at(F, 0.24, 0.16, -0.25),
        lip = facePoint(p, -R * 0.2, -R * 1.45, R * 1.05);
      p.reach('R', from.lerp(lip, lift * (1 - lower)), null, palmQ(p, 'R'), 'grip');
      makeCrowdProp(m, 'cup').visible = age < 6.6;
      sceneFace(p, age > 0.8 && age < 5.6 ? (age < 1.1 ? 'gasp' : 'jawdrop') : (age >= 5.6 ? 'stunlaugh' : 'focus'));
      p.c.disbelief = age > 2.6 && age < 4.8 ? 0.8 : 0;
      p.c.lean = lower * 0.3;
      break;
    }
    case 'friendTap':
    case 'friendLean': {
      const friend = a.friend;
      if (!friend) {
        cheekHands(p);
        sceneFace(p, 'jawdrop');
        break;
      }
      const toward = friend.p.root.position.clone().sub(p.root.position),
        side = toward.dot(F.r) > 0 ? 'R' : 'L',
        sign = side === 'R' ? 1 : -1;
      const ff = frameOf(friend.p),
        shoulder = at(ff, 0.04, p.root.position.clone().sub(ff.c).dot(ff.r) > 0 ? 0.16 : -0.16, 0.13);
      if (a.k === 'friendTap') {
        if (age > 0.45 && age < 3.7) {
          const tap = Math.max(0, Math.sin((age - 0.45) * 12));
          const hand = shoulder.clone().addScaledVector(toward.normalize(), -tap * 0.1);
          p.reach(side, hand, null, null, 'flat');
          p.reach(side === 'R' ? 'L' : 'R', at(F, 0.43, -sign * 0.12, 0.22), null, null, 'point');
          p.c.look.copy(friend.p.headWorld());
          p.c.side = sign * 0.12;
        }
        // "야 봤냐?" 하고 친구를 툭툭 → 다시 나를 보며 입 떡 → 어이없어 웃음
        sceneFace(p, age < 3.7 ? 'disbelief' : (age < 5.0 ? 'jawdrop' : 'stunlaugh'));
        p.c.disbelief = age > 3.9 && age < 5.0 ? 0.8 : 0;
      } else {
        const fold = smoothstep(0.6, 1.8, age) * (1 - smoothstep(4.1, 5.5, age));
        p.c.side = sign * 0.5 * fold;
        p.c.lean = fold * 0.16;
        if (fold > 0.1) {
          p.c.look.copy(shoulder);
          p.reach(side, shoulder, null, null, 'relax');
        }
        p.c.headShake = age > 2 && age < 4 ? 0.25 : 0;
        sceneFace(p, age < 4.5 ? 'stunlaugh' : 'jawdrop');
      }
      break;
    }
    case 'buddy': {
      if (age > 0.85 && age < 2.4) p.c.look.copy(a.friend.p.headWorld());
      // 친구 말에 돌아봤다가 같이 나를 보고 입이 떡
      sceneFace(p, age < 2.4 ? 'disbelief' : (age < 4.4 ? 'jawdrop' : 'stunlaugh'));
      p.c.disbelief = age > 2.8 && age < 4.4 ? 0.8 : 0;
      if (a.source === 'friendLean' && age > 1 && age < 4.6) {
        const target = a.friend.p.chestWorld().add(V3(0, 0.12 + Math.sin(age * 10) * 0.025, -0.08));
        const side = target.clone().sub(F.c).dot(F.r) > 0 ? 'R' : 'L';
        p.reach(side, target, null, null, 'flat');
      }
      break;
    }
    case 'stankSlap':
      sceneFace(p, age < 3.5 ? 'stank' : 'grin');
      p.c.lean = age < 2 ? -0.23 : 0.12;
      p.c.headShake = age > 0.5 && age < 3.4 ? 0.65 : 0;
      if (age > 0.9 && age < 2.2) p.reach('R', p.local(-0.12, (p.s.stand > 0.7 ? 0.72 * p.h : p.seatY + 0.14) + 0.18 * Math.abs(Math.sin((age - 0.9) * 6)), 0.22), null, null, 'flat');
      else if (age > 3.5) sceneClap(p, F, t);
      break;
    case 'riseStun':
      // 벌떡 일어나 두 손 벌린 채 굳음 → 머리 쥐고 절레절레 → 웃으며 몸을 흔듦
      p.c.stand = 1;
      sceneFace(p, age < 0.45 ? 'gasp' : (age < 3.6 ? 'jawdrop' : 'stunlaugh'));
      if (age < 2.2) {
        p.reach('L', at(F, 0.18, -0.34, 0.06), null, null, 'spread');
        p.reach('R', at(F, 0.18, 0.34, 0.06), null, null, 'spread');
      } else if (age < 3.7) {
        headHands(p);
        p.c.disbelief = 1;
      } else {
        p.reach('L', at(F, 0.03, -0.2, -0.23), null, null, 'relax');
        p.reach('R', at(F, 0.03, 0.2, -0.23), null, null, 'relax');
        p.c.groove = 0.7;
        p.c.nod = 0.75;
      }
      break;
    case 'convert':
      p.c.stand = age < 3 ? 0 : 1;
      if (age < 2) {
        p.reach('L', at(F, 0.13, 0.14, 0.08), null, null, 'relax');
        p.reach('R', at(F, 0.15, -0.14, 0.02), null, null, 'relax');
        p.c.step = 0.7;
        sceneFace(p, 'focus');
      } else if (age < 4.2) {
        p.c.lean = 0.32;
        sceneFace(p, 'jawdrop');
      } else {
        sceneFace(p, 'ecstasy');
        sceneClap(p, F, t, true);
      }
      break;
    case 'glassesDouble': {
      const off = smoothstep(0.5, 1.4, age) * (1 - smoothstep(5.1, 6.4, age));
      a.glassesOff = off;
      const eye = facePoint(p, -p.eyeP.x * 1.4, p.eyeP.y - p.headC.y, p.eyeP.z - p.headC.z + 0.02);
      if (age < 6.5) p.reach('R', eye.lerp(at(F, 0.28, 0.23, 0.02), off), null, palmQ(p, 'R'), 'pinch');
      if (age > 2.2 && age < 4.1) p.reach('L', facePoint(p, R * 0.24, R * 0.05, R * 1.1), null, palmQ(p, 'L', true), 'fist');
      // 안경 벗고 눈 비비기: "내가 잘못 봤나?"
      sceneFace(p, age > 6 ? 'focus' : (age < 2.2 ? 'jawdrop' : (age < 4.1 ? 'disbelief' : 'jawdrop')));
      p.c.lean = age > 6 ? 0.3 : -0.05;
      p.c.disbelief = age > 4.1 && age < 5.6 ? 0.8 : 0;
      break;
    }
    case 'laughFold':
      // 이마 짚고 허리 숙여 어이없어 웃음
      sceneFace(p, age < 0.8 ? 'gasp' : 'stunlaugh');
      p.c.lean = 0.48 * smoothstep(0.7, 1.4, age) * (1 - smoothstep(3.6, 4.5, age));
      p.c.headTilt = age < 4 ? 0.16 : 0;
      if (age > 1 && age < 4) p.reach('R', facePoint(p, -R * 0.2, R * 0.62, R * 0.82), null, palmQ(p, 'R', true), 'flat');
      if (age > 4) {
        p.c.look.copy(CROWD.me);
        sceneClap(p, F, t);
      }
      break;
    default: runBigScene(m, t, a, age, F);
  }
}

function updateCrowdProps(m, t) {
  const p = m.p,
    a = m.act,
    props = m.props;
  const hand = side => p.bones[BONE['hand' + side]].getWorldPosition(new THREE.Vector3());
  if (props.phone) {
    if (m.drop && a && a.k === 'phoneDrop') {
      // 떨어지는 폰: 바닥에 튕기고 멈춤
      const D = m.drop,
        dt = NOW.dt;
      if (D.pos.y > 0.02 || D.vel.lengthSq() > 0.01) {
        D.vel.y -= 9.8 * dt;
        D.pos.addScaledVector(D.vel, dt);
        if (D.pos.y < 0.012) {
          D.pos.y = 0.012;
          D.vel.y *= -0.3;
          D.vel.x *= 0.5;
          D.vel.z *= 0.5;
          if (!D.hit) {
            D.hit = true;
            if (AE.decoded) playBuf(pick(AE.syn.clinks), AE.ctx.currentTime + 0.01, 0.12, AE.buses.crowd, {
              rate: 0.6
            });
          }
        }
        D.q.multiply(_dq.setFromEuler(new THREE.Euler(D.spin * dt, 0, D.spin * 0.6 * dt)));
        if (D.pos.y <= 0.013) D.spin *= 0.9;
      }
      props.phone.visible = true;
      props.phone.position.copy(D.pos);
      props.phone.quaternion.copy(D.q);
    } else {
      props.phone.visible = !!(a && a.phoneQ && a.phoneVisible);
      if (props.phone.visible) {
        props.phone.position.copy(hand('R')).add(a.phoneOffset);
        props.phone.quaternion.copy(a.phoneQ);
      }
    }
  }
  if (props.cup && props.cup.visible) {
    props.cup.position.copy(hand('R')).add(V3(0, 0.025, 0));
    props.cup.rotation.set(0, p.root.rotation.y, 0);
  }
  // 그 밖의 소품: 장면이 a.hold = { 종류: { pos | side, off, q, s } } 로 알려 주면 그 자리에
  for (const k in props) {
    if (k === 'phone' || k === 'cup' || k === 'glasses' || k === 'cloth') continue;
    const pr = props[k],
      h = a && a.hold && a.hold[k];
    if (!h) {
      pr.visible = false;
      continue;
    }
    pr.visible = true;
    if (h.pos) pr.position.copy(h.pos);
    else if (h.side === 'both') pr.position.copy(hand('L')).add(hand('R')).multiplyScalar(0.5);
    else pr.position.copy(hand(h.side || 'R'));
    if (h.off) pr.position.add(h.off);
    if (h.q) pr.quaternion.copy(h.q);
    pr.scale.setScalar(h.s == null ? 1 : h.s);
  }
  if (props.glasses) {
    const hb = p.bones[BONE.head];
    hb.updateWorldMatrix(true, false);
    const home = V3(0, p.eyeP.y - p.eyeP.r * 0.05, p.eyeP.z + p.eyeP.r * 0.62).applyMatrix4(hb.matrixWorld);
    const q = hb.getWorldQuaternion(new THREE.Quaternion()),
      off = a?.glassesOff || 0;
    props.glasses.visible = true;
    props.glasses.position.copy(home).lerp(hand('R').add(V3(0.07, 0, 0)), off);
    props.glasses.quaternion.copy(q).slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, p.root.rotation.y, -0.2)), off);
  }
}

function updateBartender(dt, t, beat, f) {
  const m = CROWD.bartender,
    p = m.p;
  if (m.dropAt && t >= m.dropAt) {
    m.dropAt = 0;
    m.pending = null;
    m.cupFree = null;
    m.act = {
      k: 'glassDrop',
      t0: t,
      until: t + 6,
      story: true
    };
    m.nextScene = t + 14;
  }
  if (m.pending && t >= m.pending.at) {
    m.pending = null;
    m.act = {
      k: 'barFreeze',
      t0: t,
      until: t + 8,
      story: true
    };
    m.nextScene = t + rand(20, 32);
  }
  if (m.bellAt && t >= m.bellAt) {
    m.bellAt = 0;
    if (!(m.act && m.act.k === 'glassDrop') && !AFTER.on) {
      m.pending = null;
      m.act = {
        k: 'bell',
        t0: t,
        until: t + 3.0,
        story: true
      };
      m.nextScene = t + 12;
    }
  }
  if (m.act && t >= m.act.until) {
    finishCrowdScene(m, t);
    m.cupFree = null;
  }
  if (m.act && m.act.k === 'glassDrop') {
    runBartenderDrop(m, t, dt, beat);
    return;
  }
  if (m.act && m.act.k === 'bell') {
    runBartenderBell(m, t, dt, beat);
    return;
  }
  if (AFTER.on) { // 공연 끝난 뒤 (첫 화면): 혼자 잔 닦기
    p.c.look.copy(p.local(0, 1.2, 1));
    crowdStill(p, 0.05);
    m.props.cup.visible = true;
    m.props.cloth.visible = true;
    p.reach('R', p.local(-0.11, 1.25, 0.3), null, null, 'grip');
    p.reach('L', p.local(0.03, 1.27 + Math.sin(t * 3) * 0.03, 0.31), null, null, 'flat');
    p.setBase('calm');
    p.update(dt, t, beat);
    updateCrowdProps(m, t);
    m.props.cloth.position.copy(p.bones[BONE.handL].getWorldPosition(new THREE.Vector3())).add(V3(0, -0.06, 0));
    m.props.cloth.rotation.set(0, p.root.rotation.y, -0.15);
    return;
  }
  if (!m.act && !m.pending && REACT.meSolo && f > 0.65 && t > m.nextScene) m.pending = {
    at: t + rand(1, 2)
  };
  const age = m.act ? t - m.act.t0 : -1;
  p.c.lean = 0;
  crowdStill(p, 0.2);
  p.c.look.copy(age >= 0 ? CROWD.me : p.local(0, 1.3, 1.5));
  m.props.cup.visible = age < 4.4;
  m.props.cloth.visible = age < 4.4;
  if (age < 0) {
    const ph = t * 5;
    p.reach('R', p.local(-0.11, 1.3, 0.3), null, null, 'grip');
    p.reach('L', p.local(0.03, 1.32 + Math.sin(ph) * 0.035, 0.31), null, null, 'flat');
    sceneFace(p, 'smile');
  } else if (age < 4.4) {
    p.reach('R', p.local(-0.11, 1.3, 0.3), null, null, 'grip');
    p.reach('L', p.local(0.03, 1.34, 0.31), null, null, 'flat');
    sceneFace(p, age < 0.35 ? 'gasp' : 'jawdrop');
    p.c.disbelief = age > 2 ? 0.8 : 0;
  } else {
    p.c.lean = 0.27;
    p.reach('L', p.local(0.22, 1.14, 0.43), null, null, 'flat');
    p.reach('R', p.local(-0.22, 1.14, 0.43), null, null, 'flat');
    sceneFace(p, age < 6 ? 'stunlaugh' : 'grin');
  }
  p.update(dt, t, beat);
  updateCrowdProps(m, t);
  if (m.props.cloth.visible) {
    m.props.cloth.position.copy(p.bones[BONE.handL].getWorldPosition(new THREE.Vector3())).add(V3(0, -0.06, 0));
    m.props.cloth.rotation.set(0, p.root.rotation.y, -0.15);
  }
}

// 표정 고르기: 한 번 고른 얼굴은 몇 초 유지 (매 프레임 다시 뽑으면 표정이 뭉개짐)
function moodFace(m, f, t) {
  const band = f < 0.25 ? 0 : f < 0.5 ? 1 : f < 0.75 ? 2 : 3;
  if (m.moodBand === band && t < (m.moodUntil || 0)) return m.mood;
  m.moodBand = band;
  m.moodUntil = t + rand(2.2, 5.5);
  if (band === 0) m.mood = m.watch < 0.4 ? 'smile' : 'calm';
  else if (band === 1) m.mood = m.wild > 0.6 ? 'nod' : (m.watch < 0.5 ? 'bliss' : 'smile');
  else if (band === 2) m.mood = pick(m.wild > 0.55 ? ['grin', 'stank', 'grin', 'wow'] : ['wow', 'disbelief', 'bliss', 'grin']);
  // 광기: 신난 사람도 있지만 대부분은 "와 미쳤다" 하고 기가 막힌 얼굴
  else m.mood = pick(m.wild > 0.65 ? ['ecstasy', 'scream', 'stunlaugh', 'jawdrop'] : ['jawdrop', 'disbelief', 'stunlaugh', 'gasp', 'jawdrop', 'awe']);
  return m.mood;
}

function burstFace(m, burst, t) {
  if (m.burstRef === burst && t < (m.burstUntil || 0)) return m.burstMood;
  m.burstRef = burst;
  m.burstUntil = t + rand(1.8, 3.6);
  m.burstMood = burst.k > 0.8 ? pick(['scream', 'grin', 'laugh', 'stunlaugh', 'jawdrop']) : 'smile';
  return m.burstMood;
}
// 관객 자세 갱신 간격. 기기가 느리면(PERF.level이 올라가면) 뒤쪽 사람들부터 덜 자주 움직임. 맨 앞줄은 그대로
const CROWD_RATE = {
  far: [1 / 20, 1 / 15, 1 / 12, 1 / 12],
  near: [1 / 30, 1 / 24, 1 / 20, 1 / 20]
};

function crowdUpdate(dt, t, beat) {
  if (METEOR.on && METEOR.impacted) return;
  const R = REACT,
    f = R.frenzy,
    burst = R.burst && t < R.burst.until ? R.burst : null;
  CROWD.me.copy(SC.camera ? SC.camera.position : V3(0, 2.4, 1));
  if (FIGHT.on) {
    const age = t - FIGHT.t0, shocked = age < 1.05;
    const rush = smooth01(Math.max(0, age - 1.05) / 2.1);
    for (const m of CROWD.list) {
      const p = m.p; if (!p.root.visible) continue;
      const mood = shocked ? 'shock' : 'angry';
      if (m.fightFace !== mood) {
        p.express(shocked ? 'jawdrop' : 'angry', 0);
        m.fightFace = mood;
      }
      const start = m.fightStart || (m.fightStart = p.root.position.clone());
      const spread = (m.wild - 0.5) * 0.8;
      const target = V3(CROWD.me.x + spread, 0, CROWD.me.z + 0.45 + (m.wild * 0.7));
      if (!shocked) p.root.position.lerpVectors(start, target, rush);
      p.root.rotation.y += (Math.atan2(CROWD.me.x - p.root.position.x, CROWD.me.z - p.root.position.z) - p.root.rotation.y) * Math.min(1, dt * 2);
      p.c.stand = 1; p.c.lean = shocked ? 0 : 0.28 + rush * 0.22;
      p.c.headTilt = shocked ? 0 : Math.sin(t * 9 + m.phase0) * 0.12;
      p.c.headShake = shocked ? 0 : Math.sin(t * 18 + m.phase0) * 0.16;
      p.c.step = shocked ? 0 : 0.5 + rush * 0.5; p.c.look.copy(CROWD.me);
      p.update(Math.min(dt, .1), t, beat);
    }
    if (!shocked && !FIGHT.gameOver && t > FIGHT.booUntil && AE.decoded && AE.ctx) {
      FIGHT.booUntil = t + 1.5; const now = AE.ctx.currentTime;
      for (let i = 0; i < 5; i++) voiceBlip(now + rand(0, .8), {dur: rand(.45, .8), f0: rand(115, 205), fem: false, v0: VOWEL.u, v1: VOWEL.u, vol: rand(.07, .14), att: .07, hold: .7, curve: [[0, 1.05], [.28, .94], [1, .72]], rough: .18, pan: rand(-.9, .9) });
    }
    aimCamera();
    if (age > 5.0 && !FIGHT.gameOver) {
      FIGHT.gameOver = true;
      document.getElementById("gameOver").classList.remove("hide");
    }
    return;
  }
  // 누구를 볼까: 솔로하는 밴드 멤버
  let soloPos = CROWD.stageC;
  if (R.floor && R.floor !== 'me' && BAND[R.floor]) soloPos = BAND[R.floor].headWorld(_cv3).clone();
  // 새로 일어난 일 처리
  for (const ev of R.events) {
    if (ev._crowd) continue;
    ev._crowd = true;
    crowdOnEvent(ev);
  }
  for (const m of CROWD.list) {
    m.animDt = (m.animDt || 0) + dt;
    m.animElapsed = (m.animElapsed || 0) + dt;
    const interval = m.far ? CROWD_RATE.far[PERF.level] : (m.kind === 'front' ? 1 / 30 : CROWD_RATE.near[PERF.level]);
    if (m.animDt + 1e-6 < interval) continue;
    const actorDt = Math.min(m.animElapsed, 0.1);
    m.animElapsed = 0;
    m.animDt %= interval;
    const p = m.p;
    if (!p.root.visible) continue;
    p.c.headTilt = 0;
    p.c.headShake = 0;
    p.c.side = 0;
    p.c.twist = 0;
    p.c.step = 0;
    p.c.disbelief = 0;
    p.c.hipSway = 0;
    // 따로 움직이는 사람 (무대에 올라온 팬, 첫 화면에 남은 사람)
    if (m.override) {
      m.override(m, t, actorDt, beat);
      p.update(actorDt, t, beat);
      updateCrowdProps(m, t);
      continue;
    }
    if (m.act && t >= m.act.until) finishCrowdScene(m, t);
    if (m.pending && t >= m.pending.at && !(m.act && m.act.story)) {
      const q = m.pending;
      m.pending = null;
      startCrowdScene(m, q.k, q.dur, q.extra);
    }
    // 서 있기 (앉은 사람): 광기·박수 세례
    const holdStanding = t < (m.standHoldUntil || 0);
    const standNow = holdStanding || f > m.standThreshold ? 1 : (f < 0.38 ? 0 : m.standWish);
    if (standNow !== m.standWish) {
      m.standAt = t + m.standDelay;
      m.standWish = standNow;
    }
    if (t >= (m.standAt || 0)) m.standNow = standNow;
    p.c.stand = m.reserved && !m.converted ? 0 : (m.standNow || 0);
    // 그루브
    const watching = R.meSolo && m.watch < smoothstep(1, 8, R.soloTime) * (0.35 + f * 0.65);
    p.c.groove = 0.035 + f * 1.0;
    p.c.nod = 0.045 + f * 0.8 + (watching ? 0.1 : 0);
    p.c.sway = 0.035 + f * 0.8;
    p.c.bounce = p.s.stand > 0.8 ? smoothstep(0.6, 1, f) * 1.1 : 0;
    p.c.jump = p.s.stand > 0.9 && f > 0.9 && m.wild > 0.5 ? (0.5 + m.wild * 0.7) : 0;
    // 달아오르면 서 있는 사람들이 무대 쪽으로 몰려듦
    if (m.kind === 'front') {
      const rush = p.s.stand > 0.9 ? smoothstep(0.8, 1, f) * (0.25 + m.wild * 0.3) : 0;
      if (!m.act?.story || f < 0.38) m.rush = damp(m.rush || 0, rush, f < 0.38 ? 6 : 1.2, actorDt);
      const sp = m.spot.pos,
        dz = -2.6 - sp.z,
        dx = -sp.x * 0.25,
        dl = Math.hypot(dx, dz) || 1;
      p.root.position.set(sp.x + dx / dl * m.rush, sp.y, Math.min(sp.z + dz / dl * m.rush, Math.max(sp.z, LAYOUT.stage.zFront - 0.38)));
    } else if (m.spot) p.root.position.copy(m.spot.pos);
    // 일어서면 의자 앞으로 한 발 (의자 위에 올라설 때는 제자리)
    if (m.standOff) {
      const k = smooth01(p.s.stand) * (m.offK == null ? 1 : clamp(m.offK, 0, 1));
      if (k > 0.001) {
        p.root.position.x += m.standOff.x * k;
        p.root.position.z = Math.min(p.root.position.z + m.standOff.z * k, Math.max(m.spot.pos.z, LAYOUT.stage.zFront - 0.36));
      }
    }
    if (m.walkOff) p.root.position.add(m.walkOff);
    if (m.liftY) p.root.position.y += m.liftY;
    p.c.headBang = f > 0.85 && m.wild > 0.75 ? 0.6 : 0;
    p.c.lean = watching ? 0.03 + f * 0.17 : 0;
    // 시선
    let atMe = false;
    if (CROWD.pre && !CROWD.preHeard) p.c.look.copy(m.lookFriend && t < m.lookFriend && m.friend ? m.friend.p.headWorld(_cv2) : (m.idleLook || CROWD.stageC));
    else if (m.lookFriend && t < m.lookFriend && m.friend) p.c.look.copy(m.friend.p.headWorld(_cv2));
    else if (CROWD.focus) p.c.look.copy(CROWD.focus);
    else if (watching || (burst && burst.kind !== 'polite') || CROWD.pre) {
      p.c.look.copy(CROWD.me);
      atMe = true;
    } else if (MISS.k > 0 && m.watch < MISS.k) {
      p.c.look.copy(CROWD.me);
      atMe = true;
      if (!p.exUntil && Math.random() < 0.015) p.express(pick(['ask', 'teary', 'ask']), 2.2);
    } else if (R.floor && R.floor !== 'me') p.c.look.copy(soloPos);
    else p.c.look.copy(m.watch > 0.85 && m.friend ? m.friend.p.headWorld(_cv2) : CROWD.stageC);
    if (atMe) p.c.look.y += crowdFollowY(m);
    // 표정
    if (!p.exUntil) p.setBase(burst ? burstFace(m, burst, t) : (watching ? moodFace(m, f, t) : (f > 0.5 ? 'smile' : 'calm')));
    // 기가 막힌 얼굴이면 절레절레, "이게 말이 돼?"는 고개도 갸웃
    if (p.curFace === 'disbelief') {
      p.c.disbelief = 0.8;
      p.c.headTilt = m.phase0 > 1 ? 0.13 : -0.13;
    } else if (p.curFace === 'jawdrop' && m.watch > 0.45) p.c.disbelief = 0.6;
    // 동작
    if (!m.act && !m.pending && t > m.nextAct) chooseAct(m, f, burst, watching, t);
    if (m.act) runCrowdAct(m, t, beat);
    else {
      p.rest('L');
      p.rest('R');
    }
    if (holdStanding) p.c.stand = 1;
    applyShock(m, t);
    p.update(actorDt, t, beat);
    updateCrowdProps(m, t);
  }
  if (CROWD.bartender) {
    const b = CROWD.bartender;
    b.animDt = (b.animDt || 0) + dt;
    b.animElapsed = (b.animElapsed || 0) + dt;
    if (b.animDt >= 1 / 20) {
      const step = Math.min(b.animElapsed, 0.1);
      b.animElapsed = 0;
      b.animDt %= 1 / 20;
      updateBartender(step, t, beat, f);
    }
  }
  crowdSound(dt, t, f, burst);
  hypeBeat(t, f);
}

function chooseAct(m, f, burst, watching, t) {
  const p = m.p,
    standing = p.s.stand > 0.7;
  m.nextAct = t + rand(0.4, 1.4);
  // 공연 전: 다들 자기들끼리 떠들고 마심
  if (CROWD.pre && !CROWD.preHeard) {
    const r = Math.random();
    if (m.friend && r < 0.5) {
      crowdAct(m, 'talk', rand(2, 4));
      m.lookFriend = t + rand(2, 4);
      p.express(pick(['smile', 'laugh', 'calm', 'ask', 'grin']), 2.5);
    } else if (r < 0.7 && m.kind !== 'front') crowdAct(m, 'sip', 2.3);
    else if (r < 0.8) crowdAct(m, 'chin', rand(2, 3));
    m.nextAct = t + rand(1.2, 3.5);
    return;
  }
  // 내가 오래 쉬면: 나를 돌아보며 "얼른" 손짓
  if (MISS.k > 0.25 && m.watch < MISS.k && Math.random() < 0.12 * MISS.k) {
    crowdAct(m, 'beckon', rand(1.8, 2.8));
    p.express(pick(['ask', 'teary']), 2.4);
    return;
  }
  if (m.reserved && !m.converted && f < 0.72 && !(burst && burst.k > 0.7)) {
    crowdAct(m, 'reserved', rand(3.5, 5), {
      story: true
    });
    return;
  }
  if ((REACT.meSolo || (burst && burst.owner === 'me' && burst.until - t > 7)) && f > 0.3 && t >= m.nextScene && Math.random() < 0.46) {
    if (queueCrowdScene(m, sceneFor(m, f), rand(0.1, 1.6))) return;
  }
  if (burst) {
    const k = burst.kind;
    if (k === 'polite' || burst.k < 0.3) {
      if (Math.random() < 0.22) crowdAct(m, 'clap', rand(0.7, 1.2), {
        rate: 2.2,
        sound: 0
      });
      return;
    }
    const r = Math.random();
    if (k === 'ovation' || burst.k > 0.85) {
      if (r < 0.45) crowdAct(m, 'clap', rand(2, 4), {
        rate: rand(4.6, 6),
        high: Math.random() < 0.5,
        sound: Math.random() < 0.2 ? 0.12 : 0
      });
      else if (r < 0.6) crowdAct(m, 'armsUp', rand(1.5, 3), {
        fist: Math.random() < 0.5
      });
      else if (r < 0.7) crowdAct(m, 'whistle', rand(1.2, 2));
      else if (r < 0.8) crowdAct(m, 'point', rand(1.2, 2));
      else if (r < 0.88) crowdAct(m, 'headHands', rand(1.2, 2));
      else crowdAct(m, 'pump', rand(2, 3), {
        side: pick(PERSON_SIDES),
        both: Math.random() < 0.4
      });
      m.p.express(pick(['scream', 'stunlaugh', 'grin', 'ecstasy', 'jawdrop']), rand(1.5, 3));
    } else {
      if (r < 0.75) crowdAct(m, 'clap', rand(2, 3.5), {
        rate: rand(4.2, 5.5),
        sound: Math.random() < 0.15 ? 0.1 : 0
      });
      else if (r < 0.85) crowdAct(m, 'whistle', 1.4);
      else crowdAct(m, 'point', 1.5);
      m.p.express(pick(['grin', 'smile', 'laugh']), 2.5);
    }
    return;
  }
  const r = Math.random();
  if (f < 0.3) {
    if (!watching && m.friend && r < 0.12) {
      crowdAct(m, 'talk', rand(1.5, 3));
      m.lookFriend = t + 2;
      m.p.express('smile', 2.5);
    } else if (r < 0.25 && m.kind !== 'front') crowdAct(m, 'sip', 2.3);
    else if (r < 0.32) crowdAct(m, 'chin', rand(2, 4));
    else m.nextAct = t + rand(1, 3);
  } else if (f < 0.6) {
    if (r < 0.3) crowdAct(m, 'snap', rand(3, 7));
    else if (r < 0.45) crowdAct(m, 'clap', rand(3, 6), {
      onBeat: true
    });
    else if (r < 0.55 && m.wild > 0.5) crowdAct(m, 'conduct', rand(3, 5));
    else if (r < 0.62 && m.wild > 0.6) crowdAct(m, 'airhorn', rand(2, 4));
    else if (r < 0.7) crowdAct(m, 'point', 1.4);
    else m.nextAct = t + rand(0.8, 2);
  } else {
    // 기가 막힌 얼굴인 사람은 머리를 감싸 쥐거나 볼을 감쌈
    if (SHOCK_FACES.has(p.curFace) && r < 0.45) {
      crowdAct(m, r < 0.28 ? 'headHands' : 'cheeks', rand(1.8, 3.2));
      return;
    }
    if (r < 0.25) crowdAct(m, 'armsUp', rand(2, 4), {
      fist: Math.random() < 0.4
    });
    else if (r < 0.42) crowdAct(m, 'pump', rand(2, 4), {
      side: pick(PERSON_SIDES),
      both: Math.random() < 0.3
    });
    else if (r < 0.55) crowdAct(m, 'clap', rand(2, 5), {
      onBeat: Math.random() < 0.5,
      high: true
    });
    else if (r < 0.64) crowdAct(m, 'headHands', rand(1.4, 2.4));
    else if (r < 0.72) crowdAct(m, 'point', 1.6);
    else if (r < 0.8) crowdAct(m, 'whistle', 1.5);
    else if (r < 0.88) crowdAct(m, 'wave', rand(2, 3));
    else crowdAct(m, 'airhorn', rand(2, 4));
  }
}

function crowdOnEvent(ev) {
  hypeOnEvent(ev);
  if (bigOnEvent(ev)) return;
  const W = CROWD.list.filter(m => m.watch < 0.25 + REACT.frenzy && !m.override && m.p.root.visible);
  const some = n => shuffle(W.slice()).slice(0, n);
  if ((ev.kind === 'tuneStart' || ev.kind === 'bandSolo') && !playerApplauseActive()) {
    for (const m of [...CROWD.list, CROWD.bartender].filter(Boolean)) {
      m.pending = null;
      if (m.act?.story) m.act.until = Math.min(m.act.until, NOW.t + 0.9);
    }
  }
  if (!REACT.meSolo && !['myApplause', 'ovation', 'endApplause'].includes(ev.kind)) return;
  if (REACT.meSolo && REACT.frenzy < 0.3) return;
  if (ev.kind === 'awe' || ev.kind === 'breakOn' || ev.kind === 'breakOff' || ev.kind === 'ovation' || (ev.kind === 'gesture' && ['high', 'run', 'fall', 'shake', 'gliss'].includes(ev.g))) {
    const n = ev.kind === 'gesture' ? 4 : 7;
    for (const m of some(n)) queueCrowdScene(m, sceneFor(m, REACT.frenzy), rand(0.08, 1.9));
    const b = CROWD.bartender;
    if (b && NOW.t > b.nextScene && ev.kind !== 'gesture') b.pending = {
      at: NOW.t + rand(0.8, 1.8)
    };
  }
  switch (ev.kind) {
    case 'gesture': {
      const g = ev.g,
        k = REACT.heat / 100;
      if (g === 'high') {
        for (const m of some(3 + Math.round(k * 7))) {
          const fc = pick(['jawdrop', 'gasp', 'awe', 'scream']);
          m.p.express(fc, 2.0);
          if (Math.random() < 0.5) crowdAct(m, fc === 'scream' ? 'armsUp' : (Math.random() < 0.5 ? 'headHands' : 'cheeks'), 1.8);
        }
        crowdWhoops(2 + Math.round(k * 5));
      } else if (g === 'run') {
        for (const m of some(2 + Math.round(k * 5))) {
          m.p.express(pick(['grin', 'disbelief', 'gasp']), 1.6);
          if (!m.act || !m.act.story) queueCrowdScene(m, 'stankSlap', rand(0.1, 0.8));
        }
      } else if (g === 'riff') {
        for (const m of W) m.p.c.nod = 1.2;
        crowdWhoops(1 + Math.round(k * 3));
      } else if (g === 'fall') {
        for (const m of some(3 + Math.round(k * 4))) m.p.express('stank', 1.6);
        crowdWhoops(Math.round(k * 3), 'hoo');
      } else if (g === 'shake' || g === 'gliss') {
        for (const m of some(3 + Math.round(k * 4))) m.p.express(pick(['wow', 'stunlaugh', 'disbelief']), 1.6);
        crowdWhoops(1 + Math.round(k * 3));
      } else if (g === 'pedal') {
        for (const m of some(3)) m.p.express(pick(['stunlaugh', 'disbelief']), 1.6);
      } else if (g === 'space') {
        for (const m of W) m.p.c.lean = 0.3;
      }
      break;
    }
    case 'riffCatch':
      for (const m of CROWD.list.filter(x => x.kind === 'seat').slice(0, 4)) {
        crowdAct(m, 'slap', 1.4);
        for (const tt of ev.times.slice(0, 4))
          if (tt > AE.ctx.currentTime) playBuf(AE.syn.slap, tt, 0.22, AE.buses.crowd, {
            pan: clamp(m.p.root.position.x / 5, -0.9, 0.9)
          });
      }
      break;
    case 'awe':
      for (const m of some(6)) {
        m.p.express(pick(['jawdrop', 'jawdrop', 'gasp', 'disbelief']), 2.4);
        if (!m.act || !m.act.story) crowdAct(m, Math.random() < 0.5 ? 'headHands' : 'cheeks', 2.2);
      }
      crowdWhoops(3);
      break;
    case 'breakOn':
      for (const m of CROWD.list) {
        m.p.express(Math.random() < 0.8 ? 'jawdrop' : 'gasp', 4);
        m.p.c.lean = 0.35;
      }
      break;
    case 'breakOff':
      if (!SPX.boomDone) specialBoom();
      for (const m of CROWD.list) {
        m.p.express(pick(['scream', 'stunlaugh', 'ecstasy', 'stunlaugh']), 2.5);
        if (Math.random() < 0.5) crowdAct(m, Math.random() < 0.6 ? 'armsUp' : 'headHands', 2);
      }
      crowdWhoops(8);
      break;
    case 'myApplause':
      crowdWhoops(Math.round(ev.k * 6));
      if (ev.k > 0.8) crowdWhistles(2);
      break;
    case 'ovation':
      crowdWhoops(10);
      crowdWhistles(4);
      break;
    case 'endApplause':
      if (REACT.songPeak > 15) crowdWhoops(2);
      break;
  }
}

function crowdWhistles(n) {
  const burst = REACT.burst;
  if (!burst || burst.owner !== 'me') return;
  for (let i = 0; i < n; i++) REACT.later(0.3 + i * 0.6, () => {
    if (AE.decoded && REACT.burst === burst && NOW.t < burst.until) whistleCall(AE.ctx.currentTime + 0.02);
  });
}
// 환호 소리 몇 개 흩뿌림
function crowdWhoops(n, kind) {
  if (!AE.decoded || !AE.ctx) return;
  const now = AE.ctx.currentTime;
  for (let i = 0; i < n; i++) whoop(now + 0.05 + rand(0, 0.9), {
    kind: kind || undefined,
    vol: rand(0.12, 0.22)
  });
}

function crowdSound(dt, t, f, burst) {
  if (!AE.decoded || !bed.TABLE.applause) return;
  // 박수 바탕
  let clap = 0,
    big = 0;
  if (burst) {
    const age = t - burst.t,
      left = burst.until - t;
    const env = clamp(age / 0.4, 0, 1) * smoothstep(0, burst.fade || 1.2, left);
    if (burst.kind === 'polite') clap = 0.18 * env;
    else if (burst.kind === 'ovation') {
      big = 0.75 * burst.k * env;
      clap = 0.3 * env;
    } else {
      clap = 0.32 * burst.k * env;
      big = burst.k > 0.85 ? 0.35 * env : 0;
    }
  }
  const hush = (SPX.hush && t < SPX.hush.until) || ENDL.stage === 2 || (FIN.on && FIN.hushK > 0.5);
  if (hush) {
    clap = 0;
    big = 0;
  } else if (FIN.on) {
    clap = 0.3 * FIN.loud;
    big = 0.8 * FIN.loud;
  }
  CROWD.clapBed = damp(CROWD.clapBed, clap, hush ? 14 : 6, dt);
  CROWD.bigBed = damp(CROWD.bigBed || 0, big, hush ? 14 : 6, dt);
  bed.set('applause', CROWD.clapBed, 0.24);
  bed.set('applauseBig', CROWD.bigBed, 0.24);
  // 함성 바탕: 광기가 높을 때만 (음악을 덮지 않게)
  const roar = hush ? 0 : (REACT.meSolo ? smoothstep(0.62, 1, f) * 0.22 : 0) + (burst && burst.k > 0.8 ? 0.28 * smoothstep(0, burst.fade || 1, burst.until - t) : 0);
  CROWD.roar = damp(CROWD.roar, FIN.on && !hush ? 0.3 * FIN.loud : roar, hush ? 12 : 3, dt);
  bed.set('roar', CROWD.roar, 0.3);
  // 광기 중 간간이 "우—!"
  if (!hush && REACT.meSolo && f > 0.55 && t - CROWD.lastWhoop > lerp(2.5, 0.35, smoothstep(0.55, 1, f))) {
    CROWD.lastWhoop = t + rand(0, 0.4);
    whoop(AE.ctx.currentTime + 0.02, {
      vol: rand(0.1, 0.2)
    });
  }
  if (!hush && REACT.meSolo && f > 0.8 && t - CROWD.lastWhistle > 4) {
    CROWD.lastWhistle = t + rand(0, 3);
    whistleCall(AE.ctx.currentTime + 0.02, {
      vol: 0.05
    });
  }
}

// ===== 75_react.js =====
// ===================== 반응 규칙 =====================
// 내 솔로에서 나온 행동(초고음 길게·빠른 패시지·리프 반복·여백·폴·페달·셰이크·글리산도) → 열기
// 열기 → 관객 광기 단계, 밴드 시선, 경이 순간(규칙), 절정 브레이크
const GAIN = {
  high: 16,
  run: 13,
  riff: 18,
  space: 7,
  fall: 9,
  pedal: 11,
  shake: 11,
  gliss: 12
};
const BIG = new Set(['high', 'run', 'riff', 'shake', 'gliss']);
const REACT = {
  heat: 0,
  peak: 0,
  songPeak: 0,
  soloPeak: 0,
  frenzy: 0,
  frenzyT: 0,
  awes: 0,
  lastAwe: -99,
  aweOrder: ['pn', 'bs', 'dr', 'tb'],
  aweIdx: 0,
  lastAweWho: null,
  kinds: [],
  hist: [],
  lastG: {},
  breakUsed: false,
  inBreak: false,
  onsets: [],
  phrase: null,
  prevPhrase: null,
  riffN: 0,
  highFlag: false,
  pedalFlag: false,
  glissFlag: 0,
  lastOff: 0,
  timers: [],
  burst: null,
  events: [],
  floor: null,
  phase: 'title',
  meSolo: false,
  soloTime: 0,
  lastHeatNote: -99,
  lastLegatoEvent: -99,
  reset() {
    Object.assign(this, {
      heat: 0,
      peak: 0,
      songPeak: 0,
      soloPeak: 0,
      frenzy: 0,
      frenzyT: 0,
      awes: 0,
      lastAwe: -99,
      aweIdx: 0,
      lastAweWho: null,
      kinds: [],
      hist: [],
      lastG: {},
      breakUsed: false,
      inBreak: false,
      onsets: [],
      phrase: null,
      prevPhrase: null,
      riffN: 0,
      highFlag: false,
      pedalFlag: false,
      lastOff: 0,
      lastNote: 0,
      timers: [],
      burst: null,
      events: [],
      floor: null,
      phase: 'head',
      meSolo: false,
      soloTime: 0,
      lastHeatNote: -99,
      lastLegatoEvent: -99
    });
  },
  later(sec, fn) {
    this.timers.push({
      t: NOW.t + sec,
      fn
    });
  },
};
const meNow = () => AE.ctx ? AE.ctx.currentTime : 0;
// 관객·밴드 쪽에 "방금 일어난 일" 알림
function reactEvent(kind, data = {}) {
  REACT.events.push({
    kind,
    t: NOW.t,
    ...data
  });
  if (REACT.events.length > 40) REACT.events.shift();
}

// ---------- 트럼펫 이벤트 → 행동 감지 ----------
TP.listeners.push((type, d) => {
  const R = REACT,
    now = meNow();
  if (GAME.phase !== 'play') return;
  ruleOnNote(type, d, now);
  if (type === 'attack') missOnAttack();
  if (type === 'attack' || type === 'legato') {
    if (type === 'legato' && now - R.lastLegatoEvent < 0.045) return;
    if (type === 'legato') R.lastLegatoEvent = now;
    R.onsets.push(now);
    while (R.onsets.length && R.onsets[0] < now - 1.7) R.onsets.shift();
    R.highFlag = false;
    R.pedalFlag = false;
    if (type === 'attack') {
      // 앞 음을 떼고 쉬었다가 새로 시작했을 때만 새 프레이즈 (손을 안 떼고 혀만 친 음·다른 손가락으로 뛴 음은 이어지는 프레이즈)
      const p = beatPosAt(now),
        off = Math.abs(p - Math.round(p)),
        rested = R.lastOff >= (R.lastNote || 0);
      if (R.meSolo && rested && now - R.lastOff > curSpb() * 3.6 && R.lastOff > 0 && off < 0.18 && Math.round(p) % 4 === 0) gesture('space');
      if (!R.phrase || (rested && now - R.lastOff > 0.32)) {
        closePhrase();
        R.phrase = {
          t0: now,
          notes: []
        };
      }
    }
    R.lastNote = now;
    if (R.phrase && R.phrase.notes.length < 64) R.phrase.notes.push({
      t: now - R.phrase.t0,
      m: d.m
    });
    if (R.onsets.length >= 7 && now - (R.lastG.run || -9) > 4) gesture('run');
    if (R.meSolo && now - R.lastHeatNote >= 0.15) {
      R.lastHeatNote = now;
      addHeat(0.28);
    }
  } else if (type === 'release') {
    R.lastOff = now;
    if (d.flick === 'fall' && d.m >= 64) gesture('fall');
  } else if (type === 'shake') {
    if (!d.on && d.dur > 0.45) gesture('shake');
  }
});

function closePhrase() {
  const R = REACT,
    ph = R.phrase;
  if (!ph || !ph.notes.length) return;
  R.phrase = null;
  if (R.prevPhrase && similar(R.prevPhrase, ph)) {
    R.riffN++;
    if (R.riffN === 2 && R.meSolo) catchRiff(R.prevPhrase, ph);
    if (R.riffN === 3) gesture('riff');
  } else R.riffN = 1;
  R.prevPhrase = ph;
}

function similar(a, b) {
  if (Math.abs(a.notes.length - b.notes.length) > 1 || a.notes.length < 2 || a.notes.length > 9) return false;
  const n = Math.min(a.notes.length, b.notes.length);
  let ok = 0;
  for (let i = 0; i < n; i++)
    if (Math.abs(a.notes[i].t - b.notes[i].t) < 0.12) ok++;
  let cs = 0;
  for (let i = 1; i < n; i++)
    if (Math.sign(a.notes[i].m - a.notes[i - 1].m) === Math.sign(b.notes[i].m - b.notes[i - 1].m)) cs++;
  return ok >= n - 1 && cs >= (n - 1) * 0.6;
}
// 같은 리프 두 번째가 끝나면 드러머가 세 번째를 같이 침
function catchRiff(a, b) {
  const period = b.t0 - a.t0;
  if (period < 0.4 || period > 4.5) return;
  const t3 = b.t0 + period;
  const times = b.notes.slice(0, 7).map(n => t3 + n.t);
  bandAccents(times, true);
  reactEvent('riffCatch', {
    at: t3,
    times
  });
}

function addHeat(v) {
  const R = REACT,
    cap = R.meSolo ? Math.min(100, 4 + R.soloTime * 4.5) : 100;
  R.heat = clamp(R.heat + v, 0, cap);
  R.peak = Math.max(R.peak, R.heat);
  R.songPeak = Math.max(R.songPeak, R.heat);
  R.soloPeak = Math.max(R.soloPeak, R.heat);
}

function gesture(kind) {
  const R = REACT,
    now = meNow();
  R.lastG[kind] = now;
  if (!R.meSolo) {
    reactEvent('small', { g: kind });
    return;
  }
  const last3 = R.kinds.slice(-3);
  let g = (GAIN[kind] || 6) * 0.6;
  if (R.kinds[R.kinds.length - 1] === kind) g *= 0.45;
  else if (!last3.includes(kind)) g *= 1.25;
  while (R.hist.length && now - R.hist[0].t > 24) R.hist.shift();
  const same = R.hist.filter(h => h.k === kind).length;
  g *= Math.pow(0.6, same);
  R.hist.push({
    k: kind,
    t: now
  });
  R.kinds.push(kind);
  if (R.kinds.length > 30) R.kinds.shift();
  addHeat(g);
  reactEvent('gesture', {
    g: kind,
    heat: R.heat
  });
  // 경이 순간: 달아오른 상태에서 '새로운' 큰 행동, 8마디에 한 번까지
  const barsSince = (now - R.lastAwe) / (4 * curSpb());
  if (BIG.has(kind) && same <= 1 && R.heat >= 60 && R.soloTime >= 10 && barsSince >= 8 && !R.inBreak) aweMoment();
  // 절정: 열기 최고에서 초고음 길게 → 밴드가 2마디 멈춤 (곡마다 한 번)
  if (kind === 'high' && R.heat >= 88 && R.soloTime >= 18 && !R.breakUsed) {
    if (requestBreak()) R.breakUsed = true;
  }
}

function aweMoment() {
  const R = REACT;
  R.lastAwe = meNow();
  R.awes++;
  let who;
  do {
    who = R.aweOrder[R.aweIdx++ % R.aweOrder.length];
  } while (who === R.lastAweWho && R.aweOrder.length > 1);
  R.lastAweWho = who;
  // 두 번째부터는 둘이 먼저 눈을 맞추고 같이 나를 봄
  const other = R.awes >= 2 ? pick(R.aweOrder.filter(k => k !== who)) : null;
  reactEvent('awe', {
    who,
    other,
    n: R.awes
  });
}

// ---------- 곡 진행 이벤트 ----------
function beginPlayerReaction() {
  const R = REACT;
  R.soloTime = 0;
  R.soloPeak = 0;
  R.heat = 0;
  R.burst = null;
  R.lastHeatNote = -99;
  R.lastLegatoEvent = -99;
}

function reactOnSong(e) {
  const R = REACT;
  if (e.type === 'tuneStart') {
    R.songPeak = 0;
    R.breakUsed = false;
    R.awes = 0;
    R.aweIdx = randi(0, 3);
    R.phase = 'head';
    R.meSolo = false;
    R.soloPeak = 0;
    R.heat = 0;
    R.soloTime = 0;
    R.floor = null;
    if (!playerApplauseActive()) R.burst = null;
    reactEvent('tuneStart', {
      first: e.first
    });
  } else if (e.type === 'seg') {
    const wasMe = R.meSolo;
    R.phase = e.phase;
    R.floor = e.floor;
    R.meSolo = e.phase === 'solo' && e.player === 'me';
    if (R.meSolo && !wasMe) {
      beginPlayerReaction();
      reactEvent('meSolo', {});
    }
    if (wasMe && !R.meSolo) myApplause();
  } else if (e.type === 'takeover') {
    const wasMe = R.meSolo;
    R.meSolo = true;
    R.phase = 'solo';
    R.floor = 'me';
    if (!wasMe) beginPlayerReaction();
    reactEvent('takeover', {
      from: e.from
    });
  } else if (e.type === 'solo') {
    if (R.meSolo) {
      R.meSolo = false;
      myApplause();
    }
    R.floor = e.player;
    if (!playerApplauseActive()) R.burst = null;
    R.heat = 0;
    reactEvent('bandSolo', {
      player: e.player,
      trade: e.trade
    });
  } else if (e.type === 'soloEnd') {
    if (e.player && e.player !== 'dr' && !playerApplauseActive()) {
      R.burst = {
        kind: 'polite',
        t: NOW.t,
        until: NOW.t + 1.2,
        k: 0.08
      };
      reactEvent('politeApplause', {
        player: e.player
      });
    }
  } else if (e.type === 'break') {
    R.inBreak = e.on;
    reactEvent(e.on ? 'breakOn' : 'breakOff', {});
  } else if (e.type === 'cue') reactEvent('cue', {
    kind: e.kind,
    player: e.player
  });
  else if (e.type === 'fermata') reactEvent('fermata', {});
  else if (e.type === 'cut') {
    R.meSolo = false;
    if (FIN.req && !FIN.on) finBegin();
    else if (!FIN.on) ovation();
  } else if (e.type === 'gap') reactEvent('gap', {});
}

function playerApplauseActive() {
  return REACT.burst && REACT.burst.owner === 'me' && NOW.t < REACT.burst.until;
}

function myApplause() {
  const R = REACT,
    k = clamp(R.soloPeak / 100 * 1.1, 0.08, 1.1);
  R.burst = {
    kind: 'solo',
    owner: 'me',
    t: NOW.t,
    until: NOW.t + 8 + k * 4,
    k,
    energy: Math.max(R.frenzy, clamp(k * 0.9, 0, 1)),
    fade: 3
  };
  for (const m of CROWD.list)
    if (m.p.s.stand > 0.6) m.standHoldUntil = R.burst.until - 1.5 + m.standDelay;
  reactEvent('myApplause', {
    k
  });
}

function ovation() {
  const R = REACT,
    big = R.songPeak >= 62 || R.awes >= 2;
  const k = big ? clamp(0.9 + R.songPeak / 200, 0.9, 1.4) : clamp(R.songPeak / 140, 0.08, 0.6);
  R.burst = {
    kind: big ? 'ovation' : 'applause',
    owner: R.songPeak > 15 ? 'me' : 'band',
    t: NOW.t,
    until: NOW.t + (big ? 7.5 : 4.5),
    k
  };
  reactEvent(big ? 'ovation' : 'endApplause', { k });
}

// ---------- 매 프레임 ----------
function reactUpdate(dt, t) {
  const R = REACT;
  for (let i = R.timers.length - 1; i >= 0; i--)
    if (R.timers[i].t <= t) {
      const f = R.timers[i].fn;
      R.timers.splice(i, 1);
      f();
    }
  const now = meNow();
  if (MUS.running && AE.ctx) {
    const active = TP.blowing || now - TP.lastSoundT < 1.1;
    if (R.meSolo && active) {
      R.soloTime += dt;
      addHeat(dt * 3.2);
    }
    if (TP.blowing && TP.voice) {
      const held = now - TP.pitchT0;
      if (!R.highFlag && ((TP.cur >= 79 && held > 0.9) || (TP.cur >= 75 && held > 1.6))) {
        R.highFlag = true;
        gesture('high');
      }
      if (!R.pedalFlag && TP.cur <= 55 && held > 0.7) {
        R.pedalFlag = true;
        gesture('pedal');
      }
      // 자유 모드: 크게 쭉 미끄러지기 / 빠르게 떨기
      if (TP.mode === 'free' && now - (R.lastG.gliss || -9) > 3) {
        const a = TP.air;
        if (a.length > 3) {
          const tn = performance.now();
          let lo = 9,
            hi = -9;
          for (const s of a)
            if (tn - s.t < 450) {
              lo = Math.min(lo, s.pos);
              hi = Math.max(hi, s.pos);
            } if ((hi - lo) * (TP.hi - TP.lo) >= 9) gesture('gliss');
        }
      }
      if (TP.mode === 'free' && now - (R.lastG.shake || -9) > 3) {
        const a = TP.air,
          tn = performance.now();
        let rev = 0,
          dir = 0,
          prev = null;
        for (const s of a) {
          if (tn - s.t > 700) continue;
          if (prev != null) {
            const d = Math.sign(s.pos - prev);
            if (d && dir && d !== dir) rev++;
            if (d) dir = d;
          }
          prev = s.pos;
        }
        if (rev >= 6 && TP.cur >= 62) gesture('shake');
      }
    }
    if (R.phrase && !TP.blowing && now - R.lastOff > 0.34) closePhrase();
    // 열기 식기
    const silent = !TP.blowing && now - TP.lastSoundT > 4;
    if (R.meSolo) {
      if (silent) R.heat = Math.max(0, R.heat - dt * 3.2);
    } else R.heat = Math.max(0, R.heat - dt * (R.phase === 'outhead' || R.phase === 'tag' ? 0.4 : 1.5));
  }
  // Others stay subdued. My solo opens the reaction range gradually over ~20 s.
  let ft = 0.025;
  if (R.meSolo) ft = smoothstep(4, 90, R.heat) * smoothstep(0, 18, R.soloTime);
  if (R.burst && t < R.burst.until) {
    const fade = R.burst.fade ? smoothstep(0, R.burst.fade, R.burst.until - t) : 1;
    const afterglow = R.burst.owner === 'me' ? (R.burst.energy ?? clamp(R.burst.k * 0.9, 0, 1)) * fade : 0.06;
    ft = Math.max(ft, afterglow);
  }
  R.frenzyT = ft;
  R.frenzy = damp(R.frenzy, ft, ft > R.frenzy ? 1.5 : 2.4, dt);
}

// ===== 76_bigreact.js =====
// ===================== 기절초풍 리액션 (큰 순간 전용) · 물방울/유리 조각 · 창문 밖 구경꾼 =====================
const _bv = new THREE.Vector3(),
  _bv2 = new THREE.Vector3(),
  _bv3 = new THREE.Vector3();
// 사람 기준 왼쪽(s=+1)·오른쪽(s=-1) 방향 (frameOf의 r은 오른쪽)
const sideW = (F, s) => F.r.clone().multiplyScalar(-s);
const BIG_SCENES = {
  freeze: 3,
  slapHead: 5.6,
  handsTop: 5.4,
  mindBlown: 5.2,
  spitTake: 5.2,
  faint: 6.2,
  catch: 6.2,
  slideOff: 6.4,
  kneel: 6.2,
  shakeFriend: 4.8,
  shaken: 4.8,
  walkAway: 6.6,
  phoneDrop: 5.6,
  dizzy: 3.8,
  puffHold: 40
};
Object.assign(CROWD_SCENES, BIG_SCENES);

// ---------- 물방울·유리 조각 (점 입자) ----------
const FXP = {
  pts: null,
  n: 560,
  pos: null,
  vel: [],
  life: [],
  max: [],
  size: null,
  alpha: null,
  col: null,
  cur: 0,
  mat: null,
  grav: null,
  drag: null
};

function fxInit(scene) {
  const n = FXP.n,
    g = new THREE.BufferGeometry();
  FXP.pos = new Float32Array(n * 3);
  FXP.size = new Float32Array(n);
  FXP.alpha = new Float32Array(n);
  FXP.col = new Float32Array(n * 3);
  FXP.grav = new Float32Array(n).fill(7.5);
  FXP.drag = new Float32Array(n).fill(1.2);
  for (let i = 0; i < n; i++) {
    FXP.pos[i * 3 + 1] = -50;
    FXP.vel.push(new THREE.Vector3());
    FXP.life.push(0);
    FXP.max.push(1);
  }
  g.setAttribute('position', new THREE.BufferAttribute(FXP.pos, 3));
  g.setAttribute('size', new THREE.BufferAttribute(FXP.size, 1));
  g.setAttribute('alpha', new THREE.BufferAttribute(FXP.alpha, 1));
  g.setAttribute('color', new THREE.BufferAttribute(FXP.col, 3));
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.beginPath();
  x.arc(32, 32, 31, 0, Math.PI * 2);
  x.fill();
  const tex = new THREE.CanvasTexture(c);
  FXP.mat = new THREE.ShaderMaterial({
    uniforms: {
      tex: {
        value: tex
      },
      scale: {
        value: 600
      }
    },
    vertexShader: 'attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC; uniform float scale;\n void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform sampler2D tex; varying float vA; varying vec3 vC;\n void main(){ vec4 t = texture2D(tex, gl_PointCoord); float a = t.a * vA; if (a < 0.03) discard; gl_FragColor = vec4(vC, a); }',
    transparent: true,
    depthWrite: false,
  });
  FXP.pts = new THREE.Points(g, FXP.mat);
  FXP.pts.frustumCulled = false;
  FXP.pts.renderOrder = 8;
  scene.add(FXP.pts);
}
const _fxc = new THREE.Color();

function fxEmit(p, v, size, life, color, grav = 7.5, drag = 1.2) {
  const i = FXP.cur;
  FXP.cur = (FXP.cur + 1) % FXP.n;
  FXP.grav[i] = grav;
  FXP.drag[i] = drag;
  FXP.pos[i * 3] = p.x;
  FXP.pos[i * 3 + 1] = p.y;
  FXP.pos[i * 3 + 2] = p.z;
  FXP.vel[i].copy(v);
  FXP.size[i] = size;
  FXP.life[i] = life;
  FXP.max[i] = life;
  FXP.alpha[i] = 1;
  const c = _fxc.set(color);
  FXP.col[i * 3] = c.r;
  FXP.col[i * 3 + 1] = c.g;
  FXP.col[i * 3 + 2] = c.b;
}
// 입에서 뿜는 술: 물방울 + 안개
function fxSpray(o, dir, n = 44, color = '#ffe08a') {
  const d = dir.clone().normalize();
  for (let i = 0; i < n; i++) {
    const v = d.clone().multiplyScalar(rand(1.8, 3.6)).add(_bv.set(rand(-0.7, 0.7), rand(0.2, 1.1), rand(-0.7, 0.7)));
    fxEmit(o, v, rand(0.045, 0.1), rand(0.55, 0.95), Math.random() < 0.6 ? color : '#fff8e8');
  }
  for (let i = 0; i < 7; i++) fxEmit(o, d.clone().multiplyScalar(rand(0.9, 1.6)).add(_bv.set(rand(-0.3, 0.3), rand(0, 0.4), rand(-0.3, 0.3))), rand(0.22, 0.38), rand(0.35, 0.6), '#fff6e0');
}
// 깨진 유리 조각
function fxShards(o, n = 26) {
  for (let i = 0; i < n; i++) fxEmit(o, _bv.set(rand(-1.4, 1.4), rand(1.2, 3.2), rand(-1.4, 1.4)).clone(), rand(0.03, 0.06), rand(0.4, 0.75), Math.random() < 0.5 ? '#e8f6ff' : '#ffffff');
}
// 머리 위 "펑" (머리 터지는 시늉)
function fxPop(o) {
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    fxEmit(o, _bv.set(Math.cos(a) * 1.6, 1.2 + Math.sin(a) * 1.2, rand(-0.5, 0.5)).clone(), rand(0.12, 0.2), 0.45, i % 2 ? '#ffe36b' : '#ffffff');
  }
}

function fxUpdate(dt) {
  if (!FXP.pts) return;
  const P = FXP.pos,
    ST = LAYOUT.stage;
  for (let i = 0; i < FXP.n; i++) {
    if (FXP.life[i] <= 0) continue;
    FXP.life[i] -= dt;
    const v = FXP.vel[i];
    v.y -= FXP.grav[i] * dt;
    v.multiplyScalar(Math.max(0, 1 - FXP.drag[i] * dt));
    if (FXP.drag[i] > 2) P[i * 3] += Math.sin(FXP.life[i] * 7 + i) * 0.35 * dt; // 색종이: 팔랑팔랑
    P[i * 3] += v.x * dt;
    P[i * 3 + 1] += v.y * dt;
    P[i * 3 + 2] += v.z * dt;
    const fy = P[i * 3 + 2] > ST.zFront && P[i * 3 + 2] < ST.zBack && P[i * 3] > ST.x0 && P[i * 3] < ST.x1 ? LAYOUT.stageY + 0.02 : 0.02;
    if (P[i * 3 + 1] < fy) {
      P[i * 3 + 1] = fy;
      v.y *= -0.2;
      v.x *= 0.5;
      v.z *= 0.5;
    }
    FXP.alpha[i] = clamp(FXP.life[i] / FXP.max[i] * 1.6, 0, 1);
    if (FXP.life[i] <= 0) {
      P[i * 3 + 1] = -50;
      FXP.alpha[i] = 0;
    }
  }
  const g = FXP.pts.geometry;
  g.attributes.position.needsUpdate = true;
  g.attributes.alpha.needsUpdate = true;
  g.attributes.size.needsUpdate = true;
  g.attributes.color.needsUpdate = true;
  FXP.mat.uniforms.scale.value = SC.renderer.getPixelRatio() * SC.H / (2 * Math.tan(SC.camera.fov * Math.PI / 360));
}

// ---------- 큰 장면들 ----------
function mouthWorld(p) {
  const hb = p.bones[BONE.head];
  hb.updateWorldMatrix(true, false);
  return V3(0, p.mouthP.y, p.mouthP.z + 0.03).applyMatrix4(hb.matrixWorld);
}

function thud(p, vol = 0.35) {
  if (AE.decoded) playBuf(AE.syn.stomp, AE.ctx.currentTime + 0.01, vol, AE.buses.crowd, {
    pan: clamp(p.root.position.x / 6, -0.9, 0.9),
    rate: 0.8
  });
}

function runBigScene(m, t, a, age, F) {
  const p = m.p,
    R = p.R,
    h = p.h;
  switch (a.k) {
    case 'freeze': {
      // 화들짝: 두 손이 가슴께로 튀어 오른 채 굳음
      crowdStill(p);
      p.c.lean = -0.12 * smoothstep(0, 0.25, age);
      sceneFace(p, age < 0.45 ? 'gasp' : 'jawdrop');
      const up = smoothstep(0, 0.2, age);
      p.reach('L', at(F, 0.25, -0.17, lerp(-0.22, 0.12, up)), null, null, 'spread');
      p.reach('R', at(F, 0.25, 0.17, lerp(-0.22, 0.12, up)), null, null, 'spread');
      break;
    }
    case 'slapHead': {
      // 양손으로 이마 탁 → 고개가 뒤로 젖혀진 채 굳음 → 손이 얼굴을 쓸어내리며 절레절레
      const fh = s => facePoint(p, s * R * 0.3, R * 0.62, R * 0.72);
      if (!a.slap && age > 0.14) {
        a.slap = true;
        if (AE.decoded && m.kind !== 'bar') playBuf(AE.syn.slap, AE.ctx.currentTime + 0.01, 0.12, AE.buses.crowd, {
          pan: clamp(p.root.position.x / 6, -0.9, 0.9),
          rate: 1.4
        });
      }
      if (age < 2.4) {
        sceneFace(p, age < 0.16 ? 'gasp' : 'jawdrop');
        p.c.lean = -0.36 * smoothstep(0.14, 0.45, age);
        p.c.look.copy(CROWD.me).add(_bv.set(0, 5 * smoothstep(0.14, 0.5, age), 0));
        p.reach('L', fh(1), null, null, 'flat');
        p.reach('R', fh(-1), null, null, 'flat');
      } else if (age < 4.2) {
        const k = smoothstep(2.4, 4.0, age);
        sceneFace(p, 'disbelief');
        p.c.disbelief = 1;
        p.c.lean = -0.1;
        p.reach('L', facePoint(p, R * lerp(0.3, 0.45, k), lerp(R * 0.62, -R * 0.8, k), R * 0.72), null, null, 'flat');
        p.reach('R', facePoint(p, -R * lerp(0.3, 0.45, k), lerp(R * 0.62, -R * 0.8, k), R * 0.72), null, null, 'flat');
      } else {
        sceneFace(p, 'stunlaugh');
        pointAtMe(p, F);
      }
      break;
    }
    case 'handsTop': {
      // 두 손을 머리 위에 얹고 입 벌린 채 굳음 (골대 맞았을 때 그 자세)
      crowdStill(p);
      for (const [sd, s] of [
        ['L', 1],
        ['R', -1]
      ]) {
        const pole = F.c.clone().addScaledVector(sideW(F, s), 0.9).addScaledVector(UPY, 0.7);
        p.reach(sd, facePoint(p, s * R * 0.32, R * 1.06, -R * 0.06), pole, null, 'flat');
      }
      if (age < 2.8) {
        sceneFace(p, 'jawdrop');
        p.c.lean = -0.07;
      } else if (age < 4.1) {
        sceneFace(p, 'disbelief');
        p.c.disbelief = 1;
      } else {
        sceneFace(p, 'stunlaugh');
        p.c.headTilt = 0.14;
      }
      break;
    }
    case 'mindBlown': {
      // 관자놀이에 손가락 → "펑" 하고 손이 튕겨 나감
      if (age < 0.95) {
        sceneFace(p, age < 0.3 ? 'focus' : 'wow');
        p.reach('L', facePoint(p, R * 1.02, R * 0.2, R * 0.12), null, null, 'point');
        p.reach('R', facePoint(p, -R * 1.02, R * 0.2, R * 0.12), null, null, 'point');
      } else if (age < 3.4) {
        if (!a.boom) {
          a.boom = true;
          fxPop(p.headWorld(_bv2).clone().add(_bv.set(0, R * 0.9, 0)));
        }
        const k = smoothstep(0.95, 1.12, age);
        sceneFace(p, age < 1.7 ? 'scream' : 'jawdrop');
        p.c.lean = -0.32 * k;
        p.c.look.copy(CROWD.me).add(_bv.set(0, 2.5 * k, 0));
        for (const [sd, s] of [
          ['L', 1],
          ['R', -1]
        ]) p.reach(sd, F.c.clone().addScaledVector(sideW(F, s), lerp(0.14, 0.62, k)).addScaledVector(UPY, lerp(0.3, 0.78, k)).addScaledVector(F.f, 0.06), null, null, 'spread');
      } else {
        sceneFace(p, 'stunlaugh');
        headHands(p);
        p.c.disbelief = 0.8;
      }
      break;
    }
    case 'spitTake': {
      // 마시다가 보고 술을 뿜음 → 콜록 → 손등으로 입 닦기
      const cup = makeCrowdProp(m, 'cup');
      cup.visible = age < 4.7;
      const from = at(F, 0.24, 0.16, -0.25),
        lip = facePoint(p, -R * 0.2, -R * 1.45, R * 1.05);
      if (age < 0.75) {
        p.reach('R', from.clone().lerp(lip, smoothstep(0, 0.65, age)), null, palmQ(p, 'R'), 'grip');
        sceneFace(p, 'focus');
      } else if (age < 2.6) {
        if (!a.spray) {
          a.spray = true;
          fxSpray(mouthWorld(p), F.f.clone().add(_bv.set(0, 0.12, 0)));
        }
        if (!a.spray2 && age > 1.35) {
          a.spray2 = true;
          fxSpray(mouthWorld(p), F.f.clone().add(_bv.set(0, 0.05, 0)), 16);
        }
        const cough = Math.sin((age - 0.75) * 11);
        p.c.lean = 0.3 + cough * 0.09;
        sceneFace(p, 'gasp');
        p.c.headShake = 0.25;
        p.reach('R', from.clone().lerp(lip, 0.3), null, palmQ(p, 'R'), 'grip');
        p.reach('L', facePoint(p, R * 0.1, -R * 0.9, R * 1.25), null, null, 'fist');
      } else {
        sceneFace(p, age < 3.6 ? 'disbelief' : 'stunlaugh');
        p.c.lean = 0.05;
        p.reach('R', from, null, palmQ(p, 'R'), 'grip');
        const w = Math.sin((age - 2.6) * 7) * 0.5 + 0.5;
        p.reach('L', facePoint(p, lerp(R * 0.6, -R * 0.4, w), -R * 0.75, R * 1.15), null, null, 'fist');
      }
      break;
    }
    case 'faint': {
      if (a.standing) {
        // 통나무처럼 뻣뻣하게 뒤로 넘어감 (옆 친구가 받아 주거나 못 받음)
        crowdStill(p);
        p.c.stand = 1;
        p.c.lookW = 0.25;
        p.reach('L', p.local(0.25, 0.74 * h, 0.03), null, null, 'flat');
        p.reach('R', p.local(-0.25, 0.74 * h, 0.03), null, null, 'flat');
        const fall = age < 0.5 ? 0 : Math.min(1, Math.pow((age - 0.5) / 0.55, 2));
        const rise = smoothstep(4.7, 5.6, age);
        let ang = -(a.caught ? 0.6 : 1.42) * fall;
        if (!a.caught && fall >= 1) ang += Math.sin(Math.min(1, (age - 1.05) / 0.3) * Math.PI) * 0.07;
        p.root.rotation.x = ang * (1 - rise);
        sceneFace(p, age < 0.45 ? 'jawdrop' : (rise > 0.3 ? 'disbelief' : 'out'));
        if (!a.thud && fall >= 1 && !a.caught) {
          a.thud = true;
          thud(p);
        }
      } else {
        // 앉은 채로 뒤로 넘어가 축 늘어짐
        const k = smoothstep(0.3, 0.9, age) * (1 - smoothstep(4.4, 5.2, age));
        p.c.lean = -0.55 * k;
        p.c.headTilt = 0.45 * k;
        p.c.lookW = 1 - k * 0.8;
        p.c.look.copy(p.local(0, 3.2, 0.4));
        if (k > 0.05) {
          p.reach('L', F.c.clone().addScaledVector(sideW(F, 1), 0.36).addScaledVector(UPY, -0.62).addScaledVector(F.f, -0.05), null, null, 'relax');
          p.reach('R', F.c.clone().addScaledVector(sideW(F, -1), 0.36).addScaledVector(UPY, -0.62).addScaledVector(F.f, -0.05), null, null, 'relax');
        }
        sceneFace(p, age < 0.35 ? 'jawdrop' : (age < 4.6 ? 'out' : 'disbelief'));
      }
      if (a.soul) soulPose(m, a, age);
      break;
    }
    case 'catch': {
      const f = a.friend;
      if (!f) break;
      const c = f.p.chestWorld(_bv2).clone();
      p.c.lean = 0.22;
      p.c.look.copy(f.p.headWorld(_bv3));
      sceneFace(p, age < 0.9 ? 'gasp' : (age < 4.2 ? 'disbelief' : 'stunlaugh'));
      if (age > 0.5 && age < 5.2) {
        p.reach('L', c.clone().addScaledVector(F.r, -0.13).add(_bv.set(0, -0.08, 0)), null, null, 'flat');
        p.reach('R', c.clone().addScaledVector(F.r, 0.13).add(_bv.set(0, -0.08, 0)), null, null, 'flat');
      }
      break;
    }
    case 'slideOff': {
      // 의자(스툴)에서 스르륵 미끄러져 바닥에 주저앉음
      p.c.stand = 0;
      p.c.slump = age > 0.25 && age < 4.3 ? 1 : 0;
      p.c.lean = age < 4.3 ? -0.22 : 0.08;
      sceneFace(p, age < 0.3 ? 'gasp' : (age < 3.8 ? (a.out ? 'out' : 'stunlaugh') : 'grin'));
      const k = smoothstep(0.3, 1.2, age) * (1 - smoothstep(3.9, 4.5, age));
      if (k > 0.05) {
        p.reach('L', F.c.clone().addScaledVector(sideW(F, 1), 0.3).addScaledVector(UPY, 0.28 * k).addScaledVector(F.f, 0.16), null, null, 'relax');
        p.reach('R', F.c.clone().addScaledVector(sideW(F, -1), 0.3).addScaledVector(UPY, 0.28 * k).addScaledVector(F.f, 0.16), null, null, 'relax');
      }
      if (age > 4.5) sceneClap(p, F, t);
      break;
    }
    case 'kneel': {
      // 무릎 꿇고 두 팔 쳐들기 → 엎드려 두 번 절
      p.c.stand = 1;
      p.c.kneel = age > 0.25 && age < 4.9 ? 1 : 0;
      if (age < 2.5) {
        sceneFace(p, 'ecstasy');
        const w = Math.sin(age * 5) * 0.06;
        for (const [sd, s] of [
          ['L', 1],
          ['R', -1]
        ]) p.reach(sd, F.c.clone().addScaledVector(sideW(F, s), 0.32 + w).addScaledVector(UPY, 0.72).addScaledVector(F.f, 0.12), null, null, 'spread');
        p.c.look.copy(CROWD.me).add(_bv.set(0, 1.5, 0));
      } else if (age < 4.5) {
        const bow = Math.max(0, Math.sin((age - 2.5) / 2.0 * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5);
        p.c.lean = 0.95 * bow;
        sceneFace(p, 'bliss');
        for (const [sd, s] of [
          ['L', 1],
          ['R', -1]
        ]) p.reach(sd, F.c.clone().addScaledVector(F.f, 0.5).addScaledVector(sideW(F, s), 0.18).addScaledVector(UPY, -0.5 * bow), null, null, 'flat');
      } else {
        sceneFace(p, 'grin');
        sceneClap(p, F, t, true);
      }
      break;
    }
    case 'shakeFriend': {
      // 옆 사람 멱살 잡고 흔들기 ("봤냐고!")
      const f = a.friend;
      if (!f) {
        headHands(p);
        sceneFace(p, 'scream');
        break;
      }
      const fc = frameOf(f.p).c,
        toward = fc.clone().sub(F.c).setY(0).normalize();
      const collar = fc.clone().add(_bv.set(0, 0.14, 0)).addScaledVector(toward, -0.09 + Math.sin(age * 19) * 0.07);
      if (age < 3.6) {
        p.reach('L', collar.clone().addScaledVector(F.r, -0.07), null, null, 'grip');
        p.reach('R', collar.clone().addScaledVector(F.r, 0.07), null, null, 'grip');
        p.c.lean = 0.12;
        sceneFace(p, 'scream');
        p.c.look.copy(Math.sin(age * 3) > -0.2 ? f.p.headWorld(_bv3) : CROWD.me);
      } else {
        sceneFace(p, 'stunlaugh');
        pointAtMe(p, F);
      }
      break;
    }
    case 'shaken': {
      const on = age < 3.6 ? 1 : 0;
      p.c.side = Math.sin(age * 19 + 1) * 0.17 * on;
      p.c.lean = Math.sin(age * 19) * 0.07 * on;
      sceneFace(p, on ? 'disbelief' : 'stunlaugh');
      break;
    }
    case 'walkAway': {
      // 뒤돌아 몇 걸음 → 머리 감싸 쥠 → 다시 돌아와서 또 봄
      p.c.stand = 1;
      const base = m.spot.yaw;
      let yawOff = 0,
        dist = 0,
        step = 0;
      if (age < 0.5) yawOff = Math.PI * smooth01(age / 0.5);
      else if (age < 1.8) {
        yawOff = Math.PI;
        dist = smooth01((age - 0.5) / 1.3);
        step = 1;
      } else if (age < 3.0) {
        yawOff = Math.PI;
        dist = 1;
      } else if (age < 3.5) {
        yawOff = Math.PI * (1 - smooth01((age - 3.0) / 0.5));
        dist = 1;
      } else if (age < 4.8) {
        dist = 1 - smooth01((age - 3.5) / 1.3);
        step = 1;
      }
      p.root.rotation.y = base + yawOff;
      m.walkOff = (m.walkOff || new THREE.Vector3()).set(-Math.sin(base), 0, -Math.cos(base)).multiplyScalar(1.1 * dist);
      p.c.step = step;
      if (age >= 1.8 && age < 3.0) {
        headHands(p);
        p.c.disbelief = 1;
        sceneFace(p, 'disbelief');
        p.c.look.copy(p.local(0, 1.4, 3));
      } else if (age < 4.8) {
        sceneFace(p, 'jawdrop');
        p.c.look.copy(age < 1.8 ? p.local(0, 1.2, 3) : CROWD.me);
      } else {
        sceneFace(p, 'stunlaugh');
        pointAtMe(p, F);
      }
      break;
    }
    case 'phoneDrop': {
      // 찍다가 넋이 나가 폰을 떨어뜨림
      if (age < 2.3) {
        phonePose(m, F, t, false);
        break;
      }
      if (!m.drop) {
        const ph = makeCrowdProp(m, 'phone');
        m.drop = {
          pos: ph.position.clone(),
          q: ph.quaternion.clone(),
          vel: F.f.clone().multiplyScalar(0.4).add(_bv.set(0, 0.7, 0)),
          spin: rand(6, 10)
        };
      }
      sceneFace(p, age < 3 ? 'gasp' : 'jawdrop');
      cheekHands(p);
      p.c.lean = -0.08;
      if (age > 4.3) {
        p.c.lean = 0.45;
        p.c.look.copy(m.drop.pos);
        p.rest('L');
        p.reach('R', m.drop.pos.clone().add(_bv.set(0, 0.22, 0)), null, null, 'relax');
      }
      break;
    }
    case 'dizzy': {
      // 널뛰기 구경하다 어지러워 비틀
      const k = Math.exp(-age * 0.5);
      p.c.side = Math.sin(age * 2.6) * 0.32 * k;
      p.c.headTilt = Math.sin(age * 2.6 + 0.6) * 0.3 * k;
      p.c.lean = Math.sin(age * 1.9) * 0.1 * k;
      sceneFace(p, 'dizzy');
      p.c.step = p.s.stand > 0.7 ? 0.4 * k : 0;
      p.reach('L', at(F, 0.1, -0.5, -0.05), null, null, 'spread');
      p.reach('R', at(F, 0.1, 0.5, -0.05), null, null, 'spread');
      p.c.look.copy(CROWD.me).add(_bv.set(Math.sin(age * 3) * 2, Math.cos(age * 2.4) * 1.5, 0));
      break;
    }
    case 'puffHold': {
      // 안 끝나는 음: 같이 숨 참기 (머리가 풍선처럼 부풀고 얼굴이 빨개짐)
      crowdStill(p, 0);
      p.c.puff = ENDL.puffK * (m.puffMul || 1);
      sceneFace(p, 'puff');
      if (m.puffStyle === 0) {
        p.reach('L', facePoint(p, R * 0.25, -R * 0.55, R * 1.2), null, null, 'flat');
        p.reach('R', facePoint(p, -R * 0.15, -R * 0.65, R * 1.25), null, null, 'flat');
      } else if (m.puffStyle === 1) {
        p.reach('L', at(F, 0.2, -0.12, 0.05), null, null, 'fist');
        p.reach('R', at(F, 0.2, 0.12, 0.05), null, null, 'fist');
      } else cheekHands(p);
      faceTint(p, ENDL.level);
      break;
    }
    case 'soulGrab': {
      // 친구 혼이 빠져나가는 걸 붙잡으려 허우적
      const s = a.soul;
      crowdStill(p);
      p.c.lean = 0.1;
      if (s) {
        p.c.look.copy(s);
        const g = Math.sin(age * 11) > 0;
        p.reach('R', s.clone().add(_bv.set(0, -0.12 + Math.sin(age * 9) * 0.05, 0)), null, null, g ? 'grip' : 'spread');
        p.reach('L', s.clone().add(_bv.set(0, -0.2 - Math.sin(age * 9) * 0.05, 0)), null, null, g ? 'spread' : 'grip');
        sceneFace(p, 'gasp');
      } else {
        p.c.look.copy(a.friend ? a.friend.p.headWorld(_bv3) : CROWD.me);
        sceneFace(p, age < 1 ? 'gasp' : 'stunlaugh');
      }
      break;
    }
    default:
      runHypeScene(m, t, a, age, F);
  }
}
// 장면 끝: 자세 원래대로
function resetBigPose(m) {
  const p = m.p;
  p.root.rotation.x = 0;
  p.c.kneel = 0;
  p.c.slump = 0;
  p.c.puff = 0;
  p.c.lookW = 1;
  p.c.step = 0;
  p.c.hipSway = 0;
  if (m.walkOff) m.walkOff.set(0, 0, 0);
  m.liftY = 0;
  m.offK = 1;
  if (m.spot) p.root.rotation.y = m.spot.yaw;
  if (m.drop) {
    m.drop = null;
  }
  faceTint(p, 0);
}
// 얼굴 색 (숨 참기): 0 보통 ~ 3 보랏빛. 머리·턱에 붙은 피부색 정점만 물들임 (눈·입·머리카락은 그대로)
const _tintRed = new THREE.Color('#ff3a2a'),
  _tintPurple = new THREE.Color('#c0306e');
// 얼굴 살색 꼭짓점 목록 (사람마다 한 번). 전에는 숨 참는 장면이 시작될 때 관객 전원 것을 한꺼번에 찾느라 그 순간 화면이 멈칫했음 → 첫 화면에서 미리 해 둠
function faceTintPrep(p) {
  if (p.tintIdx || !p.mesh) return;
  const geo = p.mesh.geometry,
    col = geo.getAttribute('color');
  if (!col) return;
  const SI = geo.getAttribute('skinIndex').array,
    SW = geo.getAttribute('skinWeight').array,
    C = col.array;
  const skin = _tintSkin.set((p.look && p.look.skin) || '#f6c9a2'),
    idx = [],
    hd = BONE.head,
    jw = BONE.jaw;
  for (let i = 0, n = col.count; i < n; i++) {
    const a = i * 4;
    let w = 0;
    if (SI[a] === hd || SI[a] === jw) w += SW[a];
    if (SI[a + 1] === hd || SI[a + 1] === jw) w += SW[a + 1];
    if (SI[a + 2] === hd || SI[a + 2] === jw) w += SW[a + 2];
    if (SI[a + 3] === hd || SI[a + 3] === jw) w += SW[a + 3];
    if (w < 0.5) continue;
    const dr = C[i * 3] - skin.r,
      dg = C[i * 3 + 1] - skin.g,
      db = C[i * 3 + 2] - skin.b;
    if (dr * dr + dg * dg + db * db < 0.02) idx.push(i);
  }
  p.tintIdx = idx;
  p.tintBase = new Float32Array(idx.length * 3);
  for (let j = 0; j < idx.length; j++) {
    const v = idx[j] * 3;
    p.tintBase[j * 3] = C[v];
    p.tintBase[j * 3 + 1] = C[v + 1];
    p.tintBase[j * 3 + 2] = C[v + 2];
  }
  p.tintFrom = idx.length ? idx[0] : 0;
  p.tintTo = idx.length ? idx[idx.length - 1] : 0; // 색을 바꾼 뒤 이 구간만 다시 올림
  if (p.tintLv == null) p.tintLv = 0;
}
const _tintSkin = new THREE.Color();

function faceTint(p, lv) {
  lv = clamp(Math.round(lv), 0, 3);
  if (p.tintLv === lv || !p.mesh) return;
  if (!p.tintIdx && lv === 0) {
    p.tintLv = 0;
    return;
  }
  const geo = p.mesh.geometry,
    col = geo.getAttribute('color');
  if (!col) return;
  if (!p.tintIdx) faceTintPrep(p);
  const amt = [0, 0.3, 0.5, 0.58][lv],
    tg = lv === 3 ? _tintPurple : _tintRed,
    B = p.tintBase;
  for (let j = 0; j < p.tintIdx.length; j++) col.setXYZ(p.tintIdx[j], lerp(B[j * 3], tg.r, amt), lerp(B[j * 3 + 1], tg.g, amt), lerp(B[j * 3 + 2], tg.b, amt));
  if (p.tintIdx.length) {
    col.addUpdateRange(p.tintFrom * 3, (p.tintTo - p.tintFrom + 1) * 3);
    col.needsUpdate = true;
  }
  p.tintLv = lv;
}
// 큰 장면 바로 걸기 (쿨다운·동시 인원 제한 무시: 큰 순간 전용)
function forceScene(m, k, delay = 0, extra = {}) {
  if (!m || m.override) return;
  const t = NOW.t;
  // 친구가 필요한 장면은 친구가 비어 있을 때만
  if ((k === 'shakeFriend') && (!m.friend || m.friend.override || m.friend.p.root.position.distanceTo(m.p.root.position) > 1.15)) k = 'handsTop';
  if (k === 'spitTake' && m.kind === 'front') k = 'slapHead';
  if ((k === 'slideOff') && m.kind === 'front') k = 'kneel';
  if (k === 'soulFaint') {
    k = 'faint';
    extra = {
      ...extra,
      soul: true
    };
  }
  if (k === 'chairDance' && m.kind !== 'seat') k = 'towelSpin';
  if (k === 'walkAway' && m.kind !== 'front') k = 'mindBlown';
  if (k === 'kneel' && m.kind === 'bar') k = 'slideOff';
  m.pending = {
    k,
    at: t + delay,
    dur: CROWD_SCENES[k] || 5,
    extra: {
      ...extra,
      force: true
    }
  };
}
// 기절: 서 있으면 친구가 받아 줄 수도
function startFaint(m) {
  const a = m.act;
  a.standing = m.p.s.stand > 0.6;
  if (a.standing && m.friend && !m.friend.override && m.friend.p.s.stand > 0.6 && m.friend.p.root.position.distanceTo(m.p.root.position) < 1.25 && !(m.friend.act && m.friend.act.story && m.friend.act.k !== 'freeze') && Math.random() < 0.6) {
    a.caught = true;
    m.friend.pending = null;
    m.friend.act = {
      k: 'catch',
      t0: NOW.t,
      until: NOW.t + a.until - NOW.t,
      story: true,
      friend: m,
      seat: 1
    };
  } else if (a.soul && m.friend && !m.friend.override && !m.friend.pending && !(m.friend.act && m.friend.act.story && m.friend.act.k !== 'freeze') && m.friend.p.root.position.distanceTo(m.p.root.position) < 1.3) {
    m.friend.act = {
      k: 'soulGrab',
      t0: NOW.t,
      until: a.until - 0.6,
      story: true,
      friend: m,
      seat: m.friend.p.s.stand > 0.7 ? 1 : 0
    };
  }
}

// ---------- 고개가 음을 따라감 (도약·널뛰기·폴·글리산도) ----------
function crowdFollowY(m) {
  let y = 0;
  const t = NOW.t;
  const J = CROWD.jerk;
  if (J && t < J.t0 + J.dur) {
    const a = (t - J.t0) / J.dur;
    y += J.dir * J.amp * Math.sin(Math.min(1, a * 2.6) * Math.PI * 0.5) * (1 - smoothstep(0.5, 1, a));
  }
  if ((CROWD.followUntil || 0) > t && TP.cur != null) y += clamp((TP.cur - 66) / 15, -1.4, 1.6) * 2.8 * (m.followK || 1);
  return y;
}

function crowdJerk(dir, amp = 3.2, dur = 0.9) {
  CROWD.jerk = {
    t0: NOW.t,
    dir,
    amp,
    dur
  };
}

// ---------- 바텐더: 잔을 떨어뜨림 ----------
function bartenderDrop(delay = 0) {
  const b = CROWD.bartender;
  if (!b) return;
  b.pending = null;
  b.dropAt = NOW.t + delay;
}

function runBartenderDrop(m, t, dt, beat) {
  const p = m.p,
    age = t - m.act.t0,
    F = frameOf(p);
  p.c.look.copy(CROWD.me);
  crowdStill(p, 0.05);
  m.props.cloth.visible = false;
  if (age < 0.28) {
    p.reach('R', p.local(-0.11, 1.3, 0.3), null, null, 'grip');
    p.reach('L', p.local(0.03, 1.34, 0.31), null, null, 'flat');
    sceneFace(p, 'gasp');
    m.props.cup.visible = true;
  } else {
    if (!m.cupFree) {
      const c = m.props.cup;
      m.cupFree = {
        pos: c.position.clone(),
        vel: _bv.set(rand(-0.2, 0.2), 0.6, 0.35).clone(),
        broke: false
      };
    }
    const C = m.cupFree;
    if (!C.broke) {
      C.vel.y -= 9.8 * dt;
      C.pos.addScaledVector(C.vel, dt);
      m.props.cup.position.copy(C.pos);
      m.props.cup.rotation.x += dt * 9;
      if (C.pos.y < 0.95) {
        C.broke = true;
        m.props.cup.visible = false;
        if (AE.decoded) glassCrash(AE.ctx.currentTime + 0.02, {
          pan: clamp(p.root.position.x / 6, -0.9, 0.9),
          vol: 0.55
        });
        fxShards(C.pos.clone().add(_bv.set(0, 0.2, 0)));
      }
    }
    if (age < 3.2) {
      headHands(p);
      sceneFace(p, age < 1.6 ? 'jawdrop' : 'disbelief');
      p.c.disbelief = age > 1.6 ? 1 : 0;
    } else {
      p.c.lean = 0.27;
      p.reach('L', p.local(0.22, 1.14, 0.43), null, null, 'flat');
      p.reach('R', p.local(-0.22, 1.14, 0.43), null, null, 'flat');
      sceneFace(p, 'stunlaugh');
    }
  }
  p.update(dt, t, beat);
  if (!m.cupFree) updateCrowdProps(m, t);
}

// ---------- 창문 밖 구경꾼 (필살기 쓸 때마다 늘어남) ----------
const WINP = {
  list: [],
  slots: [],
  pool: []
};

function initWindowSlots() {
  const R = LAYOUT.room,
    L = [-5.6, -8.6, -11.6],
    Rr = [-7.2, -10.6];
  const s = [];
  for (let i = 0; i < 3; i++) {
    if (L[i] != null)
      for (const o of [-0.36, 0.38]) s.push({
        x: R.x0 - 0.3,
        z: L[i] + o,
        yaw: Math.PI / 2,
        side: 1
      });
    if (Rr[i] != null)
      for (const o of [0.36, -0.38]) s.push({
        x: R.x1 + 0.3,
        z: Rr[i] + o,
        yaw: -Math.PI / 2,
        side: -1
      });
  }
  WINP.slots = s;
}
// 창밖 사람은 미리 만들어 숨겨 두고(공연 중에 새로 만들면 그 순간 화면이 멈칫함) 필요할 때 꺼내 세움
function windowPerson(i) {
  if (WINP.pool[i]) return WINP.pool[i];
  const sl = WINP.slots[i],
    look = randomLook(700 + i * 13);
  look.h = rand(0.98, 1.08);
  const p = new Person(look, { lod: 2 });
  p.root.position.set(sl.x, 0.34, sl.z);
  p.root.rotation.y = sl.yaw;
  p.mesh.castShadow = false; // 바깥 계단 위 (안쪽 사람들 머리 너머로 보이게)
  p.c.groove = 0;
  p.c.nod = 0;
  p.c.sway = 0;
  p.root.visible = false;
  SC.scene.add(p.root);
  return WINP.pool[i] = p;
}

function addWindowFaces(n) {
  for (let k = 0; k < n && WINP.list.length < WINP.slots.length; k++) {
    const i = WINP.list.length,
      p = windowPerson(i);
    p.root.visible = true;
    WINP.list.push({
      p,
      sl: WINP.slots[i],
      style: i % 3,
      born: NOW.t,
      animDt: Math.random() / 15
    });
    p.update(0, NOW.t, 0);
  }
}

function updateWindowFaces(dt, t, beat) {
  const f = REACT.frenzy;
  for (const w of WINP.list) {
    w.animDt += dt;
    if (w.animDt < 1 / 15) continue;
    const step = Math.min(w.animDt, 0.1);
    w.animDt = 0;
    const p = w.p,
      sl = w.sl,
      R = p.R;
    p.c.look.copy(CROWD.me);
    // 유리에 손바닥 붙이기 / 눈 옆에 손 모으기 / 한 손 흔들기
    const gx = sl.x + sl.side * 0.48,
      hy = p.headWorld(_bv2).y;
    if (w.style === 0) {
      p.reach('L', V3(gx, hy - 0.12, sl.z + sl.side * 0.3), null, null, 'flat');
      p.reach('R', V3(gx, hy - 0.12, sl.z - sl.side * 0.3), null, null, 'flat');
    } else if (w.style === 1) {
      p.reach('L', facePoint(p, R * 0.95, R * 0.25, R * 0.75), null, null, 'flat');
      p.reach('R', facePoint(p, -R * 0.95, R * 0.25, R * 0.75), null, null, 'flat');
    } else {
      p.reach('L', V3(gx, hy - 0.1, sl.z + sl.side * 0.25), null, null, 'flat');
      p.reach('R', V3(gx, hy + 0.25 + Math.sin(t * 8) * 0.05, sl.z - sl.side * (0.3 + Math.sin(t * 7) * 0.12)), null, null, 'flat');
    }
    if (!p.exUntil) p.setBase(f > 0.6 ? pick(['jawdrop', 'scream', 'wow']) : (f > 0.3 ? 'wow' : 'smile'));
    p.c.bounce = f > 0.7 ? 0.6 : 0;
    p.c.groove = f * 0.6;
    p.update(step, t, beat);
  }
}
// 뒤쪽에 서서 보는 사람 (소문 듣고 들어옴)
const BACKP = {
  n: 0,
  pool: [],
  spots: [
    [-5.6, -12.75],
    [5.5, -12.8],
    [-3.9, -12.95],
    [3.6, -12.9],
    [-1.4, -12.85],
    [1.6, -12.95],
    [-6.3, -11.2],
    [6.4, -11.4]
  ]
};

function backPerson(i) {
  if (BACKP.pool[i]) return BACKP.pool[i];
  const [x, z] = BACKP.spots[i], look = randomLook(500 + (i + 1) * 17);
  const p = new Person(look, {
    seated: false,
    lod: 2
  });
  p.root.position.set(x, 0, z);
  p.root.rotation.order = 'YXZ';
  p.root.rotation.y = Math.atan2(0 - x, -2.5 - z);
  p.mesh.castShadow = false;
  p.root.visible = false;
  SC.scene.add(p.root);
  return BACKP.pool[i] = p;
}

function addBackCrowd(n) {
  for (let k = 0; k < n && BACKP.n < BACKP.spots.length; k++) {
    const i = BACKP.n++,
      [x, z] = BACKP.spots[i],
      yaw = Math.atan2(0 - x, -2.5 - z);
    const p = backPerson(i);
    p.root.visible = true;
    const m = {
      p,
      kind: 'back',
      spot: {
        pos: V3(x, 0, z),
        yaw
      },
      watch: Math.random() * 0.5,
      wild: Math.random(),
      act: null,
      nextAct: 0,
      friend: null,
      far: true,
      standWish: 1,
      standNow: 1,
      phase0: Math.random() * 2,
      nextScene: NOW.t + 3,
      sceneCount: 0,
      pending: null,
      props: {},
      standDelay: 0,
      standThreshold: 0,
      animDt: Math.random() / 20,
      signature: 'mouthFreeze',
      followK: rand(0.7, 1.2)
    };
    p.c.stand = 1;
    p.update(0, NOW.t, 0);
    CROWD.list.push(m);
    let best = null,
      bd = 1.4;
    for (const o of CROWD.list) {
      if (o === m) continue;
      const d = o.p.root.position.distanceTo(p.root.position);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    m.friend = best;
  }
}

// ===== 77_special.js =====
// ===================== 더블 트럼펫 필살기 =====================
// 게이지: 내 솔로로 차오름 (첫 번째는 빨리). 버튼(또는 Shift)을 한 번 누르면 왼손이 두 번째 트럼펫을 들고, 다시 누르면 내림.
// 들고 부는 동안 두 번째 트럼펫이 화음을 냄 (게이지는 소리를 내는 동안만 닳고, 다 닳으면 저절로 내림). 가득 찬 게이지로 처음 불 때 큰 장면.
// 두 대 소리가 작은 스피커(폰)에서 지지직 찢어지던 문제:
//  - 두 번째 트럼펫이 리드와 거의 같은 크기로 얹혀서 트럼펫 음량이 한 대일 때보다 4~6dB 커졌고,
//  - 평균율 3도 + 8센트 어긋남이라 두 소리의 배음이 계속 부딪혀 소리 크기가 빠르게 출렁였음.
// 그래서: 리드와의 음정을 순정률로 맞추고, 두 번째는 조금 어둡고 작게, 두 대를 부는 동안은 트럼펫 전체를 살짝 내려 합친 크기를 한 대일 때와 비슷하게 둠.
const SP_JI = {
  3: -15.6,
  4: 13.7,
  5: 2.0,
  8: -13.7,
  9: 15.6
}; // 리드보다 n반음 아래 음을 순정 음정으로 만드는 보정(센트)
const SP_LEVEL = 0.62,
  SP_DUCK = 0.78,
  SP_CUT = 5000;
const spTune = (m, hm) => SP_JI[Math.round(m - hm)] || 0;

function spFilter() {
  const f = AE.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.5;
  f.frequency.value = SP_CUT;
  return f;
}

function spRetune(v, m, hm, t, now) {
  const d = v && v.src.detune;
  if (!d) return;
  const c = spTune(m, hm);
  if (now) d.setValueAtTime(c, t);
  else d.setTargetAtTime(c, t, 0.004);
}
const SPX = {
  g: 0,
  held: false,
  active: false,
  k: 0,
  duck: 1,
  firstCharge: true,
  voice2: null,
  pan: null,
  harm: null,
  lastRevoiceT: -99,
  revoiceDue: false,
  pieceDue: false,
  pieces: 0,
  pieceT: 0,
  raisedEvt: false,
  hush: null,
  boomAt: 0,
  boomDone: true,
  uiG: -1
};

function spInitAudio() {
  const ctx = AE.ctx;
  SPX.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  if (SPX.pan.pan) SPX.pan.pan.value = -0.3;
  SPX.pan.connect(TP.in);
}
// 두 번째 트럼펫 음: 보정 모드는 지금 화음에 맞는 3도(없으면 6도) 아래, 자유 모드는 4도 아래 평행
function harmFor(m, t) {
  if (TP.mode === 'free' && !AUTO.on) return m - 5;
  const ch = chordAtTime(t + 0.01), r = Math.round(m);
  for (const d of [3, 4]) if (isChordTone(r - d, ch)) return r - d;
  for (const d of [3, 4]) if (inSet(r - d, ch, 'S')) return r - d;
  for (const d of [5, 8, 9]) if (isChordTone(r - d, ch)) return r - d;
  return r - 5;
}

function spVoiceStart(t, m, lvl) {
  if (!AE.ctx || !SPX.pan) return;
  spVoiceStop(t, 0.02);
  const hm = harmFor(m, t), s = nearestSample('T', hm);
  if (!s) return;
  const v = new SusVoice(AE.ctx, s, hm, t, SPX.pan, {
    level: lvl * SP_LEVEL,
    fadeIn: 0.012,
    offset: s.start + 0.01,
    filter: spFilter()
  });
  spRetune(v, m, hm, t, true);
  SPX.voice2 = v;
  SPX.harm = hm;
  SPX.lastRevoiceT = t;
  SPX.revoiceDue = false;
}

function spVoiceMove(t, m, kind) {
  const v = SPX.voice2;
  if (!v || v.dead) return;
  const hm = harmFor(m, t);
  if (hm === SPX.harm && TP.mode !== 'free' && !SPX.revoiceDue) {
    spRetune(v, m, hm, t);
    return;
  } // 리드만 움직여 음정 간격이 바뀐 경우: 조율만 다시
  SPX.harm = hm;
  const s = Math.abs(hm - v.s.m) > 5 ? nearestSample('T', hm) : null;
  SPX.revoiceDue = !!s && s !== v.s;
  // 음정은 즉시 따라가고, 샘플 교체만 첫 번째 트럼펫과 같은 간격으로 제한.
  if (SPX.revoiceDue && t - SPX.lastRevoiceT >= (TP.mode === 'free' ? 0.1 : 0.08)) {
    const nv = new SusVoice(AE.ctx, s, hm, t, SPX.pan, {
      level: v.level,
      fadeIn: 0.02,
      offset: Math.min(s.start + 0.12, s.ls != null ? s.ls - 0.05 : 1),
      filter: spFilter()
    });
    spRetune(nv, m, hm, t, true);
    v.glideTo(hm, t, 0.02);
    spRetune(v, m, hm, t);
    v.release(t, 0.03);
    SPX.voice2 = nv;
    SPX.lastRevoiceT = t;
    SPX.revoiceDue = false;
  } else {
    if (kind === 'gliss' || kind === 'magnet' || kind === 'slide') v.glideTo(hm, t, 0.03);
    else v.stepTo(hm, t);
    spRetune(v, m, hm, t);
  }
}

function spVoiceStop(t, rel = 0.06, flick = null) {
  const v = SPX.voice2;
  SPX.voice2 = null;
  SPX.revoiceDue = false;
  if (!v || v.dead) return;
  if (flick === 'fall') {
    v.bend(-pick([7, 9]), t, 0.34);
    v.vibrato(0, t, 0.02);
    v.release(t + 0.16, 0.24);
  } else if (flick === 'doit') {
    v.bend(5, t, 0.2);
    v.release(t + 0.1, 0.16);
  } else v.release(t, rel);
}

function spPress(on) {
  if (on && !SPX.held && SPX.g < 0.02) {
    const el = UI.el.special;
    if (el) {
      el.classList.remove('nope');
      void el.offsetWidth;
      el.classList.add('nope');
    }
    return;
  }
  SPX.held = !!on;
}
// 한 번 누르면 켜고, 다시 누르면 끔
function spToggle() {
  spPress(!SPX.held);
}

function spUpdate(dt) {
  const now = AE.ctx ? AE.ctx.currentTime : 0,
    R = REACT;
  const playing = GAME.phase === 'play' && UI.playing && MUS.running;
  // 충전: 내 솔로 중 소리를 내는 동안
  if (!SPX.active && SPX.g < 1 && playing && R.meSolo && meActive(now)) {
    const sec = SPX.firstCharge ? 13 : 40;
    SPX.g = Math.min(1, SPX.g + dt / sec * (0.65 + 0.35 * R.heat / 100));
    if (SPX.g >= 1) SPX.pieceDue = true;
  }
  // 발동 · 끝
  if (GAME.state === 'paused') {
    spUI();
    return;
  } // 멈춘 동안은 켠 상태 그대로
  if (SPX.held && playing && SPX.g > 0.02 && !SPX.active) {
    SPX.active = true;
    SPX.raisedEvt = false;
    if (TP.blowing && TP.voice) spVoiceStart(now + 0.01, TP.cur, levelFor(TP.cur));
  }
  if (SPX.active) {
    if (meActive(now)) SPX.g -= dt / (8 * 4 * curSpb());
    if (SPX.g <= 0 || !SPX.held || !playing) {
      SPX.active = false;
      SPX.held = false;
      if (SPX.g <= 0.02) {
        SPX.g = 0;
        SPX.firstCharge = false;
        SPX.pieceDue = false;
      }
      if (AE.ctx) spVoiceStop(now + 0.005, 0.08);
    }
  }
  if (SPX.held && !SPX.active) SPX.held = false;
  // 두 대를 부는 동안은 트럼펫 전체를 살짝 내림 (두 소리를 합친 크기가 한 대일 때와 비슷하게)
  const duck = SPX.active ? SP_DUCK : 1;
  if (SPX.duck !== duck && TP.in && AE.ctx) {
    SPX.duck = duck;
    TP.in.gain.setTargetAtTime(duck, now, 0.04);
  }
  // 손가락이 멈춰도 보류한 샘플 교체는 마무리. 소리를 끈 뒤에는 다시 만들지 않음.
  if (SPX.active && playing && TP.blowing && SPX.revoiceDue && now + 0.003 - SPX.lastRevoiceT >= (TP.mode === 'free' ? 0.1 : 0.08)) spVoiceMove(now + 0.003, TP.cur, 'slide');
  SPX.k = damp(SPX.k, SPX.active ? 1 : 0, SPX.active ? 7 : 5, dt);
  // 들어 올린 순간: 앞줄이 먼저 알아챔
  if (SPX.active && SPX.k > 0.85 && !SPX.raisedEvt) {
    SPX.raisedEvt = true;
    reactEvent('specialRaise', {});
  }
  // 두 대로 처음 부는 순간: 큰 장면
  if (SPX.active && SPX.pieceDue && SPX.k > 0.8 && TP.blowing && R.meSolo) {
    SPX.pieceDue = false;
    specialSetPiece();
  }
  if (!SPX.boomDone && NOW.t > SPX.boomAt + 1.6) specialBoom();
  // 필살기 동안 밴드는 더블타임
  if (SPX.active && SPX.pieces && NOW.t - SPX.pieceT < 40) MUS.doubleUntil = Math.max(MUS.doubleUntil || 0, now + curSpb() * 4);
  spUI();
}

function spUI() {
  const el = UI.el.special;
  if (!el) return;
  const g = clamp(SPX.g, 0, 1);
  if (Math.abs(SPX.uiG - g) > 0.004) {
    el.style.setProperty('--g', (g * 100).toFixed(1) + '%');
    SPX.uiG = g;
  }
  el.classList.toggle('ready', g >= 0.999 && !SPX.active);
  el.classList.toggle('on', SPX.active);
  if (SPX.uiOn !== SPX.active) {
    SPX.uiOn = SPX.active;
    el.setAttribute('aria-pressed', SPX.active ? 'true' : 'false');
  }
}
// 큰 장면: 밴드가 끊기고 객석이 "헉" → 정적 → 앞줄부터 뒤로 기절초풍 → 밴드가 돌아오며 폭발
function specialSetPiece() {
  const n = ++SPX.pieces,
    t0 = NOW.t,
    now = AE.ctx.currentTime,
    R = REACT;
  SPX.pieceT = t0;
  R.heat = 100;
  R.peak = 100;
  R.songPeak = Math.max(R.songPeak, 100);
  R.soloPeak = 100;
  R.soloTime = Math.max(R.soloTime, 22);
  R.frenzy = Math.max(R.frenzy, 0.95);
  R.awes = Math.max(R.awes, 2);
  const S = MUS.song;
  if (S && S.phase === 'solo' && S.floor === 'me' && !S.brk) {
    S.brk = {
      from: S.abs,
      to: S.abs + 1,
      special: true
    };
    R.breakUsed = true;
  }
  reactEvent('special', { n });
  crowdGasp(now + 0.06, 30, 1.15);
  SPX.hush = {
    until: t0 + (n === 1 ? 2.6 : 1.8)
  };
  SPX.boomAt = t0 + (n === 1 ? 4.2 : 3.2);
  SPX.boomDone = false;
  // 지금 하던 장면 끊고 일단 굳음
  const list = CROWD.list.filter(m => !m.override && m.p.root.visible);
  const sorted = list.slice().sort((a, b) => b.p.root.position.z - a.p.root.position.z);
  const pools = {
    front: ['slapHead', 'handsTop', 'kneel', 'faint', 'mindBlown', 'walkAway', 'shakeFriend', 'phoneDrop', 'slapHead', 'handsTop'],
    seat: ['spitTake', 'slideOff', 'soulFaint', 'slapHead', 'mindBlown', 'shakeFriend', 'handsTop', 'spitTake', 'slideOff', 'faint'],
    bar: ['slideOff', 'spitTake', 'handsTop'],
    back: ['slapHead', 'handsTop', 'mindBlown'],
  };
  const cap = {
    faint: n === 1 ? 3 : 2,
    soulFaint: 2,
    kneel: 3,
    walkAway: 2,
    spitTake: 3,
    slideOff: 3,
    phoneDrop: 2,
    shakeFriend: 3
  };
  const used = {},
    idx = {
      front: randi(0, 9) + n * 3,
      seat: randi(0, 9) + n * 2,
      bar: n,
      back: n
    };
  const taken = new Set(),
    N = sorted.length,
    gap = n === 1 ? 0.9 : 0.5,
    span = n === 1 ? 2.5 : 1.9;
  sorted.forEach((m, i) => {
    if (taken.has(m)) return;
    const delay = gap + (i / Math.max(1, N - 1)) * span + rand(0, 0.25);
    let k = null;
    const pool = pools[m.kind] || pools.front;
    for (let tries = 0; tries < pool.length && !k; tries++) {
      const c = pool[idx[m.kind] % pool.length];
      idx[m.kind]++;
      if ((used[c] || 0) >= (cap[c] || 99)) continue;
      if (c === 'shakeFriend' && (!m.friend || taken.has(m.friend) || m.friend.override || m.friend.p.root.position.distanceTo(m.p.root.position) > 1.15)) continue;
      if (c === 'walkAway' && m.p.s.stand < 0.6) continue;
      k = c;
    }
    k = k || 'slapHead';
    used[k] = (used[k] || 0) + 1;
    m.pending = null;
    if (m.reserved) m.converted = true;
    m.act = {
      k: 'freeze',
      t0: NOW.t,
      until: t0 + delay,
      story: true,
      seat: m.p.s.stand > 0.7 ? 1 : 0
    };
    forceScene(m, k, delay);
    if (k === 'shakeFriend') {
      taken.add(m.friend);
      m.friend.pending = null;
      m.friend.act = {
        k: 'freeze',
        t0: NOW.t,
        until: t0 + delay + 0.05,
        story: true,
        seat: m.friend.p.s.stand > 0.7 ? 1 : 0
      };
    }
  });
  bartenderDrop(n === 1 ? gap + span + 0.25 : rand(1.2, 2.6));
  // 소문: 창문 밖·뒤쪽에 사람이 늘어남
  addWindowFaces(n === 1 ? 2 : 3);
  addBackCrowd(2);
  // 밴드
  DIR.drPhone = {
    t0,
    until: t0 + 10
  };
  if (BAND.pn) BAND.pn.standUntil = t0 + 7.5;
  if (BAND.tb) BAND.tb.slapUntil = t0 + 3.2;
  MUS.pianoRestUntil = now + 7.5;
}

function specialBoom() {
  if (SPX.boomDone) return;
  SPX.boomDone = true;
  SPX.hush = null;
  const now = AE.ctx.currentTime,
    R = REACT;
  R.burst = {
    kind: 'ovation',
    owner: 'me',
    t: NOW.t,
    until: NOW.t + 9,
    k: 1.4,
    energy: 1,
    fade: 3
  };
  for (const m of CROWD.list)
    if (m.p.s.stand > 0.6) m.standHoldUntil = R.burst.until;
  for (let i = 0; i < 5; i++) scream(now + 0.05 + i * rand(0.12, 0.3), {
    vol: rand(0.16, 0.24)
  });
  crowdWhoops(12);
  crowdWhistles(5);
  for (let i = 0; i < 3; i++) laugh(now + rand(0.6, 2.2), {
    vol: 0.12
  });
  if (playVoiceClip(now + 0.1, {
    pan: rand(-0.6, 0.6),
    vol: 0.55
  })) playVoiceClip(now + rand(0.8, 1.4), {
    pan: rand(-0.6, 0.6),
    vol: 0.5
  });
  // 충격파 · 폭죽 · 꽃 세례 · 구호. 두 번째부터는 바텐더가 종을 치고 리더가 절함
  crowdShock(1.2);
  poppers(3, 1.6);
  throwGifts(8, 3);
  REACT.later(1.2, () => startChant(2));
  if (SPX.pieces >= 2) {
    bartenderBell(1.4);
    REACT.later(2.2, () => tbWorship(5));
  }
}

// ===== 78_rules.js =====
// ===================== 반응 규칙 보강: 폭주 속주 · 한 방 도약 · 널뛰기 · 안 끝나는 음 · 쉬면 아쉬워함 =====================
Object.assign(GAIN, {
  blaze: 17,
  blazeLong: 12,
  leap: 14,
  zigzag: 16,
  endless: 18
});
for (const k of ['blaze', 'leap', 'zigzag']) BIG.add(k);
const RULE = {
  ev: [],
  leaps: [],
  prevM: null,
  prevT: -9,
  blazeOn: false,
  blazeT0: 0,
  blazeLast: 0,
  blazeLongDone: false,
  zigOn: false,
  zigT0: 0,
  zigLast: 0,
  leapDir: 1
};

function ruleOnNote(type, d, now) {
  if (type !== 'attack' && type !== 'legato') return;
  const R = RULE,
    m = d.m;
  R.ev.push({
    t: now,
    m
  });
  while (R.ev.length && R.ev[0].t < now - 1.5) R.ev.shift();
  // 도약: 0.35초 안에 한 옥타브 넘게 건너뜀
  if (R.prevM != null && now - R.prevT <= 0.35) {
    const dm = m - R.prevM,
      ad = Math.abs(dm);
    if (ad >= 12) {
      R.leaps.push({
        t: now,
        dir: Math.sign(dm)
      });
      while (R.leaps.length && R.leaps[0].t < now - 2.5) R.leaps.shift();
      if (REACT.meSolo) crowdJerk(Math.sign(dm), ad >= 18 ? 3.8 : 2.6, 0.8);
      let alt = 0;
      for (let i = 1; i < R.leaps.length; i++)
        if (R.leaps[i].dir !== R.leaps[i - 1].dir) alt++;
      if (R.leaps.length >= 3 && alt >= 2) {
        CROWD.followUntil = NOW.t + 0.9;
        if (!R.zigOn) {
          R.zigOn = true;
          R.zigT0 = now;
          if (now - (REACT.lastG.zigzag || -9) > 4) gesture('zigzag');
        }
        R.zigLast = now;
      } else if (ad >= 18 && now - (REACT.lastG.leap || -9) > 2) {
        R.leapDir = Math.sign(dm);
        gesture('leap');
      }
    }
  }
  R.prevM = m;
  R.prevT = now;
  // 폭주 속주: 1.5초 안에 14음 이상, 위아래로 세 번 넘게 꺾으며, 음역 7반음 이상 (제자리 떨기·한 번 훑기는 제외)
  const E = R.ev;
  if (E.length >= 14) {
    let lo = 99,
      hi = 0,
      ch = 0,
      dir = 0;
    for (let i = 0; i < E.length; i++) {
      lo = Math.min(lo, E[i].m);
      hi = Math.max(hi, E[i].m);
      if (i) {
        const s = Math.sign(E[i].m - E[i - 1].m);
        if (s && dir && s !== dir) ch++;
        if (s) dir = s;
      }
    }
    if (ch >= 3 && hi - lo >= 7) {
      if (!R.blazeOn) {
        R.blazeOn = true;
        R.blazeT0 = now;
        R.blazeLongDone = false;
        if (now - (REACT.lastG.blaze || -9) > 5) gesture('blaze');
      }
      R.blazeLast = now;
      if (!R.blazeLongDone && now - R.blazeT0 >= 4) {
        R.blazeLongDone = true;
        gesture('blazeLong');
      }
    }
  }
}

function ruleTick(now) {
  const R = RULE;
  if (R.blazeOn) {
    if (REACT.meSolo) MUS.doubleUntil = Math.max(MUS.doubleUntil || 0, now + curSpb() * 4);
    if (now - R.blazeLast > 0.6) R.blazeOn = false;
  }
  if (R.zigOn && now - R.zigLast > 0.9) {
    R.zigOn = false;
    if (now - R.zigT0 > 1.4 && REACT.meSolo) dizzyWave();
  }
}

function dizzyWave() {
  const W = CROWD.list.filter(m => !m.override && !(m.act && m.act.story) && !m.pending && m.p.root.visible);
  for (const m of shuffle(W).slice(0, randi(3, 5))) forceScene(m, 'dizzy', rand(0, 0.4));
}
// 안 끝나는 음: 같이 숨 참다가 "푸하—"
const ENDL = {
  stage: 0,
  puffK: 0,
  level: 0,
  holders: []
};

function endlessTick(now) {
  const blowing = TP.blowing && GAME.phase === 'play' && UI.playing;
  const held = blowing ? now - TP.noteT0 : 0;
  if (ENDL.stage === 0 && held >= 6) {
    ENDL.stage = 1;
    const W = CROWD.list.filter(m => !m.override && !(m.act && m.act.story) && m.p.root.visible);
    for (const m of shuffle(W).slice(0, 10)) {
      m.lookFriend = NOW.t + 2.2;
      m.p.express(pick(['wow', 'disbelief']), 2.6);
    }
  }
  if (ENDL.stage === 1 && held >= 9) {
    ENDL.stage = 2;
    ENDL.holders.length = 0;
    for (const m of CROWD.list) {
      if (m.override || !m.p.root.visible || (m.act && m.act.story && m.act.k !== 'freeze') || Math.random() > 0.78) continue;
      m.pending = null;
      m.puffStyle = randi(0, 2);
      m.puffMul = rand(0.75, 1.25);
      m.act = {
        k: 'puffHold',
        t0: NOW.t,
        until: NOW.t + 60,
        story: true,
        seat: m.p.s.stand > 0.7 ? 1 : 0
      };
      ENDL.holders.push(m);
    }
  }
  if (ENDL.stage === 2) {
    if (blowing) {
      ENDL.puffK = smoothstep(9, 19, held);
      ENDL.level = held < 11 ? 0 : held < 14 ? 1 : held < 17 ? 2 : 3;
    } else endlessRelease();
  }
  if (ENDL.stage === 1 && !blowing) ENDL.stage = 0;
}

function endlessRelease() {
  ENDL.stage = 0;
  ENDL.puffK = 0;
  ENDL.level = 0;
  const now = AE.ctx.currentTime;
  crowdExhale(now + 0.03, 28);
  for (const m of ENDL.holders) {
    if (m.act && m.act.k === 'puffHold') m.act.until = NOW.t;
    m.p.c.puff = 0;
    faceTint(m.p, 0);
    const mm = m;
    REACT.later(rand(0.05, 0.35), () => {
      mm.p.express(pick(['stunlaugh', 'laugh', 'ecstasy', 'stunlaugh']), 2.6);
      if (!(mm.act && mm.act.story)) crowdAct(mm, Math.random() < 0.5 ? 'armsUp' : 'clap', 2.5, {
        rate: 5,
        high: true
      });
    });
  }
  ENDL.holders.length = 0;
  const R = REACT;
  addHeat(GAIN.endless);
  R.burst = {
    kind: 'ovation',
    owner: 'me',
    t: NOW.t + 0.4,
    until: NOW.t + 8,
    k: 1.2,
    energy: 0.95,
    fade: 3
  };
  REACT.later(0.5, () => {
    crowdWhoops(8);
    crowdWhistles(3);
  });
  if (AE.decoded) {
    const t = nextSlot(now + 0.05);
    drum('crash', t, 0.8, 'R');
    drum('kick', t, 0.6, 'RF');
  }
  reactEvent('endless', {});
}
// 쉬면 아쉬워함: 내가 오래 쉬면 돌아보는 사람이 늘어남
const MISS = {
  k: 0,
  was: false,
  everSolo: false
};

function missTick(dt, now) {
  const S = MUS.song,
    R = REACT;
  if (R.meSolo) MISS.everSolo = true;
  let target = 0;
  if (GAME.phase === 'play' && UI.playing && S && MISS.everSolo && !R.meSolo && !TP.blowing && !MUS.gap && /^(solo|trades|head|outhead)$/.test(S.phase)) target = smoothstep(5, 20, now - TP.lastSoundT) * 0.75;
  MISS.k = damp(MISS.k, target, target > MISS.k ? 0.8 : 4, dt);
  if (MISS.k > 0.3) MISS.was = true;
}

function missOnAttack() {
  if (!MISS.was) return;
  MISS.was = false;
  if (MISS.k > 0.2) reactEvent('welcomeBack', {});
  MISS.k = 0;
}
// 더블타임: 드럼은 라이드가 두 배로 촘촘, 베이스는 8분음표로 걸음 (스윙 곡에서만)
function drumsDouble(b, last, first) {
  const T = p => b.t0 + p * b.spb;
  for (let k = 0; k < 8; k++) {
    const p0 = k * 0.5;
    drum('ride', T(p0) + rand(-0.003, 0.003), (k % 2 ? 0.72 : 0.6) * rand(0.92, 1.05), 'R');
    if (k % 2 === 1) drum('ride', T(p0 + 0.33), 0.42, 'R');
  }
  for (let k = 0; k < 4; k++) {
    drum('hat', T(k + 0.5), 0.62, 'LF');
    drum('kick', T(k), 0.18, 'RF');
  }
  for (const p of [0.5, 1.5, 2.5, 3.5])
    if (Math.random() < 0.6) drum(Math.random() < 0.35 ? 'snare' : 'ghost', T(p + (Math.random() < 0.5 ? 0 : 0.25)), rand(0.3, 0.55), 'L');
  if (first) drum('crash', T(0), 0.75, 'R');
  if (last) drumFill(b, 0.8);
}

function bassWalkDouble(b, next) {
  const chs = b.chords;
  let cur = BASS.last;
  for (let a = 0; a < chs.length; a++) {
    const ch = chs[a],
      b0 = ch.at,
      len = ch.len,
      nextRoot = a + 1 < chs.length ? chs[a + 1].root : next.root;
    const start = nearestPC(ch.root, cur, 31, 50),
      target = nearestPC(nextRoot, start, 29, 52),
      steps = Math.max(1, Math.round(len * 2));
    let m = start;
    for (let k = 0; k < steps; k++) {
      if (k === 0) m = start;
      else if (k === steps - 1) m = clamp(target + (target > m ? -1 : 1), 28, 55);
      else {
        const dir = Math.sign(target - m) || (Math.random() < 0.5 ? 1 : -1);
        let n = m + dir,
          tries = 0;
        while (!inSet(n, ch, 'W') && tries++ < 3) n += dir;
        m = clamp(n, 28, 55);
      }
      bassNote(b.t0 + (b0 + k * 0.5) * b.spb, m, b.spb * 0.42, k % 2 ? 0.8 : 0.98);
    }
    cur = m;
  }
  BASS.last = cur;
}
// ===== 79_flow.js =====
// ===================== 공연 흐름: 마우스피스 정적 · 폰 녹음 사인 · 멤버 소개 · 첫 화면의 지난 공연 흔적 =====================
// ---------- 공연 전: 마우스피스 버징 한 번에 가게가 조용해짐 ----------
const PRE = {
  on: false,
  t0: 0,
  heard: false,
  heardT: 0,
  buzz: null,
  buzzT0: 0,
  releasedT: 0,
  clapT: 0,
  assembleT: 0,
  done: false
};
const buzzF = pos => 95 * Math.pow(2, clamp(pos, 0, 1) * 1.9);

function preStart() {
  Object.assign(PRE, {
    on: true,
    t0: NOW.t,
    heard: false,
    heardT: 0,
    buzz: null,
    releasedT: 0,
    clapT: 0,
    assembleT: 0,
    done: false
  });
  GAME.phase = 'pre';
  CROWD.pre = true;
  CROWD.preHeard = false;
  ME.introK = 0;
  bed.set('babble', 0.13, 1.0);
  for (const m of CROWD.list) {
    m.lookFriend = 0;
    m.nextAct = NOW.t + rand(0, 1.2);
  }
  UI.el.nextSong.style.display = 'none';
  UI.el.hudMode.style.display = 'none';
  UI.el.special.style.display = 'none';
  UI.el.endShow.style.display = 'none';
  UI.el.customMenu.style.display = 'none';
}

function preBuzzDown(pos) {
  if (!AE.ctx || PRE.buzz || PRE.assembleT) return;
  if (!UI.touched) {
    UI.touched = true;
    UI.el.stem.classList.remove('hint');
  }
  const now = AE.ctx.currentTime;
  PRE.buzz = makeBuzz(now + 0.005);
  PRE.buzz.setPitch(buzzF(pos), now);
  PRE.buzzT0 = NOW.t;
  if (!PRE.heard) preHeard();
}

function preBuzzMove(pos) {
  if (PRE.buzz && AE.ctx) PRE.buzz.setPitch(buzzF(pos), AE.ctx.currentTime);
}

function preBuzzUp() {
  if (!PRE.buzz) return;
  PRE.buzz.stop(AE.ctx.currentTime + 0.01);
  PRE.buzz = null;
  PRE.releasedT = NOW.t;
}

function preHeard() {
  PRE.heard = true;
  PRE.heardT = NOW.t;
  CROWD.preHeard = true;
  bed.set('babble', 0, 0.12);
  const now = AE.ctx.currentTime;
  const sorted = CROWD.list.filter(m => m.p.root.visible).sort((a, b) => b.p.root.position.z - a.p.root.position.z);
  sorted.forEach((m, i) => {
    m.lookFriend = 0;
    if (m.act && !m.act.story) m.act = null;
    REACT.later(0.03 + i * 0.012, () => m.p.express(pick(['gasp', 'wow', 'jawdrop', 'gasp']), 2.6));
  });
  for (const m of shuffle(sorted.filter(m => m.kind === 'seat')).slice(0, 4)) forceScene(m, 'drinkFreeze', rand(0.05, 0.4));
  for (const m of BAND.members) stare(m, 3.4, 'disbelief', 0.8);
  playBuf(pick(AE.syn.clinks), now + 0.2, 0.14, AE.buses.crowd, {
    pan: rand(-0.6, 0.6)
  });
}

function preTick() {
  if (!PRE.on || !UI.playing) return;
  const t = NOW.t;
  if (!PRE.heard) {
    if (t - PRE.t0 > 24) {
      preHeard();
      PRE.releasedT = t;
    }
    return;
  }
  const endBuzz = PRE.buzz ? (t - PRE.buzzT0 > 2.6 ? t : 0) : PRE.releasedT;
  if (!PRE.clapT && endBuzz && t - endBuzz > 0.8) {
    PRE.clapT = t;
    preApplause();
  }
  if (PRE.clapT && !PRE.assembleT && t - PRE.clapT > 2.8) {
    PRE.assembleT = t;
    preBuzzUp();
  }
  if (PRE.assembleT) {
    ME.introK = Math.min(1, (t - PRE.assembleT) / 0.75);
    if (ME.introK >= 1 && !PRE.done) preFinish();
  }
}

function preApplause() {
  const now = AE.ctx.currentTime;
  REACT.burst = {
    kind: 'ovation',
    owner: 'me',
    t: NOW.t,
    until: NOW.t + 8,
    k: 1.05,
    energy: 0.85,
    fade: 3.5
  };
  crowdOoh(now + 0.02, 14, 0.9, 1.4);
  REACT.later(0.5, () => {
    crowdWhoops(7);
    crowdWhistles(2);
    laugh(AE.ctx.currentTime + 0.1, {
      vol: 0.1
    });
  });
  for (const m of shuffle(CROWD.list.filter(m => m.p.root.visible && !(m.act && m.act.story))).slice(0, 5)) forceScene(m, 'riseStun', rand(0.1, 0.8));
  for (const m of BAND.members) {
    m.stare = null;
    m.express('stunlaugh', 2);
  }
  stare(BAND.tb, 2.5, 'grin', 0.6);
}

function preFinish() {
  PRE.done = true;
  PRE.on = false;
  CROWD.pre = false;
  GAME.phase = 'play';
  UI.el.nextSong.style.display = 'inline-flex';
  UI.el.hudMode.style.display = 'inline-flex';
  UI.el.special.style.display = 'block';
  UI.el.endShow.style.display = 'inline-flex';
  UI.el.fight.style.display = 'inline-flex';
  UI.el.customMenu.style.display = 'block';
  startSet({ count: true });
}

// ---------- 곡 사이: 폰 녹음 사인 / 멤버 소개 ----------
const ITL = {
  cur: null,
  songs: 0,
  lastIntro: -9,
  lastSign: -9,
  phoneBus: null,
  phonePan: null
};

function itlOnGap() {
  ITL.songs++;
  if (ITL.cur || GAME.phase !== 'play' || !MUS.gap) return;
  const n = ITL.songs,
    peak = REACT.songPeak;
  if (n >= 2 && n - ITL.lastIntro >= 4 && n - ITL.lastSign >= 1) {
    itlStart('intro');
    ITL.lastIntro = n;
    return;
  }
  if (peak >= 40 && n - ITL.lastSign >= 2 && n - ITL.lastIntro >= 1 && itlStart('sign')) ITL.lastSign = n;
}

function itlStart(kind) {
  const G = MUS.gap;
  if (!G) return false;
  if (kind === 'sign') {
    const fan = CROWD.list.filter(m => m.kind === 'front' && m.p.root.visible && !m.override).sort((a, b) => Math.abs(a.p.root.position.x + 0.3) - Math.abs(b.p.root.position.x + 0.3))[0];
    if (!fan) return false;
    if (fan.act) finishCrowdScene(fan, NOW.t);
    fan.pending = null;
    fan.rush = 0;
    const s0 = fan.p.root.position.clone(),
      fx = clamp(s0.x * 0.8, -2.4, 2.4);
    ITL.cur = {
      kind,
      t0: NOW.t,
      stage: 'walk',
      fan,
      path: [s0, V3(fx, 0, -4.12), V3(fx * 0.6, LAYOUT.stageY, -3.7), V3(0.3, LAYOUT.stageY, -3.0), V3(0.3, LAYOUT.stageY, -1.0), V3(SC.portrait ? 0.1 : 0.62, LAYOUT.stageY, -0.42)],
      seg: 0,
      segT: NOW.t,
      rec: [],
      recT0: 0,
      stageT: NOW.t,
      yaw: fan.p.root.rotation.y
    };
    fan.p.c.stand = 1;
    fan.override = itlFan;
    makeCrowdProp(fan, 'phone');
  } else ITL.cur = {
    kind,
    t0: NOW.t,
    fired: {}
  };
  G.hold = true;
  return true;
}

function itlEnd() {
  const c = ITL.cur;
  ITL.cur = null;
  CROWD.focus = null;
  if (c && c.fan) {
    const m = c.fan;
    m.override = null;
    m.act = null;
    m.p.root.rotation.x = 0;
    m.p.root.position.copy(m.spot.pos);
    m.p.root.rotation.y = m.spot.yaw;
    m.p.c.stand = 1;
    m.standHoldUntil = NOW.t + 2;
    if (m.props.phone) m.props.phone.visible = false;
  }
  if (BAND.tb) BAND.tb.floorK = 0;
  if (MUS.gap) MUS.gap.hold = false;
}
// 녹음: 팬이 폰을 내밀고 있는 동안의 내 소리
function itlOnNote(type, d) {
  const c = ITL.cur;
  if (!c || c.kind !== 'sign' || c.stage !== 'aim') return;
  if (!c.recT0 && type === 'attack') c.recT0 = d.t;
  if (c.recT0) c.rec.push({
    type,
    t: d.t,
    m: d.m
  });
}

function itlPhoneBus(x) {
  const ctx = AE.ctx;
  if (!ITL.phoneBus) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 650;
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 2300;
    pk.Q.value = 1.1;
    pk.gain.value = 9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4300;
    const sh = ctx.createWaveShaper();
    const cv = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 128 - 1;
      cv[i] = Math.tanh(v * 3.2);
    }
    sh.curve = cv;
    const g = ctx.createGain();
    g.gain.value = 0.6;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    hp.connect(pk);
    pk.connect(lp);
    lp.connect(sh);
    sh.connect(g);
    g.connect(pan);
    pan.connect(AE.buses.crowd);
    ITL.phoneBus = hp;
    ITL.phonePan = pan;
  }
  if (ITL.phonePan.pan) ITL.phonePan.pan.value = clamp(x / 4, -0.8, 0.8);
  return ITL.phoneBus;
}
// 녹음 재생: 폰 스피커라 쨍쨍하게
function itlPlayback(c) {
  const ev = c.rec,
    now = AE.ctx.currentTime,
    dest = itlPhoneBus(c.fan.p.root.position.x);
  if (!ev.length) return 0;
  const segs = [];
  let cur = null;
  for (const e of ev) {
    if (e.type === 'attack' || e.type === 'legato') {
      if (cur) cur.e = e.t;
      cur = {
        s: e.t,
        m: e.m,
        e: null
      };
      segs.push(cur);
    } else if (e.type === 'release' && cur) {
      cur.e = e.t;
      cur = null;
    }
  }
  if (cur) cur.e = cur.s + 0.4;
  const t0 = segs[0].s;
  for (const sg of segs) {
    const s = nearestSample('T', sg.m);
    playOne(s, sg.m, now + 0.05 + (sg.s - t0), 0.75, dest, {
      dur: Math.max(0.06, sg.e - sg.s),
      release: 0.05
    });
  }
  return segs[segs.length - 1].e - t0;
}

function itlTick() {
  const c = ITL.cur;
  if (!c) return;
  if (!MUS.gap || GAME.phase !== 'play') {
    itlEnd();
    return;
  }
  if (c.kind === 'intro') itlIntroTick(c);
}
// 무대에 올라온 팬 (매 프레임 자세)
function itlFan(m, t, dt) {
  const c = ITL.cur,
    p = m.p;
  if (!c || c.fan !== m) {
    m.override = null;
    return;
  }
  crowdStill(p, 0.1);
  p.c.stand = 1;
  p.c.step = 0;
  p.c.lean = 0.04;
  const F = frameOf(p),
    cam = SC.camera.position,
    now = AE.ctx.currentTime;
  const setYaw = (y, rate = 8) => {
    c.yaw = dampAngle(c.yaw, y, rate, dt);
    p.root.rotation.y = c.yaw;
  };
  const walkTo = (pts, speed, onDone) => {
    const a = pts[c.seg],
      b = pts[c.seg + 1];
    if (!b) {
      onDone();
      return;
    }
    const hop = b.y > a.y + 0.1,
      len = a.distanceTo(b),
      dur = hop ? 0.45 : len / speed,
      k = clamp((t - c.segT) / dur, 0, 1);
    const pos = a.clone().lerp(b, hop ? smooth01(k) : k);
    if (hop) pos.y += Math.sin(k * Math.PI) * 0.35;
    p.root.position.copy(pos);
    setYaw(Math.atan2(b.x - a.x, b.z - a.z), 10);
    p.c.step = hop ? 0 : 1;
    p.c.look.copy(b).add(_bv.set(0, 1.5, 0));
    if (k >= 1) {
      c.seg++;
      c.segT = t;
    }
  };
  const holdPhone = (q, at2) => {
    const grip = V3(-0.052, -0.015, 0).applyQuaternion(q);
    p.reach('R', at2.clone().add(grip), null, q, 'grip');
    m.act = {
      k: 'phone',
      phoneQ: q,
      phoneOffset: grip.clone().negate(),
      phoneVisible: true
    };
  };
  m.act = null;
  switch (c.stage) {
    case 'walk':
      sceneFace(p, 'ecstasy');
      CROWD.focus = p.headWorld(_bv3).clone();
      walkTo(c.path, 1.7, () => {
        c.stage = 'aim';
        c.stageT = t;
        c.seg = 0;
      });
      break;
    case 'aim': {
      // 내 벨 앞에 폰을 내밂 (화면이 나를 향함: 빨간 녹음 점)
      setYaw(Math.atan2(cam.x - p.root.position.x, cam.z - p.root.position.z));
      p.c.look.copy(cam);
      p.c.side = Math.sin(t * 31) * 0.02;
      const ph = p.root.position.clone().add(_bv.set(SC.portrait ? -0.13 : -0.17, 1.7, 0.47));
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(ph, cam, UPY));
      holdPhone(q, ph);
      p.reach('L', facePoint(p, R0(p) * 0.15, -p.R * 0.8, p.R * 1.2), null, null, 'flat');
      sceneFace(p, c.rec.length ? 'teary' : 'ecstasy');
      CROWD.focus = null;
      const quiet = TP.blowing ? 0 : now - TP.lastSoundT;
      if ((c.recT0 && !TP.blowing && quiet > 0.9) || (c.recT0 && now - c.recT0 > 4.2) || (!c.recT0 && t - c.stageT > 6.5)) {
        if (TP.blowing) {
          releaseAllInput();
          fingerVisual(null);
        }
        c.stage = 'check';
        c.stageT = t;
      }
      break;
    }
    case 'check': {
      // 폰 보고 감격 → 돌아서서 무대 앞으로
      const ph = facePoint(p, 0, -p.R * 0.6, p.R * 2.6);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(ph, p.headWorld(_bv3), UPY)).multiply(_dq.setFromAxisAngle(UPY, Math.PI));
      holdPhone(q, ph);
      p.c.look.copy(ph);
      sceneFace(p, 'teary');
      p.c.jump = 0.6;
      if (t - c.stageT > 0.8) {
        c.stage = 'back';
        c.stageT = t;
        c.seg = 0;
        c.segT = t;
        c.path2 = [p.root.position.clone(), V3(0.3, LAYOUT.stageY, -1.0), V3(0.2, LAYOUT.stageY, -3.5)];
      }
      break;
    }
    case 'back':
      sceneFace(p, 'ecstasy');
      CROWD.focus = p.headWorld(_bv3).clone();
      walkTo(c.path2, 2.0, () => {
        c.stage = 'show';
        c.stageT = t;
        c.playDur = itlPlayback(c);
        c.played = false;
      });
      break;
    case 'show': {
      // 객석 쪽으로 폰을 높이 들고 재생
      setYaw(Math.PI);
      const ph = F.c.clone().addScaledVector(F.f, 0.25).add(_bv.set(0, 0.72, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(ph, ph.clone().add(F.f), UPY));
      holdPhone(q, ph);
      p.reach('L', at(F, 0.2, -0.3, 0.55), null, null, 'spread');
      sceneFace(p, 'scream');
      CROWD.focus = ph.clone();
      p.c.look.copy(CROWD.stageC).add(_bv.set(0, -0.6, -6));
      const a = t - c.stageT;
      if (!c.f1 && a > 0.35) {
        c.f1 = true;
        crowdWhoops(4);
      }
      if (!c.f2 && a > 0.9) {
        c.f2 = true;
        for (let i = 0; i < 2; i++) scream(now + i * 0.25, {
          vol: 0.16
        });
        for (const o of shuffle(CROWD.list.filter(o => o !== m && o.p.root.visible && !(o.act && o.act.story))).slice(0, 14)) {
          o.p.express(pick(['jawdrop', 'scream', 'stunlaugh']), 2.5);
          crowdAct(o, pick(['armsUp', 'headHands', 'cheeks']), 2.2);
        }
      }
      if (!c.f3 && a > Math.max(1.6, (c.playDur || 0) + 0.5)) {
        c.f3 = true;
        REACT.burst = {
          kind: 'ovation',
          owner: 'me',
          t: NOW.t,
          until: NOW.t + 7,
          k: 1.25,
          energy: 0.95,
          fade: 3
        };
        crowdWhoops(10);
        crowdWhistles(3);
        laugh(now + 0.3, {
          vol: 0.11
        });
        const pool = ['slapHead', 'handsTop', 'mindBlown', 'kneel'];
        shuffle(CROWD.list.filter(o => o !== m && o.p.root.visible && !(o.act && o.act.story))).slice(0, 4).forEach((o, i) => forceScene(o, pool[i % pool.length], rand(0, 0.6)));
      }
      if (c.f3 && a > Math.max(2.8, (c.playDur || 0) + 1.7)) {
        c.stage = 'dive';
        c.stageT = t;
        c.d0 = p.root.position.clone();
      }
      break;
    }
    case 'dive': {
      // 등 돌리고 객석으로 몸을 던짐 → 사람들 손 위로 실려 감 → 제자리에 내려섬
      const a = t - c.stageT,
        sp = m.spot.pos;
      if (m.props.phone) m.props.phone.visible = false;
      const edge = V3(c.d0.x, LAYOUT.stageY, -3.88);
      if (a < 0.45) {
        p.root.position.lerpVectors(c.d0, edge, smooth01(a / 0.45));
        setYaw(0, 10);
        p.c.step = 1;
        sceneFace(p, 'ecstasy');
        p.c.look.copy(cam);
      } else if (a < 1.1) {
        const k = smooth01((a - 0.45) / 0.65);
        p.root.position.set(edge.x, lerp(LAYOUT.stageY, 1.15, k), lerp(-3.88, -4.05, k));
        p.root.rotation.x = -1.42 * Math.pow(k, 1.4);
        setYaw(0, 10);
        p.reach('L', at(F, 0.1, -0.45, 0.4), null, null, 'spread');
        p.reach('R', at(F, 0.1, 0.45, 0.4), null, null, 'spread');
        sceneFace(p, 'scream');
        if (!c.yell) {
          c.yell = true;
          scream(now + 0.05, {
            vol: 0.2,
            pan: clamp(edge.x / 4, -0.8, 0.8)
          });
          crowdWhoops(5);
        }
      } else if (a < 3.1) {
        const k = smooth01((a - 1.1) / 2.0);
        p.root.position.set(lerp(edge.x, sp.x, k), 1.15 + Math.sin(a * 9) * 0.05, lerp(-4.05, sp.z - 0.2, k));
        p.root.rotation.x = -1.45 + Math.sin(a * 7) * 0.05;
        p.root.rotation.y = c.yaw;
        p.reach('L', at(F, 0.1, -0.5, 0.35), null, null, 'spread');
        p.reach('R', at(F, 0.1, 0.5, 0.35), null, null, 'spread');
        sceneFace(p, 'ecstasy');
        if (!c.lift) {
          c.lift = true;
          for (const o of CROWD.list)
            if (o !== m && o.kind === 'front' && o.p.root.position.distanceTo(sp) < 3.2 && !(o.act && o.act.story)) crowdAct(o, 'armsUp', 2.2);
        }
      } else if (a < 3.7) {
        const k = smooth01((a - 3.1) / 0.6);
        p.root.position.set(sp.x, lerp(1.15, 0, k), lerp(sp.z - 0.2, sp.z, k));
        p.root.rotation.x = -1.45 * (1 - k);
        setYaw(m.spot.yaw, 6);
        sceneFace(p, 'grin');
      } else itlEnd();
      break;
    }
  }
}
const R0 = p => p.R;
// 멤버 소개: 리더가 한 명씩 소개 → 내 차례에 박수가 안 끝남 → 진정시키려다 포기하고 같이 박수
function itlIntroTick(c) {
  const a = NOW.t - c.t0,
    F = c.fired,
    now = AE.ctx.currentTime;
  const once = (k, at2, fn) => {
    if (!F[k] && a >= at2) {
      F[k] = true;
      fn();
    }
  };
  const polite = who => {
    REACT.burst = {
      kind: 'polite',
      t: NOW.t,
      until: NOW.t + 1.8,
      k: 0.12
    };
    for (const m of shuffle(CROWD.list.filter(m => m.p.root.visible && !m.override && !(m.act && m.act.story))).slice(0, 22)) crowdAct(m, 'clap', rand(1.2, 1.8), {
      rate: 3.6,
      sound: 0
    });
    BAND[who].express('smile', 2);
    BAND[who].cueNod = NOW.t + 1.2;
  };
  CROWD.focus = a < 5.6 ? BAND[a < 2.3 ? 'pn' : a < 3.9 ? 'bs' : 'dr'].headWorld(_bv3).clone() : null;
  once('pn', 0.7, () => {
    [72, 76, 79, 83, 86, 88].forEach((m, i) => pianoNotes(now + 0.02 + i * 0.075, [m], 0.2, 0.7, 'R', 0));
    pianoNotes(now + 0.5, [64, 69, 72, 76], 0.9, 0.55, 'L', 0.015);
    polite('pn');
  });
  once('bs', 2.6, () => {
    [33, 36, 40, 43, 45].forEach((m, i) => bassNote(now + 0.02 + i * 0.11, m, 0.12, 0.9));
    bassNote(now + 0.6, 33, 0.7, 1.0);
    polite('bs');
  });
  once('dr', 4.2, () => {
    ['snare', 'snare', 'tomHi', 'tomHi', 'tomLo', 'tomLo'].forEach((pc, i) => drum(pc, now + 0.02 + i * 0.085, 0.7, i % 2 ? 'L' : 'R'));
    drum('crash', now + 0.55, 0.8, 'R');
    drum('kick', now + 0.55, 0.8, 'RF');
    polite('dr');
  });
  once('me', 5.6, () => {
    REACT.burst = {
      kind: 'ovation',
      owner: 'me',
      t: NOW.t,
      until: NOW.t + 12,
      k: 1.35,
      energy: 1,
      fade: 3
    };
    for (const m of CROWD.list)
      if (m.p.s.stand > 0.3) m.standHoldUntil = NOW.t + 10;
    crowdWhoops(10);
    crowdWhistles(4);
    for (let i = 0; i < 2; i++) scream(now + 0.2 + i * 0.4, {
      vol: 0.16
    });
    stare(BAND.tb, 9, 'grin', 1.0);
    for (const k of ['pn', 'bs', 'dr']) {
      glanceMe(BAND[k], 3);
      BAND[k].express('grin', 3);
    }
  });
  once('calm', 8.2, () => {
    crowdWhoops(6);
    for (let i = 0; i < 8; i++) playBuf(AE.syn.stomp, now + 0.1 + i * 0.32, 0.28, AE.buses.crowd, {
      pan: rand(-0.7, 0.7)
    });
  });
  once('try', 9.8, () => {
    crowdWhoops(8);
    for (let i = 0; i < 3; i++) scream(now + 0.1 + i * 0.3, {
      vol: 0.17
    });
  });
  once('give', 11.2, () => {
    crowdWhoops(6);
    laugh(now + 0.2, {
      vol: 0.12
    });
    laugh(now + 0.6, {
      vol: 0.1
    });
  });
  once('end', 14.0, () => {
    BAND.tb.stare = null;
    itlEnd();
  });
}

function itlTrombone(tb, dt, t) {
  const c = ITL.cur,
    a = t - c.t0,
    F = frameOf(tb);
  tb.floorK = damp(tb.floorK || 0, (a > 8.2 && a < 9.8) || (a > 11.2 && a < 13.8) ? 1 : 0, 5, dt);
  if (a < 5.6) {
    const who = a < 2.3 ? 'pn' : a < 3.9 ? 'bs' : 'dr';
    tb.stare = null;
    tb.lookAtMember = {
      who,
      until: t + 0.2
    };
    const dir = BAND[who].headWorld(_d3).clone().sub(F.c).normalize();
    tb.reach('R', F.c.clone().addScaledVector(dir, 0.5).addScaledVector(UPY, -0.02), null, null, 'flat');
    if (!tb.exUntil) tb.express('smile', 0.6);
  } else if (a < 8.2) {
    const dir = SC.camera.position.clone().sub(F.c).normalize();
    tb.reach('R', F.c.clone().addScaledVector(dir, 0.52).addScaledVector(UPY, 0.08), null, null, 'flat');
  } else if (a < 9.8) {
    // "자, 자, 진정하시고…" 두 손바닥으로 누르는 시늉
    const pump = Math.sin(a * 9) * 0.07;
    tb.reach('L', at(F, 0.35, -0.2, -0.04 + pump), null, palmQ(tb, 'L'), 'flat');
    tb.reach('R', at(F, 0.35, 0.2, -0.04 + pump), null, palmQ(tb, 'R'), 'flat');
    if (!tb.exUntil) tb.express('ask', 0.6);
  } else if (a < 11.2) {
    // 다음 곡 하려고 트롬본을 입에 대 봄
    DIR.tbState = 'play';
    DIR.tbLastNote = AE.ctx.currentTime + 0.4;
  } else if (a < 13.8) {
    // 포기하고 같이 박수
    sceneClap(tb, F, t, false);
    if (!tb.exUntil) tb.express('stunlaugh', 0.6);
    tb.c.disbelief = a < 12.6 ? 1 : 0;
  }
}

// ---------- 첫 화면: 지난 공연 흔적 (텅 빈 가게, 꽃다발, 남아서 내 자리를 보는 한 사람) ----------
const AFTER = {
  on: false,
  fan: null,
  flowers: null,
  data: null
};

function afterLoad() {
  try {
    return JSON.parse(localStorage.getItem('egotrip.after') || 'null');
  } catch { return null; }
}

function afterSave() {
  if (GAME.phase !== 'play' && GAME.phase !== 'pre' && GAME.phase !== 'finale') return;
  try {
    localStorage.setItem('egotrip.after', JSON.stringify({
      peak: Math.round(REACT.peak || 0),
      specials: SPX.pieces,
      songs: MUS.songsPlayed,
      at: Date.now()
    }));
  } catch { }
}

function afterShow() {
  const d = afterLoad();
  if (!d || !(d.peak >= 15)) return;
  AFTER.on = true;
  AFTER.data = d;
  const fan = CROWD.list.filter(m => m.kind === 'front').sort((a, b) => Math.abs(a.p.root.position.x - 0.4) - Math.abs(b.p.root.position.x - 0.4))[0];
  for (const m of CROWD.list)
    if (m !== fan) m.p.root.visible = false;
  for (const k of ['tb', 'pn', 'bs', 'dr']) BAND[k].root.visible = false;
  BAND.bass.visible = false;
  BAND.tb.horn.visible = false;
  for (const s of Object.values(BAND.dr.sticks)) s.visible = false;
  if (fan) {
    AFTER.fan = fan;
    fan.override = afterFanPose;
  }
  buildFlowers(d);
}

function afterEnd() {
  if (!AFTER.on) return;
  AFTER.on = false;
  for (const m of CROWD.list) m.p.root.visible = true;
  for (const k of ['tb', 'pn', 'bs', 'dr']) BAND[k].root.visible = true;
  BAND.bass.visible = true;
  BAND.tb.horn.visible = true;
  const st = BAND.dr.sticks;
  st.L.visible = st.R.visible = !DIR.brushes;
  st.bL.visible = st.bR.visible = DIR.brushes;
  if (AFTER.fan) {
    AFTER.fan.override = null;
    AFTER.fan = null;
  }
}

function afterFanPose(m, t) {
  const p = m.p;
  crowdStill(p, 0);
  p.c.stand = 0;
  p.c.look.copy(CROWD.me);
  p.c.lean = 0.14 + Math.sin(t * 0.5) * 0.02;
  p.reach('L', p.local(0.04, p.seatY + 0.2, 0.3), null, null, 'relax');
  p.reach('R', p.local(-0.04, p.seatY + 0.21, 0.3), null, null, 'relax');
  if (!p.exUntil) p.express(Math.sin(t * 0.35) > 0 ? 'bliss' : 'teary', 3);
}

function buildFlowers(d) {
  if (AFTER.flowers) return;
  const parts = [],
    rnd = seeded(77 + (d.at % 9973));
  const N = clamp(Math.round(6 + d.peak / 100 * 14 + (d.specials || 0) * 3), 6, 30);
  const wraps = ['#fff4de', '#f7c6d6', '#d9b48a', '#cfe8ff', '#fffaf0'],
    blooms = ['#ee4a2c', '#ff7aa8', '#ffd84a', '#fffaf0', '#b07ad8', '#ff8a5c'];
  for (let i = 0; i < N; i++) {
    // 가운데(내 앞)로 몰리게: 세로 화면에서도 보이도록
    const onStage = rnd() < 0.5,
      x = clamp(0.5 + (rnd() + rnd() + rnd() - 1.5) * 2.3, -3.4, 3.4),
      z = onStage ? rnd.range(-3.85, -3.45) : rnd.range(-4.4, -4.02),
      y = (onStage ? LAYOUT.stageY : 0) + 0.09;
    const M = new THREE.Matrix4().compose(V3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd.range(0, Math.PI * 2), rnd.range(1.25, 1.45), 'YXZ')), V3(1.22, 1.22, 1.22));
    parts.push([new THREE.ConeGeometry(0.078, 0.27, 10).rotateX(Math.PI), rnd.pick(wraps), M]);
    parts.push([new THREE.CylinderGeometry(0.013, 0.013, 0.08, 6).translate(0, -0.17, 0), '#3aa860', M]);
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2;
      parts.push([new THREE.SphereGeometry(rnd.range(0.032, 0.046), 8, 6).translate(Math.cos(a) * 0.042, 0.15 + rnd.range(0, 0.03), Math.sin(a) * 0.042), rnd.pick(blooms), M]);
    }
    parts.push([new THREE.SphereGeometry(0.042, 8, 6).translate(0, 0.18, 0), rnd.pick(blooms), M]);
    for (let k = 0; k < 3; k++) parts.push([new THREE.SphereGeometry(0.03, 6, 4).scale(0.5, 1.4, 0.3).translate(rnd.range(-0.06, 0.06), 0.11, rnd.range(-0.06, 0.06)), '#3aa860', M]);
  }
  const mesh = new THREE.Mesh(_vm(parts), toonVC({
    outline: 0.003
  }));
  mesh.name = 'flowers';
  SC.scene.add(mesh);
  AFTER.flowers = mesh;
}
// 시작할 때 한 번: 입자·창문 자리·사람별 설정
function bigInit() {
  fxInit(SC.scene);
  initWindowSlots();
  buildBell();
  for (const m of CROWD.list) {
    m.p.root.rotation.order = 'YXZ';
    m.followK = rand(0.7, 1.25);
    m.idleLook = pick([V3(rand(-5, 5), 1.3, rand(-13, -7)), V3(rand(-6, 6), 1.5, -14.6), V3(rand(-7, 7), 1.6, rand(-12, -5))]);
  }
  TP.listeners.push(itlOnNote);
  afterShow();
}
// 새 반응 → 관객·밴드 (기존 처리 앞에서 먼저 봄; true면 기존 처리 건너뜀)
function bigOnEvent(ev) {
  const watchers = () => CROWD.list.filter(m => !m.override && m.p.root.visible && !(m.act && m.act.story));
  const near = () => watchers().sort((a, b) => b.p.root.position.z - a.p.root.position.z);
  const now = AE.ctx ? AE.ctx.currentTime : 0;
  switch (ev.kind) {
    case 'specialRaise': {
      for (const m of near().slice(0, 5)) {
        m.p.express('gasp', 2.2);
        crowdAct(m, 'point', 1.8);
      }
      for (const m of BAND.members) {
        glanceMe(m, 1.6);
        m.express('wow', 1.6);
      }
      return true;
    }
    case 'special':
      return true;
    case 'endless':
      return true;
    case 'welcomeBack': {
      crowdWhoops(5);
      if (Math.random() < 0.6) crowdWhistles(1);
      for (const m of shuffle(watchers()).slice(0, 10)) {
        m.p.express(pick(['grin', 'ecstasy', 'laugh']), 2.4);
        crowdAct(m, pick(['armsUp', 'clap', 'pump']), 2.2, {
          rate: 5,
          fist: true
        });
      }
      glanceMe(BAND.tb, 1.4);
      BAND.tb.express('smile', 1.6);
      return true;
    }
    case 'gesture': {
      const g = ev.g,
        k = REACT.heat / 100;
      if (g === 'blaze') {
        // 앞줄부터 절레절레 + 머리 감싸기 (뒤로 번짐)
        near().slice(0, 18).forEach((m, i) => REACT.later(i * 0.05, () => {
          if (m.act && m.act.story) return;
          m.p.express(pick(['disbelief', 'jawdrop', 'disbelief']), 2.4);
          crowdAct(m, pick(['headHands', 'cheeks', 'headHands']), 2.2);
        }));
        crowdWhoops(3);
        MUS.pianoRestUntil = Math.max(MUS.pianoRestUntil || 0, now + curSpb() * 8);
        if (BAND.pn) {
          stare(BAND.pn, 3, 'jawdrop', 0.9);
          BAND.pn.handsOffUntil = NOW.t + 3.2;
        }
        BAND.dr.express('grin', 2);
        return true;
      }
      if (g === 'blazeLong') {
        for (const m of shuffle(watchers()).slice(0, 16)) {
          crowdAct(m, 'clap', 4.5, {
            dbl: true,
            high: true,
            sound: Math.random() < 0.3 ? 0.08 : 0
          });
          m.standHoldUntil = NOW.t + 5;
        }
        for (const m of near().filter(m => m.kind === 'front').slice(0, 3)) forceScene(m, 'kneel', rand(0, 0.5));
        crowdWhoops(5);
        BAND.bs.express('grin', 2);
        BAND.dr.express('stunlaugh', 2);
        return true;
      }
      if (g === 'leap') {
        for (const m of shuffle(watchers()).slice(0, 6)) m.p.express(pick(['gasp', 'wow']), 1.8);
        crowdWhoops(2);
        glanceMe(BAND.tb, 1.2);
        BAND.tb.express('gasp', 1.2);
        return true;
      }
      if (g === 'zigzag') {
        for (const m of shuffle(watchers()).slice(0, 8)) m.p.express(pick(['wow', 'stunlaugh', 'disbelief']), 2.2);
        laugh(now + 0.3, { vol: 0.1 });
        laugh(now + 0.7, { vol: 0.1 });
        BAND.bs.express('stunlaugh', 1.6);
        return true;
      }
      // 기존 행동에 몸으로 보이는 반응 덧붙이기 (기존 처리도 그대로 함)
      if (g === 'fall') crowdJerk(-1, 2.6, 0.75);
      else if (g === 'pedal') {
        if (VENUE && VENUE.rumble) VENUE.rumble(1);
        glassRattle(now + 0.02, 0.8);
        for (const m of shuffle(watchers()).slice(0, 6)) crowdAct(m, 'lookDown', rand(1.6, 2.4));
      } else if (g === 'shake') {
        for (const m of shuffle(watchers()).slice(0, 6)) crowdAct(m, 'shimmy', rand(1.3, 1.9));
      } else if (g === 'gliss') CROWD.followUntil = NOW.t + 1.0;
      void k;
      return false;
    }
  }
  return false;
}

// ===== 80_ui.js =====
// ===================== 화면 조작 =====================
const UI = {
  el: {},
  playing: false,
  marksKey: '',
  kbPos: null,
  inputRect: null,
  fingerPos: null,
  fingerDirty: false,
  cancelInput: null
};

function closeCustomMenu() {
  if (!UI.el.customPanel) return;
  UI.el.customPanel.hidden = true;
  UI.el.customToggle.setAttribute('aria-expanded', 'false');
}
function toggleCustomMenu(force) {
  if (!UI.el.customPanel || METEOR.on || FIGHT.on) return;
  const open = force == null ? UI.el.customPanel.hidden : !!force;
  UI.el.customPanel.hidden = !open;
  UI.el.customToggle.setAttribute('aria-expanded', String(open));
}

function initUI() {
  const $ = id => document.getElementById(id);
  Object.assign(UI.el, {
    stem: $('stem'),
    ribbon: $('ribbon'),
    marks: $('marks'),
    finger: $('finger'),
    controls: $('controls'),
    title: $('title'),
    start: $('start'),
    fill: document.querySelector('#start .fill'),
    startLabel: document.querySelector('#start b'),
    paused: $('paused'),
    pause: $('pause'),
    hudMode: $('hudMode'),
    autoMode: $('autoMode'),
    nextSong: $('nextSong'),
    special: $('special'),
    endShow: $('endShow'),
    fight: $('fight'),
    bandCrazy: $('bandCrazy'),
    meteor: $('meteor'),
    customMenu: $('customMenu'),
    customToggle: $('customToggle'),
    customPanel: $('customPanel'),
    finBar: $('finBar'),
    encore: $('encore'),
    finHome: $('finHome')
  });
  document.querySelectorAll('[data-auto]').forEach(b => b.onclick = () => setAuto(b.dataset.auto === 'on'));
  bindInput();
  bindSpecial();
  finBind();
  document.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    setMode(b.dataset.m);
    syncMode();
  }));
  syncMode();
  $('resume').onclick = () => resumeGame();
  $('toTitle').onclick = () => location.reload();
  UI.el.pause.onclick = () => pauseGame();
  UI.el.nextSong.onclick = () => nextSong();
  UI.el.customToggle.onclick = () => toggleCustomMenu();
  UI.el.fight.onclick = () => { closeCustomMenu(); fightStart(); };
  UI.el.bandCrazy.onclick = () => { closeCustomMenu(); makeBandCrazy(); };
  UI.el.meteor.onclick = () => { closeCustomMenu(); meteorStart(); }
  $('gameOverHome').onclick = () => location.reload();
  // 첫 화면은 아무 데나 눌러도 시작
  UI.el.title.addEventListener('click', e => {
    e.preventDefault();
    titleTap();
  });
  // 앱이 뒤로 가면 소리까지 멈춤
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      afterSave();
      if (UI.playing) pauseGame();
      else if (AE.ctx && AE.ctx.state === 'running') AE.ctx.suspend();
    }
  });
  window.addEventListener('pagehide', () => {
    afterSave();
    if (UI.playing) pauseGame();
  });
  window.addEventListener('blur', () => {
    if (UI.playing) pauseGame();
    else {
      releaseAllInput();
      fingerVisual(null);
    }
  });
  const tryDecode = async () => {
    if (!window.JAZZ_AUDIO) return;
    try {
      createAudio();
      PACK.on = f => { UI.el.fill.style.width = Math.round(f * 100) + '%'; };
      PACK.on(PACK.f);
      packBegin();
      initTrumpet();
      spInitAudio();
      bed.start();
      syncMode();
      UI.el.start.disabled = false;
      UI.el.startLabel.textContent = '시작';
      // 기다리는 동안 이미 눌렀으면 바로 시작
      if (UI.wantStart) startGame();
      else if (AE.ctx.state === 'running') AE.ctx.suspend();
    } catch (e) {
      UI.el.startLabel.textContent = '소리를 못 불러왔습니다';
      console.error(e);
    }
  };
  const packMissing = () => {
    UI.el.startLabel.textContent = '소리 파일(audio.js)을 못 찾았습니다';
  };

  if (window.__audioReady) tryDecode();
  else if (window.__audioFailed) packMissing();
  else window.addEventListener('audiopack', () => {
    if (window.__audioFailed) packMissing();
    else tryDecode();
  });
}

function titleTap() {
  if (UI.playing || UI.starting) return;
  if (AE.decoded) {
    startGame();
    return;
  }
  // 소리를 아직 푸는 중: 이 터치로 소리 잠금만 풀어 두고, 준비되면 바로 시작
  UI.wantStart = true;
  try {
    if (!AE.ctx) createAudio();
    if (AE.ctx.state !== 'running') AE.ctx.resume().catch(() => { });
  } catch { }
  UI.el.startLabel.textContent = '곧 시작';
}

function syncMode() {
  document.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === TP.mode));
  UI.marksKey = '';
}
async function startGame() {
  if (!AE.decoded || UI.playing || UI.starting) return;
  if (WARM.q.length) { // 준비물을 아직 만드는 중: 이 터치로 소리 잠금만 풀어 두고, 다 되면 바로 시작
    UI.wantStart = true;
    UI.el.startLabel.textContent = '곧 시작';
    try {
      if (AE.ctx.state !== 'running') AE.ctx.resume().catch(() => { });
    } catch(e) { }
    return;
  }
  UI.starting = true;
  try {
    await AE.ctx.resume();
  } catch { }
  UI.starting = false;
  UI.wantStart = false;
  UI.el.title.classList.add('hide');
  if (!UI.touched) UI.el.stem.classList.add('hint');
  UI.el.controls.classList.remove('off');
  UI.el.pause.style.display = 'flex';
  releaseAllInput();
  TP.notes.length = 0;
  TP.lastSoundT = -9;
  TP.cur = null;
  resetCrowdAudio();
  REACT.reset();
  afterEnd();
  resetCrowdScenes();
  tossClear();
  bed.set('room', 0.05);
  bed.set('applause', 0);
  preStart();
  UI.inputRect = null;
  UI.playing = true;
  GAME.state = 'play';
}

function pauseGame() {
  if (!UI.playing) return;
  releaseAllInput();
  fingerVisual(null);
  if (AE.ctx) AE.ctx.suspend();
  UI.playing = false;
  GAME.state = 'paused';
  UI.el.paused.classList.remove('hide');
}
async function resumeGame() {
  UI.el.paused.classList.add('hide');
  try {
    await AE.ctx.resume();
  } catch { }
  UI.inputRect = null;
  UI.playing = true;
  GAME.state = 'play';
}

function measureRibbon() {
  const r = UI.el.ribbon.getBoundingClientRect(),
    stem = UI.el.stem.getBoundingClientRect();
  UI.inputRect = {
    bottom: r.bottom,
    height: r.height,
    offset: r.top - stem.top
  };
  return UI.inputRect;
}

function fingerVisual(pos) {
  UI.fingerPos = pos;
  UI.fingerDirty = pos != null;
  if (pos == null) UI.el.finger.classList.remove('on');
}

function flushFingerVisual() {
  if (!UI.fingerDirty) return;
  const r = UI.inputRect || measureRibbon(),
    f = UI.el.finger;
  f.classList.add('on');
  f.style.transform = 'translate3d(0,' + (r.offset + (1 - UI.fingerPos) * r.height) + 'px,0)';
  UI.fingerDirty = false;
}

function ribbonPos(clientY) {
  const r = UI.inputRect || measureRibbon();
  return clamp((r.bottom - clientY) / r.height, 0, 1);
}
// 띠: 손가락 여러 개. 소리는 마지막에 짚은 손가락 자리 (새로 짚으면 혀를 쳐서 뛰고, 떼면 남은 손가락 자리로 슬러)
function bindInput() {
  const st = UI.el.stem,
    F = [];
  const find = id => F.findIndex(f => f.id === id);
  st.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!UI.playing || find(e.pointerId) >= 0) return;
    if (!F.length) measureRibbon();
    try {
      st.setPointerCapture(e.pointerId);
    } catch (x) { }
    const p = ribbonPos(e.clientY);
    F.push({
      id: e.pointerId,
      pos: p
    });
    fingerVisual(p);
    if (F.length === 1) ribbonDown(p);
    else ribbonJump(p);
  });
  st.addEventListener('pointermove', e => {
    if (!UI.playing) return;
    const i = find(e.pointerId);
    if (i < 0) return;
    const p = ribbonPos(e.clientY);
    F[i].pos = p;
    if (i === F.length - 1) {
      fingerVisual(p);
      ribbonMove(p);
    }
  });
  const end = e => {
    const i = find(e.pointerId);
    if (i < 0) return;
    const top = i === F.length - 1;
    F.splice(i, 1);
    if (!top) return;
    if (F.length) {
      const f = F[F.length - 1];
      fingerVisual(f.pos);
      ribbonBack(f.pos);
      return;
    }
    fingerVisual(null);
    if (e.type === 'pointerup') ribbonUp();
    else releaseAllInput();
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('lostpointercapture', end);
  // 키보드
  let space = false;
  UI.cancelInput = () => {
    F.length = 0;
    space = false;
  };
  const stepKey = d => {
    let p = UI.kbPos != null ? UI.kbPos : TP.pos;
    if (TP.mode === 'free') p = pitchToPos(Math.round(posToPitch(p)) + d);
    else {
      const ch = chordAtTime((AE.ctx ? AE.ctx.currentTime : 0) + 0.02);
      const m = stepAllowed(Math.round(posToPitch(p)), d, ch, 'W');
      p = pitchToPos(m);
    }
    UI.kbPos = clamp(p, 0, 1);
    if (TP.blowing || PRE.buzz) {
      ribbonMove(UI.kbPos, { discrete: true });
      fingerVisual(UI.kbPos);
    } else TP.pos = UI.kbPos;
  };
  window.addEventListener('keydown', e => {
    if (!UI.playing) {
      if ((e.code === 'Space' || e.code === 'Enter') && !UI.el.title.classList.contains('hide') && !(document.activeElement && document.activeElement.id === 'arcade')) {
        e.preventDefault();
        titleTap();
      }
      return;
    }
    if (e.code === 'KeyE' && !e.repeat) {
      e.preventDefault();
      toggleCustomMenu();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat && !space) {
        space = true;
        const p = UI.kbPos != null ? UI.kbPos : TP.pos;
        fingerVisual(p);
        ribbonDown(p);
      }
    } else if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      e.preventDefault();
      stepKey(1);
    } else if (e.code === 'KeyS' || e.code === 'ArrowDown') {
      e.preventDefault();
      stepKey(-1);
    } else if (e.code === 'Tab') {
      e.preventDefault();
      setMode(TP.mode === 'snap' ? 'free' : 'snap');
      syncMode();
    } else if (e.code === 'Escape' || e.code === 'KeyP') pauseGame();
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' && space) {
      space = false;
      if (TP.blowing || PRE.buzz) ribbonUp();
      fingerVisual(null);
    }
  });
  document.addEventListener('contextmenu', e => e.preventDefault());
}
// 필살기 버튼: 한 번 누르면 시작, 다시 누르면 끝 (PC는 Shift)
function bindSpecial() {
  const b = UI.el.special;
  if (!b) return;
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!UI.playing || GAME.phase !== 'play') return;
    spToggle();
  });
  b.addEventListener('animationend', e => {
    if (e.animationName === 'spNope') b.classList.remove('nope');
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Shift' && !e.repeat && UI.playing && GAME.phase === 'play') spToggle();
  });
}

// 줄기 표시: 보정 모드는 지금 화음의 음 자리, 자유 모드는 반음 눈금
function uiTick() {
  if (UI.el.nextSong && AE.ctx) UI.el.nextSong.disabled = !UI.playing || AE.ctx.currentTime < (MUS.skipUntil || 0);
  autoSync();
  flushFingerVisual();
  if (!UI.playing && UI.marksKey) return;
  const now = AE.ctx ? AE.ctx.currentTime : 0;
  let key;
  if (TP.mode === 'snap') {
    const ch = chordAtTime(now + 0.03);
    key = 's' + ch.root + ch.q + (MUS.song && MUS.song.tune.blues ? 'b' + MUS.song.keyPc : '');
  } else key = 'f';
  if (key === UI.marksKey) return;
  UI.marksKey = key;
  const box = UI.el.marks;
  box.innerHTML = '';
  const add = (m, cls) => {
    const i = document.createElement('i');
    i.className = cls;
    i.style.top = ((1 - pitchToPos(m)) * 100) + '%';
    box.appendChild(i);
  };
  if (TP.mode === 'snap') {
    const ch = chordAtTime(now + 0.03);
    for (let m = TP.lo; m <= TP.hi; m++) {
      if (isChordTone(m, ch)) add(m, 'ct');
      else if (inSet(m, ch, 'W')) add(m, 'st');
      else if (bluesOk(m, ch, false)) add(m, 'bl');
    }
  } else
    for (let m = TP.lo; m <= TP.hi; m++) add(m, mod12(m) === 0 ? 'tk c' : 'tk');
}

// ===== 81_hype.js =====
// ===================== 뽕 차는 반응: 충격파 · 무대로 날아드는 꽃과 모자 · 폭죽 색종이 · 박자 박수와 구호 · 소품 장면 · 밴드 묘기 =====================
const HYPE = {
  chantUntil: 0,
  lastBeatK: -1,
  last: {},
  bell: null,
  beat: 0
};
const _hq = new THREE.Quaternion(),
  _hm = new THREE.Matrix4(),
  _hv = new THREE.Vector3(),
  _hv2 = new THREE.Vector3(),
  _he = new THREE.Euler();
// 같은 일이 너무 자주 겹치지 않게: gap초 안에 또 부르면 false
const hypeOk = (k, gap) => {
  const t = NOW.t;
  if (t - (HYPE.last[k] == null ? -999 : HYPE.last[k]) < gap) return false;
  HYPE.last[k] = t;
  return true;
};
// 물체의 +z가 target을 향하게 하는 회전
function faceQ(pos, target, out = new THREE.Quaternion()) {
  return out.setFromRotationMatrix(_hm.lookAt(target, pos, UPY));
}
const lerpYaw = (a, b, k) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};
const freeFans = () => CROWD.list.filter(m => !m.override && m.p.root.visible && !(m.act && m.act.story) && !m.pending);
const panOf = p => clamp(p.root.position.x / 6, -0.9, 0.9);

// ---------- 충격파: 무대에서 객석 뒤로 번지는 물결 (닿는 순간 몸이 뒤로 휙 젖혀짐) + 화면이 살짝 당겨짐 ----------
function crowdShock(amp = 1, speed = 10) {
  CROWD.shockId = (CROWD.shockId || 0) + 1;
  CROWD.shock = {
    t0: NOW.t,
    amp,
    speed,
    id: CROWD.shockId
  };
  SC.punch = Math.max(SC.punch || 0, Math.min(1.2, amp));
}

function applyShock(m, t) {
  const S = CROWD.shock;
  if (!S || m.shockId === S.id) return;
  const p = m.p,
    at0 = S.t0 + Math.hypot(p.root.position.x, p.root.position.z + 2.4) / S.speed;
  if (t < at0) return;
  m.shockId = S.id;
  if (t > at0 + 0.35) return;
  p.s.lean -= 0.5 * S.amp;
  p.s.jumpY += 0.05 * S.amp;
  if (!(m.act && m.act.story)) p.express(pick(['gasp', 'wow', 'jawdrop']), 0.8);
}
// 큰 순간에 화면을 아주 살짝 당겼다 놓음 (무대 쪽만. 내 트럼펫은 그대로)
function camFx(dt) {
  const p = SC.punch || 0;
  if (p < 0.002) {
    if (SC.punched) {
      SC.punched = false;
      SC.punch = 0;
      SC.camera.fov = SC.baseFov;
      SC.camera.updateProjectionMatrix();
    }
    return;
  }
  SC.punch = damp(p, 0, 6.5, dt);
  SC.punched = true;
  SC.camera.fov = SC.baseFov * (1 - 0.03 * SC.punch);
  SC.camera.updateProjectionMatrix();
}

// ---------- 소리 ----------
// 폭죽 "팡"
function popSound(when, pan = 0, vol = 0.5) {
  const ctx = AE.ctx;
  if (!ctx || !AE.noise) return;
  const fx = fxGraph();
  const out = fx.own(ctx.createGain());
  out.gain.value = vol;
  const pn = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pn) {
    pn.pan.value = clamp(pan, -1, 1);
    out.connect(pn);
    pn.connect(AE.buses.crowd);
  } else out.connect(AE.buses.crowd);
  const ns = fx.own(ctx.createBufferSource());
  ns.buffer = AE.noise;
  const bp = fx.own(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2600, when);
  bp.frequency.exponentialRampToValueAtTime(900, when + 0.12);
  bp.Q.value = 0.8;
  const ng = fx.own(ctx.createGain());
  ng.gain.setValueAtTime(0, when);
  ng.gain.linearRampToValueAtTime(1, when + 0.002);
  ng.gain.exponentialRampToValueAtTime(0.001, when + 0.16);
  ns.connect(bp);
  bp.connect(ng);
  ng.connect(out);
  ns.start(when, rand(0, 1));
  ns.stop(when + 0.2);
  const o = fx.own(ctx.createOscillator());
  o.frequency.setValueAtTime(260, when);
  o.frequency.exponentialRampToValueAtTime(70, when + 0.09);
  const og = fx.own(ctx.createGain());
  og.gain.setValueAtTime(0.9, when);
  og.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
  o.connect(og);
  og.connect(out);
  o.start(when);
  o.stop(when + 0.14);
}
// 바 종 "땡"
function bellDing(when, vol = 0.2, pan = 0.4) {
  const ctx = AE.ctx;
  if (!ctx) return;
  const fx = fxGraph();
  const out = fx.own(ctx.createGain());
  out.gain.value = vol;
  const pn = ctx.createStereoPanner ? fx.own(ctx.createStereoPanner()) : null;
  if (pn) {
    pn.pan.value = pan;
    out.connect(pn);
    pn.connect(AE.buses.crowd);
  } else out.connect(AE.buses.crowd);
  const f = 1180,
    ratios = [0.56, 0.92, 1.19, 1.71, 2.0, 2.74, 3.76],
    amps = [0.5, 0.6, 1, 0.5, 0.75, 0.4, 0.25],
    decs = [1.6, 1.3, 1.0, 0.8, 0.9, 0.5, 0.35];
  ratios.forEach((r, i) => {
    const o = fx.own(ctx.createOscillator());
    o.type = 'sine';
    o.frequency.value = f * r * rand(0.998, 1.002);
    const g = fx.own(ctx.createGain());
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amps[i] * 0.3, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0006, when + decs[i]);
    o.connect(g);
    g.connect(out);
    o.start(when);
    o.stop(when + decs[i] + 0.05);
  });
}
// 뽀뽀 "쪽"
function smooch(when, pan = 0, vol = 0.22) {
  breathBlip(when, {
    dur: 0.075,
    f0: 1100,
    f1: 4200,
    q: 7,
    vol,
    pan,
    att: 0.004
  });
  breathBlip(when + 0.07, {
    dur: 0.03,
    f0: 2400,
    f1: 900,
    q: 3,
    vol: vol * 0.5,
    pan,
    att: 0.002
  });
}
// 다 같이 박에 맞춰 "헤이!"
function heyShout(when, lvl = 1) {
  if (playBakedFx('hey', when, lvl)) return;
  for (let i = 0; i < 6; i++) {
    const fem = i % 2 === 0;
    voiceBlip(when + rand(-0.008, 0.026), {
      dur: rand(0.17, 0.23),
      f0: fem ? rand(300, 390) : rand(160, 215),
      fem,
      v0: VOWEL.e,
      v1: [330, 2050, 2800],
      vol: rand(0.05, 0.085) * lvl,
      att: 0.012,
      hold: 0.45,
      curve: [
        [0, 1.12],
        [1, 0.86]
      ],
      vib: 0,
      breath: 0.7,
      q: [4, 6, 8]
    });
  }
}

function startChant(bars = 2) {
  HYPE.chantUntil = NOW.t + bars * 4 * curSpb() + 0.2;
  for (const m of shuffle(freeFans()).slice(0, 18)) crowdAct(m, 'pump', bars * 4 * curSpb(), {
    side: pick(PERSON_SIDES),
    both: Math.random() < 0.5
  });
}
// 박 맞춰 내는 객석 소리: 2·4박 박수 / 구호 / 내가 오래 쉬면 "쿵쿵짝"
function hypeBeat(t, f) {
  if (!AE.decoded || !MUS.running || !UI.playing || GAME.phase !== 'play') return;
  const now = AE.ctx.currentTime,
    tb = now + 0.09,
    b = barAtTime(tb),
    S = MUS.song;
  if (!b || !S || tb > b.t0 + 4 * b.spb + 0.02) {
    HYPE.lastBeatK = -1;
    return;
  }
  const n = Math.floor((tb - b.t0) / b.spb + 1e-4),
    k = b.beat0 + n;
  if (k === HYPE.lastBeatK) return;
  HYPE.lastBeatK = k;
  const tk = b.t0 + n * b.spb,
    R = REACT;
  if (tk < now || n > 3 || (SPX.hush && t < SPX.hush.until) || ENDL.stage === 2 || R.inBreak || MUS.fermata || b.phase === 'count' || b.phase === 'final') return;
  const claps = (cnt, v) => {
    for (let i = 0; i < cnt; i++) playBuf(pick(AE.syn.claps), tk + rand(-0.012, 0.022), rand(0.08, 0.15) * v, AE.buses.crowd, {
      pan: rand(-0.85, 0.85),
      rate: rand(0.9, 1.15)
    });
  };
  if (t < HYPE.chantUntil) {
    heyShout(tk, 1);
    claps(5, 0.9);
    return;
  }
  if (R.meSolo && b.feel !== 'ballad' && f > 0.45 && !(R.burst && t < R.burst.until)) {
    if (n === 1 || n === 3) claps(Math.round(4 + f * 5), smoothstep(0.45, 0.8, f));
    return;
  }
  // 한번 달아올랐던 객석은 내가 오래 쉬면 발 구르고 손뼉 치며 재촉함
  if (MISS.k > 0.45 && R.peak > 45 && !R.meSolo) {
    const v = smoothstep(0.45, 0.7, MISS.k);
    if (n === 0 || n === 1)
      for (let i = 0; i < 4; i++) playBuf(AE.syn.stomp, tk + rand(-0.01, 0.025), rand(0.08, 0.13) * v, AE.buses.crowd, {
        pan: rand(-0.8, 0.8),
        rate: rand(0.85, 1.05)
      });
    else if (n === 2) claps(7, 0.9 * v);
  }
}

// ---------- 색종이 (폭죽·천장에서 쏟아짐) ----------
const CONFETTI = ['#ee4a2c', '#ffbf2e', '#2f5bd8', '#13a08a', '#ff7aa8', '#fffaf0', '#7b3fb0', '#ffe36b'];

function fxConfetti(o, dir, n = 44, spread = 1.5) {
  const d = dir.clone().normalize();
  for (let i = 0; i < n; i++) fxEmit(o, d.clone().multiplyScalar(rand(3.4, 6.6)).add(_hv.set(rand(-spread, spread), rand(-0.4, spread), rand(-spread, spread))), rand(0.05, 0.085), rand(1.7, 2.9), pick(CONFETTI), 2.6, 2.8);
}

function fxConfettiDrop(n = 150, sec = 1.6) {
  const one = () => fxEmit(_hv.set(rand(-4.6, 4.6), rand(4.2, 4.65), rand(-7.2, -1.2)).clone(), _hv2.set(rand(-0.5, 0.5), rand(-0.9, 0), rand(-0.5, 0.5)).clone(), rand(0.055, 0.09), rand(3.2, 5.2), pick(CONFETTI), 1.6, 2.2);
  for (let i = 0; i < n; i++) REACT.later(rand(0, sec), one);
}

function poppers(n = 2, win = 1.5) {
  const W = freeFans().filter(m => m.kind !== 'bar' && !m.far);
  shuffle(W).slice(0, n).forEach(m => REACT.later(rand(0, win), () => {
    if (m.override || (m.act && m.act.story)) return;
    m.pending = null;
    m.act = {
      k: 'popper',
      t0: NOW.t,
      until: NOW.t + 1.5
    };
  }));
}

function actPopper(m, p, a, F, t) {
  const age = t - a.t0,
    c = at(F, 0.3, 0, 0.18);
  const dir = _hv2.copy(F.f).multiplyScalar(0.5).add(UPY).normalize().clone();
  p.reach('L', c.clone().add(_hv.set(0, -0.06, 0)), null, null, 'grip');
  p.reach('R', c.clone().add(_hv.set(0, -0.15, 0)).addScaledVector(F.r, 0.03), null, null, 'pinch');
  makeCrowdProp(m, 'popper');
  a.hold = {
    popper: {
      pos: c,
      q: new THREE.Quaternion().setFromUnitVectors(UPY, dir)
    }
  };
  if (!a.done && age > 0.5) {
    a.done = true;
    fxConfetti(c.clone().addScaledVector(dir, 0.12), dir, 46);
    if (AE.decoded) popSound(AE.ctx.currentTime + 0.01, panOf(p), m.far ? 0.3 : 0.5);
    p.express('scream', 1.2);
  }
}

// ---------- 무대로 날아드는 꽃다발·장미·모자 ----------
// 내려앉은 것은 종류별 덩어리(beds)의 빈칸에 꼭짓점만 써 넣음. 전에는 하나 내려앉을 때마다 바닥의 전부를 다시 합쳤고(그 순간 화면이 멈칫함), 합치기 전까지는 방금 떨어진 것이 잠깐 사라졌음
const TOSS = {
  fly: [],
  pool: [],
  geos: null,
  mat: null,
  beds: null,
  cap: {
    bouquet: 18,
    rose: 18,
    hat: 10
  }
};

function tossGeos() {
  if (TOSS.geos) return TOSS.geos;
  const G2 = {};
  const bouquet = (wrap, bl) => {
    const parts = [
      [new THREE.ConeGeometry(0.078, 0.27, 10).rotateX(Math.PI), wrap],
      [new THREE.CylinderGeometry(0.013, 0.013, 0.08, 6).translate(0, -0.17, 0), '#3aa860'],
      [new THREE.SphereGeometry(0.042, 8, 6).translate(0, 0.185, 0), bl[0]]
    ];
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2;
      parts.push([new THREE.SphereGeometry(0.04, 8, 6).translate(Math.cos(a) * 0.042, 0.16, Math.sin(a) * 0.042), bl[k % bl.length]]);
    }
    for (const [x, z] of [
      [-0.05, 0.03],
      [0.05, 0.02],
      [0, -0.055]
    ]) parts.push([new THREE.SphereGeometry(0.03, 6, 4).scale(0.5, 1.4, 0.3).translate(x, 0.11, z), '#3aa860']);
    return _vm(parts).scale(1.2, 1.2, 1.2);
  };
  G2.bouquet = [bouquet('#fff4de', ['#ee4a2c', '#ff7aa8', '#ffd84a']), bouquet('#f7c6d6', ['#fffaf0', '#b07ad8', '#ff8a5c']), bouquet('#cfe8ff', ['#ffd84a', '#ee4a2c', '#fffaf0'])];
  const rose = col => _vm([
    [new THREE.CylinderGeometry(0.007, 0.007, 0.36, 6), '#2f8a4e'],
    [new THREE.SphereGeometry(0.04, 10, 8).scale(1, 1.15, 1).translate(0, 0.2, 0), col],
    [new THREE.SphereGeometry(0.024, 6, 4).scale(1.6, 0.35, 0.8).translate(0.034, 0.04, 0), '#3aa860']
  ]);
  G2.rose = [rose('#e0283a'), rose('#ff7aa8'), rose('#fffaf0')];
  const hat = (col, band) => _vm([
    [new THREE.CylinderGeometry(0.085, 0.1, 0.1, 16).translate(0, 0.05, 0), col],
    [new THREE.CylinderGeometry(0.17, 0.17, 0.012, 20), col],
    [new THREE.CylinderGeometry(0.102, 0.102, 0.026, 16).translate(0, 0.02, 0), band]
  ]);
  G2.hat = [hat('#22244a', '#ee4a2c'), hat('#6b3a1e', '#ffbf2e'), hat('#2f5a42', '#fff4de')];
  TOSS.geos = G2;
  TOSS.mat = toonVC({
    outline: 0.003
  });
  // 종류별 바닥 덩어리: 칸 하나 = 그 종류에서 꼭짓점이 가장 많은 모양 크기
  TOSS.beds = {};
  for (const k in TOSS.cap) {
    const vmax = Math.max(...G2[k].map(g => g.attributes.position.count)),
      geo = new THREE.BufferGeometry();
    for (const a of ['position', 'normal', 'color']) {
      const at = new THREE.BufferAttribute(new Float32Array(TOSS.cap[k] * vmax * 3), 3);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(a, at);
    }
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, TOSS.mat);
    mesh.name = 'gifts-' + k;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.visible = false;
    SC.scene.add(mesh);
    TOSS.beds[k] = {
      mesh,
      geo,
      vmax,
      n: 0
    };
  }
  return G2;
}
// 날아다닐 것 몇 개를 미리 만들어 둠
function tossWarm(n = 10) {
  const G2 = tossGeos();
  while (TOSS.pool.length + TOSS.fly.length < n) {
    const it = {
      mesh: new THREE.Mesh(G2.rose[0], TOSS.mat)
    };
    it.mesh.castShadow = false;
    it.mesh.visible = false;
    SC.scene.add(it.mesh);
    TOSS.pool.push(it);
  }
}
// 내려앉은 것 하나를 바닥 덩어리의 다음 칸에 써 넣음 (칸이 다 차면 가장 오래된 칸부터 덮어씀)
function tossLand(it) {
  const B = TOSS.beds[it.kind],
    cap = TOSS.cap[it.kind],
    A = it.geo.attributes,
    cnt = A.position.count,
    o = (B.n % cap) * B.vmax;
  const e = _hm.compose(it.pos, it.rest, _hv.set(1, 1, 1)).elements,
    P = B.geo.attributes.position,
    N = B.geo.attributes.normal,
    C = B.geo.attributes.color;
  const sp = A.position.array,
    sn = A.normal.array,
    sc = A.color.array,
    dp = P.array,
    dn = N.array,
    dc = C.array;
  for (let i = 0; i < B.vmax; i++) {
    const j = (o + i) * 3;
    if (i >= cnt) {
      dp[j] = dp[j + 1] = dp[j + 2] = 0;
      continue;
    } // 남는 꼭짓점은 한 점에 모아 안 보이게
    const k = i * 3,
      x = sp[k],
      y = sp[k + 1],
      z = sp[k + 2],
      nx = sn[k],
      ny = sn[k + 1],
      nz = sn[k + 2];
    dp[j] = e[0] * x + e[4] * y + e[8] * z + e[12];
    dp[j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    dp[j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    dn[j] = e[0] * nx + e[4] * ny + e[8] * nz;
    dn[j + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
    dn[j + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
    dc[j] = sc[k];
    dc[j + 1] = sc[k + 1];
    dc[j + 2] = sc[k + 2];
  }
  for (const a of [P, N, C]) {
    a.addUpdateRange(o * 3, B.vmax * 3);
    a.needsUpdate = true;
  }
  B.n++;
  B.geo.setDrawRange(0, Math.min(B.n, cap) * B.vmax);
  B.mesh.visible = true;
}
// 떨어질 자리: 무대 앞 가장자리와 내 앞 가운데 길
function tossTarget() {
  const r = Math.random(),
    Y = LAYOUT.stageY;
  if (r < 0.5) return V3(rand(-3.7, 3.7), Y, rand(-3.78, -3.15));
  if (r < 0.9) return V3(rand(-0.8, 1.35), Y, rand(-2.75, -0.7));
  return V3(rand(-3.4, 3.4), Y, rand(-3.1, -2.5));
}

function tossSpawn(from, kind = null, to = null) {
  const G2 = tossGeos();
  kind = kind || pick(['bouquet', 'bouquet', 'rose', 'rose', 'hat']);
  to = to || tossTarget();
  let it = TOSS.pool.pop();
  if (!it) {
    it = {
      mesh: new THREE.Mesh(G2.rose[0], TOSS.mat)
    };
    it.mesh.castShadow = false;
    SC.scene.add(it.mesh);
  }
  it.geo = pick(G2[kind]);
  it.mesh.geometry = it.geo;
  it.mesh.visible = true;
  it.kind = kind;
  const T = clamp(from.distanceTo(to) / 5.5, 0.7, 1.5);
  it.pos = from.clone();
  it.vel = to.clone().sub(from).multiplyScalar(1 / T);
  it.vel.y += 4.9 * T;
  it.t = 0;
  it.restY = to.y + (kind === 'bouquet' ? 0.1 : kind === 'rose' ? 0.045 : 0.008);
  it.axis = kind === 'hat' ? V3(rand(-0.15, 0.15), 1, rand(-0.15, 0.15)).normalize() : V3(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1)).normalize();
  it.spin = kind === 'hat' ? rand(9, 14) : rand(4, 9);
  it.q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(-1, 1), rand(0, 6), rand(-1, 1)));
  it.rest = new THREE.Quaternion().setFromEuler(kind === 'hat' ? new THREE.Euler(rand(-0.06, 0.06), rand(0, 6.28), rand(-0.06, 0.06), 'YXZ') : new THREE.Euler(0, rand(0, 6.28), rand(1.3, 1.5), 'YXZ'));
  it.down = 0;
  TOSS.fly.push(it);
  return it;
}

function tossUpdate(dt) {
  for (let i = TOSS.fly.length - 1; i >= 0; i--) {
    const it = TOSS.fly[i];
    if (!it.down) {
      it.vel.y -= 9.8 * dt;
      it.pos.addScaledVector(it.vel, dt);
      it.q.premultiply(_hq.setFromAxisAngle(it.axis, it.spin * dt));
      if (it.pos.y <= it.restY && it.vel.y < 0) {
        it.pos.y = it.restY;
        it.down = 1e-4;
        it.vel.y = 0;
        it.vel.multiplyScalar(0.28);
      }
    } else {
      // 바닥에 닿아 살짝 미끄러지다 멈춤
      it.down += dt;
      it.pos.addScaledVector(it.vel, dt);
      it.vel.multiplyScalar(Math.max(0, 1 - 7 * dt));
      it.q.slerp(it.rest, 1 - Math.exp(-14 * dt));
      if (it.down > 0.4) {
        it.mesh.visible = false;
        TOSS.fly.splice(i, 1);
        TOSS.pool.push(it);
        tossLand(it);
        continue;
      }
    }
    it.mesh.position.copy(it.pos);
    it.mesh.quaternion.copy(it.q);
  }
}

function tossClear() {
  for (const it of TOSS.fly) {
    it.mesh.visible = false;
    TOSS.pool.push(it);
  }
  TOSS.fly.length = 0;
  if (TOSS.beds)
    for (const k in TOSS.beds) {
      const B = TOSS.beds[k];
      B.n = 0;
      B.geo.setDrawRange(0, 0);
      B.mesh.visible = false;
    }
}
// 객석 여기저기서 n개가 날아옴
function throwGifts(n, win = 2.5, kinds = null) {
  const W = freeFans().filter(m => m.kind !== 'bar');
  const pool = W.map(m => ({
    m,
    s: m.p.root.position.z + rand(-3, 3)
  })).sort((a, b) => b.s - a.s).slice(0, n);
  for (const {
    m
  }
    of pool) REACT.later(rand(0, win), () => {
      if (m.override || (m.act && m.act.story)) return;
      m.pending = null;
      m.act = {
        k: 'throw',
        t0: NOW.t,
        until: NOW.t + 0.95,
        kind: kinds ? pick(kinds) : null
      };
    });
}

function actThrow(m, p, a, F, t) {
  const age = t - a.t0,
    f = smoothstep(0.24, 0.38, age);
  p.reach('R', at(F, -0.16, 0.22, 0.38).lerp(at(F, 0.5, 0.1, 0.68), f), null, null, f > 0.6 ? 'spread' : 'grip');
  p.rest('L');
  p.c.lean = lerp(-0.12, 0.2, f);
  if (!a.done && age > 0.34) {
    a.done = true;
    tossSpawn(at(F, 0.45, 0.1, 0.66), a.kind);
  }
}

// ---------- 소품 장면 ----------
const HYPE_SCENES = {
  scoreCard: 5.2,
  chairDance: 7.6,
  towelSpin: 6.2,
  sob: 6.6,
  callFriend: 5.4,
  toast: 4.8,
  hugJump: 5.0,
  hugged: 5.0,
  surf: 5.4
};
Object.assign(CROWD_SCENES, HYPE_SCENES);
// 엉엉: 눈 꼭 감고 입은 크게, 눈썹은 팔자
FACES.bawl = Object.assign({}, FACE_DEF, {
  brow: 1.0,
  browIn: 1.0,
  lid: 0.86,
  open: 1.25,
  smile: -0.55,
  width: 0.12
});
const _cardTex = {};

function cardTex(text) {
  if (_cardTex[text]) return _cardTex[text];
  return _cardTex[text] = canvasTex(128, 172, (g, w, h) => {
    g.fillStyle = '#fffaf0';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#221a2b';
    g.lineWidth = 5;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#221a2b';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${text.length > 2 ? 62 : 88}px "Hahmlet", "Noto Serif KR", Georgia, serif`;
    g.fillText(text, w / 2, h / 2 - 4);
    g.fillStyle = '#ee4a2c';
    g.fillRect(w * 0.26, h * 0.8, w * 0.48, 7);
  });
}

function setCardText(pr, text) {
  pr.userData.text = text;
  const f = pr.userData.face;
  f.material.map = cardTex(text);
  f.material.needsUpdate = true;
}
// 새 소품 모양 (makeCrowdProp이 부름)
function hypeProp(kind, add, m) {
  if (kind === 'card') {
    add(rbox(0.25, 0.33, 0.012, 0.02, 2), '#fffaf0');
    const f = add(new THREE.PlaneGeometry(0.228, 0.306), '#ffffff', [0, 0, 0.0075], true);
    f.name = 'cardFace';
    f.material.map = cardTex('10');
    return null;
  }
  if (kind === 'towel') {
    const col = (m.p.look && m.p.look.top) || '#fff4de';
    add(rbox(0.15, 0.62, 0.016, 0.02, 2).translate(0, -0.31, 0), '#fffaf0');
    for (const y of [-0.1, -0.52]) add(rbox(0.153, 0.045, 0.018, 0.005, 1).translate(0, y, 0), col);
    return null;
  }
  if (kind === 'popper') {
    add(new THREE.ConeGeometry(0.046, 0.17, 12).rotateX(Math.PI), '#ffbf2e');
    add(new THREE.CylinderGeometry(0.048, 0.048, 0.02, 12), '#ee4a2c', [0, 0.085, 0]);
    add(new THREE.CylinderGeometry(0.026, 0.02, 0.02, 10), '#2f5bd8', [0, -0.02, 0]);
    return null;
  }
  if (kind === 'soul') {
    // 입에서 빠져나가는 혼: 흰 덩어리 + 꼬리 + 멍한 눈
    add(new THREE.SphereGeometry(0.09, 16, 12).scale(1, 1.12, 0.92), '#ffffff', [0, 0.1, 0]);
    add(latheY([
      [0.001, -0.2],
      [0.012, -0.17],
      [0.03, -0.1],
      [0.06, -0.02],
      [0.078, 0.06],
      [0.001, 0.07]
    ], 12), '#ffffff');
    for (const sx of [1, -1]) add(new THREE.SphereGeometry(0.013, 8, 6).scale(1, 1.5, 0.6), '#221a2b', [sx * 0.032, 0.12, 0.079]);
    add(new THREE.SphereGeometry(0.016, 8, 6).scale(1, 1.3, 0.6), '#221a2b', [0, 0.066, 0.083]);
    return null;
  }
  if (kind === 'pad') {
    add(rbox(0.13, 0.17, 0.014, 0.012, 2), '#fffaf0');
    add(rbox(0.13, 0.022, 0.016, 0.005, 1).translate(0, 0.074, 0), '#ee4a2c');
    return null;
  }
  if (kind === 'bouquet') {
    add(tossGeos().bouquet[(m.p.look.seed || 0) % 3].clone(), '#ffffff').material = TOSS.mat;
    return null;
  }
  return null;
}
// 점수판: 가까이 앉은 서너 명이 심사위원처럼 차례로 "10"을 듦
function scoreCards() {
  if (!hypeOk('cards', 22)) return;
  const W = freeFans().filter(m => m.kind === 'seat' || m.kind === 'front');
  if (!W.length) return;
  const c = pick(W),
    grp = W.filter(o => Math.abs(o.p.root.position.z - c.p.root.position.z) < 1.0 && Math.abs(o.p.root.position.x - c.p.root.position.x) < 2.9).sort((a, b) => a.p.root.position.x - b.p.root.position.x).slice(0, 4);
  if (grp.length < 2) return;
  const odd = Math.random() < 0.6 ? grp.length - 1 : -1;
  grp.forEach((m, i) => forceScene(m, 'scoreCard', 0, {
    lag: i * 0.2,
    text: i === odd ? pick(['11', '11', '100']) : '10'
  }));
}

function toastWave() {
  if (!hypeOk('toast', 14)) return;
  for (const m of freeFans())
    if (m.kind === 'seat' || m.kind === 'bar') forceScene(m, 'toast', clamp((-4 - m.p.root.position.z) * 0.09, 0, 1.2) + rand(0, 0.25));
}

function newcomer() {
  if (BACKP.n < BACKP.spots.length) addBackCrowd(1);
  else addWindowFaces(1);
}
// 달아오른 뒤 가끔 섞이는 장면 고르기 (종류마다 동시에 몇 명까지만)
function hypeScene(m, f) {
  const cnt = k => CROWD.list.reduce((n, o) => n + (((o.act && o.act.k === k) || (o.pending && o.pending.k === k)) ? 1 : 0), 0);
  const c = [],
    st = m.p.s.stand > 0.7,
    fr = m.friend;
  if (m.kind === 'seat' && cnt('chairDance') < 3) c.push('chairDance', 'chairDance');
  if (st && m.kind !== 'bar' && cnt('towelSpin') < 2) c.push('towelSpin', 'towelSpin');
  if (cnt('sob') < 2) c.push('sob');
  if (cnt('callFriend') < 1 && NOW.t - (HYPE.last.call || -99) > 18) c.push('callFriend');
  if (st && fr && !fr.override && !fr.pending && !(fr.act && fr.act.story) && fr.p.s.stand > 0.7 && fr.kind !== 'bar' && m.kind !== 'bar' && fr.p.root.position.distanceTo(m.p.root.position) < 1.5 && cnt('hugJump') < 2) c.push('hugJump', 'hugJump');
  if (f > 0.85 && m.kind === 'front' && (m.rush || 0) > 0.15 && cnt('surf') < 1 && NOW.t - (HYPE.last.surf || -99) > 22) c.push('surf', 'surf');
  return c.length ? pick(c) : null;
}

function runHypeScene(m, t, a, age, F) {
  const p = m.p,
    R = p.R;
  switch (a.k) {
    case 'scoreCard': {
      crowdStill(p, 0.08);
      const lag = a.lag || 0,
        up = smoothstep(0.2 + lag, 0.62 + lag, age) * (1 - smoothstep(4.3, 4.9, age));
      const pr = makeCrowdProp(m, 'card');
      if (pr.userData.text !== (a.text || '10')) setCardText(pr, a.text || '10');
      const c = at(F, 0.3, 0, -0.3).lerp(at(F, 0.22, 0, 0.66 + Math.sin(age * 7 + lag * 9) * 0.015), up);
      const q = faceQ(c, CROWD.me),
        rt = _hv.set(1, 0, 0).applyQuaternion(q).clone();
      p.reach('L', c.clone().addScaledVector(rt, 0.11).add(_hv2.set(0, -0.13, 0)), null, null, 'grip');
      p.reach('R', c.clone().addScaledVector(rt, -0.11).add(_hv2.set(0, -0.13, 0)), null, null, 'grip');
      a.hold = up > 0.03 ? {
        card: {
          pos: c,
          q
        }
      } : null;
      sceneFace(p, age < 0.7 + lag ? 'focus' : (age < 3.2 ? 'grin' : 'stunlaugh'));
      p.c.nod = age > 1 ? 0.8 : 0;
      p.c.groove = age > 1 ? 0.5 : 0;
      break;
    }
    case 'chairDance': {
      // 자기 의자 위로 올라가 춤
      const D = a.until - a.t0,
        upk = smoothstep(0.5, 0.9, age) * (1 - smoothstep(D - 0.8, D - 0.45, age));
      p.c.stand = 1;
      m.offK = 1 - smoothstep(0.15, 0.5, age) + smoothstep(D - 0.45, D - 0.1, age);
      m.liftY = (m.spot.seatY || 0.47) * upk + (age > 0.5 && age < 0.95 ? Math.sin((age - 0.5) / 0.45 * Math.PI) * 0.1 : 0);
      if (upk > 0.9) {
        p.c.groove = 1;
        p.c.bounce = 1;
        p.c.jump = 0.45;
        p.c.sway = 0.9;
        p.c.hipSway = 1;
        const w = Math.sin(age * 5.2 + m.phase0 * 3) * 0.14,
          bp = ((HYPE.beat % 2) + 2) % 2;
        if (m.wild > 0.5) {
          p.reach('L', at(F, 0.1, -0.3 - w, 0.66), null, null, 'spread');
          p.reach('R', at(F, 0.1, 0.3 - w, 0.66), null, null, 'spread');
        } else {
          p.reach('L', at(F, 0.22, -0.2, bp < 1 ? 0.62 : 0.2), null, null, 'fist');
          p.reach('R', at(F, 0.22, 0.2, bp < 1 ? 0.2 : 0.62), null, null, 'fist');
        }
        sceneFace(p, Math.sin(age * 1.1 + m.phase0) > 0 ? 'scream' : 'ecstasy');
      } else sceneFace(p, 'grin');
      break;
    }
    case 'towelSpin': {
      // 수건을 머리 위로 빙빙
      p.c.stand = 1;
      p.c.jump = 0.55;
      p.c.groove = 0.8;
      p.c.bounce = 0.8;
      const k = smoothstep(0.15, 0.6, age) * (1 - smoothstep(5.4, 6.0, age)),
        w = age * 15;
      const hand = at(F, 0.06, 0.3, 0.66).add(_hv2.set(Math.cos(w) * 0.07, 0, Math.sin(w) * 0.07)); // 팔이 짧아 머리 옆 위가 가장 높은 자리
      p.reach('R', at(F, 0.15, 0.2, -0.2).lerp(hand, k), null, null, 'fist');
      const bp = ((HYPE.beat % 1) + 1) % 1;
      p.reach('L', at(F, 0.2, -0.24, 0.3 + Math.max(0, Math.cos(bp * Math.PI * 2)) * 0.2), null, null, 'fist');
      makeCrowdProp(m, 'towel');
      a.hold = k > 0.2 ? {
        towel: {
          side: 'R',
          q: new THREE.Quaternion().setFromEuler(_he.set(0, -w, 1.86, 'YXZ'))
        }
      } : null;
      sceneFace(p, Math.sin(age * 1.4) > 0 ? 'scream' : 'ecstasy');
      break;
    }
    case 'sob': {
      // 감격해서 엉엉: 눈물이 분수처럼
      crowdStill(p);
      if (age < 4.4) {
        sceneFace(p, 'bawl');
        p.c.side = Math.sin(age * 17) * 0.05;
        p.c.lean = 0.1 + Math.sin(age * 8.5) * 0.04;
        p.c.headTilt = Math.sin(age * 1.7) * 0.12;
        if (age > 0.4)
          for (const sx of [1, -1])
            if (Math.random() < 0.8) {
              const e = facePoint(p, sx * p.eyeP.x * 1.3, p.eyeP.y - p.headC.y - p.eyeP.r * 0.3, p.eyeP.z - p.headC.z + 0.03);
              fxEmit(e, sideW(F, sx).multiplyScalar(rand(0.7, 1.3)).add(_hv.set(0, rand(1.3, 2.0), 0)).addScaledVector(F.f, rand(0.1, 0.5)), rand(0.048, 0.07), rand(0.45, 0.65), Math.random() < 0.7 ? '#8fd6ff' : '#e6f7ff');
            }
        if (age > 1.6 && age < 3.0) {
          const w = Math.sin((age - 1.6) * 6) * 0.5 + 0.5;
          p.reach('R', facePoint(p, lerp(-R * 0.7, R * 0.5, w), R * 0.05, R * 1.05), null, null, 'fist');
          p.reach('L', at(F, 0.16, -0.14, 0.02), null, null, 'fist');
        } else {
          p.reach('L', at(F, 0.2, -0.1, 0.12), null, null, 'fist');
          p.reach('R', at(F, 0.2, 0.1, 0.12), null, null, 'fist');
        }
      } else {
        sceneFace(p, age < 5.4 ? 'teary' : 'stunlaugh');
        p.c.nod = 1.2;
        p.c.groove = 0.6;
        sceneClap(p, F, t, age > 5.4);
      }
      break;
    }
    case 'callFriend': {
      // "야 지금 당장 와!" → 조금 뒤 한 명이 더 들어옴
      crowdStill(p);
      p.c.lean = 0.08;
      const k = smoothstep(0, 0.55, age) * (1 - smoothstep(4.6, 5.2, age));
      const ear = facePoint(p, -R * 1.02, -R * 0.1, R * 0.12).addScaledVector(F.r, 0.05);
      p.reach('R', at(F, 0.2, 0.2, -0.3).lerp(ear, k), null, null, 'grip');
      makeCrowdProp(m, 'phone');
      a.phoneQ = new THREE.Quaternion().setFromEuler(_he.set(0, p.root.rotation.y + p.s.twist + p.s.yaw + Math.PI / 2, 0.25, 'YXZ'));
      a.phoneOffset = (a.phoneOffset || new THREE.Vector3()).set(0, 0.03, 0);
      a.phoneVisible = k > 0.15;
      if (age > 0.8 && age < 4.5) {
        const jab = Math.max(0, Math.sin(age * 9)),
          dir = CROWD.me.clone().sub(F.c).normalize();
        p.reach('L', F.c.clone().addScaledVector(dir, 0.42 + jab * 0.16).addScaledVector(UPY, 0.14).addScaledVector(F.r, -0.14), null, null, 'point');
        sceneFace(p, Math.sin(age * 5) > 0 ? 'shout' : 'jawdrop');
      } else sceneFace(p, age <= 0.8 ? 'gasp' : 'grin');
      if (!a.called && age > 4.6) {
        a.called = true;
        HYPE.last.call = NOW.t;
        REACT.later(rand(1.5, 3.5), newcomer);
      }
      break;
    }
    case 'toast': {
      // 잔을 높이 들었다가 원샷 → 탁 내려놓고 "캬"
      crowdStill(p, 0.1);
      makeCrowdProp(m, 'cup').visible = age < 4.3;
      const low = at(F, 0.26, 0.16, -0.27),
        high = at(F, 0.3, 0.2, 0.7),
        lip = facePoint(p, -R * 0.2, -R * 1.45, R * 1.05);
      let tg;
      if (age < 1.7) {
        const k = smoothstep(0, 0.45, age);
        tg = low.lerp(high, k);
        if (k > 0.9) tg.y += Math.sin(age * 16) * 0.012;
        sceneFace(p, 'scream');
      } else if (age < 3.0) {
        const k = smoothstep(1.7, 2.05, age);
        tg = high.lerp(lip, k);
        p.c.look.copy(CROWD.me).add(_hv.set(0, 4 * k, 0));
        p.c.lean = -0.16 * k;
        sceneFace(p, 'focus');
      } else {
        const k = smoothstep(3.0, 3.25, age);
        tg = lip.lerp(low, k);
        if (!a.slam && age > 3.22) {
          a.slam = true;
          if (AE.decoded) {
            const now = AE.ctx.currentTime;
            if (m.spot.table) playBuf(AE.syn.slap, now + 0.01, m.far ? 0.08 : 0.14, AE.buses.crowd, {
              pan: panOf(p)
            });
            if (Math.random() < 0.3) breathBlip(now + 0.12, {
              dur: 0.5,
              f0: 1500,
              f1: 500,
              q: 1.5,
              vol: 0.07,
              pan: panOf(p)
            });
          }
        }
        sceneFace(p, age < 4.0 ? 'bliss' : 'grin');
        if (age > 3.5) p.reach('L', facePoint(p, lerp(R * 0.5, -R * 0.4, Math.sin((age - 3.5) * 5) * 0.5 + 0.5), -R * 0.8, R * 1.12), null, null, 'fist');
      }
      p.reach('R', tg, null, palmQ(p, 'R'), 'grip');
      break;
    }
    case 'hugJump':
    case 'hugged': {
      // 옆 사람과 얼싸안고 방방
      const f = a.friend;
      if (!f) {
        sceneFace(p, 'scream');
        break;
      }
      p.c.stand = 1;
      const hm = p.root.position.clone();
      if (m.walkOff) hm.sub(m.walkOff);
      const hf = f.p.root.position.clone();
      if (f.walkOff) hf.sub(f.walkOff);
      const to = hf.sub(hm).setY(0),
        dist = to.length() || 1;
      const k = smoothstep(0.25, 0.7, age) * (1 - smoothstep(3.7, 4.2, age));
      p.root.rotation.y = lerpYaw(m.spot.yaw, Math.atan2(to.x, to.z), k);
      m.walkOff = (m.walkOff || new THREE.Vector3()).copy(to).multiplyScalar(Math.max(0, dist - 0.46) * 0.5 / dist * k);
      if (k > 0.55) {
        const fc = f.p.chestWorld(_hv).clone();
        p.reach('L', fc.clone().add(_hv2.set(0, 0.16, 0)).addScaledVector(F.r, -0.12), null, null, 'flat');
        p.reach('R', fc.clone().add(_hv2.set(0, 0.02, 0)).addScaledVector(F.r, 0.12), null, null, 'flat');
        p.c.jump = 0.9;
        p.c.bounce = 1;
        p.c.groove = 1;
        p.c.lean = 0.14;
        p.c.look.copy(f.p.headWorld(_hv2));
        sceneFace(p, a.k === 'hugJump' ? 'scream' : 'ecstasy');
      } else if (age < 0.7) {
        sceneFace(p, 'gasp');
        p.c.look.copy(f.p.headWorld(_hv2));
      } else {
        sceneFace(p, 'stunlaugh');
        pointAtMe(p, F, a.k === 'hugJump' ? 'R' : 'L');
      }
      break;
    }
    case 'surf': {
      // 사람들 손 위로 실려 다님
      p.c.stand = 1;
      p.c.lookW = 0.3;
      const D = a.until - a.t0,
        up = smoothstep(0.25, 0.95, age) * (1 - smoothstep(D - 0.9, D - 0.2, age));
      if (!a.dir) {
        a.dir = p.root.position.x > 0 ? -1 : 1;
        HYPE.last.surf = NOW.t;
        for (const o of CROWD.list)
          if (o !== m && o.kind === 'front' && !o.override && !(o.act && o.act.story) && Math.abs(o.p.root.position.x - p.root.position.x - a.dir * 1.2) < 2.6) crowdAct(o, 'armsUp', D - 0.6);
        crowdWhoops(4);
      }
      const go = Math.sin(clamp((age - 0.95) / (D - 2.0), 0, 1) * Math.PI);
      m.liftY = (1.78 + Math.sin(age * 8.5) * 0.05) * up;
      p.root.rotation.x = -1.47 * up;
      m.walkOff = (m.walkOff || new THREE.Vector3()).set(a.dir * 2.3 * go, 0, 0.75 * up);
      p.reach('L', at(F, 0.1, -0.5, 0.35), null, null, 'spread');
      p.reach('R', at(F, 0.1, 0.5, 0.35), null, null, 'spread');
      sceneFace(p, Math.sin(age * 2.3) > 0 ? 'ecstasy' : 'scream');
      break;
    }
  }
}
// 기절한 사람 입에서 혼이 빠져나갔다가 돌아옴
function soulPose(m, a, age) {
  const p = m.p,
    D = a.until - a.t0;
  if (age < 0.9 || age > D - 1.3) {
    if (a.hold) a.hold = null;
    return;
  }
  makeCrowdProp(m, 'soul');
  const rise = smoothstep(0.9, 2.3, age),
    back = smoothstep(D - 1.75, D - 1.35, age);
  const base = mouthWorld(p),
    pos = base.clone().add(_hv.set(Math.sin(age * 2.1) * 0.08 * rise, 0.12 + 0.42 * rise + Math.sin(age * 3.3) * 0.03, 0)).lerp(base, back);
  a.hold = {
    soul: {
      pos,
      q: faceQ(pos, CROWD.me),
      s: (0.25 + 0.9 * rise) * (1 - back * 0.75)
    }
  };
  // 옆 친구가 붙잡으려 손을 뻗음
  const f = m.friend;
  if (f && !f.override && f.act && f.act.k === 'soulGrab') f.act.soul = pos;
}

// ---------- 바텐더 종 ----------
function buildBell() {
  if (HYPE.bell || !CROWD.bartender) return;
  const bp = CROWD.bartender.p.root.position,
    top = 2.42,
    H = LAYOUT.room.h,
    g = new THREE.Group();
  g.position.set(bp.x - 0.3, top, bp.z + 0.24);
  const brass = metalMat(STYLE.pal.brass, 0.25, {
    outline: 0.003
  }),
    swing = new THREE.Group();
  g.add(swing);
  swing.add(new THREE.Mesh(latheY([
    [0.012, 0],
    [0.032, -0.012],
    [0.052, -0.05],
    [0.064, -0.12],
    [0.088, -0.19],
    [0.118, -0.235],
    [0.12, -0.246],
    [0.102, -0.24],
    [0.072, -0.19],
    [0.05, -0.12],
    [0.036, -0.05],
    [0.01, -0.022]
  ], 22), brass));
  swing.add(new THREE.Mesh(_vm([
    [new THREE.SphereGeometry(0.024, 10, 8).translate(0, -0.225, 0), '#3a2a1e'],
    [new THREE.CylinderGeometry(0.006, 0.006, 0.4, 6).translate(0, -0.44, 0), '#fff4de'],
    [new THREE.SphereGeometry(0.022, 8, 6).translate(0, -0.65, 0), '#ee4a2c']
  ]), toonVC({
    outline: 0.002
  })));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, H - top, 6).translate(0, (H - top) / 2, 0), toonMat('#2a2630', {
    outline: 0.002
  })));
  SC.scene.add(g);
  HYPE.bell = {
    g,
    swing,
    v: 0,
    a: 0,
    cord: V3(g.position.x, top - 0.65, g.position.z)
  };
}

function bartenderBell(delay = 0) {
  const b = CROWD.bartender;
  if (!b || !HYPE.bell || !hypeOk('bell', 20)) return;
  if (b.act && b.act.k === 'glassDrop') return;
  b.pending = null;
  b.bellAt = NOW.t + delay;
}

function runBartenderBell(m, t, dt, beat) {
  const p = m.p,
    age = t - m.act.t0,
    B = HYPE.bell;
  p.c.look.copy(CROWD.me);
  crowdStill(p, 0.3);
  m.props.cup.visible = false;
  m.props.cloth.visible = false;
  const x = (age - 0.35) / 0.4,
    n = Math.floor(x),
    pull = x > 0 && n < 5 ? Math.sin(Math.min(1, (x - n) * 2.2) * Math.PI) : 0;
  p.reach('R', B.cord.clone().add(_hv.set(0.02, -0.02 - pull * 0.16, 0)), null, null, 'grip');
  p.reach('L', p.local(0.3, 1.75 + Math.sin(age * 12) * 0.05, 0.25), null, null, 'fist');
  sceneFace(p, age < 0.3 ? 'gasp' : 'scream');
  p.c.jump = 0.4;
  if (x > 0 && n < 5 && n !== m.act.n) {
    m.act.n = n;
    B.v += 5.5;
    if (AE.decoded) bellDing(AE.ctx.currentTime + 0.05, 0.2, 0.5);
    if (n === 2) toastWave();
  }
  p.update(dt, t, beat);
}

// ---------- 밴드 묘기 ----------
// 트롬본 리더가 무릎 꿇고 절함
function tbWorship(dur = 5) {
  const tb = BAND.tb;
  if (!tb || (tb.worship && NOW.t < tb.worship.until)) return;
  tb.worship = {
    t0: NOW.t,
    until: NOW.t + dur
  };
  stare(tb, dur, 'ecstasy', 1);
}

function tbWorshipPose(tb, dt, t) {
  const w = tb.worship && t < tb.worship.until ? tb.worship : null;
  if (!(ITL.cur && ITL.cur.kind === 'intro')) tb.floorK = damp(tb.floorK || 0, w || FIN.band ? 1 : 0, 5, dt);
  tb.c.kneel = w && t - w.t0 > 0.35 && t < w.until - 0.7 ? 1 : 0;
  if (!w) return false;
  const a = t - w.t0,
    F = frameOf(tb),
    D = w.until - w.t0;
  if (a < 1.5 || a > D - 1.2) {
    const wv = Math.sin(a * 5) * 0.05;
    for (const [sd, s] of [
      ['L', 1],
      ['R', -1]
    ]) tb.reach(sd, F.c.clone().addScaledVector(sideW(F, s), 0.3 + wv).addScaledVector(UPY, 0.7).addScaledVector(F.f, 0.14), null, null, 'spread');
    tb.c.lean = 0;
    if (!tb.exUntil) tb.express('ecstasy', 0.6);
  } else {
    const bow = Math.max(0, Math.sin((a - 1.5) / (D - 2.7) * Math.PI * 4 - Math.PI / 2) * 0.5 + 0.5);
    tb.c.lean = 0.95 * bow;
    if (!tb.exUntil) tb.express('bliss', 0.6);
    for (const [sd, s] of [
      ['L', 1],
      ['R', -1]
    ]) tb.reach(sd, F.c.clone().addScaledVector(F.f, 0.5).addScaledVector(sideW(F, s), 0.18).addScaledVector(UPY, -0.5 * bow + 0.25 * (1 - bow)), null, null, 'flat');
  }
  return true;
}
// 박수 받을 때: 베이스 한 바퀴 돌리기 / 드럼 스틱 던져 받기
function bandFlourish() {
  if (!hypeOk('flourish', 9)) return;
  const r = Math.random();
  if (r < 0.6) later(rand(0.2, 0.7), () => {
    DIR.bassSpin = {
      t0: NOW.t,
      dur: 0.8
    };
    BAND.bs.express('grin', 2);
  });
  if (r > 0.35 && !DIR.brushes && !(DIR.drPhone && NOW.t < DIR.drPhone.until)) later(rand(0.3, 1.0), () => {
    DIR.stickToss = {
      t0: NOW.t,
      dur: 1.0
    };
    BAND.dr.express('grin', 2);
  });
}

// ---------- 매 프레임 ----------
function hypeUpdate(dt, t, beat) {
  HYPE.beat = beat;
  tossUpdate(dt);
  const B = HYPE.bell;
  if (B && (Math.abs(B.v) > 0.001 || Math.abs(B.a) > 0.001)) {
    B.v += (-B.a * 70 - B.v * 2.4) * dt;
    B.a += B.v * dt;
    B.swing.rotation.z = B.a * 0.22;
  }
  camFx(dt);
}
// ---------- 새 반응 규칙: 무슨 일이 일어났을 때 무엇을 얹을지 ----------
function hypeOnEvent(ev) {
  const R = REACT;
  switch (ev.kind) {
    case 'gesture':
      if (ev.g === 'high' && R.heat >= 50) crowdShock(0.55 + R.heat / 220);
      else if (ev.g === 'blazeLong') {
        startChant(2);
        for (const m of shuffle(freeFans().filter(o => o.p.s.stand > 0.7 && o.kind !== 'bar')).slice(0, 2)) forceScene(m, 'towelSpin', rand(0, 0.5));
      }
      break;
    case 'awe':
      crowdShock(0.7);
      if (ev.n === 1) REACT.later(1.3, scoreCards);
      else if (ev.n === 2) bartenderBell(1.0);
      else tbWorship(5.2);
      if (R.heat > 80 && ev.n >= 2) startChant(2);
      break;
    case 'breakOff':
      crowdShock(1.0);
      startChant(2);
      throwGifts(5, 2);
      break;
    case 'myApplause': {
      const k = ev.k;
      if (k > 0.5) throwGifts(Math.round(k * 6), 3);
      if (k > 0.72) {
        REACT.later(0.7, scoreCards);
        bandFlourish();
      }
      if (k > 0.92) poppers(2, 2);
      break;
    }
    case 'ovation':
      throwGifts(7, 3.5);
      REACT.later(0.9, toastWave);
      poppers(2, 2);
      bandFlourish();
      break;
    case 'endless':
      crowdShock(0.8);
      REACT.later(0.7, toastWave);
      throwGifts(4, 2);
      break;
  }
}

// ===== 82_finale.js =====
// ===================== 공연 끝내기: 마지막 화음 → 기립 박수 → 팬들이 무대로 올라와 둘러쌈 → 내민 물건에 손가락으로 사인 → 한 곡 더 / 처음으로 =====================
const FIN = {
  req: false,
  reqT: 0,
  on: false,
  stage: 'off',
  t0: 0,
  stageT: 0,
  camK: 0,
  camT: 0,
  away: 0,
  band: false,
  loud: 1,
  bump: 0,
  fans: [],
  slots: [],
  cur: null,
  pool: [],
  signed: 0,
  reacts: [],
  cheerUntil: 0,
  kindN: 0,
  lpN: 0,
  faint: null,
  items: [],
  pen: null,
  penK: 0,
  penAt: new THREE.Vector3(),
  draw: null,
  ink: 0,
  inkT: -9,
  hushK: 0,
  sqT: 0,
  lay: null,
  ray: new THREE.Raycaster(),
  plane: new THREE.Plane(),
  nextFlash: 0,
  nextYell: 0,
  built: false,
};
// 팬들이 설 자리 (무대 바닥 [x, z]). 0번이 사인받는 자리, 번호가 작을수록 나와 가까움. 왼쪽 드럼(x<-0.65, z<-1.4)과 오른쪽 피아노(x>1.05)는 피함
const FIN_SLOTS = [
  [0, -0.34],
  [-0.56, -0.24],
  [0.56, -0.24],
  [-0.3, -0.9],
  [0.3, -0.9],
  [-0.9, -0.72],
  [0.8, -0.94],
  [-0.64, -1.36],
  [0.62, -1.42],
  [-1.04, 0],
  [-1.3, -0.52],
  [-0.32, -1.98],
  [0.4, -2.0]
];
// 사인받을 물건: 사인하는 면의 크기(m), 면이 몸통 앞으로 나온 정도, 사인할 수 있는 범위(면 안의 비율)
const FIN_KINDS = {
  lp: { w: 0.31, h: 0.31, z: 0.0042 },
  poster: { w: 0.28, h: 0.37, z: 0.0026 },
  tee: { w: 0.4, h: 0.34, z: 0.0036, rect: [0.15, 0.03, 0.85, 0.8] },
  book: { w: 0.34, h: 0.25, z: 0.0094 },
};
const FIN_ORDER = ['lp', 'tee', 'poster', 'book'];
const FIN_STYLES = ['grab', 'film', 'scream', 'grab', 'cry', 'wave', 'point', 'scream', 'film', 'grab', 'cry', 'wave', 'grab']; // 자리마다 하는 짓 (사인받는 사람 바로 옆은 물건을 가리지 않는 동작)
const _fv = new THREE.Vector3(), _fv2 = new THREE.Vector3(), _fv3 = new THREE.Vector3(), _fq = new THREE.Quaternion();
// 펜 방향 (물건 면 기준): 끝에서 손 쪽으로 오른쪽 아래·내 쪽
const FIN_PENQ = (() => {
  const d = V3(0.5, -0.5, 0.72).normalize(),
    a = V3(0, 1, 0).addScaledVector(d, -d.y).normalize(),
    x = new THREE.Vector3().crossVectors(a, d);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, a, d));
})();

// ---------- 끝내기 버튼 ----------
function meteorStart() {
  if (METEOR.on || FIGHT.on || !UI.playing || (GAME.phase !== 'play' && GAME.phase !== 'pre')) return;
  if (!METEOR.group) return;
  METEOR.on = true; METEOR.impacted = false; METEOR.t0 = NOW.t; METEOR.impactT = 0; METEOR.shake = 0;
  METEOR.bodyPhysics.length = 0; METEOR.debris.length = 0;
  setAuto(false);
  releaseAllInput();
  fingerVisual(null);
  TP.blowing = false; TP.voice = null; MUS.running = false;
  if (AE.ctx) stopBandVoices(AE.ctx.currentTime);
  if (ITL.cur) itlEnd();
  if (AE.ctx) {
    bed.set('applause', 0);
    bed.set('babble', 0);
  }
  for (const id of ['pause', 'fight', 'meteor', 'endShow', 'nextSong', 'hudMode', 'autoMode', 'special', 'finishHint', 'finBar', 'customMenu']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  document.getElementById('controls').classList.add('off');
  const cam = SC.camera; cam.updateMatrixWorld(true);
  METEOR.basePos.copy(cam.position); METEOR.baseQuat.copy(cam.quaternion);
  cam.getWorldDirection(METEOR.flight).normalize();
  METEOR.up.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
  METEOR.right.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
  METEOR.target.copy(cam.position).addScaledVector(METEOR.flight, 1.65);
  METEOR.start.copy(METEOR.target).addScaledVector(METEOR.flight, 22).addScaledVector(METEOR.up, 8).addScaledVector(METEOR.right, 6);
  METEOR.group.position.copy(METEOR.start); METEOR.group.visible = true;
  METEOR.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), METEOR.target.clone().sub(METEOR.start).normalize());
  METEOR.group.scale.setScalar(1.18);
}

function meteorImpact(t) {
  METEOR.impacted = true; METEOR.impactT = t; METEOR.shake = 1;
  METEOR.group.visible = false;
  const source = METEOR.target;
  const addBody = (object, weight = 1) => {
    if (!object || !object.position || METEOR.bodyPhysics.some(b => b.object === object)) return;
    const direction = new THREE.Vector3(rand(-1, 1), rand(0.15, 1.25), rand(-1, 1)).normalize();
    const speed = rand(4.8, 10.5) * weight;
    METEOR.bodyPhysics.push({ object, velocity: direction.multiplyScalar(speed), spin: new THREE.Vector3(rand(-5, 5), rand(-5, 5), rand(-5, 5)), floor: object.position.y, weight });
  };
  if (VENUE && VENUE.root) addBody(VENUE.root, 0.55);
  for (const m of CROWD.list) if (m.p && m.p.root.visible) addBody(m.p.root, 1);
  for (const m of BAND.members) if (m.root && m.root.visible) addBody(m.root, 1.05);
  for (const object of SC.scene.children) if (object.visible && !object.isLight && !object.isCamera && object !== METEOR.group) addBody(object, 0.62);
  for (let i = 0; i < 30; i++) {
    const size = rand(0.08, 0.28), geo = new THREE.IcosahedronGeometry(size, 0);
    const mat = new THREE.MeshStandardMaterial({ color: pick(['#ff6835', '#ffc36d', '#6d4858', '#3a303f']), emissive: '#a73418', emissiveIntensity: rand(0.25, 0.8), roughness: 0.8 });
    const shard = new THREE.Mesh(geo, mat); shard.position.copy(source).add(V3(rand(-0.6, 0.6), rand(-0.5, 0.6), rand(-0.6, 0.6))); SC.scene.add(shard);
    const v = new THREE.Vector3(rand(-1, 1), rand(-0.1, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(4, 12));
    METEOR.debris.push({ object: shard, velocity: v, spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)), life: rand(2.3, 4.2) });
  }
  const eyebrow = document.querySelector('.game-over-eyebrow');
  if (eyebrow) eyebrow.textContent = 'METEOR STRIKE';
}

function meteorUpdate(dt, t) {
  if (!METEOR.on) return;
  const age = t - METEOR.t0, impactAge = METEOR.impacted ? t - METEOR.impactT : 0;
  if (!METEOR.impacted) {
    const k = smooth01(age / 1.7);
    METEOR.group.position.lerpVectors(METEOR.start, METEOR.target, k);
    METEOR.group.rotation.x += dt * 1.8; METEOR.group.rotation.y += dt * 2.5;
    METEOR.group.scale.setScalar(1.05 + k * 0.38);
    const near = smooth01((age - 0.75) / 0.95);
    METEOR.shake = near * 0.12;
    if (age >= 1.7) meteorImpact(t);
  }
  const shake = METEOR.impacted ? Math.max(0, 1 - impactAge / 2.1) : METEOR.shake;
  const cam = SC.camera;
  cam.position.copy(METEOR.basePos).add(V3(Math.sin(t * 48) * shake * 0.17, Math.sin(t * 37 + 0.7) * shake * 0.14, Math.sin(t * 54 + 1.4) * shake * 0.08));
  cam.quaternion.copy(METEOR.baseQuat).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(t * 33) * shake * 0.07, Math.sin(t * 41 + 1) * shake * 0.07, Math.sin(t * 45 + 2) * shake * 0.095)));
  if (METEOR.impacted) {
    for (const b of METEOR.bodyPhysics) {
      const o = b.object; b.velocity.y -= 9.8 * dt; o.position.addScaledVector(b.velocity, dt);
      o.rotation.x += b.spin.x * dt; o.rotation.y += b.spin.y * dt; o.rotation.z += b.spin.z * dt;
      if (o.position.y < b.floor) { o.position.y = b.floor; b.velocity.y = Math.abs(b.velocity.y) * 0.24; b.velocity.x *= 0.68; b.velocity.z *= 0.68; b.spin.multiplyScalar(0.72); if (Math.abs(b.velocity.y) < 0.7) b.velocity.y = 0; }
    }
    for (const d of METEOR.debris) {
      const o = d.object; d.velocity.y -= 9.8 * dt; o.position.addScaledVector(d.velocity, dt);
      o.rotation.x += d.spin.x * dt; o.rotation.y += d.spin.y * dt; o.rotation.z += d.spin.z * dt;
      d.life -= dt; o.scale.multiplyScalar(Math.max(0, 1 - dt * 0.7)); if (d.life <= 0) o.visible = false;
    }
    if (impactAge > 2.3 && !METEOR.gameOver) { METEOR.gameOver = true; document.getElementById('gameOver').classList.remove('hide'); }
  }
}

function fightStart() {
  if (FIGHT.on || !UI.playing || (GAME.phase !== "play" && GAME.phase !== "pre")) return;
  FIGHT.on = true; FIGHT.t0 = NOW.t; FIGHT.booUntil = 0; FIGHT.gameOver = false;
  FIN.req = true; setAuto(false); releaseAllInput(); fingerVisual(null);
  TP.blowing = false; TP.voice = null; MUS.running = false;
  if (AE.ctx) stopBandVoices(AE.ctx.currentTime);
  if (ITL.cur) itlEnd();
  for (const id of ["fight", "endShow", "nextSong", "pause", "hudMode", "autoMode", "special", "finishHint", "finBar", "customMenu"]) { const el = document.getElementById(id); if (el) el.style.display = "none"; }
  document.getElementById("controls").classList.add("off");
  REACT.burst = null;
  bed.set("applause", 0);
  bed.set("babble", 0);
  for (const m of CROWD.list) {
    m.fightStart = m.p.root.position.clone();
    m.fightFace = 'shock';
    m.act = null;
    m.pending = null;
    m.p.express('jawdrop', 1.15);
    m.p.c.stand = 1;
    m.p.c.step = 0;
    m.p.c.lean = 0;
  }
  for (const m of BAND.members) stare(m, 4.8, 'jawdrop', 0.9);
  aimCamera();
}

function finRequest() {
  if (FIN.req || FIN.on || GAME.phase !== 'play' || !UI.playing || !AE.ctx || !MUS.running) return;
  const fromAuto = AUTO.on;
  if (fromAuto) setAuto(false);
  FIN.manualWaiting = fromAuto;
  FIN.manualPlayed = false;
  FIN.manualReleased = false;
  document.getElementById('finishHint').hidden = !fromAuto;
  if (fromAuto) UI.el.stem.classList.add('hint');
  FIN.req = true;
  FIN.reqT = NOW.t;
  finUI();
  if (ITL.cur) itlEnd();
  const now = AE.ctx.currentTime,
    S = MUS.song;
  const cutDue = VQ.some(e => e.who === 'song' && e.type === 'cut');
  if (S && !S.ended && S.phase !== 'final' && S.phase !== 'done') {
    // 연주 중: 지금 마디를 끊고 곧바로 끝 화음으로 (늘임표라, 마지막 음을 물고 있으면 밴드가 같이 끌어 줌)
    stopBandVoices(now);
    for (let i = VQ.length - 1; i >= 0; i--)
      if (VQ[i].t > now) VQ.splice(i, 1);
    while (MUS.bars.length && MUS.bars[MUS.bars.length - 1].t0 > now) {
      MUS.bars.pop();
      MUS.beatCount -= 4;
    }
    MUS.soloH.length = 0;
    MUS.soloWho = null;
    S.brk = null;
    REACT.inBreak = false;
    DIR.hits.L.length = 0;
    DIR.hits.R.length = 0;
    MUS.nextT = now + 0.14;
    S.showEnd = true;
    enterFinal(S);
    schedTick();
  } else if (S && !S.ended && (S.phase === 'final' || (MUS.fermata && !MUS.fermata.cut) || cutDue)) S.showEnd = true; // 이미 끝나 가는 중: 끊기는 순간 시작
  else if (fromAuto) {
    if (MUS.gap) MUS.gap.hold = true;
    genFinal({
      final: MUS.gapChord || chordAtTime(now),
      tune: { ending: 'fermata' },
      showEnd: true
    }, { t0: now + 0.06 });
  } else {
    if (!S) finStab(now);
    finBegin();
  }
}
// 곡 사이에 눌렀을 때: 밴드가 한 방 찍어 줌
function finStab(now) {
  const ch = MUS.gapChord;
  if (!ch) return;
  const t = now + 0.06,
    root = nearestPC(ch.root, 34, 28, 40);
  drum('crash', t, 1.0, 'R');
  drum('kick', t, 1.0, 'RF');
  drum('snare', t, 0.8, 'L');
  bassNote(t, root, 0.5, 1.0);
  pianoNotes(t, [root + 12, ...voicingFor(ch, null, 55, 80)], 0.7, 0.75, 'L', 0.004);
  tbnNote(t, nearestPC(ch.root + QUAL[ch.q].tones[1], 60, 55, 67), 0.5, 1.0, { scoop: 0 });
}

function finUI() {
  const E = UI.el, play = GAME.phase === 'play', fin = FIN.on;
  const show = (el, on, d = 'inline-flex') => {
    if (el) el.style.display = on ? d : 'none';
  };

  const active = UI.playing && (play || GAME.phase === 'pre');
  const doomed = active && !FIN.req && !fin && !FIGHT.on && !METEOR.on;
  show(E.nextSong, active && !FIN.req);
  show(E.endShow, active && !FIN.req);
  show(E.fight, doomed);
  show(E.meteor, doomed);
  show(E.customMenu, doomed && !FIN.req);
  show(E.hudMode, play && !FIGHT.on && !METEOR.on);
  show(E.special, play && !FIGHT.on && !METEOR.on, 'block');
  if (GAME.phase !== 'pre' && GAME.phase !== 'title') E.controls.classList.toggle('off', fin || FIGHT.on || METEOR.on);
  show(E.finBar, fin && FIN.stage === 'sign', 'flex');
}

// ---------- 자리·카메라 ----------
// 물건을 내 눈 쪽으로 비스듬히 받쳐 들게 하고, 화면 크기에 맞춰 내 눈(카메라)을 그 앞으로 가져감
function finLayout() {
  const hy = Math.tan((SC.baseFov || SC.camera.fov) * Math.PI / 360),
    hx = hy * SC.camera.aspect;
  const T = Object.assign(SC.portrait ? { al: 54, fw: 0.62, fh: 0.47, low: 0.84 } : { al: 42, fw: 0.62, fh: 0.54, low: 0.91 }, FIN.tune || {});
  const al = T.al * Math.PI / 180,
    C = V3(0, T.cy || 1.84, T.cz || 0.04),
    box = 0.34;
  const D = Math.max(box / 2 / (T.fw * hx), box / 2 / (T.fh * hy), 0.62); // 넓은 화면(태블릿)에서는 너무 다가가지 않게
  const n = V3(0, Math.sin(al), Math.cos(al)),
    up = V3(0, Math.cos(al), -Math.sin(al));
  const eye = C.clone().addScaledVector(n, D);
  const halfN = box / 2 / D / hy,
    yc = -(T.low - halfN);
  const pitch = -al - Math.atan(yc * hy);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, 0, 'YXZ'));
  const iq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V3(1, 0, 0), up, n));
  FIN.lay = { C, D, n, up, eye, pitch, q, iq, hx, hy };
}

// ---------- 준비물: 사인받을 물건 · 펜 든 내 손 ----------
function finBuild() {
  while (!FIN.built) finBuildStep();
}
// 한 번에 하나씩 만듦 (첫 화면에서 미리 조금씩 만들어 두려고 나눠 놓음. 공연 끝에 처음 만들면 그 순간 화면이 멈칫함)
function finBuildStep() {
  if (FIN.built) return;
  if (FIN.items.length < 6) {
    FIN.items.push(finMakeItem());
    return;
  }
  FIN.pen = finBuildPen();
  FIN.pen.visible = false;
  ME.rig.add(FIN.pen);
  FIN.built = true;
}
// 물건 네 종류의 몸통 모양 (여섯 개가 같이 씀)
function finKindGeos() {
  if (FIN.geo) return FIN.geo;
  const G2 = {};
  // 음반: 종이 재킷 + 오른쪽으로 삐져나온 판
  G2.lp = _vm([
    [rbox(0.31, 0.31, 0.007, 0.003, 1), '#fffaf0'],
    [new THREE.CylinderGeometry(0.146, 0.146, 0.003, 30).rotateX(Math.PI / 2).translate(0.085, 0, -0.0075), '#1b1828']
  ]); // 판은 재킷 뒤에 (겹치면 외곽선이 재킷 앞으로 비쳐 나옴)
  // 포스터
  G2.poster = _vm([[rbox(0.28, 0.37, 0.004, 0.002, 1), '#fffaf0']]);
  // 흰 티셔츠 (어깨를 잡고 펼쳐 듦)
  {
    const s = new THREE.Shape();
    s.moveTo(-0.15, -0.17);
    s.lineTo(0.15, -0.17);
    s.lineTo(0.15, 0.05);
    s.lineTo(0.185, 0.03);
    s.lineTo(0.2, 0.095);
    s.lineTo(0.105, 0.17);
    s.lineTo(0.05, 0.17);
    s.quadraticCurveTo(0, 0.12, -0.05, 0.17);
    s.lineTo(-0.105, 0.17);
    s.lineTo(-0.2, 0.095);
    s.lineTo(-0.185, 0.03);
    s.lineTo(-0.15, 0.05);
    s.lineTo(-0.15, -0.17);
    const sg = new THREE.ExtrudeGeometry(s, {
      depth: 0.006,
      bevelEnabled: false,
      curveSegments: 8
    }).translate(0, 0, -0.003);
    const nk = new THREE.TorusGeometry(0.052, 0.0045, 6, 14, Math.PI).rotateZ(Math.PI).translate(0, 0.172, 0.003).scale(1, 0.9, 1);
    G2.tee = _vm([[sg, '#fffdf6'], [nk, '#e6dcc8']]);
  }
  // 스케치북: 파란 표지 + 종이 + 위쪽 스프링
  {
    const parts = [
      [rbox(0.36, 0.27, 0.012, 0.004, 1), '#2f5bd8'],
      [rbox(0.342, 0.252, 0.005, 0.002, 1).translate(0, 0, 0.0065), '#fffaf0']
    ];
    for (let i = 0; i < 9; i++) parts.push([new THREE.TorusGeometry(0.011, 0.0022, 5, 12).rotateY(Math.PI / 2).translate(-0.14 + i * 0.035, 0.134, 0.004), '#8d93a8']);
    G2.book = _vm(parts);
  }
  FIN.mat = toonVC({
    outline: 0.003
  });
  return FIN.geo = G2;
}

function finMakeItem() {
  const g = new THREE.Group();
  g.name = 'sign-item';
  g.visible = false;
  const G2 = finKindGeos(), kinds = {};
  for (const k in G2) kinds[k] = new THREE.Mesh(G2[k], FIN.mat);
  for (const k in kinds) {
    kinds[k].visible = false;
    g.add(kinds[k]);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 384;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat('#ffffff', {
    map: tex,
    transparent: true,
    depthWrite: false
  }));
  face.renderOrder = 2;
  g.add(face);
  // 사인할 자리 표시: 처음 긋기 전까지 노랗게 숨 쉬는 테두리 (글 설명 대신)
  const hs = new THREE.Shape();
  hs.moveTo(-0.5, -0.5);
  hs.lineTo(0.5, -0.5);
  hs.lineTo(0.5, 0.5);
  hs.lineTo(-0.5, 0.5);
  hs.lineTo(-0.5, -0.5);
  const hh = new THREE.Path();
  hh.moveTo(-0.44, -0.44);
  hh.lineTo(-0.44, 0.44);
  hh.lineTo(0.44, 0.44);
  hh.lineTo(0.44, -0.44);
  hh.lineTo(-0.44, -0.44);
  hs.holes.push(hh);
  const hint = new THREE.Mesh(new THREE.ShapeGeometry(hs), basicMat('#ffbf2e', {
    transparent: true,
    opacity: 0.8,
    depthWrite: false
  }));
  hint.renderOrder = 3;
  g.add(hint);
  SC.scene.add(g);
  return {
    g,
    kinds,
    canvas,
    ctx: canvas.getContext('2d'),
    tex,
    face,
    hint,
    kind: 'lp',
    w: 0.31,
    h: 0.31,
    rect: [0, 0, 1, 1],
    inkCol: '#1b1828',
    owner: null,
    t0: -99
  };
}
// 물건 겉그림 (사인 전). 좌표는 m, 왼쪽 아래가 원점
function finPaint(it, kind, seed) {
  const K = FIN_KINDS[kind],
    g = it.ctx,
    CW = it.canvas.width,
    CH = it.canvas.height,
    w = K.w,
    h = K.h;
  it.kind = kind;
  it.w = w;
  it.h = h;
  it.rect = K.rect || [0.03, 0.03, 0.97, 0.97];
  for (const k in it.kinds) it.kinds[k].visible = k === kind;
  it.face.scale.set(w, h, 1);
  it.face.position.set(0, 0, K.z);
  const R = it.rect;
  it.hint.scale.set((R[2] - R[0]) * w, (R[3] - R[1]) * h, 1);
  it.hint.position.set(((R[0] + R[2]) / 2 - 0.5) * w, ((R[1] + R[3]) / 2 - 0.5) * h, K.z + 0.0012);
  it.hint.visible = true;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, CW, CH);
  g.setTransform(CW / w, 0, 0, -CH / h, 0, CH);
  const disc = (x, y, r, c) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  const INK = '#221a2b';
  if (kind === 'lp') {
    const n = FIN.lpN++,
      bg = ['#fff4de', '#ffbf2e', '#ffc9d6', '#a8e6d6'][n % 4],
      cols = ['#ee4a2c', '#2f5bd8', '#13a08a', '#7b3fb0', '#ffbf2e', '#fff4de'].filter(c => c !== bg);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const v = (n + 2) % 3;
    if (v === 0) {
      disc(0, 0, 0.125, cols[0]);
      disc(0, 0, 0.07, cols[1]);
      g.fillStyle = cols[2];
      for (let i = 0; i < 3; i++) g.fillRect(0.205 + i * 0.03, h - 0.095, 0.016, 0.095);
    } else if (v === 1) {
      g.fillStyle = cols[0];
      g.fillRect(0, h - 0.052, w, 0.052);
      g.fillStyle = cols[1];
      g.fillRect(0, h - 0.068, w, 0.01);
      disc(w - 0.056, 0.056, 0.04, cols[2]);
      disc(w - 0.056, 0.056, 0.016, bg);
    } else {
      for (let i = 0; i < 4; i++) disc(0.045 + i * 0.074, 0.034, 0.05, cols[i % cols.length]);
      g.fillStyle = cols[4 % cols.length];
      g.fillRect(0, h - 0.03, w * 0.5, 0.03);
    }
    g.strokeStyle = INK;
    g.lineWidth = 0.005;
    g.strokeRect(0.0025, 0.0025, w - 0.005, h - 0.005);
  } else if (kind === 'poster') {
    g.fillStyle = '#fff4de';
    g.fillRect(0, 0, w, h);
    const c = ['#ee4a2c', '#2f5bd8', '#13a08a'][seed % 3];
    // 아래에서 퍼지는 햇살 + 위쪽 띠
    g.fillStyle = '#ffbf2e';
    for (let i = 0; i < 7; i++) {
      const a0 = Math.PI * (0.08 + i * 0.125),
        a1 = a0 + Math.PI * 0.06;
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w / 2 + Math.cos(a0) * 0.13, Math.sin(a0) * 0.13);
      g.lineTo(w / 2 + Math.cos(a1) * 0.13, Math.sin(a1) * 0.13);
      g.fill();
    }
    disc(w / 2, 0, 0.055, c);
    g.fillStyle = c;
    g.fillRect(0, h - 0.04, w, 0.04);
    g.fillStyle = INK;
    g.fillRect(0, h - 0.05, w, 0.006);
    g.strokeStyle = INK;
    g.lineWidth = 0.005;
    g.strokeRect(0.0025, 0.0025, w - 0.005, h - 0.005);
  } else if (kind === 'book') {
    g.fillStyle = '#fffdf5';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#e3d8c2';
    g.lineWidth = 0.003;
    g.strokeRect(0.004, 0.004, w - 0.008, h - 0.008);
  }
  it.tex.needsUpdate = true;
}
// 펜 든 내 오른손 (1인칭). 펜 끝이 원점, 몸통은 +z, 손등은 +y 쪽, 손바닥·새끼손가락은 +x 쪽
function finBuildPen() {
  let g = new THREE.Group();
  const mats = ME.mats,
    sk = mats.skin;
  g.add(new THREE.Mesh(_vm([
    [new THREE.ConeGeometry(0.0034, 0.011, 10).rotateX(-Math.PI / 2).translate(0, 0, 0.0055), '#1b1828'],
    [new THREE.CylinderGeometry(0.0062, 0.0036, 0.012, 12).rotateX(Math.PI / 2).translate(0, 0, 0.017), '#e8e8f0'],
    [new THREE.CylinderGeometry(0.0082, 0.0082, 0.121, 14).rotateX(Math.PI / 2).translate(0, 0, 0.0835), '#22244a'],
    [new THREE.CylinderGeometry(0.0087, 0.0087, 0.012, 14).rotateX(Math.PI / 2).translate(0, 0, 0.134), '#ffbf2e'],
    [new THREE.SphereGeometry(0.0082, 12, 8).translate(0, 0, 0.144), '#22244a'],
  ]), toonVC({
    outline: 0.003
  })));
  const pen = g;
  g = new THREE.Group();
  g.position.z = 0.016;
  pen.add(g); // 손은 촉에서 조금 떨어져 쥠
  const P = a => V3(a[0], a[1], a[2]);
  const chain = (pts, rs) => {
    for (let i = 0; i < pts.length - 1; i++) g.add(capsuleBetween(P(pts[i]), P(pts[i + 1]), rs[i], sk));
  };
  // 검지: 펜 위에 얹힘
  const KI = [0.021, 0.0225, 0.099];
  chain([
    [0.0012, 0.0102, 0.03],
    [0.004, 0.019, 0.05],
    [0.011, 0.0268, 0.074], KI
  ], [0.0082, 0.0087, 0.0092]);
  // 중지: 오른쪽 아래에서 받침
  const KM = [0.0365, 0.0165, 0.099];
  chain([
    [0.0086, -0.0064, 0.035],
    [0.0185, -0.004, 0.054],
    [0.031, 0.0065, 0.076], KM
  ], [0.0084, 0.0089, 0.0094]);
  // 약지·새끼: 손바닥 쪽으로 말아 쥠
  const KR = [0.0495, 0.0075, 0.098],
    KP = [0.0595, -0.0045, 0.097];
  chain([
    [0.0345, -0.0205, 0.063],
    [0.046, -0.0115, 0.077], KR
  ], [0.0082, 0.0088]);
  chain([
    [0.0445, -0.0285, 0.068],
    [0.055, -0.0215, 0.08], KP
  ], [0.0072, 0.0078]);
  for (const [k, r] of [
    [KI, 0.0108],
    [KM, 0.011],
    [KR, 0.0102],
    [KP, 0.0092]
  ]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), sk);
    s.position.copy(P(k)).add(V3(0.001, 0.001, 0.002));
    g.add(s);
  }
  // 엄지: 왼쪽에서 펜을 누름
  const TT = [-0.0094, 0.0018, 0.036],
    TI = [-0.0138, -0.003, 0.058],
    TM = [-0.0055, -0.0155, 0.085],
    TB = [0.015, -0.0225, 0.11];
  chain([TT, TI, TM, TB], [0.0086, 0.0098, 0.0115]);
  const W = V3(0.047, -0.016, 0.166);
  g.add(handBack(P(KI).add(V3(0, -0.003, 0.002)), P(KP).add(V3(0, -0.002, 0.002)), W, sk, 0.029, 0.017));
  g.add(ellipsoid(V3(0.024, -0.022, 0.118), V3(-0.5, 0.1, -0.86), V3(1, 0, 0), [0.026, 0.017, 0.013], sk)); // 엄지 두덩
  // 손톱 (검지·엄지)
  g.add(ellipsoid(V3(0.0016, 0.0178, 0.0345), V3(-0.12, -0.4, -0.9), V3(1, 0, 0), [0.0062, 0.0052, 0.0022], mats.nail, 12));
  g.add(ellipsoid(V3(-0.0172, 0.0026, 0.04), V3(0.2, 0.2, -0.95), V3(0, 1, 0), [0.0066, 0.0054, 0.0022], mats.nail, 12));
  sleeveOn(g, W, W.clone().add(V3(-0.066, -0.066, 0.995).multiplyScalar(0.3)), mats);
  return pen;
}

// ---------- 시작 ----------
function finBegin() {
  if (FIN.on) return;
  if (AUTO.on) setAuto(false);
  FIN.manualWaiting = false;
  document.getElementById('finishHint').hidden = true;
  UI.el.stem.classList.remove('hint');
  finBuild();
  finLayout();
  const t = NOW.t,
    R = REACT,
    hot = clamp((R.peak || 0) / 100, 0, 1);
  Object.assign(FIN, {
    on: true,
    stage: 'ovation',
    t0: t,
    stageT: t,
    band: true,
    signed: 0,
    kindN: 0,
    faint: null,
    cur: null,
    ink: 0,
    inkT: -9,
    draw: null,
    camT: 0,
    loud: 1,
    bump: 0,
    cheerUntil: t + 2.5,
    hushK: 0,
    nextYell: t + 1,
    nextFlash: t + 4
  });
  FIN.fans.length = 0;
  FIN.slots.length = 0;
  FIN.reacts.length = 0;
  for (const m of CROWD.list) m.finGot = false;
  GAME.phase = 'finale';
  if (MUS.gap) MUS.gap.hold = true; // 곡 사이에 끝냈으면 다음 곡으로 넘어가지 않게 붙잡아 둠
  releaseAllInput();
  fingerVisual(null);
  R.meSolo = false;
  R.inBreak = false;
  R.burst = {
    kind: 'ovation',
    owner: 'me',
    t,
    until: t + 1e6,
    k: 1.15 + 0.25 * hot,
    energy: 1,
    fade: 3
  };
  for (const m of CROWD.list) {
    m.standHoldUntil = t + 1e6;
    m.pending = null;
  }
  finUI();
  reactEvent('finale', {});
  // 터지는 순간: 충격파 · 폭죽 · 색종이 · 꽃과 모자 · 종 · 건배 · 밴드
  crowdShock(1.3);
  poppers(4, 2.2);
  fxConfettiDrop(200, 2.6);
  throwGifts(12, 4.5);
  delete HYPE.last.bell;
  bartenderBell(0.9);
  R.later(2.8, toastWave);
  tbWorship(4.4);
  delete HYPE.last.flourish;
  bandFlourish();
  for (const m of BAND.members) m.express(pick(['stunlaugh', 'grin', 'ecstasy']), 4);
  if (AE.decoded) {
    const now = AE.ctx.currentTime;
    crowdWhoops(12);
    crowdOoh(now + 0.05, 12, 0.8, 1.6);
    for (let i = 0; i < 3; i++) scream(now + 0.15 + i * 0.3, { vol: 0.17 });
  }
  crowdWhistles(4);
  afterSave();
}
// 팬들이 무대로 뛰어 올라옴
function finRush() {
  FIN.stage = 'rush';
  FIN.stageT = NOW.t;
  const c = V3(0, 0, -4.4);
  FIN.pool = CROWD.list.filter(m => m.p.root.visible && !m.override && m.kind !== 'bar' && !m.far && m.spot && !(m.reserved && !m.converted))
    .map(m => ({ m, d: (m.kind === 'front' ? 0 : 3) + m.spot.pos.distanceTo(c) })).sort((a, b) => a.d - b.d).map(o => o.m);
  const n = Math.min(FIN_SLOTS.length, FIN.pool.length);
  for (let i = 0; i < n; i++) finSend(FIN.pool[i], i, i * 0.17 + rand(0, 0.12));
  REACT.later(0.9, () => {
    if (FIN.on && FIN.stage !== 'out') FIN.camT = 1;
  });
  if (AE.decoded) {
    const now = AE.ctx.currentTime;
    for (let i = 0; i < 3; i++) scream(now + 0.1 + i * 0.35, {
      vol: 0.16
    });
    crowdWhoops(6);
    for (let i = 0; i < 14; i++) playBuf(AE.syn.stomp, now + 0.25 + i * 0.11 + rand(0, 0.05), rand(0.1, 0.18), AE.buses.crowd, {
      pan: rand(-0.5, 0.5),
      rate: rand(1.1, 1.5)
    });
  }
}

function finSend(m, slot, delay = 0) {
  if (m.act) finishCrowdScene(m, NOW.t);
  m.pending = null;
  m.rush = 0;
  m.walkOff = null;
  m.liftY = 0;
  const p = m.p,
    s0 = p.root.position.clone(),
    S = FIN_SLOTS[slot],
    Y = LAYOUT.stageY;
  const fan = {
    m,
    p,
    slot,
    st: 'wait',
    at: NOW.t + delay,
    t0: NOW.t,
    path: null,
    seg: 0,
    segT: 0,
    pos: s0,
    yaw: p.root.rotation.y,
    ph: rand(0, 6.28),
    speed: rand(2.9, 3.5),
    kind: 'lp',
    item: null,
    react: null,
    carry: null,
    gx: clamp(s0.x * 0.45, -0.5, 0.5) + rand(-0.12, 0.12)
  };
  fan.path = [s0.clone(), V3(fan.gx, 0, -4.22), V3(fan.gx, Y, -3.7), ...finVia(S), V3(S[0], Y, S[1])];
  FIN.slots[slot] = fan;
  FIN.fans.push(fan);
  m.fin = fan;
  m.override = finFan;
  p.c.stand = 1;
  m.standNow = 1;
  return fan;
}
// 무대 앞 가운데 통로(베이스와 트롬본 사이)에서 자리까지 거쳐 갈 점
function finVia(S) {
  const Y = LAYOUT.stageY,
    out = [V3(clamp(S[0] * 0.35, -0.3, 0.45) + rand(-0.08, 0.08), Y, -2.75)];
  if (S[1] > -1.3 && S[0] < -0.7) out.push(V3(-0.5, Y, -1.32));
  else if (S[0] > 0.6) out.push(V3(0.48, Y, -1.3));
  return out;
}

function finLeave(fan, carry = null, dive = false) {
  const m = fan.m,
    Y = LAYOUT.stageY,
    S = [fan.pos.x, fan.pos.z],
    via = finVia(S).reverse();
  if (FIN.slots[fan.slot] === fan) FIN.slots[fan.slot] = null;
  fan.st = 'leave';
  fan.seg = 0;
  fan.segT = NOW.t;
  fan.carry = carry;
  fan.dive = dive;
  fan.speed = fan.slow ? 1.5 : rand(3.0, 3.6);
  fan.path = [fan.pos.clone(), ...via, V3(fan.gx, Y, dive ? -3.5 : -3.7)];
  if (!dive) fan.path.push(V3(fan.gx, 0, -4.22), m.spot.pos.clone());
}

function finRelease(m) {
  const fan = m.fin,
    p = m.p;
  if (fan) {
    fan.st = 'gone';
    if (fan.item) {
      fan.item.g.visible = false;
      fan.item.owner = null;
      fan.item = null;
    }
    if (FIN.slots[fan.slot] === fan) FIN.slots[fan.slot] = null;
    if (FIN.cur === fan) FIN.cur = null;
  }
  m.fin = null;
  m.override = null;
  m.act = null;
  p.root.rotation.x = 0;
  p.root.position.copy(m.spot.pos);
  p.root.rotation.y = m.spot.yaw;
  p.c.stand = 1;
  p.c.slump = 0;
  p.c.kneel = 0;
  m.standNow = 1;
  m.standWish = 1;
  for (const k in m.props)
    if (k !== 'glasses') m.props[k].visible = false;
}

// ---------- 무대에 올라온 팬 (매 프레임) ----------
function finFan(m, t, dt, beat) {
  const fan = m.fin,
    p = m.p;
  if (!fan || !FIN.on) {
    finRelease(m);
    return;
  }
  crowdStill(p, 0.1);
  p.c.stand = 1;
  p.c.step = 0;
  p.c.lean = 0.04;
  p.c.kneel = 0;
  p.c.slump = 0;
  p.c.look.copy(CROWD.me);
  p.root.rotation.x = 0;
  m.act = null;
  const F = frameOf(p);
  switch (fan.st) {
    case 'wait': {
      const w = Math.sin(t * 11 + fan.ph) * 0.1;
      p.reach('L', at(F, 0.12, -0.26 - w, 0.6), null, null, 'spread');
      p.reach('R', at(F, 0.12, 0.26 - w, 0.6), null, null, 'spread');
      sceneFace(p, 'scream');
      p.c.jump = 1;
      if (t >= fan.at) {
        fan.st = 'run';
        fan.seg = 0;
        fan.segT = t;
        fan.path[0].copy(fan.pos);
      }
      break;
    }
    case 'run':
      finRunPose(fan, t, F);
      finMove(fan, t, dt, () => {
        fan.st = fan.slot === 0 ? 'present' : 'ring';
        fan.t0 = t;
      });
      break;
    case 'ring':
      finRing(fan, t, dt, F);
      break;
    case 'present':
      finPresent(fan, t, dt, F);
      break;
    case 'react':
      finReact(fan, t, dt, F);
      break;
    case 'leave':
      finRunPose(fan, t, F, true);
      finMove(fan, t, dt, () => {
        if (fan.dive) {
          fan.st = 'dive';
          fan.t0 = t;
          fan.d0 = fan.pos.clone();
        } else finRelease(m);
      });
      break;
    case 'dive':
      finDive(fan, t, dt, F);
      break;
  }
  if (m.fin !== fan) return; // 방금 내려감
  p.root.position.copy(fan.pos);
  p.root.rotation.y = fan.yaw;
}

function finMove(fan, t, dt, onDone) {
  const a = fan.path[fan.seg],
    b = fan.path[fan.seg + 1],
    p = fan.p;
  if (!b) {
    onDone();
    return;
  }
  const hop = Math.abs(b.y - a.y) > 0.1,
    len = a.distanceTo(b),
    dur = hop ? 0.42 : Math.max(0.05, len / fan.speed),
    k = clamp((t - fan.segT) / dur, 0, 1);
  fan.pos.lerpVectors(a, b, hop ? smooth01(k) : k);
  if (hop) fan.pos.y += Math.sin(k * Math.PI) * 0.32;
  else if (!fan.slow) fan.pos.y += Math.abs(Math.sin(t * 15 + fan.ph)) * 0.04;
  if (len > 0.05) fan.yaw = dampAngle(fan.yaw, Math.atan2(b.x - a.x, b.z - a.z), 12, dt);
  p.c.step = hop ? 0 : 1;
  p.c.lean = fan.slow ? 0.1 : 0.2;
  if (k >= 1) {
    fan.seg++;
    fan.segT = t;
  }
}

function finRunPose(fan, t, F, leaving = false) {
  const p = fan.p;
  if (fan.item && fan.carry) {
    finCarry(fan, fan.carry, t, F);
    sceneFace(p, fan.carry === 'hug' ? (fan.slow ? 'dizzy' : 'bawl') : 'scream');
    if (fan.slow) p.c.side = Math.sin(t * 5 + fan.ph) * 0.16;
    return;
  }
  const w = Math.sin(t * 13 + fan.ph) * 0.1;
  p.reach('L', at(F, 0.16, -0.26 - w, 0.56), null, null, 'spread');
  p.reach('R', at(F, 0.16, 0.26 - w, 0.56), null, null, 'spread');
  sceneFace(p, leaving ? 'grin' : (fan.ph > 3.1 ? 'scream' : 'ecstasy'));
}
// 눈물 분수
function finTears(p, F, rate = 0.6) {
  for (const sx of [1, -1])
    if (Math.random() < rate) {
      const e = facePoint(p, sx * p.eyeP.x * 1.3, p.eyeP.y - p.headC.y - p.eyeP.r * 0.3, p.eyeP.z - p.headC.z + 0.03);
      fxEmit(e, sideW(F, sx).multiplyScalar(rand(0.5, 1.0)).add(_fv3.set(0, rand(1.0, 1.7), 0)).addScaledVector(F.f, rand(0.1, 0.4)), rand(0.03, 0.045), rand(0.4, 0.6), Math.random() < 0.7 ? '#8fd6ff' : '#e6f7ff');
    }
}

function finToSlot(fan, t, dt, jostle = 1) {
  const S = FIN_SLOTS[fan.slot],
    p = fan.p,
    cam = CROWD.me;
  const jx = (Math.sin(t * 1.7 + fan.ph) * 0.035 + Math.sin(t * 3.1 + fan.ph * 2) * 0.018) * jostle,
    jz = Math.cos(t * 1.3 + fan.ph * 1.7) * 0.04 * jostle;
  _fv.set(S[0] + jx, LAYOUT.stageY, S[1] + jz);
  const d = _fv.distanceTo(fan.pos);
  if (d > 0.14) {
    fan.pos.addScaledVector(_fv2.copy(_fv).sub(fan.pos).normalize(), Math.min(d, 1.9 * dt));
    p.c.step = 1;
  } else fan.pos.lerp(_fv, 1 - Math.exp(-7 * dt));
  fan.yaw = dampAngle(fan.yaw, Math.atan2(cam.x - fan.pos.x, cam.z - fan.pos.z), 8, dt);
  return d;
}
// 둘러싼 팬: 저마다 다른 짓 (손 뻗기 · 찍기 · 비명 · 엉엉 · 꽃 흔들기 · 가리키며 웃기)
function finRing(fan, t, dt, F) {
  finRingPose(fan, t, dt, F);
  for (const sd of PERSON_SIDES) {
    const A = fan.p.arms[sd];
    if (A.mode === 'ik' && A.target.z > -0.66 && Math.abs(A.target.x) < 0.36) A.target.x = (fan.pos.x < 0 ? -1 : 1) * 0.36;
  }
}

function finRingPose(fan, t, dt, F) {
  const p = fan.p,
    m = fan.m,
    cam = CROWD.me,
    L = FIN.lay;
  finToSlot(fan, t, dt);
  const toCam = _fv3.copy(cam).sub(F.c).normalize().clone(),
    R = p.R;
  // 방금 사인이 끝났으면 다 같이 폭발
  if (t < FIN.cheerUntil && !FIN.faint) {
    const w = Math.sin(t * 12 + fan.ph) * 0.1;
    p.reach('L', at(F, 0.14, -0.27 - w, 0.6), null, null, 'spread');
    p.reach('R', at(F, 0.14, 0.27 - w, 0.6), null, null, 'spread');
    sceneFace(p, fan.ph > 3.1 ? 'scream' : 'ecstasy');
    p.c.jump = 1.3;
    return;
  }
  // 누가 주저앉으면: 다 같이 헉 하고 내려다봄
  const fz = FIN.faint;
  if (fz && fz !== fan) {
    p.c.look.copy(fz.p.headWorld(_fv2));
    sceneFace(p, fan.ph > 3.1 ? 'gasp' : 'jawdrop');
    p.c.lean = 0.2;
    if (fan.ph > 2) cheekHands(p);
    else headHands(p);
    return;
  }
  // 내가 쓰는 동안: 숨죽이고 펜 끝만 봄 (찍는 사람은 계속 찍음)
  const style = FIN_STYLES[fan.slot % FIN_STYLES.length],
    hush = FIN.hushK > 0.5 && style !== 'film';
  if (hush) {
    p.c.look.copy(L.C);
    p.c.lean = 0.22;
    sceneFace(p, fan.ph > 4 ? 'jawdrop' : 'gasp');
    if (fan.ph > 2) cheekHands(p);
    else {
      p.reach('L', at(F, 0.2, -0.07, 0.12), null, null, 'fist');
      p.reach('R', at(F, 0.2, 0.07, 0.13), null, null, 'fist');
    }
    return;
  }
  switch (style) {
    case 'grab': {
      const open = Math.sin(t * 9 + fan.ph) > 0;
      for (const [sd, s] of [['L', -1], ['R', 1]]) p.reach(sd, F.c.clone().addScaledVector(toCam, 0.44).addScaledVector(F.r, s * 0.17).addScaledVector(UPY, 0.14 + Math.sin(t * 6 + fan.ph + s) * 0.05), null, null, open ? 'spread' : 'grip');
      sceneFace(p, fan.ph > 3.1 ? 'ecstasy' : 'scream');
      p.c.jump = 0.9;
      p.c.lean = 0.16;
      break;
    }
    case 'film': {
      const head = p.headWorld(_fv2).clone(),
        ph = head.addScaledVector(toCam, 0.3).addScaledVector(F.r, 0.17).add(_fv.set(0, 0.03 + Math.sin(t * 2.3 + fan.ph) * 0.012, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(ph, cam, UPY)).multiply(_fq.setFromAxisAngle(UPY, Math.PI));
      const grip = V3(0.052, -0.015, 0).applyQuaternion(q);
      p.reach('R', ph.clone().add(grip), null, q, 'grip');
      makeCrowdProp(m, 'phone');
      m.act = {
        k: 'fin',
        phoneQ: q,
        phoneOffset: grip.clone().negate(),
        phoneVisible: true
      };
      p.reach('L', at(F, 0.18, -0.26 + Math.sin(t * 8 + fan.ph) * 0.1, 0.5), null, null, 'spread');
      sceneFace(p, FIN.hushK > 0.5 ? 'focus' : 'grin');
      if (t > (fan.flashAt || 0)) {
        fan.flashAt = t + rand(2.2, 6);
        finFlash(ph.clone().addScaledVector(toCam, 0.03), panOf(p));
      }
      break;
    }
    case 'scream': {
      if (Math.sin(t * 0.9 + fan.ph) > 0) headHands(p);
      else {
        const w = Math.sin(t * 11 + fan.ph) * 0.1;
        p.reach('L', at(F, 0.14, -0.26 - w, 0.58), null, null, 'fist');
        p.reach('R', at(F, 0.14, 0.26 - w, 0.58), null, null, 'fist');
      }
      sceneFace(p, 'scream');
      p.c.jump = 1.1;
      break;
    }
    case 'cry': {
      cheekHands(p);
      sceneFace(p, 'bawl');
      p.c.side = Math.sin(t * 15 + fan.ph) * 0.04;
      p.c.headTilt = Math.sin(t * 1.6 + fan.ph) * 0.1;
      finTears(p, F, 0.35);
      break;
    }
    case 'wave': {
      const w = Math.sin(t * 8 + fan.ph) * 0.16;
      p.reach('R', at(F, 0.15, 0.25 + w, 0.6), null, null, 'flat');
      const b = at(F, 0.3, -0.12, 0.16 + Math.sin(t * 5 + fan.ph) * 0.04);
      p.reach('L', b, null, null, 'grip');
      makeCrowdProp(m, 'bouquet');
      m.act = {
        k: 'fin',
        hold: {
          bouquet: {
            side: 'L',
            off: V3(0, 0.1, 0),
            q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, fan.yaw, 0, 'YXZ'))
          }
        }
      };
      sceneFace(p, 'ecstasy');
      p.c.jump = 0.6;
      break;
    }
    default: { // point
      pointAtMe(p, F);
      headHands(p, 'L');
      sceneFace(p, 'stunlaugh');
      p.c.headTilt = 0.1;
      p.c.jump = 0.5;
    }
  }
  void R;
}

function finFlash(pos, pan = 0) {
  fxEmit(pos, _fv.set(0, 0, 0), 0.34, 0.09, '#ffffff', 0, 0);
  if (AE.decoded) {
    const now = AE.ctx.currentTime + 0.01;
    breathBlip(now, {
      dur: 0.028,
      f0: 5200,
      f1: 2300,
      q: 3,
      vol: 0.045,
      pan,
      att: 0.002
    });
    breathBlip(now + 0.06, {
      dur: 0.03,
      f0: 3200,
      f1: 1500,
      q: 3,
      vol: 0.035,
      pan,
      att: 0.002
    });
  }
}
// 물건을 한 자리에 놓고 두 손으로 가장자리를 잡게 함
function finPlaceItem(fan, C, q, hug = false, s = 1) {
  const it = fan.item,
    p = fan.p;
  if (!it) return;
  it.g.position.copy(C);
  it.g.quaternion.copy(q);
  it.g.scale.setScalar(s);
  const X = V3(1, 0, 0).applyQuaternion(q),
    Y = V3(0, 1, 0).applyQuaternion(q),
    F = frameOf(p);
  const sg = X.dot(F.r) >= 0 ? 1 : -1,
    hw = it.w / 2 + 0.012;
  if (hug) {
    p.reach('R', C.clone().addScaledVector(X, -sg * hw * 0.5).addScaledVector(F.f, 0.035), null, null, 'flat');
    p.reach('L', C.clone().addScaledVector(X, sg * hw * 0.5).addScaledVector(F.f, 0.035).addScaledVector(Y, -0.05), null, null, 'flat');
  } else {
    p.reach('R', C.clone().addScaledVector(X, sg * hw).addScaledVector(Y, -it.h * 0.16), null, null, 'grip');
    p.reach('L', C.clone().addScaledVector(X, -sg * hw).addScaledVector(Y, -it.h * 0.16), null, null, 'grip');
  }
}

function finCarry(fan, mode, t, F) {
  if (!fan.item) return;
  if (mode === 'up') {
    const C = F.c.clone().addScaledVector(F.f, 0.04).addScaledVector(UPY, 0.66 + Math.sin(t * 9 + fan.ph) * 0.03);
    finPlaceItem(fan, C, faceQ(C, C.clone().addScaledVector(F.f, 1).addScaledVector(UPY, 0.1)));
  } else {
    const C = F.c.clone().addScaledVector(F.f, 0.2).addScaledVector(UPY, -0.03);
    finPlaceItem(fan, C, faceQ(C, C.clone().addScaledVector(F.f, 1).addScaledVector(UPY, 0.55)));
  } // 가슴 앞에 꼭 쥠 (사인이 나를 향함)
}
// 사인받는 자리: 물건을 내 눈 쪽으로 받쳐 듦
function finPresent(fan, t, dt, F) {
  const p = fan.p,
    L = FIN.lay,
    d = finToSlot(fan, t, dt, 0);
  if (!fan.item) {
    // 오는 중 / 막 도착
    const w = Math.sin(t * 13 + fan.ph) * 0.08;
    p.reach('L', at(F, 0.2, -0.2 - w, 0.3), null, null, 'spread');
    p.reach('R', at(F, 0.2, 0.2 - w, 0.3), null, null, 'spread');
    sceneFace(p, 'scream');
    if (d < 0.14 && FIN.stage === 'sign' && !FIN.cur) finGive(fan);
    return;
  }
  const it = fan.item,
    age = t - it.t0,
    pop = smooth01(age / 0.3),
    drawing = !!FIN.draw || (FIN.ink > 0 && t - FIN.inkT < 1.6);
  const beg = !FIN.ink && age > 6 ? smooth01((age - 6) / 0.6) : 0;
  const idle = drawing ? 0 : 1;
  const C = _fv.copy(F.c).addScaledVector(F.f, 0.16).lerp(L.C, pop).clone();
  C.addScaledVector(L.up, (Math.sin(t * 5.2 + fan.ph) * 0.003 + Math.max(0, Math.sin(t * 13)) * 0.012 * beg) * idle);
  const q = _fq.copy(L.iq).multiply(new THREE.Quaternion().setFromAxisAngle(V3(0, 0, 1), Math.sin(t * 3.4 + fan.ph) * 0.018 * idle)).clone();
  finPlaceItem(fan, C, q, false, lerp(0.25, 1, pop));
  it.hint.material.opacity = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * 5.2));
  if (drawing) {
    p.c.look.copy(FIN.draw && FIN.draw.w ? FIN.draw.w : L.C);
    sceneFace(p, FIN.ink < 0.25 ? 'gasp' : 'jawdrop');
    crowdStill(p, 0);
    p.c.lean = 0.1;
  } else {
    sceneFace(p, beg > 0.5 ? 'teary' : (Math.sin(t * 0.8 + fan.ph) > 0 ? 'stunlaugh' : 'scream'));
    p.c.jump = beg > 0.5 ? 0.7 : 0.25;
  }
}

function finGive(fan) {
  let it = FIN.items.find(i => !i.owner);
  if (!it) {
    it = FIN.items.slice().sort((a, b) => a.t0 - b.t0)[0];
    if (it.owner) it.owner.item = null;
  }
  it.owner = fan;
  fan.item = it;
  it.t0 = NOW.t;
  fan.kind = FIN_ORDER[FIN.kindN++ % FIN_ORDER.length];
  finPaint(it, fan.kind, (fan.p.look.seed || 1) + FIN.signed);
  it.g.visible = true;
  FIN.cur = fan;
  FIN.ink = 0;
  FIN.inkT = -9;
  FIN.draw = null;
}

// ---------- 사인 ----------
function finHit(e, clampIn) {
  const fan = FIN.cur,
    it = fan && fan.item;
  if (!it || NOW.t - it.t0 < 0.3) return null;
  const r = SC.renderer.domElement.getBoundingClientRect();
  _fv2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5);
  SC.camera.updateMatrixWorld(true);
  it.g.updateMatrixWorld(true);
  FIN.ray.setFromCamera(_fv2, SC.camera);
  FIN.plane.setFromNormalAndCoplanarPoint(_fv.set(0, 0, 1).transformDirection(it.g.matrixWorld), _fv3.set(0, 0, FIN_KINDS[it.kind].z).applyMatrix4(it.g.matrixWorld));
  const hit = FIN.ray.ray.intersectPlane(FIN.plane, new THREE.Vector3());
  if (!hit) return null;
  const loc = it.g.worldToLocal(hit.clone()),
    u = loc.x / it.w + 0.5,
    v = loc.y / it.h + 0.5,
    R = it.rect,
    pad = 0.12;
  if (!clampIn && (u < -pad || u > 1 + pad || v < -pad || v > 1 + pad)) return null; // 물건 언저리에서 시작해도 받아 줌 (사인 칸 안으로 당겨서 그림)
  const cu = clamp(u, R[0], R[2]),
    cv = clamp(v, R[1], R[3]);
  return {
    u: cu,
    v: cv,
    w: it.g.localToWorld(V3((cu - 0.5) * it.w, (cv - 0.5) * it.h, FIN_KINDS[it.kind].z))
  };
}

function finPenStyle(it) {
  const g = it.ctx;
  g.strokeStyle = g.fillStyle = it.inkCol;
  g.lineWidth = 0.0066;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  return g;
}

function finDown(e) {
  if (!FIN.on || FIN.stage !== 'sign' || !UI.playing || FIN.draw) return;
  const h = finHit(e, false);
  if (!h) return;
  e.preventDefault();
  try {
    SC.renderer.domElement.setPointerCapture(e.pointerId);
  } catch (x) { }
  const it = FIN.cur.item,
    g = finPenStyle(it),
    x = h.u * it.w,
    y = h.v * it.h;
  g.beginPath();
  g.arc(x, y, 0.0033, 0, Math.PI * 2);
  g.fill();
  it.tex.needsUpdate = true;
  FIN.draw = {
    id: e.pointerId,
    prev: h,
    mx: x,
    my: y,
    w: h.w
  };
  FIN.ink += 0.012;
  FIN.inkT = NOW.t;
  it.hint.visible = false;
}

function finDrag(e) {
  const d = FIN.draw;
  if (!d || e.pointerId !== d.id || !FIN.cur || !FIN.cur.item) return;
  const h = finHit(e, true);
  if (!h) return;
  const it = FIN.cur.item,
    a = d.prev,
    len = Math.hypot((h.u - a.u) * it.w, (h.v - a.v) * it.h);
  if (len < 0.0012) return;
  const g = finPenStyle(it),
    mx = (a.u + h.u) / 2 * it.w,
    my = (a.v + h.v) / 2 * it.h;
  g.beginPath();
  g.moveTo(d.mx, d.my);
  g.quadraticCurveTo(a.u * it.w, a.v * it.h, mx, my);
  g.stroke();
  it.tex.needsUpdate = true;
  d.mx = mx;
  d.my = my;
  d.prev = h;
  d.w = h.w;
  FIN.ink += len / it.w;
  FIN.inkT = NOW.t;
  // 매직 끽끽
  if (AE.decoded && NOW.t - FIN.sqT > 0.055) {
    FIN.sqT = NOW.t;
    const f = rand(2500, 3300) + Math.min(1500, len * 60000);
    breathBlip(AE.ctx.currentTime + 0.004, {
      dur: 0.06,
      f0: f,
      f1: f * 0.74,
      q: 9,
      vol: 0.07,
      pan: 0.12,
      att: 0.008
    });
  }
}

function finUp(e) {
  const d = FIN.draw;
  if (!d || e.pointerId !== d.id) return;
  const it = FIN.cur && FIN.cur.item;
  if (it) {
    const g = finPenStyle(it);
    g.beginPath();
    g.moveTo(d.mx, d.my);
    g.lineTo(d.prev.u * it.w, d.prev.v * it.h);
    g.stroke();
    it.tex.needsUpdate = true;
  }
  FIN.draw = null;
  FIN.inkT = NOW.t;
}

function finBind() {
  const cv = SC.renderer.domElement;
  cv.addEventListener('pointerdown', finDown);
  cv.addEventListener('pointermove', finDrag);
  cv.addEventListener('pointerup', finUp);
  cv.addEventListener('pointercancel', finUp);
  cv.addEventListener('lostpointercapture', finUp);
  UI.el.endShow.onclick = () => finRequest();
  UI.el.encore.onclick = () => finEncore();
  UI.el.finHome.onclick = () => {
    afterSave();
    location.reload();
  };
}
// 사인 하나 끝: 받은 사람은 내 코앞 그 자리에서 저마다 난리를 치고, 내려가기 시작하면 다음 사람이 밀고 들어옴
function finSigned() {
  const fan = FIN.cur;
  if (!fan) return;
  const t = NOW.t;
  FIN.cur = null;
  FIN.signed++;
  FIN.draw = null;
  FIN.ink = 0;
  FIN.inkT = -9;
  for (const o of FIN.fans)
    if (o.st === 'react') finLeave(o, 'hug');
  fan.m.finGot = true;
  fan.st = 'react';
  fan.t0 = t;
  if (!FIN.reacts.length) {
    FIN.reacts = shuffle(['trophy', 'kiss', 'faint', 'dive', 'dance']);
    if (FIN.reacts[FIN.reacts.length - 1] === FIN.lastReact) FIN.reacts.reverse();
  }
  fan.react = FIN.lastReact = FIN.reacts.pop();
  FIN.cheerUntil = t + 1.5;
  FIN.bump = 1;
  if (AE.decoded) {
    const now = AE.ctx.currentTime;
    crowdWhoops(7);
    scream(now + 0.05, {
      vol: 0.2,
      pan: 0
    });
    if (Math.random() < 0.6) whistleCall(now + 0.4, { vol: 0.05 });
  }
  for (let i = 0; i < 3; i++) REACT.later(0.15 + i * 0.22, () => {
    const f = pick(FIN.fans.filter(o => o.st === 'ring'));
    if (f) finFlash(f.p.headWorld(new THREE.Vector3()).add(V3(0, 0.05, 0.25)), panOf(f.p));
  });
  for (const sx of [-1, 1]) fxConfetti(V3(sx * 0.95, 1.5, -0.7), V3(-sx * 0.25, 1, 0.1), 22, 1.3);
}

function finAdvance() {
  if (!FIN.on || FIN.stage !== 'sign' || FIN.slots[0] || FIN.fans.some(f => f.st === 'react')) return;
  const ring = FIN.fans.filter(f => f.st === 'ring' || f.st === 'run' || f.st === 'wait');
  let next = ring.filter(f => f.st === 'ring' && !f.m.finGot).sort((a, b) => a.slot - b.slot)[0] || ring.filter(f => f.st === 'ring').sort((a, b) => a.slot - b.slot)[0] || ring.sort((a, b) => a.slot - b.slot)[0];
  if (!next) {
    const m = finFromFloor();
    if (m) finSend(m, 0, 0);
    return;
  }
  const old = next.slot;
  FIN.slots[old] = null;
  next.slot = 0;
  FIN.slots[0] = next;
  if (next.st === 'ring') {
    next.st = 'present';
    next.t0 = NOW.t;
  } else next.path[next.path.length - 1].set(FIN_SLOTS[0][0], LAYOUT.stageY, FIN_SLOTS[0][1]);
  finFill(old, 0);
}
// 빈 자리는 바로 뒤 사람이 채우고, 맨 뒤 빈자리로는 객석에서 새 사람이 뛰어 올라옴
function finFill(s, depth) {
  if (FIN.stage !== 'sign' || depth > 8 || FIN.slots[s]) return;
  const S = FIN_SLOTS[s];
  let best = null,
    bd = 1.0;
  for (const f of FIN.fans) {
    if (f.st !== 'ring' || f.slot <= s) continue;
    const T = FIN_SLOTS[f.slot],
      d = Math.hypot(T[0] - S[0], T[1] - S[1]);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  if (best) {
    const old = best.slot;
    FIN.slots[old] = null;
    best.slot = s;
    FIN.slots[s] = best;
    finFill(old, depth + 1);
  } else {
    const m = finFromFloor();
    if (m) finSend(m, s, rand(0, 0.3));
  }
}

function finFromFloor() {
  const free = FIN.pool.filter(m => !m.fin && !m.override && m.p.root.visible);
  return free.find(m => !m.finGot) || free[0] || null;
}
// 사인받은 뒤: 내 코앞에서 사인을 들여다봄 → 저마다 다른 난리(자랑하며 한 바퀴 · 뽀뽀하고 엉엉 · 뒤로 넘어가며 혼이 빠짐 · 번쩍 들고 객석으로 몸 던짐 · 덩실덩실) → 내려감
function finReact(fan, t, dt, F) {
  const p = fan.p,
    m = fan.m,
    a = t - fan.t0,
    it = fan.item,
    cam = CROWD.me;
  const go = (carry, dive = false) => {
    if (FIN.faint === fan) FIN.faint = null;
    finLeave(fan, carry, dive);
    REACT.later(0.15, finAdvance);
  };
  if (!it) {
    go(null);
    return;
  }
  const head = p.headWorld(new THREE.Vector3()),
    toMe = Math.atan2(cam.x - fan.pos.x, cam.z - fan.pos.z);
  fan.yaw = dampAngle(fan.yaw, toMe, 8, dt);
  if (a < 0.7) {
    const C = head.clone().addScaledVector(F.f, 0.3).add(V3(0, -0.06, 0));
    finPlaceItem(fan, C, faceQ(C, head));
    p.c.look.copy(C);
    sceneFace(p, 'gasp');
    return;
  }
  switch (fan.react) {
    case 'trophy': {
      // 번쩍 들고 제자리에서 한 바퀴 (다들 보라고)
      if (a < 1.1) {
        finCarry(fan, 'hug', t, F);
        sceneFace(p, 'scream');
        p.c.jump = 1.3;
      } else if (a < 2.7) {
        fan.yaw = toMe + smooth01((a - 1.1) / 1.45) * Math.PI * 2;
        finCarry(fan, 'up', t, F);
        sceneFace(p, 'scream');
        p.c.jump = 1.1;
        p.c.look.copy(head).add(_fv.set(Math.sin(fan.yaw) * 3, 0.3, Math.cos(fan.yaw) * 3));
        if (!fan.f1) {
          fan.f1 = true;
          crowdWhoops(6);
          for (const o of shuffle(CROWD.list.filter(o => !o.override && o.p.root.visible && !(o.act && o.act.story))).slice(0, 12)) crowdAct(o, pick(['armsUp', 'pump', 'point']), 2.2, {
            fist: true,
            both: true
          });
        }
      } else go('up');
      break;
    }
    case 'kiss': {
      // 사인에 뽀뽀 세 번 → 끌어안고 엉엉 울며 꾸벅꾸벅
      if (a < 2.05) {
        const k = (a - 0.7) / 0.45,
          n = Math.floor(k),
          pk = Math.max(0, Math.sin((k - n) * Math.PI));
        const mo = mouthWorld(p),
          C = mo.clone().addScaledVector(F.f, 0.05 + 0.1 * (1 - pk)).add(V3(0, 0.04, 0));
        finPlaceItem(fan, C, faceQ(C, head));
        sceneFace(p, 'bliss');
        p.c.look.copy(C);
        p.c.lean = 0.1 + pk * 0.12;
        if (n !== fan.kn && n < 3) {
          fan.kn = n;
          if (AE.decoded) smooch(AE.ctx.currentTime + 0.1, 0, 0.2);
        }
      } else if (a < 3.3) {
        finCarry(fan, 'hug', t, F);
        sceneFace(p, 'bawl');
        finTears(p, F, 0.8);
        p.c.lean = 0.15 + 0.4 * Math.max(0, Math.sin((a - 2.05) * 7.5));
      } else go('hug');
      break;
    }
    case 'dance': {
      // 끌어안았다가 번쩍 들고 덩실덩실
      const b = a - 0.7;
      if (b < 0.4) {
        finCarry(fan, 'hug', t, F);
        sceneFace(p, 'scream');
        p.c.jump = 1.3;
      } else if (b < 2.0) {
        const w = Math.sin(b * 10);
        const C = F.c.clone().addScaledVector(F.f, 0.1).addScaledVector(F.r, w * 0.2).addScaledVector(UPY, 0.6 + Math.abs(w) * 0.05);
        finPlaceItem(fan, C, _fq.copy(faceQ(C, C.clone().addScaledVector(F.f, 1).addScaledVector(UPY, 0.2))).multiply(new THREE.Quaternion().setFromAxisAngle(V3(0, 0, 1), -w * 0.3)).clone());
        p.c.hipSway = 1.4;
        p.c.side = w * 0.2;
        p.c.twist = w * 0.22;
        p.c.jump = 1.2;
        sceneFace(p, 'ecstasy');
      } else go('up');
      break;
    }
    case 'dive': {
      // 번쩍 든 채 무대 앞으로 달려가 객석으로 몸을 던짐
      if (a < 1.2) {
        finCarry(fan, 'up', t, F);
        sceneFace(p, 'scream');
        p.c.jump = 1.3;
      } else go('up', true);
      break;
    }
    default: { // faint: 비명 → 눈이 풀려 뒷걸음질 → 다리가 풀려 털썩 주저앉고 입에서 혼이 빠져나감 → 정신 차리고 비틀비틀
      finCarry(fan, 'hug', t, F);
      if (a < 1.0) {
        sceneFace(p, 'scream');
        p.c.jump = 1.3;
        break;
      }
      const b = a - 1.0,
        backZ = FIN_SLOTS[0][1] - 0.46;
      if (fan.pos.z > backZ) {
        fan.pos.z = Math.max(backZ, fan.pos.z - 1.4 * dt);
        p.c.step = 1;
      }
      const down = b > 0.3 && b < 2.2;
      p.c.slump = down ? 1 : 0;
      FIN.faint = down ? fan : null;
      sceneFace(p, b < 0.3 || b > 2.4 ? 'dizzy' : 'out');
      crowdStill(p, 0);
      p.c.look.copy(cam);
      p.c.headTilt = 0.22 * Math.sin(b * 2.2);
      if (b > 0.75 && !fan.f1) {
        fan.f1 = true;
        thud(p, 0.3);
        if (AE.decoded) crowdGasp(AE.ctx.currentTime + 0.02, 10, 0.7);
      }
      if (b > 0.7 && b < 2.2) {
        makeCrowdProp(m, 'soul');
        const rise = smoothstep(0.7, 1.5, b),
          back = smoothstep(1.9, 2.2, b),
          base = mouthWorld(p);
        const up = cam.clone().sub(base).normalize().multiplyScalar(0.5).add(V3(0, 0.22, 0)); // 내 쪽으로 떠오름
        const pos = base.clone().addScaledVector(up, rise).add(_fv.set(Math.sin(b * 2.3) * 0.06 * rise, Math.sin(b * 3.3) * 0.03, 0)).lerp(base, back);
        m.act = { k: 'fin', hold: { soul: { pos, q: faceQ(pos, cam), s: (0.25 + 0.85 * rise) * (1 - back * 0.75) } } };
      }
      if (b > 2.9) {
        fan.slow = true;
        go('hug');
      }
    }
  }
}
// 등 돌리고 객석으로 몸을 던짐 → 사람들 손 위로 실려 제자리까지
function finDive(fan, t, dt, F) {
  const p = fan.p,
    m = fan.m,
    a = t - fan.t0,
    sp = m.spot.pos,
    Y = LAYOUT.stageY,
    cam = CROWD.me;
  const edge = _fv3.set(fan.d0.x, Y, -3.88).clone();
  const hugIt = () => {
    if (fan.item) {
      const C = F.c.clone().addScaledVector(F.f, 0.14).add(V3(0, 0.02, 0));
      finPlaceItem(fan, C, faceQ(C, C.clone().addScaledVector(F.f, 1)), true);
    }
  };
  if (a < 0.45) {
    fan.pos.lerpVectors(fan.d0, edge, smooth01(a / 0.45));
    fan.yaw = dampAngle(fan.yaw, 0, 12, dt);
    p.c.step = 1;
    sceneFace(p, 'ecstasy');
    p.c.look.copy(cam);
    finCarry(fan, 'up', t, F);
  } else if (a < 1.1) {
    const k = smooth01((a - 0.45) / 0.65);
    fan.pos.set(edge.x, lerp(Y, 1.15, k), lerp(-3.88, -4.05, k));
    p.root.rotation.x = -1.42 * Math.pow(k, 1.4);
    fan.yaw = dampAngle(fan.yaw, 0, 12, dt);
    hugIt();
    sceneFace(p, 'scream');
    if (!fan.f2) {
      fan.f2 = true;
      if (AE.decoded) scream(AE.ctx.currentTime + 0.05, {
        vol: 0.2,
        pan: clamp(edge.x / 4, -0.8, 0.8)
      });
      crowdWhoops(5);
    }
  } else if (a < 3.1) {
    const k = smooth01((a - 1.1) / 2.0);
    fan.pos.set(lerp(edge.x, sp.x, k), 1.15 + Math.sin(a * 9) * 0.05, lerp(-4.05, sp.z - 0.2, k));
    p.root.rotation.x = -1.45 + Math.sin(a * 7) * 0.05;
    hugIt();
    sceneFace(p, 'ecstasy');
    if (!fan.f3) {
      fan.f3 = true;
      for (const o of CROWD.list)
        if (o !== m && !o.override && o.kind === 'front' && o.p.root.position.distanceTo(sp) < 3.2 && !(o.act && o.act.story)) crowdAct(o, 'armsUp', 2.2);
    }
  } else if (a < 3.7) {
    const k = smooth01((a - 3.1) / 0.6);
    fan.pos.set(sp.x, lerp(1.15, 0, k), lerp(sp.z - 0.2, sp.z, k));
    p.root.rotation.x = -1.45 * (1 - k);
    fan.yaw = dampAngle(fan.yaw, m.spot.yaw, 6, dt);
    hugIt();
    sceneFace(p, 'grin');
  } else finRelease(m);
}

// ---------- 한 곡 더 ----------
function finEncore() {
  if (!FIN.on || FIN.stage === 'out' || FIN.stage === 'ovation') return;
  const t = NOW.t;
  FIN.stage = 'out';
  FIN.stageT = t;
  FIN.band = false;
  FIN.camT = 0;
  FIN.cur = null;
  FIN.draw = null;
  FIN.cheerUntil = 0;
  FIN.bump = 1;
  FIN.faint = null;
  finUI();
  for (const fan of FIN.fans) {
    if (fan.st === 'gone' || fan.st === 'dive') continue;
    if (fan.st === 'leave') {
      if (fan.slow) {
        fan.slow = false;
        fan.speed = 3.3;
        fan.path[fan.seg].copy(fan.pos);
        fan.segT = t;
      }
      continue;
    } // 비틀비틀 내려가던 사람도 서두름
    if (fan.st === 'wait') {
      finRelease(fan.m);
      continue;
    }
    fan.slow = false;
    finLeave(fan, fan.item ? 'up' : null);
    fan.segT = t + rand(0, 0.4);
  }
  REACT.burst = {
    kind: 'solo',
    owner: 'me',
    t,
    until: t + 6,
    k: 1.0,
    energy: 0.7,
    fade: 2.5
  };
  bed.set('babble', 0, 1);
  crowdWhoops(9);
  crowdWhistles(2);
  for (const m of BAND.members) {
    m.stare = null;
    m.c.jump = 0;
    m.express('grin', 2.5);
  }
  if (BAND.tb) BAND.tb.worship = null;
}

function finEnd() {
  for (const m of CROWD.list) {
    if (m.fin) finRelease(m);
    m.standHoldUntil = NOW.t + 3 + (m.standDelay || 0);
    m.finGot = false;
  }
  for (const it of FIN.items) {
    it.g.visible = false;
    it.owner = null;
  }
  FIN.fans.length = 0;
  FIN.slots.length = 0;
  Object.assign(FIN, {
    on: false,
    req: false,
    stage: 'off',
    cur: null,
    draw: null,
    band: false,
    camT: 0,
    hushK: 0
  });
  GAME.phase = 'play';
  finUI();
  bed.set('babble', 0, 0.8);
  TP.lastSoundT = -9;
  UI.inputRect = null;
  const now = AE.ctx.currentTime;
  if (MUS.gap) {
    MUS.gap.hold = false;
    MUS.gap.minEnd = now + 0.3;
    MUS.gap.maxEnd = now + 8;
  } else if (!MUS.song) {
    const S = compileSong(tuneById(MUS.setOrder[MUS.setPos]), MUS.setPos);
    BASS.last = 41;
    PNO.voicing = null;
    startSong(S, now + 0.3, false);
  }
}

// ---------- 매 프레임 ----------
function finTick(dt, t) {
  if (FIN.req && !FIN.on && t - FIN.reqT > 22) finBegin(); // 혹시 끝 화음이 안 끊겨도 시작은 함
  // 카메라: 무대 앞으로 다가가 내려다봄 / 트럼펫은 내려 둠
  const ck = FIN.camK,
    ct = FIN.on ? FIN.camT : 0;
  if (ck !== ct) {
    FIN.camK = clamp(ck + Math.sign(ct - ck) * dt / 1.7, 0, 1);
    aimCamera();
  }
  if (VENUE) VENUE.keyK = lerp(1, 0.3, smooth01(FIN.camK)); // 무대 가운데 조명: 팬들이 바로 밑에 서면 얼굴이 하얗게 날아가서 낮춤
  const aw = FIN.on && FIN.stage !== 'out' && t - FIN.t0 > 0.9 ? 1 : 0;
  if (FIN.away !== aw) FIN.away = clamp(FIN.away + Math.sign(aw - FIN.away) * dt / 0.7, 0, 1);
  finPenTick(dt, t);
  if (!FIN.on) return;
  const a = t - FIN.t0,
    R = REACT;
  // 소리: 처음엔 터질 듯 → 웅성웅성으로 가라앉고, 사인 하나 끝날 때마다 다시 환호
  FIN.bump = Math.max(0, FIN.bump - dt / 3.0);
  const base = lerp(1, 0.5, smoothstep(6, 12, a));
  FIN.loud = lerp(base, 1, smooth01(FIN.bump * 1.6));
  if (FIN.stage !== 'out' && !(R.burst && R.burst.until > t + 1e5)) R.burst = {
    kind: 'ovation',
    owner: 'me',
    t,
    until: t + 1e6,
    k: 1.2,
    energy: 0.95,
    fade: 3
  }; // 다른 장면이 박수를 덮어썼으면 다시 세움
  if (FIN.stage !== 'out') {
    const calm = a > 8 && FIN.bump <= 0;
    R.burst.kind = calm ? 'solo' : 'ovation';
    R.burst.k = calm ? 0.62 : 1.2;
    R.burst.energy = calm ? 0.64 : 0.95;
  }
  switch (FIN.stage) {
    case 'ovation':
      if (a > 2.0) finRush();
      break;
    case 'rush': {
      const f0 = FIN.slots[0];
      if ((f0 && f0.st === 'present') || t - FIN.stageT > 9) {
        FIN.stage = 'sign';
        FIN.stageT = t;
        finUI();
        if (!FIN.slots[0]) finAdvance();
      }
      break;
    }
    case 'sign': {
      const cur = FIN.cur;
      if (cur && cur.item && !FIN.draw && FIN.ink >= 0.3 && t - FIN.inkT > 1.0) finSigned(); // 획 사이에 잠깐 쉬는 건 기다려 줌
      if (!FIN.slots[0] && t - FIN.stageT > 1.5 && !FIN.fans.some(f => f.st === 'react')) finAdvance();
      const hush = !!cur && (!!FIN.draw || (FIN.ink > 0 && t - FIN.inkT < 2.2));
      FIN.hushK = damp(FIN.hushK, hush ? 1 : 0, 9, dt);
      if (AE.decoded && bed.TABLE.babble) bed.set('babble', 0.12 * (1 - FIN.hushK), 0.3); // 쓰는 동안은 웅성거림도 뚝
      // 여기저기서 터지는 외침
      if (AE.decoded && !hush && t > FIN.nextYell) {
        FIN.nextYell = t + rand(0.7, 2.3);
        const now = AE.ctx.currentTime, r = Math.random();
        if (r < 0.5) whoop(now + 0.02, { vol: rand(0.08, 0.15) });
        else if (r < 0.75) scream(now + 0.02, { vol: 0.1 });
        else laugh(now + 0.02, { vol: 0.08 });
      }
      break;
    }
    case 'out':
      FIN.hushK = 0;
      if (FIN.fans.every(f => f.st === 'gone') || t - FIN.stageT > 5.5) finEnd();
      break;
  }
}

function finPenTick(dt, t) {
  const pen = FIN.pen;
  if (!pen) return;
  const fan = FIN.cur,
    it = fan && fan.item,
    L = FIN.lay;
  const show = FIN.on && FIN.stage === 'sign' && it && t - it.t0 > 0.25;
  FIN.penK = damp(FIN.penK, show ? 1 : 0, show ? 7 : 10, dt);
  if (it && L) {
    SC.camera.updateMatrixWorld(true);
    if (FIN.draw && FIN.draw.w) _fv.copy(FIN.draw.w).addScaledVector(L.n, 0.002);
    else {
      it.g.updateMatrixWorld(true);
      const R = it.rect,
        cyc = (t - it.t0 - 2.0) % 3.6,
        hint = !FIN.ink && t - it.t0 > 2.0 && cyc < 1.5;
      // 아직 한 번도 안 그었으면 가끔 면 위 허공에서 휘갈기는 시늉 (손가락으로 그리면 된다는 걸 글 없이 알려 줌), 평소엔 오른쪽 아래에서 쉼
      if (hint) {
        const k = cyc / 1.5;
        _fv.set((lerp(R[0], R[2], lerp(0.26, 0.74, k)) - 0.5) * it.w, (lerp(R[1], R[3], 0.5 + 0.13 * Math.sin(k * 10)) - 0.5) * it.h, 0.016);
      } else _fv.set((lerp(R[0], R[2], 0.86) - 0.5) * it.w, (lerp(R[1], R[3], 0.34) - 0.5) * it.h + Math.sin(t * 2.1) * 0.004, 0.035 + Math.sin(t * 2.1 + 1) * 0.004);
      _fv.applyMatrix4(it.g.matrixWorld);
    }
    _fv.applyMatrix4(SC.camera.matrixWorldInverse);
    if (FIN.penK < 0.06) FIN.penAt.copy(_fv);
    else FIN.penAt.lerp(_fv, 1 - Math.exp(-(FIN.draw ? 45 : 9) * dt));
  }
  pen.visible = FIN.penK > 0.02 && !!L;
  if (!pen.visible) return;
  const k = smooth01(FIN.penK);
  pen.position.copy(FIN.penAt).add(_fv2.set(0.1, -0.2, 0.08).multiplyScalar(1 - k));
  pen.quaternion.copy(SC.camera.quaternion).invert().multiply(L.iq).multiply(FIN_PENQ);
}
// 밴드: 연주를 내려놓고 나를 보며 박수 (트롬본 리더는 절부터)
function finBandPose(k, m, t) {
  if (!FIN.band) return false;
  m.stare = {
    until: t + 0.5,
    turn: 1
  };
  if (!m.exUntil) m.express(k === 'tb' ? 'ecstasy' : pick(['grin', 'stunlaugh', 'grin']), rand(1.5, 3));
  const F = frameOf(m);
  if (k === 'tb') {
    sceneClap(m, F, t, true);
    m.c.jump = 0.6;
    return true;
  }
  if (k === 'pn') {
    m.c.stand = 1;
    sceneClap(m, F, t + 0.11, true);
    return true;
  }
  if (k === 'bs') {
    m.reach('R', m.local(-0.34, 1.7 + Math.sin(t * 9) * 0.07, 0.2), null, null, 'spread');
    return false;
  }
  return false;
}

// ===== 85_me.js =====
// ===================== 1인칭: 내 트럼펫과 두 손 =====================
// 트럼펫 좌표: 마우스피스 +z, 벨 -z, 밸브 단추 +y, 원점은 2번 밸브 케이싱 가운데. +x = 내 오른쪽
const ME = {
  press: [0, 0, 0],
  press2: [0, 0, 0],
  lift: 0,
  pitchLift: 0,
  bend: 0,
  introK: 1,
  buzz: 0
};

function capsuleBetween(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a),
    len = Math.max(1e-4, d.length());
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 12), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(V3(0, 1, 0), d.normalize());
  return m;
}
// 납작한 타원체 (손바닥·손톱): 중심, 길이 방향, 너비 방향, 반지름 (길이/너비/두께)
function ellipsoid(center, along, across, r, mat, seg = 18) {
  const y = along.clone().normalize();
  const x = across.clone().addScaledVector(y, -across.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7)), mat);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  m.scale.set(r[1], r[0], r[2]);
  m.position.copy(center);
  return m;
}
// 손등(손바닥 덩어리): 손가락 뿌리 줄(검지 kI → 새끼 kP)에서 손목 W까지. 손목 쪽으로 좁아지고 얇아지는 납작한 덩어리
function handBack(kI, kP, W, mat, thick = 0.027, pad = 0.019) {
  const kc = kI.clone().add(kP).multiplyScalar(0.5);
  const y = kc.clone().sub(W),
    len = y.length();
  y.normalize(); // 손목 → 손가락 뿌리
  const x = kI.clone().sub(kP),
    wid = x.length() + pad;
  x.addScaledVector(y, -x.dot(y)).normalize(); // 새끼 → 검지
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const L = len + 0.01,
    g = rbox(wid, L, thick, 0.021, 4),
    p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getY(i) / L + 0.5, 0, 1);
    p.setX(i, p.getX(i) * lerp(0.74, 1, t));
    p.setZ(i, p.getZ(i) * lerp(0.84, 1, t));
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  m.position.copy(W).addScaledVector(y, L / 2 - 0.004);
  return m;
}
// 밸브 단추 윗면 (트럼펫 좌표)
function valveTops(horn) {
  horn.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(horn.matrixWorld).invert();
  const v = horn.userData.valves || [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    if (!v[i]) {
      out.push(V3(0, 0.075, 0.034 - i * 0.034));
      continue;
    }
    const b = new THREE.Box3().setFromObject(v[i]).applyMatrix4(inv);
    out.push(V3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2));
  }
  return out;
}

function sleeveOn(g, wrist, elbow, mats) {
  const dir = new THREE.Vector3().subVectors(elbow, wrist).normalize();
  const c0 = wrist.clone().addScaledVector(dir, 0.034);
  g.add(capsuleBetween(wrist, c0, 0.026, mats.skin));
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.026, 18), mats.cuff);
  cuff.position.copy(c0).addScaledVector(dir, 0.01);
  cuff.quaternion.setFromUnitVectors(V3(0, 1, 0), dir);
  g.add(cuff);
  const s0 = c0.clone().addScaledVector(dir, 0.026);
  const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.05, 0.42, 18, 1, false), mats.sleeve);
  sl.position.copy(s0).addScaledVector(dir, 0.21);
  sl.quaternion.setFromUnitVectors(V3(0, 1, 0), dir);
  g.add(sl);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.006, 8, 22), mats.sleeve);
  rim.position.copy(s0);
  rim.quaternion.setFromUnitVectors(V3(0, 0, 1), dir);
  g.add(rim);
}
// 오른손: 손끝 셋이 밸브 단추 위, 손등은 오른쪽 위
// 손 안에서 함께 움직이는 불투명 조각만 묶는다. 손가락 pivot은 그대로 둔다.
// OutlineEffect는 object normal을 쓰므로 비균일 scale 부품은 병합하지 않는다.
function batchHandMeshes(root) {
  for (const child of root.children.slice())
    if (child.isGroup) batchHandMeshes(child);
  const buckets = new Map();
  for (const m of root.children) {
    if (!m.isMesh || m.children.length || Array.isArray(m.material) || m.material.transparent ||
      m.scale.x !== 1 || m.scale.y !== 1 || m.scale.z !== 1 || !m.visible) continue;
    const g = m.geometry;
    if (Object.keys(g.morphAttributes).length || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) continue;
    const attrs = Object.keys(g.attributes).sort().map(k => {
      const a = g.attributes[k];
      return k + ':' + a.itemSize + ':' + a.normalized + ':' + a.array.constructor.name;
    }).join(',');
    const key = m.material.uuid + ':' + m.castShadow + ':' + m.receiveShadow + ':' + m.renderOrder + ':' + m.layers.mask + ':' + !!g.index + ':' + attrs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const parts = list.map(m => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!geo) continue;
    const first = list[0],
      merged = new THREE.Mesh(geo, first.material);
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;
    merged.renderOrder = first.renderOrder;
    merged.layers.mask = first.layers.mask;
    merged.name = 'batchedHand';
    for (const m of list) root.remove(m);
    root.add(merged);
  }
  return root;
}

function buildRightHand(horn, mats) {
  const g = new THREE.Group();
  g.name = 'rightHand';
  const tops = valveTops(horn),
    r = 0.0088,
    sk = mats.skin;
  const fingers = [],
    knuckles = [];
  // 손톱: 끝마디의 등 쪽(굽은 바깥쪽)에 얹음 → 위에서 내려다보면 손등·손톱이 보임
  const nail = (T, D, P, rad, k = 1) => {
    const s = new THREE.Vector3().subVectors(T, D).normalize(),
      p = new THREE.Vector3().subVectors(D, P).normalize();
    const n = p.addScaledVector(s, -p.dot(s)).normalize();
    return ellipsoid(T.clone().addScaledVector(s, -0.0035 * k).addScaledVector(n, rad - 0.0011), s, new THREE.Vector3().crossVectors(s, n), [0.0066 * k, 0.0055 * k, 0.0022], mats.nail, 12);
  };
  // 검지·중지·약지: 손끝이 1·2·3번 밸브 단추 위 (누를 때 뿌리 마디를 축으로 내려감)
  for (let i = 0; i < 3; i++) {
    const T = tops[i].clone().add(V3(0.001, r * 0.95, 0));
    const D = T.clone().add(V3(0.011, 0.02, 0));
    const P = D.clone().add(V3(0.022, 0.012, 0.0015 * (i - 1)));
    const K = P.clone().add(V3(0.027, -0.004, 0.004 * (i - 1)));
    const piv = new THREE.Group();
    piv.position.copy(K);
    g.add(piv);
    const off = K.clone().negate();
    const add = m => {
      m.position.add(off);
      piv.add(m);
    };
    add(capsuleBetween(T, D, r * 0.94, sk));
    add(capsuleBetween(D, P, r, sk));
    add(capsuleBetween(P, K, r * 1.08, sk));
    add(nail(T, D, P, r * 0.94));
    fingers.push(piv);
    knuckles.push(K);
  }
  // 새끼손가락: 약지 옆(벨 쪽)에 나란히, 조금 짧고 가늘게. 3번 밸브 앞 허공에 살짝 굽혀 둠
  const K3 = knuckles[2].clone().add(V3(-0.003, -0.008, -0.02));
  const P3 = K3.clone().add(V3(-0.022, 0.003, -0.005)),
    D3 = P3.clone().add(V3(-0.017, -0.011, -0.003)),
    T3 = D3.clone().add(V3(-0.008, -0.016, -0.001));
  g.add(capsuleBetween(K3, P3, 0.0082, sk), capsuleBetween(P3, D3, 0.0077, sk), capsuleBetween(D3, T3, 0.0072, sk), nail(T3, D3, P3, 0.0072, 0.86));
  knuckles.push(K3);
  // 손등 + 뿌리 마디 넷
  const kAvg = knuckles.slice(0, 3).reduce((a, k) => a.add(k), V3(0, 0, 0)).multiplyScalar(1 / 3).add(V3(0, -0.002, -0.004));
  const W = kAvg.clone().add(V3(0.05, -0.056, 0.016));
  g.add(handBack(knuckles[0].clone().add(V3(0, -0.002, 0.004)), K3, W, sk, 0.026, 0.02));
  knuckles.forEach((K, i) => {
    const b = new THREE.Mesh(new THREE.SphereGeometry((i === 3 ? 0.0082 : r) * 1.2, 14, 10), sk);
    b.position.copy(K).add(V3(0.002, 0.0008, 0));
    g.add(b);
  });
  // 엄지: 손목의 내 쪽(검지 쪽) 옆에서 나와 리드파이프 밑으로 들어가 1번 밸브 뒤를 받침.
  // 오른손은 손등을 위에서 보면 엄지가 내 쪽(가까운 쪽)에 있음 — 전에는 엄지가 손바닥 속에 묻혀 안 보이고, 벨 쪽의 짧은 새끼손가락이 엄지처럼 보여 왼손으로 읽혔음
  const TB = W.clone().add(V3(-0.007, -0.009, 0.034)),
    TM = TB.clone().add(V3(-0.026, -0.03, 0.012)),
    TI = TM.clone().add(V3(-0.028, -0.026, 0.002)),
    TT = TI.clone().add(V3(-0.03, -0.016, -0.006));
  g.add(capsuleBetween(TB, TM, 0.0118, sk), capsuleBetween(TM, TI, 0.0108, sk), capsuleBetween(TI, TT, 0.0098, sk));
  g.add(ellipsoid(W.clone().lerp(TM, 0.5).add(V3(0, 0.003, 0.004)), new THREE.Vector3().subVectors(TM, W), V3(0, 0, 1), [0.03, 0.019, 0.015], sk)); // 엄지 두덩
  g.add(nail(TT, TI, TM, 0.0098, 1.05));
  sleeveOn(g, W, W.clone().add(V3(0.13, -0.2, 0.25)), mats);
  g.userData.fingers = fingers;
  return batchHandMeshes(g);
}
// 왼손: 밸브 케이싱을 왼쪽에서 감싸 쥠
function buildLeftHand(horn, mats) {
  const g = new THREE.Group();
  g.name = 'leftHand';
  const tops = valveTops(horn);
  const x0 = (tops[0].x + tops[2].x) / 2,
    zF = Math.min(tops[0].z, tops[2].z) - 0.014,
    zB = Math.max(tops[0].z, tops[2].z) + 0.014;
  const yTop = tops[1].y - 0.035;
  const ks = [];
  for (let k = 0; k < 4; k++) {
    const r = k === 3 ? 0.0078 : 0.0088;
    const K = V3(x0 - 0.027, yTop - k * 0.018, zF + 0.002);
    const P = K.clone().add(V3(0.017, -0.001, -0.014)),
      T = P.clone().add(V3(0.022, -0.001, 0.008 - k * 0.001));
    g.add(capsuleBetween(K, P, r * 1.05, mats.skin), capsuleBetween(P, T, r, mats.skin));
    ks.push(K);
  }
  const W = V3(x0 - 0.047, yTop - 0.06, zB + 0.03);
  g.add(handBack(ks[0], ks[3], W, mats.skin, 0.026, 0.02));
  // 엄지: 위로 올라와 1번 슬라이드 쪽
  const TB = W.clone().add(V3(0.012, 0.03, -0.012)),
    TM = TB.clone().add(V3(0.006, 0.024, -0.016)),
    TT = TM.clone().add(V3(0.004, 0.012, -0.018));
  g.add(capsuleBetween(TB, TM, 0.011, mats.skin), capsuleBetween(TM, TT, 0.0098, mats.skin));
  sleeveOn(g, W, W.clone().add(V3(-0.11, -0.21, 0.25)), mats);
  return batchHandMeshes(g);
}

function setupMeteor() {
  const group = METEOR.group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1.25, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 1 + 0.16 * Math.sin(x * 19 + y * 23 + z * 29) + 0.07 * Math.sin(x * 41 - y * 17 + z * 13);
    pos.setXYZ(i, x * n, y * n, z * n);
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#4a3029', roughness: 0.86, emissive: '#a72e12', emissiveIntensity: 0.42 }));
  rock.castShadow = true; group.add(rock);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.68, 16, 12), new THREE.MeshBasicMaterial({ color: '#ff4b12', transparent: true, opacity: 0.72 }));
  tail.position.z = 1.42; tail.scale.set(0.78, 0.78, 2.5); group.add(tail);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), new THREE.MeshBasicMaterial({ color: '#ffd36a', transparent: true, opacity: 0.88 }));
  core.position.z = 1.0; core.scale.set(0.58, 0.58, 2.1); group.add(core);
  METEOR.light = new THREE.PointLight('#ff642b', 5, 16, 2);
  group.add(METEOR.light);
  group.visible = false; SC.scene.add(group);
}

function setupMe() {
  const rig = new THREE.Group();
  SC.vmScene.add(rig);
  ME.rig = rig;
  const hold = new THREE.Group();
  rig.add(hold);
  ME.hold = hold;
  const horn = makeTrumpet();
  ME.horn = horn;
  const mats = {
    skin: toonMat('#f1b892'),
    nail: toonMat('#f9d9c8', { outline: 0.003 }),
    sleeve: toonMat('#d23b4f'),
    cuff: toonMat('#fff6e6')
  };
  ME.mats = mats;
  const RH = buildRightHand(horn, mats),
    LH = buildLeftHand(horn, mats);
  horn.add(RH);
  horn.add(LH);
  ME.fingers = RH.userData.fingers;
  ME.LH = LH;
  const mouth = horn.getObjectByName('mouth'),
    bell = horn.getObjectByName('bell');
  const mp = mouth ? mouth.position.clone() : V3(0, 0.03, 0.25),
    bp = bell ? bell.position.clone() : V3(0, 0.03, -0.23);
  horn.position.copy(mp).negate();
  ME.axis = bp.clone().sub(mp);
  ME.len = ME.axis.length();
  ME.axis.normalize();
  hold.add(horn);
  setupHorn2(mats);
  setupMouthpieceRig(mats);
  setupFightHand();
  placeMe();
}
// Fight 전용 1인칭 제스처.
function setupFightHand() {
  const g = ME.fightHand = new THREE.Group();
  SC.vmScene.add(g);
  const skin = toonMat('#f1b892'), sleeve = toonMat('#d23b4f'), cuff = toonMat('#fff6e6');
  const ball = (x, y, z, sx, sy, sz, mat = skin) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz); g.add(m);
  };
  const seg = (a, b, r = 0.018, mat = skin) => g.add(capsuleBetween(V3(...a), V3(...b), r, mat));
  seg([0.10, -0.31, 0.02], [-0.015, -0.07, 0.015], 0.047, sleeve);
  seg([0.015, -0.11, 0.005], [-0.01, -0.055, 0.005], 0.045, cuff);
  ball(0, 0.005, 0, 0.087, 0.105, 0.035);
  // The middle finger stays raised while the other fingers curl into a fist.
  seg([-0.008, 0.066, -0.002], [-0.009, 0.15, -0.012], 0.021);
  seg([-0.009, 0.15, -0.012], [-0.01, 0.245, -0.02], 0.018);
  ball(-0.01, 0.244, -0.02, 0.018, 0.02, 0.017);
  for (const x of [-0.052, 0.032, 0.061]) {
    const y = x > 0.05 ? 0.045 : 0.055;
    seg([x, y, -0.002], [x * 1.02, y - 0.035, -0.025], 0.017);
    seg([x * 1.02, y - 0.035, -0.025], [x * 0.72, y - 0.052, -0.035], 0.016);
    ball(x * 0.72, y - 0.052, -0.035, 0.016, 0.016, 0.014);
  }
  seg([0.069, -0.005, -0.002], [0.078, 0.038, -0.025], 0.021);
  seg([0.078, 0.038, -0.025], [0.031, 0.029, -0.045], 0.019);
  ball(0.031, 0.029, -0.045, 0.019, 0.018, 0.014);
  g.visible = false;
}
// 두 번째 트럼펫: 왼손에 드는 거울상 (밸브를 왼손 손가락으로 누름)
function setupHorn2(mats) {
  const hold2 = new THREE.Group();
  ME.rig.add(hold2);
  ME.hold2 = hold2;
  hold2.visible = false;
  const mir = new THREE.Group();
  mir.scale.x = -1;
  hold2.add(mir);
  const horn2 = makeTrumpet();
  mir.add(horn2);
  ME.horn2 = horn2;
  const H2 = buildRightHand(horn2, mats);
  horn2.add(H2);
  ME.fingers2 = H2.userData.fingers;
  const mp = horn2.getObjectByName('mouth').position.clone(),
    bp = horn2.getObjectByName('bell').position.clone();
  horn2.position.copy(mp).negate();
  ME.axis2 = bp.clone().sub(mp);
  ME.axis2.x *= -1;
  ME.axis2.normalize();
}
// 공연 전: 마우스피스를 쥔 오른손. 팔은 오른쪽 아래에서 들어오고 손등이 위를 봄.
// 네 손가락이 오른쪽에서 대롱 위를 넘어 왼쪽으로 감아 내려가고, 엄지는 내 쪽(컵 바로 뒤)에서 대롱 밑으로 감음.
// 좌표: 대롱이 z축 (컵 림이 z=0, 내 쪽 +z), +x 오른쪽, +y 위
function setupMouthpieceRig(mats) {
  const g = new THREE.Group();
  ME.rig.add(g);
  ME.mpRig = g;
  g.visible = false;
  const inner = new THREE.Group();
  g.add(inner);
  ME.mpInner = inner;
  inner.add(new THREE.Mesh(mouthpieceGeo(0.0135, 0.014, 0.088, 0.0062, 24).rotateX(Math.PI / 2), metalMat('#c3c8d6', 0.24, {
    env: 1.0
  })));
  const sk = mats.skin;
  const zs = [-0.036, -0.0545, -0.072, -0.0875],
    rs = [0.0086, 0.0089, 0.0085, 0.0075],
    arch = [0, 0.0022, 0.0012, -0.0022],
    kn = [];
  for (let i = 0; i < 4; i++) {
    const z = zs[i],
      r = rs[i],
      a = arch[i],
      c = i === 3 ? 0.9 : 1;
    const K = V3(0.0145, 0.0245 + a, z),
      P = V3(-0.0152 * c, 0.0178 + a, z - 0.001),
      D = V3(-0.0208 * c, -0.003, z - 0.0015),
      T = V3(-0.0072 * c, -0.0162, z - 0.002);
    inner.add(capsuleBetween(K, P, r * 1.05, sk), capsuleBetween(P, D, r, sk), capsuleBetween(D, T, r * 0.93, sk));
    const kb = new THREE.Mesh(new THREE.SphereGeometry(r * 1.22, 14, 10), sk);
    kb.position.copy(K).add(V3(0.0015, 0.0012, 0));
    inner.add(kb); // 손가락 뿌리 마디
    kn.push(K);
  }
  const W = V3(0.078, -0.012, -0.058);
  inner.add(handBack(kn[0].clone().add(V3(0, -0.003, 0.003)), kn[3].clone().add(V3(0, -0.003, -0.001)), W, sk, 0.03, 0.017));
  // 엄지: 손바닥 아래(내 쪽)에서 대롱 밑으로 감아 검지 끝과 만남
  const TB = V3(0.052, -0.016, -0.03),
    TM = V3(0.026, -0.0245, -0.0165),
    TI = V3(0.002, -0.0262, -0.0165),
    TT = V3(-0.0175, -0.0185, -0.021);
  inner.add(capsuleBetween(TB, TM, 0.0124, sk), capsuleBetween(TM, TI, 0.0108, sk), capsuleBetween(TI, TT, 0.0098, sk));
  inner.add(ellipsoid(V3(0.047, -0.0125, -0.04), V3(-0.8, -0.35, 0.45), V3(0, 0, 1), [0.027, 0.019, 0.0135], sk)); // 엄지 두덩
  const nd = new THREE.Vector3().subVectors(TT, TI).normalize();
  inner.add(ellipsoid(TT.clone().addScaledVector(nd, 0.001).add(V3(-0.001, -0.0068, 0.0052)), nd, V3(0, -0.55, 0.83), [0.0068, 0.0056, 0.0022], mats.nail, 12));
  sleeveOn(inner, W, W.clone().add(V3(0.135, -0.165, 0.2)), mats);
}

function placeMe() {
  ME.pose = SC.portrait ? { bell: V3(-0.035, -0.262, -0.42), pitch: 0.36, yaw: 0.05, scale: 0.9 } : { bell: V3(-0.01, -0.104, -0.42), pitch: 0.46, yaw: 0.03, scale: 0.9 };
  ME.dbl = doublePose();
  // 마우스피스 쥔 손: 화면 안 같은 자리에 오도록 화면 비율로 계산
  const hy = Math.tan(SC.vmCam.fov * Math.PI / 360), hx = hy * SC.vmCam.aspect;
  const m = Object.assign(SC.portrait ? { sx: -0.2, sy: -0.76, z: 0.29, s: 1.25 } : { sx: -0.04, sy: -0.74, z: 0.44, s: 1.08 }, ME.mpTune || {});
  ME.mpPose = {
    p: V3(m.sx * hx * m.z, m.sy * hy * m.z, -m.z),
    s: m.s
  };
  updateMe(0, NOW.t);
}
// 두 대를 들었을 때의 자세: 벨 두 개가 화면에서 놓일 자리를 먼저 정하고(화면 폭 기준), 거기서 거꾸로 각 트럼펫의 위치·방향을 구함.
// 좁은 화면일수록 벨을 조금 멀리 두어 작게 보이게 하고, 두 대 모두 바깥으로 기울여 V자로 벌림.
function doublePose() {
  const hy = Math.tan(SC.vmCam.fov * Math.PI / 360),
    hx = hy * SC.vmCam.aspect,
    L = ME.len || 0.483;
  const T = ME.dblTune || {};
  // 화면 좌표(-1~1)로 본 벨 중심, 화면에 보이는 기울기(도), 벨 반지름(화면 반폭 대비)
  if (!SC.portrait && !T.force) {
    // 가로 화면: 한 대 자세의 입 위치에서 좌우로 벌림 (가운데 객석이 벨 사이로 보이게)
    const P = ME.pose,
      d0 = V3(-Math.sin(P.yaw) * Math.cos(P.pitch), Math.sin(P.pitch), -Math.cos(P.yaw) * Math.cos(P.pitch));
    const mouth = P.bell.clone().addScaledVector(d0, -L * P.scale);
    return {
      h1: {
        m: mouth,
        yaw: P.yaw - 0.25,
        pitch: P.pitch + 0.09,
        s: P.scale
      },
      h2: {
        m: mouth.clone().add(V3(-0.025, 0, 0)),
        yaw: P.yaw + 0.33,
        pitch: P.pitch + 0.11,
        s: P.scale
      }
    };
  }
  // 세로(좁은) 화면: 오른쪽 줄기를 뺀 빈 폭의 가운데를 기준으로 좌우에 벨 하나씩
  const stem = (Math.min(SC.W * 0.22, 86) + 14) / SC.W,
    free = 1 - 2 * stem; // 빈 영역 오른쪽 끝 (-1~1)
  const rad = clamp(0.27 * hx, 0.09, 0.125) / hx; // 벨 반지름 (화면 반폭 대비): 넓은 화면에서는 너무 커지지 않게
  const cx = (free - 1) / 2,
    sep = Math.min(0.42, (free + 1) / 2 - rad - 0.02);
  const c = {
    x1: cx + sep,
    x2: cx - sep,
    y: -0.54,
    lean: 16,
    rad,
    pitch: 0.72,
    scale: 0.9,
    minZ: 0.36
  };
  Object.assign(c, T);
  const out = {};
  for (const [k, sx, sign] of [['h1', c.x1, 1], ['h2', c.x2, -1]]) {
    const r = 0.062 * c.scale; // 벨 반지름
    const z = Math.max(c.minZ || 0.3, r / (c.rad * hx)); // 벨까지 거리
    const B = V3(sx * hx * z, c.y * hy * z, -z);
    // 화면에서 바깥으로 lean도 기울어 보이게 하는 좌우 방향 (원근 때문에 실제로는 더 크게 벌려야 함)
    const p = c.pitch,
      dy = Math.sin(p),
      tl = Math.tan(c.lean * Math.PI / 180) * sign;
    // d = (dx, dy, -dz), dx² + dz² = cos²p.  기울기 조건: dx·z - Bx·dz = tl·(dy·z - By·dz)
    let best = 0,
      be = 1e9;
    for (let a = -1.3; a <= 1.3; a += 0.005) {
      const dx = Math.sin(a) * Math.cos(p),
        dz = Math.cos(a) * Math.cos(p);
      const e = Math.abs(dx * z - B.x * dz - tl * (dy * z - B.y * dz));
      if (e < be) {
        be = e;
        best = a;
      }
    }
    const yaw = -best; // 내 기준: +면 왼쪽
    const d = V3(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    out[k] = {
      m: B.clone().addScaledVector(d, -L * c.scale),
      yaw,
      pitch: p,
      s: c.scale,
      bell: B
    };
  }
  return out;
}
const _md = new THREE.Vector3();

function updateMe(dt, t) {
  if (!ME.horn || !ME.pose) return;
  const playing = TP.blowing ? 1 : 0;
  ME.lift = damp(ME.lift, playing, playing ? 10 : 4, dt);
  const hi = TP.cur ? clamp((TP.cur - 66) / 20, -0.4, 1) : 0;
  ME.pitchLift = damp(ME.pitchLift, playing ? hi : 0, 5, dt);
  const fing = TP.blowing && TP.cur ? fingeringFor(TP.curF) : 0;
  const v = ME.horn.userData.valves || [];
  for (let i = 0; i < 3; i++) {
    ME.press[i] = damp(ME.press[i], (fing >> i) & 1, 30, dt);
    if (v[i]) {
      if (v[i].userData.y0 == null) v[i].userData.y0 = v[i].position.y;
      v[i].position.y = v[i].userData.y0 - ME.press[i] * 0.013;
    }
    if (ME.fingers[i]) ME.fingers[i].rotation.z = ME.press[i] * 0.2;
  }
  const P = ME.pose;
  const br = TP.blowing ? Math.sin(t * 2.4) * 0.0015 : Math.sin(t * 1.3) * 0.003;
  const ph = P.pitch + ME.lift * 0.05 + ME.pitchLift * 0.06,
    yw = P.yaw;
  _md.set(-Math.sin(yw) * Math.cos(ph), Math.sin(ph), -Math.cos(yw) * Math.cos(ph));
  const bell = V3(P.bell.x, P.bell.y + br + ME.lift * 0.012 + ME.pitchLift * 0.012, P.bell.z);
  // 입 위치(마우스피스)는 그대로 두고 방향만 벌림: 필살기 때 1번은 오른쪽, 2번은 왼쪽으로 V자
  const sk = smooth01(SPX.k);
  const mouth = bell.clone().addScaledVector(_md, -ME.len * P.scale);
  // 공연 전: 트럼펫은 아래에 숨어 있다가 마우스피스를 끼우며 올라옴
  const ik = smooth01(ME.introK);
  ME.hold.visible = ik > 0.01;
  ME.hold.position.copy(mouth).add(_mv.set(0, -0.42 * (1 - ik), 0.08 * (1 - ik)));
  // 두 대를 들면: 1번은 오른쪽, 2번은 왼쪽으로 기울여 V자 (자세는 doublePose가 화면 폭에 맞춰 계산)
  const D = ME.dbl,
    lf = (ME.lift * 0.05 + ME.pitchLift * 0.06) * 0.6,
    bob = br + ME.lift * 0.008;
  const y1 = lerp(yw, D.h1.yaw, sk),
    p1 = lerp(ph, D.h1.pitch + lf, sk);
  if (sk > 0.0005) ME.hold.position.lerp(_mv.copy(D.h1.m).setY(D.h1.m.y + bob), sk);
  ME.hold.quaternion.setFromUnitVectors(ME.axis, _md2.set(-Math.sin(y1) * Math.cos(p1), Math.sin(p1), -Math.cos(y1) * Math.cos(p1)));
  ME.hold.scale.setScalar(lerp(P.scale, D.h1.s, sk));
  if (ME.LH) {
    ME.LH.position.y = -0.24 * sk;
    ME.LH.visible = sk < 0.55;
  }
  if (ME.hold2) {
    ME.hold2.visible = sk > 0.01;
    if (ME.hold2.visible) {
      const y2 = D.h2.yaw,
        ph2 = D.h2.pitch + lf;
      ME.hold2.position.copy(D.h2.m).add(_mv.set(-0.08 * (1 - sk), -0.36 * (1 - sk) + bob, 0.05 * (1 - sk)));
      ME.hold2.quaternion.setFromUnitVectors(ME.axis2, _md2.set(-Math.sin(y2) * Math.cos(ph2), Math.sin(ph2), -Math.cos(y2) * Math.cos(ph2)));
      ME.hold2.scale.setScalar(D.h2.s);
      const f2 = SPX.voice2 && SPX.harm != null ? fingeringFor(SPX.harm) : 0,
        v2 = ME.horn2.userData.valves || [];
      for (let i = 0; i < 3; i++) {
        ME.press2[i] = damp(ME.press2[i], (f2 >> i) & 1, 30, dt);
        if (v2[i]) {
          if (v2[i].userData.y0 == null) v2[i].userData.y0 = v2[i].position.y;
          v2[i].position.y = v2[i].userData.y0 - ME.press2[i] * 0.013;
        }
        if (ME.fingers2[i]) ME.fingers2[i].rotation.z = ME.press2[i] * 0.2;
      }
    }
  }
  // 공연이 끝나면 트럼펫은 아래로 내려 둠 (사인하는 동안)
  if (FIN.away > 0.001) {
    const k = smooth01(FIN.away);
    ME.hold.position.y -= 0.7 * k;
    ME.hold.position.z += 0.1 * k;
    if (k > 0.97) ME.hold.visible = false;
    if (ME.hold2) ME.hold2.visible = false;
  }
  if (FIGHT.on && ME.fightHand) {
    const age = Math.max(0, t - FIGHT.t0);
    const d = 0.62, hy = Math.tan(SC.vmCam.fov * Math.PI / 360) * d;
    const hx = hy * SC.vmCam.aspect;
    const enter = smooth01(age / 0.45);
    // starts dropping at 1.0s, fully down by 1.35s
    const exit = smooth01(Math.min(1, Math.max(0, (age - 1.0) / 0.35)));

    ME.hold.visible = false;
    if (ME.hold2) ME.hold2.visible = false;
    if (ME.mpRig) ME.mpRig.visible = false;

    if (exit >= 1) {
      ME.fightHand.visible = false;
    } else {
      ME.fightHand.visible = true;
      ME.fightHand.position.set(hx * 0.22 + (1 - enter) * hx * 0.75, -hy * 0.02 - (1 - enter) * hy * 1.1 - exit * hy * 1.1, -d);
      ME.fightHand.scale.setScalar(0.78);
      ME.fightHand.rotation.set(0, 0, -0.16);
    }
  } else if (ME.fightHand) ME.fightHand.visible = false;
  if (ME.mpRig) {
    ME.mpRig.visible = ik < 0.6;
    if (ME.mpRig.visible) {
      ME.buzz = damp(ME.buzz, PRE.buzz ? 1 : 0, 18, dt);
      const j = ME.buzz * 0.0016;
      const M = ME.mpPose;
      ME.mpRig.position.set(M.p.x + Math.sin(t * 157) * j, M.p.y - ik * 0.5 + Math.sin(t * 131) * j + (1 - ME.buzz) * Math.sin(t * 1.3) * 0.004, M.p.z + ME.buzz * 0.03);
      ME.mpRig.rotation.set(0.5 - ME.buzz * 0.1, 0.22, 0.12, 'YXZ');
      ME.mpRig.scale.setScalar(M.s);
    }
  }
}
const _mv = new THREE.Vector3(), _md2 = new THREE.Vector3();

// ===== 90_main.js =====
// ===================== 장면 · 시작 · 루프 =====================
const SC = {
  renderer: null,
  scene: null,
  camera: null,
  effect: null,
  vmScene: null,
  vmCam: null,
  W: 1,
  H: 1,
  portrait: true
};
const GAME = {
  state: 'title',
  phase: 'title'
};
let VENUE = null;

function initScene() {
  const canvas = document.getElementById('scene');
  const dpr = window.devicePixelRatio || 1;
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(dpr, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  SC.renderer = renderer;
  initStyle(renderer);
  initPeopleMaterials();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f6e2c0');
  SC.scene = scene;
  SC.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 80);
  scene.add(SC.camera);
  SC.effect = new OutlineEffect(renderer, {
    defaultThickness: 0.006,
    defaultColor: STYLE.outlineColor,
    defaultAlpha: 1,
    defaultKeepAlive: true
  });
  // 1인칭 트럼펫은 따로 그림 (화면 비율이 바뀌어도 모양 유지)
  SC.vmScene = new THREE.Scene();
  SC.vmCam = new THREE.PerspectiveCamera(42, 1, 0.01, 5);
  SC.vmScene.add(new THREE.HemisphereLight('#fff4e0', '#c98a52', 1.6));
  const vs = new THREE.DirectionalLight('#ffe2b8', 2.6);
  vs.position.set(-1.5, 2.5, 1.5);
  SC.vmScene.add(vs);
  const vf = new THREE.DirectionalLight('#d6e6ff', 0.8);
  vf.position.set(1.5, 0.6, 2);
  SC.vmScene.add(vf);
  onResize();
  window.addEventListener('resize', onResize);
}

function onResize() {
  PERF.skipNext = true;
  UI.inputRect = null;
  if (UI.fingerPos != null) UI.fingerDirty = true;
  const w = window.innerWidth, h = window.innerHeight;
  SC.W = w;
  SC.H = h;
  SC.portrait = h > w;
  SC.renderer.setSize(w, h, false);
  const asp = w / h;
  // 세로 화면: 가로 시야를 넓게 잡아 밴드 양끝이 들어오게
  const hfov = SC.portrait ? 58 : 82;
  let vfov = 2 * Math.atan(Math.tan(hfov * Math.PI / 360) / asp) * 180 / Math.PI;
  vfov = clamp(vfov, 46, SC.portrait ? 80 : 88);
  SC.camera.fov = vfov;
  SC.baseFov = vfov;
  SC.camera.aspect = asp;
  SC.camera.updateProjectionMatrix();
  SC.vmCam.fov = vfov;
  SC.vmCam.aspect = asp;
  SC.vmCam.updateProjectionMatrix();
  if (FIN.on) finLayout();
  aimCamera();
  if (ME.rig) placeMe();
}

function aimCamera() {
  const e = LAYOUT.eye, l = LAYOUT.look;
  SC.camera.position.set(e[0], e[1], e[2]);
  // 세로 화면은 오른쪽 줄기가 가리는 만큼 시선을 살짝 오른쪽으로 (무대 가운데가 화면 왼쪽 빈 곳에 오게)
  SC.camera.lookAt(l[0] + (SC.portrait ? 0.85 : 0.3), SC.portrait ? l[1] - 0.85 : l[1], l[2]);
  // 공연이 끝난 뒤: 단 앞으로 다가가 팬들과 내민 물건을 내려다봄
  const k = smooth01(FIN.camK);
  if (k > 0.0005 && FIN.lay) {
    SC.camera.position.lerp(FIN.lay.eye, k);
    SC.camera.quaternion.slerp(FIN.lay.q, k);
  }
  if (FIGHT.on) {
    const fall = smooth01((NOW.t - FIGHT.t0 - 1.55) / 1.45);
    FIGHT.fall = fall; SC.camera.position.y -= fall * 1.28; SC.camera.position.z += fall * 0.35;
    SC.camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(fall * 0.32, 0, -fall * 1.22, "XYZ")));
  }
}

// ---------- 시작 ----------
function boot() {
  const bootT0 = performance.now();
  initScene();
  perfRestore();
  VENUE = buildVenue(SC.scene);
  setupBand(SC.scene);
  setupCrowd(SC.scene);
  setupMe();
  setupMeteor();
  bigInit();
  initUI();
  warmSetup();
  SC.renderer.shadowMap.needsUpdate = true;
  if (AE.at) {
    AE.at.boot0 = bootT0;
    AE.at.boot1 = performance.now();
  }
  requestAnimationFrame(loop);
}

function frame(dt) {
  const t = NOW.t;
  const audible = AE.ctx ? AE.ctx.currentTime - (AE.ctx.outputLatency || 0) : 0;
  if (MUS.running && AE.ctx) {
    processVQ(audible);
    trumpetTick();
  }
  const beat = MUS.running && AE.ctx ? beatAt(audible) : t * 2;
  if (AE.ctx) {
    const nowA = AE.ctx.currentTime;
    spUpdate(dt);
    ruleTick(nowA);
    endlessTick(nowA);
    missTick(dt, nowA);
  }
  preTick();
  itlTick();
  reactUpdate(dt, t);
  finTick(dt, t);
  directorUpdate(dt, t, audible, beat);
  crowdUpdate(dt, t, beat);
  meteorUpdate(dt, t);
  hypeUpdate(dt, t, beat);
  updateWindowFaces(dt, t, beat);
  fxUpdate(dt);
  updateMe(dt, t);
  if (VENUE) {
    if (VENUE.setMood) VENUE.setMood(REACT.frenzy, t);
    if (VENUE.update) VENUE.update(dt, t);
  }
  uiTick();
  vjobTick();
}

function render() {
  const R = SC.renderer;
  if (WARM.draw) warmDraw();
  R.clear();
  NOW.frame++;
  if (NOW.frame % PERF.shadowEvery === 1 || PERF.shadowEvery === 1) R.shadowMap.needsUpdate = true;
  PEOPLE.drawing = true;
  try {
    SC.effect.render(SC.scene, SC.camera);
    R.clearDepth();
    SC.effect.render(SC.vmScene, SC.vmCam);
  } finally { PEOPLE.drawing = false; }
}
// ---------- 미리 만들어 두기 ----------
// 공연 도중 처음 만들거나 처음 그리면 그 순간 화면이 멈칫하는 것들을 첫 화면에서 조금씩 만들어 둠:
// 뒤늦게 오는 구경꾼, 소품 모양, 던지는 꽃, 점수판 글자, 사인받을 물건. 다 만들면 숨겨 둔 것까지 한 번 그려서 셰이더·버퍼·텍스처를 미리 올림.
// (첫 화면에서 다 못 끝냈으면 공연 전 정적 동안 이어서 함. 그래도 안 된 것은 전처럼 필요할 때 만듦)
const WARM = {
  q: [],
  draw: false,
  done: false
};

function warmAdd(fn) {
  WARM.q.push(fn);
}

function warmTick(budget) {
  const t0 = performance.now();
  do {
    const fn = WARM.q.shift();
    try {
      fn();
    } catch (e) { console.error('warm', e); }
  } while (WARM.q.length && performance.now() - t0 < budget);
}

function warmSetup() {
  for (const k of ['phone', 'cup', 'popper', 'card', 'soul', 'pad', 'cloth']) warmAdd(() => crowdPropTemplate(k));
  warmAdd(() => tossWarm(10));
  warmAdd(() => {
    const go = () => {
      for (const t of ['10', '11', '100']) SC.renderer.initTexture(cardTex(t));
    };
    if (document.fonts && document.fonts.status !== 'loaded' && document.fonts.ready) document.fonts.ready.then(go);
    else go();
  });
  for (let i = 0; i < WINP.slots.length; i++) warmAdd(() => windowPerson(i));
  for (let i = 0; i < BACKP.spots.length; i++) warmAdd(() => backPerson(i));
  for (let i = 0; i < 7; i++) warmAdd(finBuildStep);
  for (const m of CROWD.list) warmAdd(() => faceTintPrep(m.p));
  warmAdd(() => WARM.draw = true);
}
// 숨겨 둔 것·화면 밖에 있는 것까지 전부 한 번 그림 (바로 뒤에 정상 화면을 다시 그리므로 눈에는 안 보임)
function warmDraw() {
  WARM.draw = false;
  WARM.done = true;
  const R = SC.renderer,
    hidden = [],
    culled = [];
  for (const sc of [SC.scene, SC.vmScene]) sc.traverse(o => {
    if (o.isLight) return;
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
    if (o.frustumCulled && (o.isMesh || o.isPoints || o.isSprite || o.isLine)) {
      culled.push(o);
      o.frustumCulled = false;
    }
  });
  for (const p of PEOPLE.all) {
    p.dirty = true;
    p.skDirty = true;
  }
  try {
    R.shadowMap.needsUpdate = true;
    R.clear();
    SC.effect.render(SC.scene, SC.camera);
    R.clearDepth();
    SC.effect.render(SC.vmScene, SC.vmCam);
  } catch (e) { console.error('warm draw', e); }
  for (const o of hidden) o.visible = false;
  for (const o of culled) o.frustumCulled = true;
  R.shadowMap.needsUpdate = true;
}
// 느린 기기: 몇 초 재 보고 해상도·그림자 갱신을 단계적으로 낮춤 (올리지는 않음)
const PERF = {
  acc: 0,
  n: 0,
  stalls: 0,
  level: 0,
  shadowEvery: 2,
  skipNext: false
};
document.addEventListener('visibilitychange', () => PERF.skipNext = true);

function perfTick(rawDt) {
  if (GAME.state !== 'play' || document.hidden || rawDt <= 0 || PERF.skipNext) {
    PERF.acc = 0;
    PERF.n = 0;
    PERF.stalls = 0;
    PERF.skipNext = false;
    return;
  }
  // 긴 멈춤도 포함하되 한 번의 탭 복귀·창 크기 변경으로 품질을 낮추지 않는다.
  PERF.acc += Math.min(rawDt, 1);
  PERF.n++;
  if (rawDt > 0.1) PERF.stalls++;
  if (PERF.acc < 3) return;
  const avg = PERF.acc / PERF.n,
    stalls = PERF.stalls;
  PERF.acc = 0;
  PERF.n = 0;
  PERF.stalls = 0;
  if ((avg > 0.026 || stalls >= 3) && PERF.level < 3) {
    PERF.level = Math.min(3, PERF.level + (avg > 0.045 ? 2 : 1));
    perfApply();
    try {
      sessionStorage.setItem('egotrip.perf', String(PERF.level));
    } catch { }
  }
}

function perfApply() {
  const dpr = window.devicePixelRatio || 1;
  SC.renderer.setPixelRatio(Math.min(dpr, [1.75, 1.4, 1.15, 1][PERF.level]));
  SC.renderer.setSize(SC.W, SC.H, false);
  PERF.shadowEvery = [2, 3, 5, 8][PERF.level];
}
// 이 탭에서 앞서 낮춰 둔 단계가 있으면 그 단계에서 시작
function perfRestore() {
  try {
    const lv = Math.round(+sessionStorage.getItem('egotrip.perf'));
    if (lv >= 1 && lv <= 3) {
      PERF.level = lv;
      perfApply();
    }
  } catch { }
}

function tick(draw) {
  const n = performance.now();
  let dt = (n - (NOW.last || n)) / 1000;
  NOW.last = n;
  if (draw) perfTick(dt);
  dt = clamp(dt, 0, 0.1);
  if (GAME.state === 'paused') dt = 0;
  NOW.dt = dt;
  NOW.t += dt;
  // 첫 화면에서는 한 프레임에 16ms씩(이미 시작을 눌러 기다리는 중이면 40ms씩) 미리 만들기에 씀. 공연 중으로 넘어온 뒤라면 3ms씩만
  if (WARM.q.length) {
    warmTick(GAME.phase === 'title' ? (UI.wantStart ? 40 : 16) : 3);
    if (!WARM.q.length && UI.wantStart && AE.decoded && !UI.playing) startGame();
  }
  try {
    frame(dt);
  } catch (err) {
    if (!tick.errs) tick.errs = 0;
    if (tick.errs++ < 5) console.error(err);
  }
  if (draw) render();
}

function loop() {
  requestAnimationFrame(loop);
  tick(true);
}

// 무대 만들기(본 화면이 1초~몇 초 멈춤)에 들어가기 전에 소리 쪽 일을 먼저 출발시킴.
// 워커는 본 화면이 쉬어야 뜨므로, 워커가 떴다는 신호를 받고 나서(안 오면 0.4초 뒤) 무대를 만듦.
function bootSoon() {
  let ran = false;
  const go = () => {
    if (ran) return;
    ran = true;
    boot();
    if (AE.synWatch) AE.synWatch();
  };
  try {
    synthBegin(() => setTimeout(go, 0));
    if (window.JAZZ_AUDIO) packBegin();
  } catch (e) { console.error(e); }
  setTimeout(go, 400);
}
bootSoon();