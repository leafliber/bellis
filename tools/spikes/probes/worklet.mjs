class SilentProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
  }
  process(_inputs, outputs) {
    for (const channel of outputs[0]) channel.fill(0);
    this.frames += outputs[0][0].length;
    if (this.frames % 1280 === 0) this.port.postMessage({ frames: this.frames });
    return true;
  }
}
registerProcessor("silent-probe", SilentProbe);
