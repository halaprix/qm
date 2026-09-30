import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { EventEmitter } from "node:events";
import { ChannelType } from "discord.js";
import {
  createDiscordPlugin,
  DISCORD_DELIVERY_POLL_MS,
  DISCORD_LOGIN_RETRY_BASE_MS,
  READERS_UNKNOWN_TEXT,
} from "../src/discord/index.ts";
import { REFUSED_GUEST_TEXT } from "../src/discord/turn-flow.ts";
import type { DiscordPluginConfig } from "../src/discord/config.ts";
import type { DiscordCoreClient } from "../src/api/discord-core-client.ts";

const cfg: DiscordPluginConfig = {
  botToken: "fake-token",
  allowUserIds: new Set(["111"]),
  guildIds: new Set(),
  internalRoleIds: new Set(),
};

function fakeCore(): DiscordCoreClient {
  return {
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => ({ status: "ok", reply: "done" }),
    streamSnapshot: () => null,
    linkedInternal: async () => false,
    discordUserIdsFor: () => [],
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
  } as unknown as DiscordCoreClient;
}

test("stop drains in-flight handle before calling client.destroy", async () => {
  const events: string[] = [];
  let inFlightResolve: () => void;
  const inFlightPromise = new Promise<void>((r) => {
    inFlightResolve = r;
  });

  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#0001" },
    login: async () => "ok",
    destroy: async () => {
      events.push("client.destroy");
    },
  });

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("handle.start");
      await inFlightPromise;
      events.push("handle.finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => fakeClient as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  emitter.emit("messageCreate", fakeMessage);

  await new Promise((r) => setTimeout(r, 10));

  const stopPromise = plugin.stop();

  emitter.emit("messageCreate", {
    ...fakeMessage,
    id: "m2",
    content: "hello 2",
  });

  await new Promise((r) => setTimeout(r, 20));
  inFlightResolve!();
  await stopPromise;

  assert.deepEqual(events, ["handle.start", "handle.finish", "client.destroy"]);
});

test("plugin is restartable and creates a new client on each start", async () => {
  let clientCount = 0;
  const destroyed: number[] = [];

  const factory = () => {
    const id = ++clientCount;
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      user: { id: "999", tag: "bot#0001" },
      login: async () => "ok",
      destroy: async () => {
        destroyed.push(id);
      },
    }) as never;
  };

  const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
  await plugin.start();
  assert.equal(clientCount, 1);
  await plugin.stop();
  assert.deepEqual(destroyed, [1]);

  await plugin.start();
  assert.equal(clientCount, 2);
  await plugin.stop();
  assert.deepEqual(destroyed, [1, 2]);
});

test("start during stop drain immediately creates a new client that survives the old drain", async () => {
  const events: string[] = [];
  let finishSlowMessage: () => void;
  const slowMessagePromise = new Promise<void>((r) => {
    finishSlowMessage = r;
  });

  const createdClients: Array<{ id: number; emitter: EventEmitter; destroyed: boolean; loggedIn: boolean }> = [];
  let clientSeq = 0;

  const clientFactory = () => {
    const id = ++clientSeq;
    const emitter = new EventEmitter();
    const clientRecord = {
      id,
      emitter,
      destroyed: false,
      loggedIn: false,
    };
    createdClients.push(clientRecord);
    return Object.assign(emitter, {
      user: { id: `bot-${id}`, tag: `bot#000${id}` },
      login: async () => {
        clientRecord.loggedIn = true;
        events.push(`login:${id}`);
        return "ok";
      },
      destroy: async () => {
        clientRecord.destroyed = true;
        events.push(`destroy:${id}`);
      },
    }) as never;
  };

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("turn:start");
      await slowMessagePromise;
      events.push("turn:finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory,
    drainTimeoutMs: 5000,
  });

  await plugin.start();
  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0]!.loggedIn, true);

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  createdClients[0]!.emitter.emit("messageCreate", fakeMessage);
  await new Promise((r) => setTimeout(r, 10));

  const stopPromise = plugin.stop();
  const startPromise = plugin.start();

  await new Promise((r) => setTimeout(r, 20));
  finishSlowMessage!();
  await Promise.all([stopPromise, startPromise]);

  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[1]!.loggedIn, true);
  assert.equal(createdClients[1]!.destroyed, false);
  assert.equal(createdClients[0]!.destroyed, true);
});

