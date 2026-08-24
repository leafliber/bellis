//#region src/lanes/audio/pcm-scene-buffer.ts
var e = class {
	#e;
	#t;
	#n = /* @__PURE__ */ new Map();
	#r = null;
	#i = 0;
	constructor(e = {}) {
		this.#t = e.sampleRateHz ?? 48e3;
		let t = e.maxBufferedUs ?? 2000000n;
		this.#e = Number(t * BigInt(this.#t) / 1000000n);
	}
	get activeScene() {
		return this.#r;
	}
	get droppedScenes() {
		return this.#i;
	}
	appendFrame(e, t) {
		let n = this.#n.get(e);
		return n === void 0 && (n = {
			samples: new Int16Array(this.#e),
			written: 0,
			read: 0,
			underruns: 0,
			fading: !1,
			fadeRemaining: 0,
			fadeTotal: 0
		}, this.#n.set(e, n)), n.written + t.length > n.samples.length ? !1 : (n.samples.set(t, n.written), n.written += t.length, !0);
	}
	switchScene(e) {
		this.#r = e;
	}
	bufferedUs(e) {
		let t = this.#n.get(e);
		return t === void 0 ? 0n : BigInt(Math.floor((t.written - t.read) / this.#t * 1e6));
	}
	underrunCount(e) {
		return this.#n.get(e)?.underruns ?? 0;
	}
	pull(e, t) {
		let n = this.#r;
		if (n === null) return e.fill(0, 0, t), t;
		let r = this.#n.get(n);
		if (r === void 0) return e.fill(0, 0, t), t;
		let i = 0;
		for (; i < t;) {
			let n = r.written - r.read;
			if (n <= 0) return e.fill(0, i, t), r.underruns += 1, t;
			let a = Math.min(t - i, n), o = r.samples.subarray(r.read, r.read + a);
			if (r.fading && r.fadeRemaining > 0) for (let t = 0; t < a; t += 1) {
				let n = Math.min(1, r.fadeRemaining / r.fadeTotal);
				e[i + t] = Math.round((o[t] ?? 0) * n), --r.fadeRemaining;
			}
			else if (r.fading) return e.fill(0, i, t), t;
			else e.set(o, i);
			r.read += a, i += a;
		}
		return i;
	}
	cancelScene(e, t = 480) {
		let n = this.#n.get(e);
		n !== void 0 && (n.fading = !0, n.fadeRemaining = Math.min(t, n.written - n.read), n.fadeTotal = Math.max(1, n.fadeRemaining), n.fadeRemaining <= 0 && (this.#n.delete(e), this.#i += 1, this.#r === e && (this.#r = null)));
	}
	releaseScene(e) {
		this.#n.delete(e) && (this.#i += 1), this.#r === e && (this.#r = null);
	}
}, t = 1, n = { buffer: new e({
	maxBufferedUs: 2000000n,
	sampleRateHz: 48e3
}) }, r = class extends AudioWorkletProcessorBase {
	#e = 0;
	constructor() {
		super(), this.port.onmessage = (e) => {
			let r = e.data;
			if (r.v !== t) {
				this.port.postMessage({
					v: t,
					op: "error",
					code: "unsupported_version"
				});
				return;
			}
			switch (r.op) {
				case "frame":
					typeof r.sceneId == "string" && r.samples instanceof Int16Array && (i.add(r.sceneId), n.buffer.appendFrame(r.sceneId, r.samples) || this.port.postMessage({
						v: t,
						op: "error",
						code: "buffer_full"
					}));
					break;
				case "switch":
					typeof r.sceneId == "string" && n.buffer.switchScene(r.sceneId);
					break;
				case "cancel":
					typeof r.sceneId == "string" && n.buffer.cancelScene(r.sceneId);
					break;
				case "clear":
					for (let e of i) n.buffer.releaseScene(e);
					i.clear();
					break;
				default: this.port.postMessage({
					v: t,
					op: "error",
					code: "unknown_op"
				});
			}
		};
	}
	process(e, r) {
		let i = r[0]?.[0];
		if (i === void 0) return !0;
		let a = i.length, o = new Int16Array(a);
		n.buffer.pull(o, a);
		for (let e = 0; e < a; e += 1) i[e] = (o[e] ?? 0) / 32768;
		let s = n.buffer.activeScene;
		if (s !== null) {
			let e = n.buffer.underrunCount(s);
			e > this.#e && (this.#e = e, this.port.postMessage({
				v: t,
				op: "stats",
				underruns: e,
				activeScene: s
			}));
		}
		return !0;
	}
}, i = /* @__PURE__ */ new Set();
registerProcessor("bellis-pcm-scene", r);
//#endregion
