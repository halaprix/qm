import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationFor,
  deliveryTargetFor,
  routeMessage,
  threadName,
  type DiscordInbound,
} from "../src/discord/events.ts";

const BOT = "999";
const GUILDS = new Set(["900"]);
const msg = (over: Partial<DiscordInbound>): DiscordInbound => ({
  id: "m1",
  channelId: "c1",
  guildId: null,
  threadParentId: null,
  channelName: null,
  authorId: "111",
  authorName: "Ana",
  authorIsBot: false,
  content: "hi",
  mentionedUserIds: [],
  attachments: [],
  ...over,
});

test("DMs route to the DM session", () => {
  assert.deepEqual(routeMessage(msg({}), BOT, GUILDS), { target: "dm", text: "hi" });
});

test("a mention in a configured guild channel opens a thread with the mention stripped", () => {
  const r = routeMessage(msg({ guildId: "900", content: "<@999> deploy it", mentionedUserIds: [BOT] }), BOT, GUILDS);
  assert.deepEqual(r, { target: "new-thread", text: "deploy it" });
});

test("an unmentioned top-level guild message is ignored", () => {
  assert.equal(routeMessage(msg({ guildId: "900" }), BOT, GUILDS), null);
});

test("guilds that are not configured are ignored", () => {
  assert.equal(routeMessage(msg({ guildId: "901", mentionedUserIds: [BOT] }), BOT, GUILDS), null);
});

test("inside a thread a mention is prompted and anything else is an ambient candidate", () => {
  const inThread = { guildId: "900", channelId: "t1", threadParentId: "c1" };
  assert.deepEqual(routeMessage(msg({ ...inThread, content: "<@!999> again", mentionedUserIds: [BOT] }), BOT, GUILDS), {
    target: "thread",
    text: "again",
    unprompted: false,
  });
  assert.deepEqual(routeMessage(msg({ ...inThread, content: "and also" }), BOT, GUILDS), {
    target: "thread",
    text: "and also",
    unprompted: true,
  });
});

test("bots and this bot are ignored everywhere", () => {
  assert.equal(routeMessage(msg({ authorIsBot: true }), BOT, GUILDS), null);
  assert.equal(routeMessage(msg({ authorId: BOT, guildId: "900", threadParentId: "c1" }), BOT, GUILDS), null);
});

test("guild threads are channel conversations carrying their audience", () => {
  const audience = [{ externalId: "discord:111" }];
  const target = { kind: "thread" as const, threadId: "t1", parentChannelId: "c1", channelName: "eng" };
  assert.deepEqual(conversationFor(target, audience), {
    kind: "channel",
    threadRef: "discord:th:t1",
    channelRef: "c1",
    channelName: "eng",
    audience,
  });
  assert.equal(deliveryTargetFor(target), "t1");
  assert.deepEqual(conversationFor({ kind: "dm", channelId: "d1" }), {
    kind: "dm",
    threadRef: "discord:dm:d1",
    channelRef: "d1",
  });
});

test("thread names are the first line capped at 100 chars", () => {
  assert.equal(threadName("a".repeat(150)).length, 100);
  assert.equal(threadName("first\nsecond"), "first");
  assert.equal(threadName("   "), "QM");
});