test("a second stop while draining waits for the same drain", async () => {
  const events: string[] = [];
  let finishSlowMessage: () => void;
  const slowMessagePromise = new Promise<void>((r) => {
    finishSlowMessage = r;
  });

  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#0001" },
    login: async () => "ok",
    destroy: async () => {
      events.push("client.destroy");
    },
  });

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("handle.start");
      await slowMessagePromise;
      events.push("handle.finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => fakeClient as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  emitter.emit("messageCreate", fakeMessage);
  await new Promise((r) => setTimeout(r, 10));

  let secondStopResolved = false;
  const firstStop = plugin.stop();
  const secondStop = plugin.stop().then(() => {
    secondStopResolved = true;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondStopResolved, false);
  assert.equal(events.includes("client.destroy"), false);

  finishSlowMessage!();
  await Promise.all([firstStop, secondStop]);

  assert.equal(secondStopResolved, true);
  assert.deepEqual(events, ["handle.start", "handle.finish", "client.destroy"]);
});

test("second stop does not settle before second client drain even if previous destroy rejects", async () => {
  let finishTurn1: () => void;
  const turn1Promise = new Promise<void>((r) => {
    finishTurn1 = r;
  });
  let finishTurn2: () => void;
  const turn2Promise = new Promise<void>((r) => {
    finishTurn2 = r;
  });

  let clientSeq = 0;
  const emitters: EventEmitter[] = [];
  const factory = () => {
    const id = ++clientSeq;
    const emitter = new EventEmitter();
    emitters.push(emitter);
    return Object.assign(emitter, {
      user: { id: `bot-${id}`, tag: `bot#000${id}` },
      login: async () => "ok",
      destroy: async () => {
        if (id === 1) {
          throw new Error("first client destroy failed");
        }
      },
    }) as never;
  };

  const core = {
    ...fakeCore(),
    submitTurn: async (req: { text: string }) => {
      if (req.text === "turn 1") await turn1Promise;
      if (req.text === "turn 2") await turn2Promise;
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, core, {
    clientFactory: factory,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = (text: string) => ({
    id: `m-${text}`,
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: text,
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  });

  emitters[0]!.emit("messageCreate", fakeMessage("turn 1"));
  await new Promise((r) => setTimeout(r, 10));

  const stop1 = plugin.stop();
  stop1.catch(() => {});
  const start2 = plugin.start();
  await start2;

  emitters[1]!.emit("messageCreate", fakeMessage("turn 2"));
  await new Promise((r) => setTimeout(r, 10));

  let secondStopSettled = false;
  const stop2 = plugin.stop();
  stop2
    .catch(() => {})
    .finally(() => {
      secondStopSettled = true;
    });

  finishTurn1!();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(secondStopSettled, false);

  finishTurn2!();
  await assert.rejects(stop2, /first client destroy failed/);
  assert.equal(secondStopSettled, true);
});

test("a failed login retries with a new client", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const createdClients: Array<{ id: number; destroyed: boolean; loggedIn: boolean }> = [];
    let clientSeq = 0;

    const factory = () => {
      const id = ++clientSeq;
      const emitter = new EventEmitter();
      const record = { id, destroyed: false, loggedIn: false };
      createdClients.push(record);
      return Object.assign(emitter, {
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          if (id === 1) {
            throw new Error("login failed");
          }
          record.loggedIn = true;
          return "ok";
        },
        destroy: async () => {
          record.destroyed = true;
        },
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
    await plugin.start();

    assert.equal(createdClients.length, 1);
    assert.equal(createdClients[0]!.destroyed, true);
    assert.equal(createdClients[0]!.loggedIn, false);

    mock.timers.tick(DISCORD_LOGIN_RETRY_BASE_MS);
    await Promise.resolve();

    assert.equal(createdClients.length, 2);
    assert.equal(createdClients[0]!.destroyed, true);
    assert.equal(createdClients[1]!.destroyed, false);
    assert.equal(createdClients[1]!.loggedIn, true);

    await plugin.stop();
  } finally {
    mock.timers.reset();
  }
});

test("stop cancels a pending login retry so a restart connects at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const createdClients: Array<{ id: number; destroyed: boolean; loggedIn: boolean }> = [];
    let clientSeq = 0;

    const factory = () => {
      const id = ++clientSeq;
      const emitter = new EventEmitter();
      const record = { id, destroyed: false, loggedIn: false };
      createdClients.push(record);
      return Object.assign(emitter, {
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          throw new Error("login failed");
        },
        destroy: async () => {
          record.destroyed = true;
        },
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
    await plugin.start();

    assert.equal(createdClients.length, 1);
    await plugin.stop();
    await plugin.start();
    assert.equal(createdClients.length, 2);
    await plugin.stop();

    mock.timers.tick(DISCORD_LOGIN_RETRY_BASE_MS * 2);
    await Promise.resolve();

    assert.equal(createdClients.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("c1 login rejection after stop and start does not schedule a retry or create a new client", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let clientSeq = 0;
    let rejectLogin1: (err: Error) => void;
    const login1Promise = new Promise<string>((_, reject) => {
      rejectLogin1 = reject;
    });

    const factory = () => {
      const id = ++clientSeq;
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          if (id === 1) return await login1Promise;
          return "ok";
        },
        destroy: async () => {},
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), {
      clientFactory: factory,
      drainTimeoutMs: 5000,
    });

    const start1 = plugin.start();
    await Promise.resolve();
    assert.equal(clientSeq, 1);

    await plugin.stop();

    const start2 = plugin.start();
    await start2;
    assert.equal(clientSeq, 2);

    const setTimeoutSpy = mock.method(globalThis, "setTimeout");
    rejectLogin1!(new Error("c1 login failed"));
    await start1.catch(() => {});
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.equal(setTimeoutSpy.mock.calls.length, 0);

    mock.timers.tick(DISCORD_LOGIN_RETRY_BASE_MS * 2);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.equal(clientSeq, 2);

    await plugin.stop();
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

function guildHarness(opts: {
  authorRoles: string[];
  viewers: Array<{ id: string; roles: string[]; bot?: boolean }>;
  hydrationFails?: boolean;
  submitResult?: (b: Record<string, unknown>) => Promise<Record<string, unknown>>;
  extraGuild?: { id: string; members: Array<{ id: string; roles: string[] }> };
}) {
  const submitted: Array<Record<string, unknown>> = [];
  const ingested: unknown[][] = [];
  let historyFetchCount = 0;
  const threads: string[] = [];
  const channelPosts: string[] = [];
  const threadPosts: string[] = [];
  const acked: string[] = [];
  const pendingRows: Array<Record<string, unknown>> = [];
  let enqueued: () => void = () => {};
  const emitter = new EventEmitter();
  const member = (id: string, roles: string[], bot = false) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  });
  const cache = new Map(opts.viewers.map((v) => [v.id, member(v.id, v.roles, v.bot)]));
  const guild = {
    id: "900",
    members: {
      cache,
      fetch: async () => {
        if (opts.hydrationFails) throw new Error("gateway timeout");
        return cache;
      },
    },
    roles: { cache: new Map() },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        historyFetchCount += 1;
        return new Map();
      },
    },
  };
  const thread = {
    id: "t1",
    parentId: "c1",
    parent,
    guild,
    name: "deploy it",
    isThread: () => true,
    isTextBased: () => true,
    send: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      threadPosts.push(text);
      return { id: "s1", edit: async () => {}, delete: async () => {} };
    },
    sendTyping: async () => {},
    messages: {
      fetch: async () => {
        historyFetchCount += 1;
        return new Map();
      },
    },
  };
  const channelsCache = new Map<string, unknown>([
    ["c1", parent],
    ["t1", thread],
  ]);
  const extraGuildCache = opts.extraGuild
    ? new Map(opts.extraGuild.members.map((m) => [m.id, member(m.id, m.roles)]))
    : null;
  const extraGuild = opts.extraGuild
    ? {
        id: opts.extraGuild.id,
        members: { cache: extraGuildCache, fetch: async () => extraGuildCache },
        roles: { cache: new Map() },
      }
    : null;
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#1" },
    login: async () => {
      queueMicrotask(() => emitter.emit("clientReady", fakeClient));
      return "ok";
    },
    destroy: async () => {},
    channels: {
      cache: channelsCache,
      fetch: async (id: string) => (id === "c1" ? parent : thread),
    },
    guilds: {
      cache: new Map(
        extraGuild
          ? [
              ["900", guild],
              [extraGuild.id, extraGuild],
            ]
          : [["900", guild]],
      ),
      fetch: async (id: string) => {
        if (id === "900") return guild;
        return extraGuild && id === extraGuild.id ? extraGuild : null;
      },
    },
  });
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      if (opts.submitResult) return await opts.submitResult(b);
      return { status: "silent" };
    },
    linkedInternal: async () => false,
    ingestSurfaceEvents: async (events: unknown[]) => {
      ingested.push(events);
    },
    onDeliveryEnqueued: (listener: () => void) => {
      enqueued = listener;
      return () => {};
    },
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async (type: string) => (type === "discord" ? pendingRows.splice(0) : []),
    ackDelivery: async (id: string) => void acked.push(id),
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const message = {
    id: "m1",
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "ana", bot: false, globalName: null },
    member: member("111", opts.authorRoles),
    content: "<@999> deploy it",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: {
      ...parent,
      name: "eng",
      send: async (o: { content?: string } | string) => {
        const text = typeof o === "string" ? o : (o.content ?? "");
        channelPosts.push(text);
        return { id: "r1" };
      },
    },
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      channelPosts.push(text);
      return { id: "r1" };
    },
    startThread: async () => {
      threads.push("t1");
      return thread;
    },
  };
  const plugin = createDiscordPlugin(
    {
      botToken: "t",
      allowUserIds: new Set(),
      guildIds: new Set(extraGuild ? ["900", extraGuild.id] : ["900"]),
      internalRoleIds: new Set(["staff"]),
    },
    core,
    { clientFactory: () => fakeClient as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    plugin,
    emitter,
    message,
    thread,
    submitted,
    threads,
    channelPosts,
    threadPosts,
    settle,
    acked,
    pendingRows,
    enqueue: () => enqueued(),
    ingested,
    historyFetchCount: () => historyFetchCount,
  };
}

