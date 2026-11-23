import { QUAL } from "../data/harmony.js";
import { clamp, mod12 } from '../utils/Math.js';
import { pick, randi } from '../utils/Random.js';
import { chordAt } from '../utils/Sound.js';
import { nearestAllowed, nearestPC } from '../utils/Harmony.js';

const EPS = 1e-6;
const snapHalf = x => Math.round(x * 2) / 2; // 8분음표 격자로 맞춤

export default class Improviser {
  constructor(o = {}) {
    Object.assign(this, {
      lo: 52,
      hi: 72,
      busy: 0.6,
      last: null,
      dir: 1,
      left: 0,
      rest: 0,
      trip: 0.08,
      blue: false,
      longEnd: true,
      maxLeap: 7,
      motifProb: 0.3 // 앞 프레이즈의 모티프를 다시 쓸 확률
    }, o);
    // 사용자가 지정한 last는 존중하고, 없을 때만 음역 중앙에서 시작
    this.last = clamp(this.last == null ? Math.round((this.lo + this.hi) / 2) : this.last, this.lo, this.hi);
    this.motif = null;
    this.phraseN = 0;
    this._cur = [];      // 현재 프레이즈에서 기록 중인 {di, len}
    this._replay = null; // 모티프 재현 상태
    this._idx = 0;       // 프레이즈 내 음 순번
  }

  // 곡이 바뀔 때 등 상태 초기화
  reset() {
    this.left = 0;
    this.rest = 0;
    this.motif = null;
    this.phraseN = 0;
    this._cur = [];
    this._replay = null;
    this._idx = 0;
    this.last = Math.round((this.lo + this.hi) / 2);
  }

  // 마디 하나 분량 음표: [{pos, dur, m, v}]
  bar(b, energy = 0.5, from = 0, to = 4) {
    const out = [], straight = b.swing < 0.55;
    const busy = clamp(this.busy + energy * 0.3, 0.1, 1);
    const fast = 60 / b.spb > 190;
    let pos = from;

    while (pos < to - EPS) {
      const ch = chordAt(b, pos);

      // 쉬는 중
      if (this.rest > 0) {
        const r = Math.min(this.rest, to - pos);
        this.rest -= r;
        pos += r;
        continue;
      }

      // 새 프레이즈: 길이·방향·가끔 높은 곳에서 시작
      if (this.left <= 0) {
        if (this._cur.length >= 2) this.motif = this._cur.slice();
        this._cur = [];
        this._idx = 0;
        this._replay = this.motif && Math.random() < this.motifProb  ? { i: 0, steps: this.motif } : null;

        this.left = randi(4, Math.round(5 + busy * (fast ? 6 : 10)));
        if (Math.random() < 0.5) this.dir *= -1;
        this.phraseN++;
        if (Math.random() < 0.25 + energy * 0.3) this.last = clamp(this.last + this.dir * randi(3, 7), this.lo + 2, this.hi - 2);
        if (Math.abs(pos - Math.round(pos)) < EPS && Math.random() < 0.45) {
          pos += 0.5; // 엇박 시작
          continue;
        }
      }

      const prev = this.last;
      const onBeat = Math.abs(pos - Math.round(pos)) < EPS;
      let n, motifLen;
      const rp = this._replay;

      if (rp && this._idx > 0 && rp.i < rp.steps.length) {
        // 모티프 재현: 같은 간격·리듬으로 현재 코드에 맞춰 이조
        const s = rp.steps[rp.i++];
        n = nearestAllowed(this.last + s.di, ch, onBeat ? 'S' : 'W', Math.sign(s.di) || this.dir);
        motifLen = s.len;
      } else if (onBeat) {
        n = nearestAllowed(this.last + this.dir * randi(1, 3), ch, 'S', this.dir);
        if (Math.random() < 0.35) {
          // 가이드톤(3도·7도) 쪽으로
          const g = QUAL[ch.q].guide;
          const cand = [];
          for (let m = this.last - 5; m <= this.last + 5; m++)
            if (g.includes(mod12(m - ch.root))) cand.push(m);
          if (cand.length) n = pick(cand);
        }
      } else {
        if (Math.random() < 0.22) n = this.last + this.dir; // 반음 지나가기
        else n = nearestAllowed(this.last + this.dir * randi(1, 2), ch, 'W', this.dir);
        if (this.blue && Math.random() < 0.15) n = nearestPC(ch.root + pick([3, 6, 10]), this.last, this.lo, this.hi);
      }

      // 음역 끝에서 방향 전환
      if (n >= this.hi - 1) this.dir = -1;
      if (n <= this.lo + 1) this.dir = 1;
      if (!motifLen && Math.random() < 0.1) this.dir *= -1;

      // 도약 제한 후 음역 안으로
      if (Math.abs(n - this.last) > this.maxLeap) n = this.last + Math.sign(n - this.last) * this.maxLeap;
      n = clamp(n, this.lo, this.hi);

      let len = fast ? (Math.random() < 0.55 ? 1 : 0.5) : 0.5;
      this.left--;
      const phraseEnd = this.left <= 0;
      if (phraseEnd) {
        len = pick(this.longEnd ? [1, 1.5, 2] : [0.5, 1]);
        n = clamp(nearestAllowed(n, ch, 'S', this.dir), this.lo, this.hi);
        // 쉼은 항상 8분음표 격자에 맞춰 박자가 틀어지지 않게
        this.rest = Math.max(0.5, snapHalf(pick([1, 1.5, 2, 2.5, 3]) * (1.35 - busy)));
      } else if (motifLen) len = motifLen;
      else if (Math.random() < 0.12) len = 1;

      // 셋잇단 꾸밈 (프레이즈 끝음에는 적용하지 않음)
      if (!straight && onBeat && !phraseEnd && pos + 1 <= to + EPS && Math.random() < this.trip * busy) {
        const a = clamp(nearestAllowed(n + this.dir * 2, ch, 'W', this.dir), this.lo, this.hi);
        const c = clamp(n + this.dir, this.lo, this.hi);
        out.push({ pos, dur: 1 / 3, m: a, v: 0.85 }, { pos: pos + 1 / 3, dur: 1 / 3, m: c, v: 0.8 }, { pos: pos + 2 / 3, dur: 1 / 3, m: n, v: 0.9 });
        this.last = n;
        this._idx++;
        pos += 1;
        continue;
      }

      len = Math.min(len, to - pos);
      out.push({ pos, dur: len, m: n, v: onBeat ? 0.95 : 0.85 });

      // 모티프 후보 기록 (프레이즈 첫 음은 이전 프레이즈와의 간격이라 제외)
      if (this._idx > 0 && this._cur.length < 4) this._cur.push({ di: n - prev, len });
      this._idx++;

      this.last = n;
      pos += len;
    }
    return out;
  }
}