import assert from "node:assert/strict";
import { test } from "node:test";
import { audienceWith, channelReaders } from "../src/discord/readers.ts";
import { classifyMember, type DiscordMemberFacts } from "../src/discord/members.ts";

const BOT = "999";
const cfg = { allowUserIds: new Set(["1", "2"]), internalRoleIds: new Set<string>() };
const classify = (m: DiscordMemberFacts) => classifyMember(m, cfg, async () => false);
const facts = (userId: string, isBot = false): DiscordMemberFacts => ({
  userId,
  displayName: userId,
  roleIds: [],
  isBot,
});
const base = { guildIds: new Set(["900"]), ready: () => true, botUserId: BOT, classify };

test("a guest viewer is in the audience as a guest", async () => {
  const r = await channelReaders({ ...base, viewers: { ok: true, guildId: "900", members: [facts("1"), facts("3")] } });
  assert.ok(r.ok);
  assert.deepEqual(
    r.readers.map((a) => [a.externalId, a.isExternalGuest === true]),
    [
      ["discord:1", false],
      ["discord:3", true],
    ],
  );
});

test("the bot itself is never a reader, but other bots are guest readers", async () => {
  const r = await channelReaders({
    ...base,
    viewers: { ok: true, guildId: "900", members: [facts("1"), facts(BOT, true), facts("77", true)] },
  });
  assert.ok(r.ok);
  assert.deepEqual(
    r.readers.map((a) => [a.externalId, a.isExternalGuest === true]),
    [
      ["discord:1", false],
      ["discord:77", true],
    ],
  );
});

test("readers are unknown, and retryable, while the guild's members are not hydrated", async () => {
  const r = await channelReaders({
    ...base,
    ready: () => false,
    viewers: { ok: true, guildId: "900", members: [facts("1")] },
  });
  assert.deepEqual(r, { ok: false, retry: true, reason: "members_not_ready" });
});

test("unconfigured guilds, non-guild channels and oversized channels are final refusals", async () => {
  assert.deepEqual(await channelReaders({ ...base, viewers: { ok: true, guildId: "901", members: [] } }), {
    ok: false,
    retry: false,
    reason: "guild_not_configured",
  });
  assert.deepEqual(await channelReaders({ ...base, viewers: { ok: false, reason: "not_a_guild_channel" } }), {
    ok: false,
    retry: false,
    reason: "not_a_guild_channel",
  });
  assert.deepEqual(
    await channelReaders({ ...base, cap: 1, viewers: { ok: true, guildId: "900", members: [facts("1"), facts("2")] } }),
    { ok: false, retry: false, reason: "too_many_readers" },
  );
});

test("the actor is always in the audience", () => {
  assert.deepEqual(
    audienceWith([{ externalId: "discord:2" }], { externalId: "discord:1" }).map((a) => a.externalId),
    ["discord:2", "discord:1"],
  );
  assert.equal(audienceWith([{ externalId: "discord:1" }], { externalId: "discord:1" }).length, 1);
});
