import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUserClassifier,
  memberFacts,
  cachedViewers,
  createChannelKind,
  createStakeHistory,
  toInbound,
} from "../src/discord/gateway.ts";

const member = (id: string, roles: string[], bot = false) => ({
  id,
  displayName: `u${id}`,
  user: { id, bot, globalName: null, username: `u${id}` },
  roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
});

const guild = (id: string, members: Array<ReturnType<typeof member>>) => ({
  id,
  members: { cache: new Map(members.map((m) => [m.id, m])) },
});

const cfg = {
  botToken: "t",
  allowUserIds: new Set(["1"]),
  guildIds: new Set(["900", "901"]),
  internalRoleIds: new Set(["staff"]),
};

function classifier(allReady: boolean, guilds: Array<ReturnType<typeof guild>>) {
  return createUserClassifier({
    client: { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } } as never,
    cfg,
    hydrator: { allReady: () => allReady },
    linkedInternal: async (id) => id === "3",
  });
}

test("a staff role in any configured guild makes a DM user internal, regardless of guild order", async () => {
  const a = classifier(true, [guild("900", [member("2", [])]), guild("901", [member("2", ["staff"])])]);
  const b = classifier(true, [guild("901", [member("2", ["staff"])]), guild("900", [member("2", [])])]);
  assert.equal((await a("2", "two"))!.isExternalGuest, undefined);
  assert.deepEqual(await a("2", "two"), await b("2", "two"));
});

test("allowlisted and linked users are decided before hydration; others wait", async () => {
  const c = classifier(false, [guild("900", [])]);
  assert.equal((await c("1", "one"))!.isExternalGuest, undefined);
  assert.equal((await c("3", "three"))!.isExternalGuest, undefined);
  assert.equal(await c("4", "four"), null);
});

test("after hydration an unknown user is a guest", async () => {
  const c = classifier(true, [guild("900", [])]);
  assert.equal((await c("4", "four"))!.isExternalGuest, true);
});

test("memberFacts extracts facts from a guild member", () => {
  const m = member("10", ["r1", "r2"], false);
  const facts = memberFacts(m as never);
  assert.deepEqual(facts, {
    userId: "10",
    displayName: "u10",
    roleIds: ["r1", "r2"],
    isBot: false,
  });
});

test("cachedViewers returns not_a_guild_channel when channel is not in cache", () => {
  const client = { channels: { cache: new Map() } };
  const res = cachedViewers(client as never, "unknown");
  assert.deepEqual(res, { ok: false, reason: "not_a_guild_channel" });
});

test("cachedViewers returns viewers for a guild channel", () => {
  const g = guild("900", [member("1", ["staff"]), member("2", [])]);
  const channel = {
    id: "c1",
    guild: g,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({ has: () => m.id === "1" }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const res = cachedViewers(client as never, "c1");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.guildId, "900");
    assert.equal(res.members.length, 1);
    assert.equal(res.members[0]!.userId, "1");
  }
});

test("createChannelKind handles DM and guild channels", async () => {
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id === "dm1") return { type: 1, recipientId: "u1" };
        if (id === "g1") {
          return {
            type: 0,
            isThread: () => false,
            id: "g1",
            guild: { id: "900" },
          };
        }
        return null;
      },
    },
  };
  const kindFn = createChannelKind(client as never);
  assert.deepEqual(await kindFn("dm1"), { kind: "dm", recipientId: "u1" });
  assert.deepEqual(await kindFn("g1"), { kind: "guild", baseChannelId: "g1" });
  assert.equal(await kindFn("missing"), null);
});

test("createStakeHistory fetches recent messages", async () => {
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id !== "t1") return null;
        return {
          isTextBased: () => true,
          messages: {
            fetch: async () => new Map([["m1", { author: { id: "u1" }, mentions: { users: new Map([["bot", {}]]) } }]]),
          },
        };
      },
    },
  };
  const stakeHistory = createStakeHistory(client as never);
  const history = await stakeHistory("t1");
  assert.deepEqual(history, [{ authorId: "u1", mentionedUserIds: ["bot"] }]);
});

test("toInbound maps discord message correctly", () => {
  const fakeMsg = {
    id: "msg1",
    channelId: "c1",
    guildId: "g1",
    channel: { isThread: () => true, parentId: "parent1", name: "my-thread" },
    author: { id: "a1", username: "alice", bot: false, globalName: "Alice" },
    member: { displayName: "Alice D" },
    content: "hello world",
    mentions: { users: new Map([["bot1", {}]]) },
    attachments: new Map([
      ["att1", { url: "https://example.com/f.txt", name: "f.txt", contentType: "text/plain", size: 100 }],
    ]),
  };
  const inbound = toInbound(fakeMsg as never);
  assert.equal(inbound.id, "msg1");
  assert.equal(inbound.channelId, "c1");
  assert.equal(inbound.guildId, "g1");
  assert.equal(inbound.threadParentId, "parent1");
  assert.equal(inbound.channelName, "my-thread");
  assert.equal(inbound.authorId, "a1");
  assert.equal(inbound.authorName, "Alice D");
  assert.equal(inbound.authorIsBot, false);
  assert.equal(inbound.content, "hello world");
  assert.deepEqual(inbound.mentionedUserIds, ["bot1"]);
  assert.equal(inbound.attachments.length, 1);
});
