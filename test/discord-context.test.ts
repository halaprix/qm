import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { createContextFulfiller, type DiscordHistoryReader } from "../src/discord/context.ts";
import { createDiscordHistoryReader } from "../src/discord/gateway.ts";
import type { SurfaceContextRequest } from "../src/types.ts";

function harness(viewerIds: string[], visible: Set<string>) {
  const outcomes: Array<{ id: string; outcome: unknown }> = [];
  const reader: DiscordHistoryReader = {
    recent: async () => [
      { id: "1300000000000000002", authorId: "999", authorName: "bot", text: "earlier answer" },
      { id: "1300000000000000003", authorId: "111", authorName: "Ana", text: "follow-up" },
    ],
    canView: async (channelId, userId) => visible.has(`${channelId}:${userId}`),
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async (id, outcome) => void outcomes.push({ id, outcome }),
      discordUserIdsFor: () => viewerIds,
    },
    reader,
    botUserId: () => "999",
  });
  return { fulfill, outcomes };
}

const req = (query: SurfaceContextRequest["query"]): SurfaceContextRequest => ({
  id: "q1",
  source: "discord",
  createdAt: 0,
  status: "pending",
  query,
});

test("read_thread returns messages oldest first, with the bot shown as you", async () => {
  const h = harness(["111"], new Set(["t1:111"]));
  await h.fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com", count: 10 }));
  assert.deepEqual(h.outcomes[0], {
    id: "q1",
    outcome: {
      result: {
        messages: [
          { ts: "1300000000000000002", author: "you", authorId: "discord:999", text: "earlier answer" },
          { ts: "1300000000000000003", author: "Ana", authorId: "discord:111", text: "follow-up" },
        ],
      },
    },
  });
});

test("a viewer who cannot see the channel gets an error, not messages", async () => {
  const h = harness(["111"], new Set());
  await h.fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com" }));
  assert.deepEqual(h.outcomes[0]!.outcome, { error: "You can't read that Discord channel." });
});

test("a viewer with no linked Discord id cannot read", async () => {
  const h = harness([], new Set(["t1:111"]));
  await h.fulfill(req({ conversationTarget: "t1", viewer: "sys" }));
  assert.equal((h.outcomes[0]!.outcome as { error: string }).error, "You can't read that Discord channel.");
});

test("unsupported queries fail explicitly", async () => {
  const h = harness(["111"], new Set(["t1:111"]));
  await h.fulfill(req({ openGroup: { participants: ["a", "b"] } }));
  assert.equal((h.outcomes[0]!.outcome as { error: string }).error, "Discord has no group DMs the bot can open.");

  await h.fulfill(req({ searchAll: "findme" }));
  assert.equal((h.outcomes[1]!.outcome as { error: string }).error, "That lookup isn't available on Discord.");

  await h.fulfill(req({ file: { ts: "f1" } }));
  assert.equal((h.outcomes[2]!.outcome as { error: string }).error, "That lookup isn't available on Discord.");

  await h.fulfill(req({ syncDirectory: true }));
  assert.equal((h.outcomes[3]!.outcome as { error: string }).error, "That lookup isn't available on Discord.");

  await h.fulfill(req({ viewer: "ana@acme.com" }));
  assert.equal((h.outcomes[4]!.outcome as { error: string }).error, "No Discord conversation to read.");
});

test("a viewer with multiple linked ids can read if any one has access", async () => {
  const h = harness(["111", "222"], new Set(["t1:222"]));
  await h.fulfill(req({ conversationTarget: "t1:m1", viewer: "ana@acme.com" }));
  assert.equal("result" in (h.outcomes[0]!.outcome as { result: unknown }), true);
});

test("fetch error during recent returns an error outcome", async () => {
  const outcomes: Array<{ id: string; outcome: unknown }> = [];
  const reader: DiscordHistoryReader = {
    recent: async () => {
      throw new Error("Discord API connection failed");
    },
    canView: async () => true,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async (id, outcome) => void outcomes.push({ id, outcome }),
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "c1", viewer: "ana@acme.com" }));
  assert.deepEqual(outcomes[0], {
    id: "q1",
    outcome: { error: "Discord API connection failed" },
  });
});

test("canView returns false for unknown channel", async () => {
  const client = { channels: { cache: new Map() } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("unknown", "u1"), false);
});

test("canView returns false when guild is not in configured guildIds", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "unconfigured-guild",
    members: { cache: new Map([["u1", member]]) },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({ has: () => m.id === "u1" }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("c1", "u1"), false);
});

test("canView returns false when guild is not hydrated", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({ has: () => m.id === "u1" }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => false },
  });
  assert.equal(await reader.canView("c1", "u1"), false);
});

test("canView returns false when member is not cached", async () => {
  const guild = {
    id: "g1",
    members: { cache: new Map() },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({ has: () => m.id === "u1" }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("c1", "u1"), false);
});

test("canView returns false when member lacks ViewChannel permission", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) => {
        if (m.id !== "u1") return false;
        if (Array.isArray(perms)) return !perms.includes(PermissionFlagsBits.ViewChannel);
        return perms !== PermissionFlagsBits.ViewChannel;
      },
    }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("c1", "u1"), false);
});

