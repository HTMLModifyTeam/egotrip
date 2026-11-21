import { rateFor } from '../utils/Math.js';
import { rand } from '../utils/Random.js';
import { dynGain, dynCut } from '../utils/Sound.js';
import { trackBandVoice } from '../audio/BandVoice.js';

const TC = 2.5; // 'time'(대략 도달 시간) → setTargetAtTime 시정수 변환 계수

export default class SusVoice {
  constructor(audio, sample, midi, when, dest, o = {}) {
    const ctx = audio;
    this.s = sample;
    this.midi = midi;
    this.dest = dest;

    const src = ctx.createBufferSource();
    src.buffer = sample.buf;
    if (sample.ls != null) {
      src.loop = true;
      src.loopStart = sample.ls;
      src.loopEnd = sample.le;
    }

    // 음높이 (스쿱: 위/아래에서 미끄러져 들어오기)
    this.rate = rateFor(sample, midi);
    if (o.scoop) {
      src.playbackRate.setValueAtTime(this.rate * Math.pow(2, o.scoop / 12), when);
      src.playbackRate.setTargetAtTime(this.rate, when, (o.scoopTime || 0.03) / TC);
    } else src.playbackRate.setValueAtTime(this.rate, when);

    // 음량 (fadeIn: 0을 직접 지정해도 존중)
    const lvl = o.level ?? 1;
    const fi = o.fadeIn ?? 0.004;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(lvl, when + Math.max(fi, 0.001));

    // 비브라토
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibRate || rand(5.0, 5.8);
    const lg = ctx.createGain();
    lg.gain.value = 0;
    lfo.connect(lg);
    lg.connect(src.playbackRate);

    // 연결: src → (filter) → g → dest
    let tail = src;
    if (o.filter) {
      tail.connect(o.filter);
      tail = o.filterOut || o.filter;
    }
    tail.connect(g);
    g.connect(dest);

    // 시작 위치: 음수가 되지 않게
    const end = sample.le ?? sample.buf.duration;
    const off = o.offset ?? sample.start ?? 0;
    src.start(when, Math.max(0, Math.min(off, end - 0.05)));
    lfo.start(when);
    trackBandVoice(src, g, dest, lfo);

    Object.assign(this, {
      src,
      g,
      lfo,
      lg,
      // setDyn/stepTo가 쓰는 필터 (예전엔 한 번도 대입되지 않아 셈여림에 따른 음색 변화가 안 먹었음)
      f: o.filter && o.filter.frequency ? o.filter : null,
      t0: when,
      level: lvl,
      dead: false,
      ended: false
    });

    src.onended = () => {
      this.dead = true;
      this.ended = true;
      try { lfo.stop(); } catch { }
      try { tail.disconnect(g); } catch { }
      src.disconnect();
      g.disconnect();
      lfo.disconnect();
      lg.disconnect();
    };
  }

  glideTo(midi, when, time = 0.03) {
    if (this.dead) return;
    this.midi = midi;
    this.rate = rateFor(this.s, midi);
    const p = this.src.playbackRate;
    p.cancelScheduledValues(when);
    p.setTargetAtTime(this.rate, when, Math.max(0.004, time / TC));
  }

  // 밸브 바꾸듯 또렷하게: 음높이는 곧바로, 소리는 아주 잠깐 눌렸다가 다시 (d를 주면 셈여림도 같이)
  stepTo(midi, when, d) {
    if (this.ended) return;
    this.midi = midi;
    this.rate = rateFor(this.s, midi);
    const p = this.src.playbackRate;
    p.cancelScheduledValues(when);
    p.setTargetAtTime(this.rate, when, 0.0022);
    if (this.dead) return;
    const lvl = d != null ? dynGain(midi, d) : this.level;
    this.level = lvl;
    const g = this.g.gain;
    g.setTargetAtTime(lvl * 0.7, Math.max(this.t0 + 0.012, when - 0.006), 0.0028);
    g.setTargetAtTime(lvl, when + 0.007, 0.009);
    if (this.f && d != null) {
      this.f.frequency.setTargetAtTime(dynCut(d), when, 0.008);
      this.d = d;
    }
  }

  setDyn(d, when, time = 0.03) {
    if (this.dead) return;
    const lvl = dynGain(this.midi, d);
    this.level = lvl;
    this.d = d;
    this.g.gain.setTargetAtTime(lvl, when, time / TC);
    if (this.f) this.f.frequency.setTargetAtTime(dynCut(d), when, time / TC);
  }

  bend(semis, when, time) {
    if (this.dead) return;
    const p = this.src.playbackRate;
    p.cancelScheduledValues(when);
    p.setValueAtTime(this.rate, when);
    p.exponentialRampToValueAtTime(this.rate * Math.pow(2, semis / 12), when + time);
  }

  vibrato(depthCents, when, ramp = 0.35) {
    if (this.dead) return;
    const d = this.rate * (Math.pow(2, depthCents / 1200) - 1);
    this.lg.gain.cancelScheduledValues(when);
    this.lg.gain.setTargetAtTime(d, when, ramp);
  }

  setLevel(v, when, time = 0.03) {
    if (this.dead) return;
    this.level = v;
    this.g.gain.cancelScheduledValues(when);
    this.g.gain.setTargetAtTime(v, when, time / TC);
  }

  release(when, time = 0.06) {
    if (this.dead) return;
    this.dead = true;
    const g = this.g.gain;

    // 아직 소리가 나기 전이면 아예 취소 (늦게 튀어나오는 소리 없음)
    if (when <= this.t0) {
      g.cancelScheduledValues(0);
      g.setValueAtTime(0, this.t0);
      try {
        this.src.stop(this.t0);
        this.lfo.stop(this.t0 + 0.01);
      } catch { }
      return;
    }

    // 그 시점의 실제 값에서 이어서 내려가기 (지원되면 정확히, 아니면 근사)
    let held = false;
    if (typeof g.cancelAndHoldAtTime === "function") {
      try {
        g.cancelAndHoldAtTime(when);
        held = true;
      } catch { }
    }
    if (!held) {
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(when);
      else {
        const value = g.value;
        g.cancelScheduledValues(when);
        g.setValueAtTime(value, when);
      }
    }
    g.setTargetAtTime(0, when, time / 3);
    try {
      this.src.stop(when + time * 3 + 0.05);
      this.lfo.stop(when + time * 3 + 0.05);
    } catch { }
  }
}