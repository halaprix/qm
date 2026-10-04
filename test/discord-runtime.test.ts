import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDiscordRuntimeConfig } from "../src/surfaces/discord-installation.ts";
import { createSurfaceRuntimeReconciler } from "../src/surfaces/surface-runtime.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const env = { DISCORD_BOT_TOKEN: "env-token", DISCORD_GUILD_IDS: "900000000000000000" };
const store = (stored: unknown, disabled = false) => ({
  get: async () => stored as never,
  status: async () => ({ configured: Boolean(stored), disabled }) as never,
});

test("a stored installation wins over env", async () => {
  const got = await loadDiscordRuntimeConfig(
    store({
      botToken: "db",
      botUserId: "1",
      botTag: "b",
      applicationId: "1",
      oauthClientSecret: null,
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
      version: "v7",
    }),
    env,
  );
  assert.equal(got!.version, "v7");
  assert.equal(got!.config.botToken, "db");
});

test("a tombstone disables Discord even with env present", async () => {
  assert.equal(await loadDiscordRuntimeConfig(store(null, true), env), null);
});

test("env boots Discord only when nothing is stored", async () => {
  const got = await loadDiscordRuntimeConfig(store(null), env);
  assert.equal(got!.version, "environment");
  assert.deepEqual([...got!.config.guildIds], ["900000000000000000"]);
  assert.equal(await loadDiscordRuntimeConfig(store(null), {}), null);
});

test("stop with slow plugin stop, then start while stopping, then let stop settle restarts plugin", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await stopping;
  await runtime.reconcile();
  assert.equal(starts, 2);

  await runtime.stop();
});

test("stop, start, stop while stopping leaves plugin stopped", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  runtime.stop();
  stopSlow.resolve();
  await stopping;
  await runtime.reconcile();
  assert.equal(starts, 1);
});

test("start while stopping restarts plugin immediately when reconcile is called", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await runtime.reconcile();
  assert.equal(starts, 2);

  await stopping;
  await runtime.stop();
});

test("start while stopping restarts plugin via setImmediate when reconcile is not called", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await stopping;
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(starts, 2);

  await runtime.stop();
});

test("serverDeps propagates discordEnvironmentConfigured", () => {
  const built = buildApp(testConfig());
  assert.equal(
    serverDeps(testConfig({ discordEnvironmentConfigured: true }), built).discordEnvironmentConfigured,
    true,
  );
  assert.equal(
    serverDeps(testConfig({ discordEnvironmentConfigured: false }), built).discordEnvironmentConfigured,
    false,
  );
});