test("a staff mention in a private channel opens a thread and submits a channel turn with its audience", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "112", roles: ["staff"] },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.threads, ["t1"]);
  const body = h.submitted[0]! as { conversation: Record<string, unknown>; deliveryTarget: string };
  assert.equal(body.conversation.kind, "channel");
  assert.equal(body.conversation.threadRef, "discord:th:t1");
  assert.equal(body.deliveryTarget, "t1");
  assert.deepEqual(
    (body.conversation.audience as Array<{ externalId: string }>).map((a) => a.externalId),
    ["discord:111", "discord:112"],
  );
});

test("guild turns use mode spine and never post model output directly to the channel", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: async () => ({ status: "ok", reply: "secret model reply" }),
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(h.threadPosts, []);
  assert.deepEqual(h.channelPosts, []);
});

test("a guild whose member list contains the bot never lists the bot as a reader", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "999", roles: [], bot: true },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  const audience = (h.submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation
    .audience;
  assert.deepEqual(
    audience.map((a) => a.externalId),
    ["discord:111"],
  );
});

test("a reader who is internal via another configured guild counts as internal", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "222", roles: [] },
    ],
    extraGuild: { id: "901", members: [{ id: "222", roles: ["staff"] }] },
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  const audience = (
    h.submitted[0] as { conversation: { audience: Array<{ externalId: string; isExternalGuest?: boolean }> } }
  ).conversation.audience;
  const reader = audience.find((a) => a.externalId === "discord:222");
  assert.equal(reader?.isExternalGuest, undefined);
});

