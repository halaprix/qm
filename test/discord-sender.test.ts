import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordSender } from "../src/discord/sender.ts";
import { noLinkChannels } from "./support/discord-channels.ts";

const senderOn = (client: unknown) => createDiscordSender(client as never, noLinkChannels(client));

test("every send and edit carries empty allowedMentions", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const channel = {
    isTextBased: () => true,
    send: async (o: Record<string, unknown>) => {
      calls.push(o);
      return { id: "m9" };
    },
    messages: {
      edit: async (_id: string, o: Record<string, unknown>) => void calls.push(o),
      fetch: async () => ({ react: async () => {} }),
      delete: async () => {},
    },
  };
  const sender = senderOn({ channels: { fetch: async () => channel } });
  assert.deepEqual(await sender.send("c1", { content: "<@123> hi", replyTo: "m1" }), { id: "m9" });
  await sender.edit("c1", "m9", { content: "@everyone" });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.deepEqual(c.allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(calls[0]!.reply, { messageReference: "m1", failIfNotExists: false });
});

test("a channel that cannot receive messages throws", async () => {
  const sender = senderOn({ channels: { fetch: async () => null } });
  await assert.rejects(sender.send("c1", { content: "x" }), /not sendable/);
});

test("unreact removes the bot's own reaction for that emoji from the fetched message", async () => {
  const removed: string[] = [];
  const msg = {
    reactions: {
      resolve: (e: string) => (e === "👀" ? { users: { remove: async () => void removed.push(e) } } : null),
    },
  };
  const channel = { isTextBased: () => true, send: async () => ({ id: "x" }), messages: { fetch: async () => msg } };
  const sender = senderOn({ channels: { fetch: async () => channel } });
  await sender.unreact("c1", "m1", "👀");
  await sender.unreact("c1", "m1", "🔍");
  assert.deepEqual(removed, ["👀"]);
});

test("react retries on the thread's parent channel when the message is unknown in the thread", async () => {
  const reacted: string[] = [];
  const unknown = Object.assign(new Error("Unknown Message"), { code: 10008 });
  const parent = {
    isTextBased: () => true,
    send: async () => ({ id: "x" }),
    messages: { fetch: async () => ({ react: async (e: string) => void reacted.push(`parent${e}`) }) },
  };
  const thread = {
    parentId: "c1",
    isTextBased: () => true,
    send: async () => ({ id: "x" }),
    messages: {
      fetch: async () => {
        throw unknown;
      },
    },
  };
  const sender = senderOn({
    channels: { fetch: async (id: string) => (id === "c1" ? parent : thread) },
  });
  await sender.react("t1", "m1", "👍");
  assert.deepEqual(reacted, ["parent👍"]);
  const other = { ...thread, messages: { fetch: async () => Promise.reject(new Error("boom")) } };
  const failing = senderOn({ channels: { fetch: async () => other } });
  await assert.rejects(failing.react("t1", "m1", "👍"), /boom/);
});

test("remove deletes the bot's own message and refuses anyone else's", async () => {
  const deleted: string[] = [];
  const message = (authorId: string) => ({ author: { id: authorId }, delete: async () => void deleted.push(authorId) });
  const sender = (authorId: string) =>
    senderOn({
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => ({ id: "m" }),
          messages: { fetch: async () => message(authorId) },
        }),
      },
    });
  await sender("bot").remove("c1", "m1");
  await assert.rejects(sender("someone").remove("c1", "m1"), /only delete my own/);
  assert.deepEqual(deleted, ["bot"]);
});
