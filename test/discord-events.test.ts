import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordGate, discordPluginConfigFromEnv } from "../src/discord/config.ts";
import { conversationFor, routeMessage, type DiscordInbound } from "../src/discord/events.ts";

const BOT = "999";
const gate = createDiscordGate(discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_USER_IDS: "111" })!);

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

test("DM from an allowlisted user routes to the DM session", () => {
  const r = routeMessage(msg({}), BOT, gate)!;
  assert.equal(r.target, "dm");
  assert.equal(r.actor.externalId, "discord:111");
  assert.equal(r.actor.displayName, "Ana");
});

test("a message from an allowlisted user in a guild (guildId 900) routes to null", () => {
  assert.equal(routeMessage(msg({ authorId: "111", guildId: "900", content: "hi" }), BOT, gate), null);
});

test("users not on the allowlist are ignored everywhere", () => {
  assert.equal(routeMessage(msg({ authorId: "222" }), BOT, gate), null);
  assert.equal(routeMessage(msg({ authorId: "222", guildId: "900" }), BOT, gate), null);
});

test("bots, including this bot, are ignored", () => {
  assert.equal(routeMessage(msg({ authorIsBot: true }), BOT, gate), null);
  assert.equal(routeMessage(msg({ authorId: BOT }), BOT, gate), null);
});

test("a message with no text and no files is ignored", () => {
  assert.equal(routeMessage(msg({ content: "   " }), BOT, gate), null);
});

test("conversation keys are stable per DM channel", () => {
  assert.deepEqual(conversationFor("c1"), { kind: "dm", threadRef: "discord:dm:c1", channelRef: "c1" });
});
