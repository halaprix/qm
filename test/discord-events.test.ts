import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordGate, discordPluginConfigFromEnv } from "../src/discord/config.ts";
import { conversationFor, routeMessage, threadName, type DiscordInbound } from "../src/discord/events.ts";

const BOT = "999";
const gate = createDiscordGate(
  discordPluginConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOW_USER_IDS: "111", DISCORD_GUILD_IDS: "900" })!,
);

function msg(over: Partial<DiscordInbound>): DiscordInbound {
  return {
    id: "m1",
    channelId: "c1",
    guildId: null,
    isThread: false,
    authorId: "111",
    authorName: "Ana",
    authorIsBot: false,
    content: "hi",
    mentionsBot: false,
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

test("users not on the allowlist are ignored everywhere", () => {
  assert.equal(routeMessage(msg({ authorId: "222" }), BOT, gate), null);
  assert.equal(routeMessage(msg({ authorId: "222", guildId: "900", mentionsBot: true }), BOT, gate), null);
});

test("bots, including this bot, are ignored", () => {
  assert.equal(routeMessage(msg({ authorIsBot: true }), BOT, gate), null);
  assert.equal(routeMessage(msg({ authorId: BOT }), BOT, gate), null);
});

test("server messages need a mention; mention text is stripped", () => {
  assert.equal(routeMessage(msg({ guildId: "900" }), BOT, gate), null);
  const r = routeMessage(msg({ guildId: "900", mentionsBot: true, content: `<@${BOT}> summarize this` }), BOT, gate)!;
  assert.equal(r.target, "new-thread");
  assert.equal(r.text, "summarize this");
  const inThread = routeMessage(
    msg({ guildId: "900", isThread: true, mentionsBot: true, content: `<@!${BOT}> ok` }),
    BOT,
    gate,
  )!;
  assert.equal(inThread.target, "thread");
});

test("a bare mention with no text and no files is ignored", () => {
  assert.equal(routeMessage(msg({ guildId: "900", mentionsBot: true, content: `<@${BOT}>` }), BOT, gate), null);
});

test("conversation keys are stable per DM channel and per thread", () => {
  assert.deepEqual(conversationFor("dm", "c1"), { kind: "dm", threadRef: "discord:dm:c1", channelRef: "c1" });
  assert.deepEqual(conversationFor("thread", "t7", "ops"), {
    kind: "channel",
    threadRef: "discord:thread:t7",
    channelRef: "t7",
    channelName: "ops",
  });
});

test("thread names are trimmed to Discord's 100-char cap", () => {
  assert.equal(threadName("a".repeat(300)).length, 100);
  assert.equal(threadName("   "), "QM");
});
