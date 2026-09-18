import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startProbeServer } from "./probe-server.mjs";

const executable = process.env.BELLIS_PROBE_CHROME;
if (!executable) throw new Error("Set BELLIS_PROBE_CHROME to the installed Chrome executable");
const server = await startProbeServer(0);
const folder = mkdtempSync(join(tmpdir(), "bellis-browser-probe-"));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = {
  executablePath: executable,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
};
let browser;
try {
  browser = await chromium.launchPersistentContext(folder, options);
  let page = await browser.newPage();
  await page.goto(`${origin}/stage.html`);
  const initial = await page.evaluate(() => window.runPairingProbe());
  await page.reload();
  const refresh = await page.evaluate(() => window.runPairingProbe());
  await page.close();
  page = await browser.newPage();
  await page.goto(`${origin}/stage.html`);
  const reopened = await page.evaluate(() => window.runPairingProbe());
  await browser.close();
  browser = await chromium.launchPersistentContext(folder, options);
  page = await browser.newPage();
  await page.goto(`${origin}/stage.html`);
  const restarted = await page.evaluate(() => window.runPairingProbe());
  const audio = await page.evaluate(() => window.runAudioProbe());
  for (const item of [initial, refresh, reopened, restarted]) {
    assert.equal(item.verified, true);
    assert.equal(item.export_rejected, true);
    assert.equal(item.private_extractable, false);
    assert.equal(item.fingerprint, initial.fingerprint);
  }
  for (const item of [refresh, reopened, restarted]) assert.equal(item.restored, true);
  assert.ok(audio.rendered_frames > 0);
  assert.ok(
    audio.timestamps.every(
      (t) => t && Number.isFinite(t.contextTime) && Number.isFinite(t.performanceTime),
    ),
  );
  assert.ok(audio.timestamps.at(-1).contextTime > audio.timestamps[0].contextTime);
  const report = {
    status: "PARTIAL",
    executed_at: new Date().toISOString(),
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      executable,
      launch_options: options,
    },
    source_sha256: createHash("sha256")
      .update(readFileSync(new URL(import.meta.url)))
      .digest("hex"),
    origin,
    profile_directory: folder,
    key: { initial, refresh, reopened, restarted },
    audio,
    not_tested: [
      "OBS/CEF",
      "machine reboot",
      "recorded output alignment",
      "loaded broadcast environment",
    ],
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/spike-browser.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "PARTIAL",
      key_paths: 4,
      worklet_frames: audio.rendered_frames,
      report: "reports/spike-browser.json",
    }),
  );
} finally {
  if (browser) await browser.close();
  server.close();
}