test("a mention from a guest is ignored: no thread, no turn", async () => {
  const h = guildHarness({ authorRoles: [], viewers: [{ id: "111", roles: [] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.threads, []);
  assert.deepEqual(h.submitted, []);
});

test("a staff mention in a channel a guest can read still submits, and core refuses it", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "555", roles: [] },
    ],
    submitResult: async () => ({
      status: "refused",
      reason: "internal-only: shared audience includes a non-internal participant",
    }),
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  const audience = (
    h.submitted[0] as { conversation: { audience: Array<{ externalId: string; isExternalGuest?: boolean }> } }
  ).conversation.audience;
  assert.ok(audience.some((a) => a.externalId === "discord:555" && a.isExternalGuest));
  assert.deepEqual(h.threadPosts, [REFUSED_GUEST_TEXT]);
});

test("while members are not hydrated, a staff mention is refused with a clear message and nothing is submitted", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }], hydrationFails: true });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.threads, []);
  assert.deepEqual(h.channelPosts, [READERS_UNKNOWN_TEXT]);
});

test("after ShardReconnecting readers are unknown until the session resumes", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("shardReconnecting", 0);
  h.pendingRows.push({
    id: "d1",
    text: "cron result",
    idempotencyKey: "cron:x",
    createdAt: 0,
    deliveredAt: null,
    destination: { type: "discord", target: "t1" },
  });
  h.enqueue();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.channelPosts, [READERS_UNKNOWN_TEXT]);
  assert.deepEqual(h.acked, []);
  h.emitter.emit("shardResume", 0, 0);
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: "m2" });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
});

