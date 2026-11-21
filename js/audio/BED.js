// Looping ambient beds (room, applause, roar, babble) with smooth gain control.
// Usage: const bed = new BED(AE); bed.start(); bed.set('applause', 0.4, 1);

const LAYERS = {
  //             buffer (ae.syn)  bus (ae.buses)  initial gain
  room:        ['room',        'room',  0.05],
  applause:    ['applause',    'crowd', 0],
  applauseBig: ['applauseBig', 'crowd', 0],
  roar:        ['roar',        'cheer', 0],
  babble:      ['babble',      'crowd', 0],
};

export default class BED {
  layers = {};

  constructor(ae) {
    this.ae = ae;
  }

  // Creates every layer that isn't running yet. Safe to call repeatedly,
  // so it can be retried if buffers weren't ready the first time.
  start() {
    const { ctx, syn, buses } = this.ae;
    if (!ctx) return false;

    for (const [name, [bufKey, busKey, gain]] of Object.entries(LAYERS)) {
      if (this.layers[name]) continue;

      const buf = syn?.[bufKey], dest = buses?.[busKey];
      if (!buf || !dest) {
        console.warn(`BED: "${name}" not ready (syn.${bufKey}: ${!!buf}, buses.${busKey}: ${!!dest})`);
        continue;
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(dest);
      src.start();

      this.layers[name] = { src, g, target: gain, tau: null };
    }
    return Object.keys(this.layers).length === Object.keys(LAYERS).length;
  }

  set(name, v, time = 0.6) {
    const b = this.layers[name], ctx = this.ae.ctx;
    if (!b || !ctx) return;

    const now = ctx.currentTime, tau = time / 3;
    if (Math.abs(v) < 0.0001) v = 0;
    if ((v === b.target || (v !== 0 && Math.abs(b.target - v) < 0.001)) && b.tau === tau) return;

    b.target = v;
    b.tau = tau;

    const gain = b.g.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else {
      const value = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(value, now);
    }
    gain.setTargetAtTime(v, now, tau);
  }

  stop() {
    for (const { src, g } of Object.values(this.layers)) {
      try { src.stop(); } catch {}
      src.disconnect();
      g.disconnect();
    }
    this.layers = {};
  }
}