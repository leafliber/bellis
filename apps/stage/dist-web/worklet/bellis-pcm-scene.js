//#region src/lanes/audio/pcm-scene-buffer.ts
var e = class {
	#e;
	#t;
	#n = /* @__PURE__ */ new Map();
	#r = /* @__PURE__ */ new Set();
	#i = null;
	#a = 0;
	constructor(e = {}) {
		this.#t = e.sampleRateHz ?? 48e3;
		let t = e.maxBufferedUs ?? 2000000n;
		this.#e = Number(t * BigInt(this.#t) / 1000000n);
	}
	get activeScene() {
		return this.#i;
	}
	get droppedScenes() {
		return this.#a;
	}
	#o() {
		return {
			chunks: [],
			chunkOffset: 0,
			buffered: 0,
			underruns: 0,
			fading: !1,
			fadeRemaining: 0,
			fadeTotal: 0,
			ended: !1,
			endedNotified: !1
		};
	}
	appendFrame(e, t) {
		if (this.#r.has(e)) return !1;
		let n = this.#n.get(e);
		return n === void 0 && (n = this.#o(), this.#n.set(e, n)), n.ended || n.buffered + t.length > this.#e ? !1 : (n.chunks.push(t.slice()), n.buffered += t.length, !0);
	}
	switchScene(e) {
		this.#r.has(e) || (this.#i = e);
	}
	bufferedUs(e) {
		let t = this.#n.get(e);
		return t === void 0 ? 0n : BigInt(Math.floor(t.buffered / this.#t * 1e6));
	}
	underrunCount(e) {
		return this.#n.get(e)?.underruns ?? 0;
	}
	pull(e, t) {
		let n = this.#i;
		if (n === null) return e.fill(0, 0, t), t;
		let r = this.#n.get(n);
		if (r === void 0) return e.fill(0, 0, t), t;
		let i = 0;
		for (; i < t;) {
			if (r.buffered <= 0) return e.fill(0, i, t), r.ended ? this.#l(r, n) : r.underruns += 1, t;
			let a = r.chunks[0];
			if (a === void 0) return e.fill(0, i, t), r.ended || (r.underruns += 1), t;
			let o = a.length - r.chunkOffset, s = Math.min(t - i, o);
			if (r.fading && (s = Math.min(s, r.fadeRemaining)), r.fading && s > 0) for (let t = 0; t < s; t += 1) {
				let n = r.fadeRemaining / r.fadeTotal;
				e[i + t] = Math.round((a[r.chunkOffset + t] ?? 0) * n), --r.fadeRemaining;
			}
			else if (r.fading) return e.fill(0, i, t), this.#c(r, n), t;
			else e.set(a.subarray(r.chunkOffset, r.chunkOffset + s), i);
			if (r.chunkOffset += s, r.buffered -= s, i += s, r.chunkOffset >= a.length && (r.chunks.shift(), r.chunkOffset = 0), r.fading && r.fadeRemaining <= 0) return e.fill(0, i, t), this.#c(r, n), t;
			r.buffered <= 0 && r.ended && this.#l(r, n);
		}
		return i;
	}
	cancelScene(e, t = 480) {
		this.#r.add(e);
		let n = this.#n.get(e);
		if (n === void 0) {
			this.#i === e && (this.#i = null);
			return;
		}
		if (this.#i !== e || t <= 0 || n.buffered <= 0) {
			this.#c(n, e);
			return;
		}
		n.fading = !0, n.fadeRemaining = Math.min(t, n.buffered), n.fadeTotal = Math.max(1, n.fadeRemaining);
	}
	endScene(e) {
		if (this.#r.has(e)) return !0;
		let t = this.#n.get(e);
		return t === void 0 || (t.ended = !0, t.buffered <= 0 && (this.#l(t, e), !0));
	}
	drainEndedScenes() {
		return this.#s.splice(0, this.#s.length);
	}
	#s = [];
	releaseScene(e) {
		let t = this.#n.get(e);
		if (t !== void 0) {
			this.#c(t, e);
			return;
		}
		this.#i === e && (this.#i = null);
	}
	clearAll() {
		for (let [e, t] of this.#n) this.#c(t, e);
		this.#r.clear(), this.#i = null;
	}
	#c(e, t) {
		e.chunks = [], e.chunkOffset = 0, e.buffered = 0, this.#n.delete(t), this.#a += 1, this.#i === t && (this.#i = null);
	}
	#l(e, t) {
		e.endedNotified || (e.endedNotified = !0, this.#s.push(t));
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
					typeof t.sceneId == "string" && t.samples instanceof Int16Array && (r.buffer.appendFrame(t.sceneId, t.samples) || this.port.postMessage({
						v: n,
						op: "error",
						code: "buffer_full"
					}));
					break;
				case "switch":
					typeof t.sceneId == "string" && r.buffer.switchScene(t.sceneId);
					break;
				case "end":
					typeof t.sceneId == "string" && r.buffer.endScene(t.sceneId) && this.port.postMessage({
						v: n,
						op: "ended",
						sceneId: t.sceneId
					});
					break;
				case "cancel":
					typeof t.sceneId == "string" && r.buffer.cancelScene(t.sceneId);
					break;
				case "clear":
					r.buffer.clearAll();
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
		}), r.buffer.releaseScene(e);
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
};
registerProcessor("bellis-pcm-scene", i);
//#endregion
