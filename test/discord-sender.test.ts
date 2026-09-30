import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordSender } from "../src/discord/sender.ts";

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
  const sender = createDiscordSender({ channels: { fetch: async () => channel } } as never);
  assert.deepEqual(await sender.send("c1", { content: "<@123> hi", replyTo: "m1" }), { id: "m9" });
  await sender.edit("c1", "m9", { content: "@everyone" });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.deepEqual(c.allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(calls[0]!.reply, { messageReference: "m1", failIfNotExists: false });
});

test("a channel that cannot receive messages throws", async () => {
  const sender = createDiscordSender({ channels: { fetch: async () => null } } as never);
  await assert.rejects(sender.send("c1", { content: "x" }), /not sendable/);
});
