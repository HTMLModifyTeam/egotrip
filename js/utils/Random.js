// 난수 유틸리티
// - 기본 함수(pick, wpick, rand, randi, shuffle)는 Math.random 사용 (매번 다름)
// - 마지막 인자로 seeded() 가 만든 rng를 넘기면 같은 시드 → 항상 같은 결과
//   예) const r = seeded("person-42"); pick(hairs, r); shuffle(list, r);

const defaultRng = Math.random;

/** 문자열 → 32bit 해시 (FNV-1a). 문자열 시드용. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** [min, max) 실수 */
export const rand = (min, max, rng = defaultRng) => min + rng() * (max - min);

/** [min, max] 정수 (양 끝 포함) */
export const randi = (min, max, rng = defaultRng) => {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(rng() * (hi - lo + 1));
};

/** 배열에서 하나 선택. 빈 배열이면 undefined. */
export const pick = (arr, rng = defaultRng) => arr.length ? arr[Math.floor(rng() * arr.length)] : undefined;

/**
 * 가중치 선택. opts = [[값, 가중치], ...]
 * 가중치가 0 이하이거나 숫자가 아닌 항목은 무시한다.
 */
export function wpick(opts, rng = defaultRng) {
  let total = 0;
  for (const [, w] of opts) if (w > 0) total += w;
  if (total <= 0) return undefined;

  let r = rng() * total;
  let last;
  for (const [value, w] of opts) {
    if (!(w > 0)) continue;
    last = value;
    r -= w;
    if (r < 0) return value;
  }
  return last; // 부동소수점 오차 대비
}

/** Fisher–Yates 셔플 (원본 배열을 직접 변경). */
export function shuffle(a, rng = defaultRng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 원본을 건드리지 않는 셔플. */
export const shuffled = (a, rng = defaultRng) => shuffle(a.slice(), rng);

/** 배열에서 중복 없이 n개 선택. */
export const sample = (arr, n, rng = defaultRng) => shuffled(arr, rng).slice(0, Math.max(0, n));

/**
 * 시드 고정 난수 생성기 (Mulberry32).
 * 숫자 또는 문자열 시드를 받는다.
 */
export function seeded(seed) {
  let s = (typeof seed === "string" ? hashString(seed) : seed) >>> 0;

  const f = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  f.range = (a, b) => rand(a, b, f);
  f.int = (a, b) => randi(a, b, f);
  f.pick = arr => pick(arr, f);
  f.wpick = opts => wpick(opts, f);
  f.chance = p => f() < p;
  f.shuffle = arr => shuffle(arr, f);
  f.shuffled = arr => shuffled(arr, f);
  f.sample = (arr, n) => sample(arr, n, f);
  /** 정규분포 (Box–Muller). 키, 체형 등 자연스러운 분포에 유용. */
  f.normal = (mean = 0, sd = 1) => {
    const u = 1 - f(); // (0, 1]
    const v = f();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  /** 같은 시드 상태에서 독립적으로 이어가고 싶을 때 하위 rng 생성. */
  f.fork = label => seeded((f() * 4294967296) ^ hashString(String(label)));

  return f;
}