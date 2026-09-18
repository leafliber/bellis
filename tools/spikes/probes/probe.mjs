const output = (result) => {
  document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
  return result;
};
const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
window.runPairingProbe = async () => {
  const opening = indexedDB.open("bellis-probe-only", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
  const db = await req(opening);
  let pair = await req(db.transaction("keys").objectStore("keys").get("pair"));
  const restored = !!pair;
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const transaction = db.transaction("keys", "readwrite");
    const committed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    transaction.objectStore("keys").put(pair, "pair");
    await committed;
  }
  let exportRejected = false;
  try {
    await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  } catch {
    exportRejected = true;
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    challenge,
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    signature,
    challenge,
  );
  const publicKey = await crypto.subtle.exportKey("spki", pair.publicKey);
  const fingerprint = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  db.close();
  return output({
    probe: "S-1",
    user_agent: navigator.userAgent,
    origin: location.origin,
    restored,
    verified,
    export_rejected: exportRejected,
    private_extractable: pair.privateKey.extractable,
    fingerprint,
    at: new Date().toISOString(),
  });
};
window.runAudioProbe = async () => {
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule("worklet.mjs");
    const worklet = new AudioWorkletNode(context, "silent-probe");
    let renderedFrames = 0;
    worklet.port.onmessage = (event) => {
      renderedFrames = event.data.frames;
    };
    worklet.connect(context.destination);
    await context.resume();
    const timestamps = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      timestamps.push(
        typeof context.getOutputTimestamp === "function" ? context.getOutputTimestamp() : null,
      );
    }
    worklet.disconnect();
    return output({
      probe: "S-2",
      user_agent: navigator.userAgent,
      sample_rate: context.sampleRate,
      state: context.state,
      rendered_frames: renderedFrames,
      timestamps,
      at: new Date().toISOString(),
      not_proven: "真实录制偏差、音画同步、欠载/爆音与目标OBS兼容性",
    });
  } finally {
    await context.close();
  }
};
document.querySelector("#key").onclick = () =>
  window.runPairingProbe().catch((e) => output({ error: String(e) }));
document.querySelector("#audio").onclick = () =>
  window.runAudioProbe().catch((e) => output({ error: String(e) }));
