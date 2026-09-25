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
    DISCORD_GUILD_IDS: "900",
  })!;
  assert.deepEqual([...cfg.allowUserIds], ["111", "222", "333"]);
  assert.deepEqual([...cfg.allowGuildIds], ["900"]);
});

test("gate admits only listed users, and only in listed guilds or DMs", () => {
  const gate = createDiscordGate(
    discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_USER_IDS: "111", DISCORD_GUILD_IDS: "900" })!,
  );
  assert.equal(gate("111", null), true);
  assert.equal(gate("111", "900"), true);
  assert.equal(gate("111", "901"), false);
  assert.equal(gate("222", null), false);
});

test("empty DISCORD_GUILD_IDS means DMs only", () => {
  const gate = createDiscordGate(
    discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_USER_IDS: "111" })!,
  );
  assert.equal(gate("111", null), true);
  assert.equal(gate("111", "900"), false);
});

test("external ids are namespaced so they never collide with Slack ids or emails", () => {
  assert.equal(discordExternalId("111"), "discord:111");
});
