import assert from "node:assert/strict";
import { test } from "node:test";
import { discordPluginConfigFromEnv, discordUserIdOf } from "../src/discord/config.ts";

test("no token means no Discord", () => {
  assert.equal(discordPluginConfigFromEnv({}), null);
});

test("a token with no allowlist boots: unknown users are guests, not a startup error", () => {
  const cfg = discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t" })!;
  assert.equal(cfg.allowUserIds.size, 0);
});

test("lists parse from comma or space separated env", () => {
  const cfg = discordPluginConfigFromEnv({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_ALLOW_USER_IDS: "1, 2",
    DISCORD_GUILD_IDS: "900 901",
    DISCORD_INTERNAL_ROLE_IDS: "r1",
  })!;
  assert.deepEqual([...cfg.allowUserIds], ["1", "2"]);
  assert.deepEqual([...cfg.guildIds], ["900", "901"]);
  assert.deepEqual([...cfg.internalRoleIds], ["r1"]);
});

test("discordUserIdOf only strips the discord prefix", () => {
  assert.equal(discordUserIdOf("discord:42"), "42");
  assert.equal(discordUserIdOf("U42"), null);
});
