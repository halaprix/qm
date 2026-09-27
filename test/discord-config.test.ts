import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordGate, discordExternalId, discordPluginConfigFromEnv } from "../src/discord/config.ts";

test("no token means no Discord surface", () => {
  assert.equal(discordPluginConfigFromEnv({}), null);
});

test("a token without an allowlist is startup-fatal", () => {
  assert.throws(() => discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t" }), /DISCORD_ALLOW_USER_IDS/);
});

test("parses comma/space separated ids", () => {
  const cfg = discordPluginConfigFromEnv({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_ALLOW_USER_IDS: "111, 222\n333",
  })!;
  assert.deepEqual([...cfg.allowUserIds], ["111", "222", "333"]);
});

test("gate admits only listed users", () => {
  const gate = createDiscordGate(
    discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_USER_IDS: "111" })!,
  );
  assert.equal(gate("111"), true);
  assert.equal(gate("222"), false);
});

test("external ids are namespaced so they never collide with Slack ids or emails", () => {
  assert.equal(discordExternalId("111"), "discord:111");
});
