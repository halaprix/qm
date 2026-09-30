import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeliveryGuard,
  createDiscordDispatcher,
  DISCORD_DELIVERY_CLAIM_MS,
  DISCORD_RUN_RECOVERY_GRACE_MS,
  parseDiscordTarget,
  type DeliveryGuard,
  type PostVerdict,
} from "../src/discord/deliveries.ts";
import type { DiscordSender } from "../src/discord/sender.ts";
import type { Delivery, Destination } from "../src/types.ts";

function row(over: Omit<Partial<Delivery>, "destination"> & { destination?: Partial<Destination> }): Delivery {
  return {
    id: "d1",
    text: "hello",
    idempotencyKey: "post:x",
    createdAt: 0,
    deliveredAt: null,
    ...over,
    destination: { type: "discord", target: "c1", ...over.destination } as Destination,
  } as Delivery;
}

function harness(
  rows: Delivery[],
  guard: DeliveryGuard = { mayPost: async () => ({ ok: true }) },
  inFlight = new Set<string>(),
) {
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}:${m.replyTo ?? ""}`);
      return { id: "new" };
    },
    edit: async (c, id, m) => void log.push(`edit:${c}:${id}:${m.content}`),
    react: async (c, id, e) => void log.push(`react:${c}:${id}:${e}`),
    remove: async (c, id) => void log.push(`remove:${c}:${id}`),
    openDm: async () => "dm",
  };
  const core = {
    claimDeliveries: async (_surface: string, claimMs: number) => {
      assert.equal(claimMs, DISCORD_DELIVERY_CLAIM_MS);
      return rows;
    },
    ackDelivery: async (id: string) => void log.push(`ack:${id}`),
    reportDeliveryUndeliverable: async (id: string, reason: string) => void log.push(`undeliverable:${id}:${reason}`),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const dispatcher = createDiscordDispatcher({ core, sender, guard, inFlightRuns: inFlight, now: () => 100_000 });
  return { log, dispatcher };
}

test("targets carry an optional reply-to message", () => {
  assert.deepEqual(parseDiscordTarget("c1"), { channelId: "c1" });
  assert.deepEqual(parseDiscordTarget("c1:m1"), { channelId: "c1", replyTo: "m1" });
});

test("a plain post is sent and acked", async () => {
  const h = harness([row({ destination: { target: "c1:m1" } })]);
  assert.equal(await h.dispatcher.drain(), true);
  assert.deepEqual(h.log, ["send:c1:hello:m1", "ack:d1"]);
});

test("a delivery to a channel with a guest reader is dropped, not posted", async () => {
  const h = harness([row({})], { mayPost: async () => ({ ok: false, retry: false, reason: "guest reader" }) });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["undeliverable:d1:guest reader", "ack:d1"]);
});

test("a delivery whose readers are not known yet is left unacked for retry", async () => {
  const h = harness([row({})], { mayPost: async () => ({ ok: false, retry: true, reason: "members_not_ready" }) });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, []);
});

test("run rows are skipped while in flight or inside the grace window", async () => {
  const young = row({ id: "d2", idempotencyKey: "run:r2", createdAt: 100_000 - DISCORD_RUN_RECOVERY_GRACE_MS + 1 });
  const flying = row({ id: "d3", idempotencyKey: "run:r3", createdAt: 0 });
  const old = row({ id: "d4", idempotencyKey: "run:r4", createdAt: 0, destination: { editRef: "s4" } });
  const h = harness([young, flying, old], undefined, new Set(["r3"]));
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["edit:c1:s4:hello", "ack:d4"]);
});

test("a long editRef delivery edits the placeholder and sends the rest", async () => {
  const h = harness([row({ text: "x".repeat(2500), destination: { editRef: "s1" } })]);
  await h.dispatcher.drain();
  assert.equal(h.log[0]!.startsWith("edit:c1:s1:"), true);
  assert.equal(h.log[1]!.startsWith("send:c1:"), true);
  assert.equal(h.log.at(-1), "ack:d1");
});

test("reactions need a Unicode emoji; a :name: is reported and acked, not retried", async () => {
  const good = row({ id: "r1", text: "", destination: { react: { messageTs: "m1", emoji: "👍" } } });
  const bad = row({ id: "r2", text: "", destination: { react: { messageTs: "m1", emoji: "thumbsup" } } });
  const h = harness([good, bad]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, [
    "react:c1:m1:👍",
    "ack:r1",
    "undeliverable:r2:Discord reactions need a Unicode emoji",
    "ack:r2",
  ]);
});

test("deletes remove the message", async () => {
  const h = harness([row({ text: "", destination: { delete: { messageTs: "m7" } } })]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["remove:c1:m7", "ack:d1"]);
});

test("a send failure is reported and left unacked for retry", async () => {
  const h = harness([row({})]);
  const failing = createDiscordDispatcher({
    core: {
      claimDeliveries: async () => [row({})],
      ackDelivery: async () => void h.log.push("ack"),
      reportDeliveryUndeliverable: async (_id: string, r: string) => void h.log.push(`undeliverable:${r}`),
      holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
      readBlob: async () => Buffer.from(""),
      readFileArtifact: async () => Buffer.from(""),
    },
    sender: {
      send: async () => {
        throw new Error("503");
      },
    } as never,
    guard: { mayPost: async () => ({ ok: true }) },
    inFlightRuns: new Set(),
  });
  await failing.drain();
  assert.deepEqual(h.log, ["undeliverable:503"]);
});

test("the guard drops guest-readable and unconfigured channels, retries unknown readers and recipients", async () => {
  const guard = createDeliveryGuard({
    channelKind: async (id) =>
      (
        ({
          pub: { kind: "guild", baseChannelId: "pub" },
          priv: { kind: "guild", baseChannelId: "priv" },
          other: { kind: "guild", baseChannelId: "other" },
          cold: { kind: "guild", baseChannelId: "cold" },
          dmGuest: { kind: "dm", recipientId: "4" },
          dmStaff: { kind: "dm", recipientId: "1" },
          dmUnknown: { kind: "dm", recipientId: "5" },
        }) as const
      )[id] ?? null,
    readers: async (base) => {
      if (base === "pub")
        return { ok: true, readers: [{ externalId: "discord:1" }, { externalId: "discord:4", isExternalGuest: true }] };
      if (base === "other") return { ok: false, retry: false, reason: "guild_not_configured" };
      if (base === "cold") return { ok: false, retry: true, reason: "members_not_ready" };
      return { ok: true, readers: [{ externalId: "discord:1" }] };
    },
    classifyUser: async (id) => {
      if (id === "1") return { externalId: "discord:1" };
      if (id === "5") return null;
      return { externalId: `discord:${id}`, isExternalGuest: true };
    },
  });
  const pubVerdict: PostVerdict = await guard.mayPost("pub");
  assert.deepEqual(pubVerdict, { ok: false, retry: false, reason: "guest reader" });
  assert.deepEqual(await guard.mayPost("priv"), { ok: true });
  assert.deepEqual(await guard.mayPost("other"), { ok: false, retry: false, reason: "guild_not_configured" });
  assert.deepEqual(await guard.mayPost("cold"), { ok: false, retry: true, reason: "members_not_ready" });
  assert.deepEqual(await guard.mayPost("dmGuest"), { ok: false, retry: false, reason: "DM recipient is not internal" });
  assert.deepEqual(await guard.mayPost("dmStaff"), { ok: true });
  assert.deepEqual(await guard.mayPost("dmUnknown"), {
    ok: false,
    retry: true,
    reason: "DM recipient not classified yet",
  });
  assert.deepEqual(await guard.mayPost("missing"), { ok: false, retry: false, reason: "channel not found" });
});

test("lease loss mid-drain stops dispatching subsequent deliveries", async () => {
  let notifyLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    notifyLost = resolve;
  });
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}:${m.replyTo ?? ""}`);
      notifyLost();
      return { id: "new" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    openDm: async () => "dm",
  };
  const core = {
    claimDeliveries: async () => [row({ id: "d1" }), row({ id: "d2" }), row({ id: "d3" })],
    ackDelivery: async (id: string) => void log.push(`ack:${id}`),
    reportDeliveryUndeliverable: async (id: string, reason: string) => void log.push(`undeliverable:${id}:${reason}`),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(lost),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard: { mayPost: async () => ({ ok: true }) },
    inFlightRuns: new Set(),
  });
  assert.equal(await dispatcher.drain(), true);
  assert.deepEqual(log, ["send:c1:hello:", "ack:d1"]);
});
