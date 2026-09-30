import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyMember, type DiscordMemberFacts } from "../src/discord/members.ts";
import { conversationFor, routeMessage, type DiscordInbound } from "../src/discord/events.ts";

const BOT = "999";
const cfg = { allowUserIds: new Set(["111"]), internalRoleIds: new Set<string>() };
const classify = (m: DiscordMemberFacts) => classifyMember(m, cfg, async () => false);

function msg(over: Partial<DiscordInbound>): DiscordInbound {
  return {
    id: "m1",
    channelId: "c1",
    guildId: null,
    authorId: "111",
    authorName: "Ana",
    authorIsBot: false,
    content: "hi",
    attachments: [],
    ...over,
  };
}

test("DM from an allowlisted user routes to the DM session", async () => {
  const r = (await routeMessage(msg({}), BOT, classify))!;
  assert.equal(r.target, "dm");
  assert.equal(r.actor.externalId, "discord:111");
  assert.equal(r.actor.displayName, "Ana");
});

test("a message from an allowlisted user in a guild (guildId 900) routes to null", async () => {
  assert.equal(await routeMessage(msg({ authorId: "111", guildId: "900", content: "hi" }), BOT, classify), null);
});

test("users not on the allowlist are ignored everywhere", async () => {
  assert.equal(await routeMessage(msg({ authorId: "222" }), BOT, classify), null);
  assert.equal(await routeMessage(msg({ authorId: "222", guildId: "900" }), BOT, classify), null);
});

test("bots, including this bot, are ignored", async () => {
  assert.equal(await routeMessage(msg({ authorIsBot: true }), BOT, classify), null);
  assert.equal(await routeMessage(msg({ authorId: BOT }), BOT, classify), null);
});

test("a message with no text and no files is ignored", async () => {
  assert.equal(await routeMessage(msg({ content: "   " }), BOT, classify), null);
});

test("conversation keys are stable per DM channel", () => {
  assert.deepEqual(conversationFor("c1"), { kind: "dm", threadRef: "discord:dm:c1", channelRef: "c1" });
});
