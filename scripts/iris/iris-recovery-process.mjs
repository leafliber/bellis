import assert from "node:assert/strict";
import { fork } from "node:child_process";
export function launchRecoveryChild(configPath, mode, childPath) {
  const child = fork(childPath, [configPath, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [],
    waiters = new Set();
  let logs = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-8192);
    });
  child.on("message", (message) => {
    messages.push(message);
    for (const poll of waiters) poll();
  });
  child.on("exit", () => {
    for (const poll of waiters) poll();
  });
  function expect(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`recovery child timeout: ${type}`)), 35_000);
      const finish = (error, value) => {
        clearTimeout(timer);
        waiters.delete(poll);
        error ? reject(error) : resolve(value);
      };
      const poll = () => {
        const failure = messages.find((item) => item.type === "error");
        if (failure) return finish(new Error(`recovery child: ${failure.message}`));
        const index = messages.findIndex((item) => item.type === type);
        if (index !== -1) return finish(undefined, messages.splice(index, 1)[0]);
        if (child.exitCode !== null || child.signalCode !== null)
          finish(
            new Error(`recovery child exited: ${child.exitCode ?? child.signalCode}; ${logs}`),
          );
      };
      waiters.add(poll);
      poll();
    });
  }
  async function stop(signal) {
    assert.equal(child.exitCode, null, "recovery child exited before explicit stop");
    assert.equal(child.signalCode, null, "recovery child was signalled before explicit stop");
    const ended = new Promise((resolve) =>
      child.once("exit", (code, reason) => resolve({ code, signal: reason })),
    );
    if (signal) child.kill(signal);
    else child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const result = await ended;
      if (!signal)
        assert.equal(
          result.code,
          0,
          `recovery child must close cleanly: ${messages.find((item) => item.type === "error")?.message ?? logs}`,
        );
      else assert.equal(result.signal, signal);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  return { child, expect, stop };
}
