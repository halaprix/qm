import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { EventEmitter } from "node:events";
import { createDiscordPlugin, DISCORD_LOGIN_RETRY_BASE_MS } from "../src/discord/index.ts";
import type { DiscordPluginConfig } from "../src/discord/config.ts";
import type { SurfaceCoreClient } from "../src/api/surface-core-client.ts";

const cfg: DiscordPluginConfig = {
  botToken: "fake-token",
  allowUserIds: new Set(["111"]),
};

function fakeCore(): SurfaceCoreClient {
  return {
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => ({ status: "ok", reply: "done" }),
    streamSnapshot: () => null,
  } as unknown as SurfaceCoreClient;
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
  } as unknown as SurfaceCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => fakeClient as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false },
    content: "hello",
    attachments: new Map(),
    channel: {
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
  } as unknown as SurfaceCoreClient;

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
    author: { id: "111", username: "user", bot: false },
    content: "hello",
    attachments: new Map(),
    channel: {
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
  } as unknown as SurfaceCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => fakeClient as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false },
    content: "hello",
    attachments: new Map(),
    channel: {
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
  } as unknown as SurfaceCoreClient;

  const plugin = createDiscordPlugin(cfg, core, {
    clientFactory: factory,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = (text: string) => ({
    id: `m-${text}`,
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false },
    content: text,
    attachments: new Map(),
    channel: {
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