test("the dispatcher also drains on the DISCORD_DELIVERY_POLL_MS timer, not only on enqueue", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await h.plugin.start();
    await h.settle();
    h.pendingRows.push({
      id: "d1",
      text: "cron result",
      idempotencyKey: "cron:x",
      createdAt: 0,
      deliveredAt: null,
      destination: { type: "discord", target: "t1" },
    });
    assert.deepEqual(h.acked, []);
    mock.timers.tick(DISCORD_DELIVERY_POLL_MS);
    await h.settle();
    await h.plugin.stop();
    assert.deepEqual(h.acked, ["d1"]);
  } finally {
    mock.timers.reset();
  }
});

test("a guildId-null message from a group DM channel submits no turn", async () => {
  const submitted: unknown[] = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "queued", runId: "r1" };
    },
  } as unknown as DiscordCoreClient;
  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#0001" },
    login: async () => "ok",
    destroy: async () => {},
  });
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => fakeClient as never, drainTimeoutMs: 5000 });
  await plugin.start();
  const groupDmMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.GroupDM,
      isThread: () => false,
      send: async () => ({ edit: async () => {}, delete: async () => {} }),
    },
  };
  emitter.emit("messageCreate", groupDmMessage);
  await new Promise((r) => setTimeout(r, 10));
  await plugin.stop();
  assert.deepEqual(submitted, []);
});

test("a message in an unconfigured guild triggers no ingest and no history fetch", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    guildId: "777",
    content: "deploy it",
  });
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.ingested, []);
  assert.equal(h.historyFetchCount(), 0);
});

test("a mention in a configured guild is mirrored into the surface cache", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 1);
});

test("a staked unprompted follow-up in a thread submits a turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.threads, ["t1"]);
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m2",
    channelId: "t1",
    content: "no mention here",
    mentions: { users: new Map() },
    channel: h.thread,
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      h.threadPosts.push(text);
      return { id: "r2" };
    },
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 2);
});

test("an explicit mention in a thread the bot never marked does not fetch stake history", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    channelId: "t1",
    content: "<@999> still here",
    channel: h.thread,
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      h.threadPosts.push(text);
      return { id: "r2" };
    },
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  assert.equal(h.historyFetchCount(), 0);
});

test("the bot's own message in a configured guild thread is mirrored with no history fetch", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-self",
    channelId: "t1",
    author: { id: "999", username: "qm", bot: true, globalName: null },
    content: "here's the answer",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 1);
  const event = (h.ingested[0] as Array<{ self: boolean }>)[0]!;
  assert.equal(event.self, true);
  assert.equal(h.historyFetchCount(), 0);
  assert.equal(h.submitted.length, 0);
});

