import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadIrisRuntimeConfiguration } from "../../src/bootstrap/iris-config.js";
import { parseRuntimeConfig } from "../../src/bootstrap/config.js";

const input = (directory: string) => ({
  schemaVersion: 1,
  runtime: {
    dataDirectory: directory,
    runtimeVersion: "test",
    port: 0,
    phase2: { enabled: true },
    phase3: { enabled: true },
  },
  iris: {
    enabled: true,
    baseUrl: "http://127.0.0.1:4874",
    allowedOrigins: ["http://127.0.0.1:4874"],
    credential: { kind: "environment", name: "IRIS_TEST_TOKEN" },
    appInstanceId: "test",
    agentId: "agent",
    spaceId: "space",
    identityScope: "owner",
    privacyRevision: "1",
    scope: { kind: "space", acknowledgeCrossSession: true },
    actors: [{ provider: "fixture", externalId: "viewer" }],
    publicLabels: ["space:space"],
  },
});
async function fixture(run: (directory: string, configPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bellis-iris-config-"));
  try {
    await run(directory, join(directory, "config.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("loads referenced credentials separately from Runtime config with the unchanged schema default", async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify(input(directory)));
    const loaded = await loadIrisRuntimeConfiguration(path, {
      IRIS_TEST_TOKEN: "secret-test-value",
    });
    expect(loaded.bearerToken).toBe("secret-test-value");
    expect(JSON.stringify(loaded.runtime)).not.toContain("secret-test-value");
    expect(JSON.stringify(loaded.iris)).not.toContain("secret-test-value");
    expect(parseRuntimeConfig(loaded.runtime)).toEqual({ ok: true, config: loaded.runtime });
    expect(loaded.iris).toMatchObject({
      coreSchema: { minimum: 14, maximum: 15 },
      deadlineMs: 200,
    });
  });
});

it("does not read environment references when Iris is disabled", async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify({ ...input(directory), iris: { enabled: false } }));
    const loaded = await loadIrisRuntimeConfiguration(
      path,
      new Proxy(
        {},
        {
          get() {
            throw new Error("must not resolve credentials");
          },
        },
      ),
    );
    expect(loaded.iris.enabled).toBe(false);
    expect(loaded.bearerToken).toBeUndefined();
  });
});

it("rejects unauthorized origins, plaintext remote transport, invalid scope/ranges and inline secrets with one safe error", async () => {
  await fixture(async (directory, path) => {
    const base = input(directory);
    const overrides = [
      { allowedOrigins: ["https://different.invalid"] },
      { baseUrl: "http://remote.invalid", allowedOrigins: ["http://remote.invalid"] },
      { baseUrl: "https://user:secret@example.invalid" },
      { scope: { kind: "session", sessionId: "invented" } },
      { coreSchema: { minimum: 20, maximum: 14 } },
      { bearerToken: "secret-test-value" },
      { credential: { kind: "file", path: "relative-secret" } },
      { historyRecovery: { timeoutMs: 60001 } },
    ];
    for (const override of overrides) {
      await writeFile(path, JSON.stringify({ ...base, iris: { ...base.iris, ...override } }));
      await expect(
        loadIrisRuntimeConfiguration(path, { IRIS_TEST_TOKEN: "secret-test-value" }),
      ).rejects.toThrow(/^iris_launch_configuration_invalid$/u);
    }
    for (const token of [undefined, "", "secret\r\ninjected", "secret value", "x".repeat(8193)]) {
      await writeFile(path, JSON.stringify(base));
      await expect(loadIrisRuntimeConfiguration(path, { IRIS_TEST_TOKEN: token })).rejects.toThrow(
        /^iris_launch_configuration_invalid$/u,
      );
    }
  });
});

it("bounds config and token reads, rejects symlinks, and enforces private POSIX credential files", async () => {
  await fixture(async (directory, path) => {
    const tokenPath = join(directory, "token");
    const base = input(directory);
    await writeFile(tokenPath, "file-secret\n", { mode: 0o600 });
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        iris: { ...base.iris, credential: { kind: "file", path: tokenPath } },
      }),
    );
    expect((await loadIrisRuntimeConfiguration(path)).bearerToken).toBe("file-secret");
    if (process.getuid !== undefined) {
      await chmod(tokenPath, 0o644);
      await expect(loadIrisRuntimeConfiguration(path)).rejects.toThrow(
        "iris_launch_configuration_invalid",
      );
      await chmod(tokenPath, 0o600);
    }
    await writeFile(tokenPath, "x".repeat(8194));
    await expect(loadIrisRuntimeConfiguration(path)).rejects.toThrow(
      "iris_launch_configuration_invalid",
    );
    await writeFile(path, "x".repeat(65537));
    await expect(loadIrisRuntimeConfiguration(path)).rejects.toThrow(
      "iris_launch_configuration_invalid",
    );
    if (process.platform !== "win32") {
      const link = join(directory, "link");
      await symlink(tokenPath, link);
      await writeFile(
        path,
        JSON.stringify({
          ...base,
          iris: { ...base.iris, credential: { kind: "file", path: link } },
        }),
      );
      await expect(loadIrisRuntimeConfiguration(path)).rejects.toThrow(
        "iris_launch_configuration_invalid",
      );
    }
  });
});

it("rejects invalid runtime prerequisites and crash injection before credential resolution", async () => {
  await fixture(async (directory, path) => {
    const base = input(directory);
    for (const runtime of [
      { ...base.runtime, phase3: { enabled: false } },
      { ...base.runtime, phase2: { enabled: true, faultPoint: "before_durable_commit" } },
      { ...base.runtime, dataDirectory: "relative" },
    ]) {
      await writeFile(path, JSON.stringify({ ...base, runtime }));
      await expect(loadIrisRuntimeConfiguration(path, {})).rejects.toThrow(
        "iris_launch_configuration_invalid",
      );
    }
  });
});