test("canView returns false when member has ViewChannel but lacks ReadMessageHistory", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) =>
        m.id === "u1" &&
        Array.isArray(perms) &&
        perms.includes(PermissionFlagsBits.ViewChannel) &&
        !perms.includes(PermissionFlagsBits.ReadMessageHistory),
    }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("c1", "u1"), false);
});

test("canView returns true when member has ViewChannel and ReadMessageHistory permissions", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const channel = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) =>
        m.id === "u1" &&
        Array.isArray(perms) &&
        perms.includes(PermissionFlagsBits.ViewChannel) &&
        perms.includes(PermissionFlagsBits.ReadMessageHistory),
    }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("c1", "u1"), true);
});

test("canView returns false for thread whose parent is not viewable", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (_m: { id: string }) => ({
      has: () => false,
    }),
  };
  const thread = {
    id: "t1",
    parent,
    isThread: () => true,
  };
  const client = { channels: { cache: new Map([["t1", thread]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), false);
});

test("canView returns false for thread whose parent is missing", async () => {
  const thread = {
    id: "t1",
    parent: null,
    isThread: () => true,
  };
  const client = { channels: { cache: new Map([["t1", thread]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), false);
});

test("canView checks DM recipient", async () => {
  const dmChannel = {
    id: "dm1",
    type: ChannelType.DM,
    recipientId: "u1",
    isThread: () => false,
  };
  const client = { channels: { cache: new Map([["dm1", dmChannel]]) } };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("dm1", "u1"), true);
  assert.equal(await reader.canView("dm1", "u2"), false);
});

test("recent fetches and sorts messages oldest first", async () => {
  const messages = new Map([
    [
      "1300000000000000003",
      { id: "1300000000000000003", content: "third", author: { id: "1", globalName: null, username: "alice" } },
    ],
    [
      "1300000000000000001",
      {
        id: "1300000000000000001",
        content: "first",
        author: { id: "1", globalName: null, username: "alice" },
        member: { displayName: "Alice" },
      },
    ],
    [
      "1300000000000000002",
      { id: "1300000000000000002", content: "second", author: { id: "2", globalName: "Bob", username: "bob" } },
    ],
  ]);
  const channel = {
    id: "c1",
    isTextBased: () => true,
    isThread: () => false,
    messages: {
      fetch: async (opts: { limit: number }) => {
        assert.equal(opts.limit, 10);
        return messages;
      },
    },
  };
  const client = {
    channels: {
      cache: new Map([["c1", channel]]),
      fetch: async () => channel,
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const res = await reader.recent("c1", { count: 10 });
  assert.deepEqual(res, [
    { id: "1300000000000000001", authorId: "1", authorName: "Alice", text: "first" },
    { id: "1300000000000000002", authorId: "2", authorName: "Bob", text: "second" },
    { id: "1300000000000000003", authorId: "1", authorName: "alice", text: "third" },
  ]);
});

test("canView returns false for private thread when viewer is not a thread member and lacks ManageThreads", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) =>
        m.id === "u1" &&
        Array.isArray(perms) &&
        perms.includes(PermissionFlagsBits.ViewChannel) &&
        perms.includes(PermissionFlagsBits.ReadMessageHistory),
    }),
  };
  const thread = {
    id: "t1",
    parent,
    type: ChannelType.PrivateThread,
    isThread: () => true,
    members: { cache: new Map() },
  };
  const client = {
    channels: {
      cache: new Map<string, unknown>([
        ["t1", thread],
        ["c1", parent],
      ]),
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), false);
});

test("canView returns true for private thread when viewer is a thread member", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) =>
        m.id === "u1" &&
        Array.isArray(perms) &&
        perms.includes(PermissionFlagsBits.ViewChannel) &&
        perms.includes(PermissionFlagsBits.ReadMessageHistory),
    }),
  };
  const thread = {
    id: "t1",
    parent,
    type: ChannelType.PrivateThread,
    isThread: () => true,
    members: { cache: new Map([["u1", { id: "u1" }]]) },
  };
  const client = {
    channels: {
      cache: new Map<string, unknown>([
        ["t1", thread],
        ["c1", parent],
      ]),
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), true);
});

test("canView returns true for private thread when viewer is not a member but has ManageThreads on parent", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) => {
        if (m.id !== "u1") return false;
        if (Array.isArray(perms)) {
          return (
            perms.includes(PermissionFlagsBits.ViewChannel) && perms.includes(PermissionFlagsBits.ReadMessageHistory)
          );
        }
        return perms === PermissionFlagsBits.ManageThreads;
      },
    }),
  };
  const thread = {
    id: "t1",
    parent,
    type: ChannelType.PrivateThread,
    isThread: () => true,
    members: { cache: new Map() },
  };
  const client = {
    channels: {
      cache: new Map<string, unknown>([
        ["t1", thread],
        ["c1", parent],
      ]),
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), true);
});