test("another bot's message in a staked thread is mirrored and submits no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.threads, ["t1"]);
  const fetchesBeforeSecondMessage = h.historyFetchCount();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-other-bot",
    channelId: "t1",
    author: { id: "222", username: "otherbot", bot: true, globalName: null },
    content: "beep boop",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 2);
  const event = (h.ingested[1] as Array<{ self: boolean; bot: boolean }>)[0]!;
  assert.equal(event.self, false);
  assert.equal(event.bot, true);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.historyFetchCount(), fetchesBeforeSecondMessage);
});

test("another bot's message in an unstaked thread is not mirrored", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-other-bot",
    channelId: "t1",
    author: { id: "222", username: "otherbot", bot: true, globalName: null },
    content: "beep boop",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 0);
  assert.equal(h.submitted.length, 0);
  assert.equal(h.historyFetchCount(), 1);
});

test("a member removed from the guild between hydrations is dropped from the cached member list", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  });
  const membersCache = new Map([
    ["111", member("111", ["staff"])],
    ["222", member("222", ["staff"])],
  ]);
  let kicked = false;
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => (kicked ? new Map([["111", membersCache.get("111")!]]) : new Map(membersCache)),
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const submitted: Array<Record<string, unknown>> = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "silent" };
    },
    linkedInternal: async () => false,
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#1" },
    login: async () => {
      queueMicrotask(() => emitter.emit("clientReady", fakeClient));
      return "ok";
    },
    destroy: async () => {},
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", allowUserIds: new Set(), guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => fakeClient as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const mention = (id: string) => ({
    id,
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "u111", bot: false, globalName: null },
    member: member("111", ["staff"]),
    content: "<@999> hi",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: { ...parent, name: "eng", send: async () => ({ id: "r1" }) },
    reply: async () => ({ id: "r1" }),
    startThread: async () => ({
      id: "t1",
      parentId: "c1",
      parent,
      guild,
      isThread: () => true,
      send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
      sendTyping: async () => {},
    }),
  });
  await plugin.start();
  await settle();
  emitter.emit("messageCreate", mention("m1"));
  await settle();
  kicked = true;
  emitter.emit("shardResume", 0, 0);
  await settle();
  emitter.emit("messageCreate", mention("m2"));
  await settle();
  await plugin.stop();
  assert.equal(submitted.length, 2);
  const before = (submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation.audience;
  const after = (submitted[1] as { conversation: { audience: Array<{ externalId: string }> } }).conversation.audience;
  assert.deepEqual(before.map((a) => a.externalId).sort(), ["discord:111", "discord:222"]);
  assert.deepEqual(after.map((a) => a.externalId).sort(), ["discord:111"]);
});

test("a member added to the cache while the fetch is pending is still cached afterwards and appears in readers", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  });
  const membersCache = new Map([["111", member("111", ["staff"])]]);
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => {
        membersCache.set("222", member("222", []));
        return new Map([["111", membersCache.get("111")!]]);
      },
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const submitted: Array<Record<string, unknown>> = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "silent" };
    },
    linkedInternal: async () => false,
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#1" },
    login: async () => {
      queueMicrotask(() => emitter.emit("clientReady", fakeClient));
      return "ok";
    },
    destroy: async () => {},
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", allowUserIds: new Set(), guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => fakeClient as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const mention = {
    id: "m1",
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "u111", bot: false, globalName: null },
    member: member("111", ["staff"]),
    content: "<@999> hi",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: { ...parent, name: "eng", send: async () => ({ id: "r1" }) },
    reply: async () => ({ id: "r1" }),
    startThread: async () => ({
      id: "t1",
      parentId: "c1",
      parent,
      guild,
      isThread: () => true,
      send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
      sendTyping: async () => {},
    }),
  };
  await plugin.start();
  await settle();
  assert.equal(guild.members.cache.has("222"), true);
  emitter.emit("messageCreate", mention);
  await settle();
  await plugin.stop();
  assert.equal(submitted.length, 1);
  const audience = (submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation
    .audience;
  assert.deepEqual(audience.map((a) => a.externalId).sort(), ["discord:111", "discord:222"]);
});

