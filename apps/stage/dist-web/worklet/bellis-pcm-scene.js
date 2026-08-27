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
			fadeTotal: 0,
			ended: !1,
			endedNotified: !1
		}, this.#n.set(e, n)), n.written + t.length > n.samples.length || n.ended ? !1 : (n.samples.set(t, n.written), n.written += t.length, !0);
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
			let a = r.written - r.read;
			if (a <= 0) return e.fill(0, i, t), r.ended ? this.#o(r, n) : r.underruns += 1, t;
			let o = Math.min(t - i, a), s = r.samples.subarray(r.read, r.read + o);
			if (r.fading && r.fadeRemaining > 0) for (let t = 0; t < o; t += 1) {
				let n = Math.min(1, r.fadeRemaining / r.fadeTotal);
				e[i + t] = Math.round((s[t] ?? 0) * n), --r.fadeRemaining;
			}
			else if (r.fading) return e.fill(0, i, t), t;
			else e.set(s, i);
			r.read += o, i += o, r.read >= r.written && r.ended && this.#o(r, n);
		}
		return i;
	}
	endScene(e) {
		let t = this.#n.get(e);
		return t === void 0 || (t.ended = !0, t.read >= t.written && (this.#o(t, e), !0));
	}
	drainEndedScenes() {
		return this.#a.splice(0, this.#a.length);
	}
	#a = [];
	#o(e, t) {
		e.endedNotified || (e.endedNotified = !0, this.#a.push(t));
	}
	cancelScene(e, t = 480) {
		let n = this.#n.get(e);
		n !== void 0 && (n.fading = !0, n.fadeRemaining = Math.min(t, n.written - n.read), n.fadeTotal = Math.max(1, n.fadeRemaining), n.fadeRemaining <= 0 && (this.#n.delete(e), this.#i += 1, this.#r === e && (this.#r = null)));
	}
	releaseScene(e) {
		this.#n.delete(e) && (this.#i += 1), this.#r === e && (this.#r = null);
	}
}, t = globalThis.AudioWorkletProcessor, n = 1, r = { buffer: new e({
	maxBufferedUs: 2000000n,
	sampleRateHz: 48e3
}) }, i = class extends t {
	#e = 0;
	constructor() {
		super(), this.port.onmessage = (e) => {
			let t = e.data;
			if (t.v !== n) {
				this.port.postMessage({
					v: n,
					op: "error",
					code: "unsupported_version"
				});
				return;
			}
			switch (t.op) {
				case "frame":
					typeof t.sceneId == "string" && t.samples instanceof Int16Array && (a.add(t.sceneId), r.buffer.appendFrame(t.sceneId, t.samples) || this.port.postMessage({
						v: n,
						op: "error",
						code: "buffer_full"
					}));
					break;
				case "switch":
					typeof t.sceneId == "string" && r.buffer.switchScene(t.sceneId);
					break;
				case "end":
					typeof t.sceneId == "string" && (a.add(t.sceneId), r.buffer.endScene(t.sceneId) && this.port.postMessage({
						v: n,
						op: "ended",
						sceneId: t.sceneId
					}));
					break;
				case "cancel":
					typeof t.sceneId == "string" && r.buffer.cancelScene(t.sceneId);
					break;
				case "clear":
					for (let e of a) r.buffer.releaseScene(e);
					a.clear();
					break;
				default: this.port.postMessage({
					v: n,
					op: "error",
					code: "unknown_op"
				});
			}
		};
	}
	process(e, t) {
		let i = t[0]?.[0];
		if (i === void 0) return !0;
		let a = i.length, o = new Int16Array(a);
		r.buffer.pull(o, a);
		for (let e = 0; e < a; e += 1) i[e] = (o[e] ?? 0) / 32768;
		for (let e of r.buffer.drainEndedScenes()) this.port.postMessage({
			v: n,
			op: "ended",
			sceneId: e
		});
		let s = r.buffer.activeScene;
		if (s !== null) {
			let e = r.buffer.underrunCount(s);
			e > this.#e && (this.#e = e, this.port.postMessage({
				v: n,
				op: "stats",
				underruns: e,
				activeScene: s
			}));
		}
		return !0;
	}
}, a = /* @__PURE__ */ new Set();
registerProcessor("bellis-pcm-scene", i);
//#endregion