test("canView returns true for public thread when viewer can see parent even if not a thread member and lacks ManageThreads", async () => {
  const member = { id: "u1" };
  const guild = {
    id: "g1",
    members: { cache: new Map([["u1", member]]) },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (perms: bigint | bigint[]) =>
        m.id === "u1" &&
        Array.isArray(perms) &&
        perms.includes(PermissionFlagsBits.ViewChannel) &&
        perms.includes(PermissionFlagsBits.ReadMessageHistory),
    }),
  };
  const thread = {
    id: "t1",
    parent,
    type: ChannelType.PublicThread,
    isThread: () => true,
    members: { cache: new Map() },
  };
  const client = {
    channels: {
      cache: new Map<string, unknown>([
        ["t1", thread],
        ["c1", parent],
      ]),
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.equal(await reader.canView("t1", "u1"), true);
});

test("recent on a thread channel sets threadTs to the thread channel id", async () => {
  const messages = new Map([
    [
      "1300000000000000001",
      {
        id: "1300000000000000001",
        content: "thread reply",
        author: { id: "1", globalName: null, username: "alice" },
        member: { displayName: "Alice" },
      },
    ],
  ]);
  const channel = {
    id: "t1",
    isTextBased: () => true,
    isThread: () => true,
    messages: {
      fetch: async () => messages,
    },
  };
  const client = {
    channels: {
      cache: new Map([["t1", channel]]),
      fetch: async () => channel,
    },
  };
  const reader = createDiscordHistoryReader({
    client: client as unknown as Client,
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const res = await reader.recent("t1", { count: 10 });
  assert.equal(res[0]?.threadTs, "t1");
});

test("read_thread preserves threadTs on messages for thread targets so whats_new counts hereNew", async () => {
  const outcomes: Array<{ id: string; outcome: unknown }> = [];
  const reader: DiscordHistoryReader = {
    recent: async () => [
      { id: "1300000000000000002", authorId: "999", authorName: "bot", text: "earlier answer", threadTs: "t1" },
      { id: "1300000000000000003", authorId: "111", authorName: "Ana", text: "follow-up", threadTs: "t1" },
    ],
    canView: async () => true,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async (id, outcome) => void outcomes.push({ id, outcome }),
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com", count: 10 }));
  const result = (outcomes[0]?.outcome as { result: { messages: Array<{ ts: string; threadTs?: string }> } }).result;
  assert.equal(result.messages[0]?.threadTs, "t1");
  assert.equal(result.messages[1]?.threadTs, "t1");
  const destTarget = "t1";
  const hereRoot = destTarget.slice(destTarget.lastIndexOf(":") + 1);
  const newer = result.messages.filter((m) => m.threadTs === hereRoot || m.ts === hereRoot);
  assert.equal(newer.length, 2);
});

test("count is clamped between 1 and 100", async () => {
  const counts: number[] = [];
  const reader: DiscordHistoryReader = {
    recent: async (_channelId, opts) => {
      counts.push(opts.count);
      return [];
    },
    canView: async () => true,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async () => {},
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com", count: 0 }));
  await fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com", count: 500 }));
  assert.deepEqual(counts, [1, 100]);
});

test("before parameter is passed through to recent", async () => {
  let capturedBefore: string | undefined;
  const reader: DiscordHistoryReader = {
    recent: async (_channelId, opts) => {
      capturedBefore = opts.before;
      return [];
    },
    canView: async () => true,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async () => {},
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com", before: "1300000000000000050" }));
  assert.equal(capturedBefore, "1300000000000000050");
});

test("falls back to channelId when conversationTarget is absent", async () => {
  let readChannel: string | undefined;
  const reader: DiscordHistoryReader = {
    recent: async (channelId) => {
      readChannel = channelId;
      return [];
    },
    canView: async () => true,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async () => {},
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ channelId: "c1", viewer: "ana@acme.com" }));
  assert.equal(readChannel, "c1");
});

test("recent is not called when access is denied", async () => {
  let recentCalls = 0;
  const reader: DiscordHistoryReader = {
    recent: async () => {
      recentCalls += 1;
      return [];
    },
    canView: async () => false,
  };
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async () => {},
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "t1", viewer: "ana@acme.com" }));
  assert.equal(recentCalls, 0);
});

test("a request with no viewer gets an error and does not call canView or recent", async () => {
  let canViewCalls = 0;
  let recentCalls = 0;
  const reader: DiscordHistoryReader = {
    recent: async () => {
      recentCalls += 1;
      return [];
    },
    canView: async () => {
      canViewCalls += 1;
      return true;
    },
  };
  const outcomes: Array<{ id: string; outcome: unknown }> = [];
  const fulfill = createContextFulfiller({
    core: {
      fulfillContextRequest: async (id, outcome) => void outcomes.push({ id, outcome }),
      discordUserIdsFor: () => ["111"],
    },
    reader,
    botUserId: () => "999",
  });
  await fulfill(req({ conversationTarget: "t1" }));
  assert.deepEqual(outcomes[0]!.outcome, { error: "You can't read that Discord channel." });
  assert.equal(canViewCalls, 0);
  assert.equal(recentCalls, 0);
});