test("a rejected fetch prunes nothing", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  });
  const membersCache = new Map([["111", member("111", ["staff"])]]);
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => {
        throw new Error("gateway timeout");
      },
    },
  };
  const parent = { id: "c1", guild, isThread: () => false, permissionsFor: () => ({ has: () => true }) };
  const core = {
    ...fakeCore(),
    linkedInternal: async () => false,
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const emitter = new EventEmitter();
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#1" },
    login: async () => {
      queueMicrotask(() => emitter.emit("clientReady", fakeClient));
      return "ok";
    },
    destroy: async () => {},
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", allowUserIds: new Set(), guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => fakeClient as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await plugin.start();
  await settle();
  await plugin.stop();
  assert.equal(membersCache.has("111"), true);
});

test("a run in flight from a stopping connection is not delivered by the next connection's dispatcher", async () => {
  const acked: string[] = [];
  const dmCfg: DiscordPluginConfig = {
    botToken: "t",
    allowUserIds: new Set(["111"]),
    guildIds: new Set(),
    internalRoleIds: new Set(),
  };
  let claimed = false;
  let messageSent = false;
  let resolveWaitRun!: () => void;
  const waitRunPromise = new Promise<{ status: "silent" }>((resolve) => {
    resolveWaitRun = () => resolve({ status: "silent" });
  });
  const core = {
    ...fakeCore(),
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: () => waitRunPromise,
    reportRunEditRef: async () => {},
    linkedInternal: async () => false,
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async (type: string) => {
      if (type !== "discord" || claimed || !messageSent) return [];
      claimed = true;
      return [
        {
          id: "d1",
          text: "cron result",
          idempotencyKey: "run:r1",
          createdAt: Date.now() - 1_000_000,
          deliveredAt: null,
          destination: { type: "discord", target: "c1" },
        },
      ];
    },
    ackDelivery: async (id: string) => void acked.push(id),
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const dmChannel = {
    type: ChannelType.DM,
    recipientId: "111",
    isThread: () => false,
    isTextBased: () => true,
    send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
    messages: { edit: async () => {}, delete: async () => {} },
  };
  const emitters: EventEmitter[] = [];
  const factory = () => {
    const emitter = new EventEmitter();
    emitters.push(emitter);
    const fakeClient = Object.assign(emitter, {
      user: { id: "999", tag: "bot#1" },
      login: async () => {
        queueMicrotask(() => emitter.emit("clientReady", fakeClient));
        return "ok";
      },
      destroy: async () => {},
      channels: { cache: new Map(), fetch: async () => dmChannel },
      guilds: { cache: new Map(), fetch: async () => null },
    });
    return fakeClient as never;
  };
  const plugin = createDiscordPlugin(dmCfg, core, { clientFactory: factory, drainTimeoutMs: 20 });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  await plugin.start();
  await settle();
  messageSent = true;
  emitters[0]!.emit("messageCreate", {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: dmChannel,
  });
  await settle();

  await plugin.stop();
  await plugin.start();
  await settle();

  assert.deepEqual(acked, []);
  resolveWaitRun();
  await plugin.stop();
  await settle();
});

test("a ClientReady that fires after detach starts no delivery subscription or poll", async () => {
  let subscriptions = 0;
  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => {
      subscriptions += 1;
      return () => {};
    },
  } as unknown as DiscordCoreClient;
  const emitter = new EventEmitter();
  let fireReady: (() => void) | null = null;
  const fakeClient = Object.assign(emitter, {
    user: { id: "999", tag: "bot#1" },
    login: async () => {
      fireReady = () => emitter.emit("clientReady", fakeClient);
      return "ok";
    },
    destroy: async () => {},
  });
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => fakeClient as never, drainTimeoutMs: 20 });
  await plugin.start();
  await plugin.stop();
  fireReady!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subscriptions, 0);
});
