import { MathUtils } from "three";

export const rateFor = (s, midi, cents = 0) => Math.pow(2, (midi - s.m) / 12 + ((s.c || 0) + cents) / 1200);
export const clamp = MathUtils.clamp;

// 프레임 독립 감쇠 보간
export const damp = MathUtils.damp;
export const dampAngle = (cur, target, rate, dt) => {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-rate * dt));
}

export const lerp = MathUtils.lerp;
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const mod12 = x => ((x % 12) + 12) % 12;

export const smooth01 = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export const smoothstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  return smooth01((x - a) / (b - a));
}