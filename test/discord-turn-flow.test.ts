import assert from "node:assert/strict";
import { test } from "node:test";
import type { SurfaceCoreClient } from "../src/api/surface-core-client.ts";
import {
  FAILURE_TEXT,
  REFUSED_GUEST_TEXT,
  runDiscordTurn,
  WORKING_TEXT,
  type ReplyChannel,
  type StatusMessage,
} from "../src/discord/turn-flow.ts";
import type { TurnResult } from "../src/types.ts";

interface Log {
  sent: string[];
  edits: string[];
  deleted: number;
  files: string[];
}

function channel(log: Log): ReplyChannel {
  return {
    async send(content, files): Promise<StatusMessage> {
      log.sent.push(content);
      for (const f of files ?? []) log.files.push(f.name);
      return {
        id: "s1",
        edit: async (c: string) => {
          if (c === "") throw new Error("Cannot send an empty message");
          log.edits.push(c);
        },
        delete: async () => {
          log.deleted += 1;
        },
      };
    },
    typing: async () => {},
  };
}

function core(opts: {
  submit?: () => Promise<TurnResult>;
  wait?: () => Promise<TurnResult | null>;
  snapshots?: string[];
}): SurfaceCoreClient {
  const snaps = [...(opts.snapshots ?? [])];
  return {
    submitTurn: opts.submit ?? (async () => ({ status: "queued", runId: "r1" })),
    waitRun: opts.wait ?? (async () => ({ status: "ok", reply: "done" })),
    streamSnapshot: () => snaps.shift() ?? null,
    readBlob: async (id: string) => Buffer.from(id),
    readFileArtifact: async () => Buffer.from(""),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
  } as unknown as SurfaceCoreClient;
}

const body = {
  actor: { externalId: "discord:1" },
  conversation: { kind: "dm" as const, threadRef: "discord:dm:c" },
  text: "hi",
};
const baseBody = {
  ...body,
  deliveryTarget: "c1",
};
const fresh = (): Log => ({ sent: [], edits: [], deleted: 0, files: [] });

test("posts a working message, then edits it into the final reply", async () => {
  const log = fresh();
  await runDiscordTurn({ core: core({}), channel: channel(log), body, mode: "stream", inFlightRuns: new Set() });
  assert.deepEqual(log.sent, [WORKING_TEXT]);
  assert.equal(log.edits.at(-1), "done");
});

test("streams partial text into the status message while the run is live", async () => {
  const log = fresh();
  const slowWait = () =>
    new Promise<TurnResult>((r) => setTimeout(() => r({ status: "ok", reply: "final answer" }), 60));
  await runDiscordTurn({
    core: core({ wait: slowWait, snapshots: ["par", "partial"] }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
    streamIntervalMs: 10,
  });
  assert.ok(log.edits.includes("par"));
  assert.ok(log.edits.includes("partial"));
  assert.equal(log.edits.at(-1), "final answer");
});

test("long replies edit the first chunk and send the rest", async () => {
  const log = fresh();
  const reply = `${"a ".repeat(1500)}\n\n${"b ".repeat(1500)}`;
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "ok", reply }) }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.ok(log.sent.length >= 3, `sent ${log.sent.length}`);
  for (const s of [...log.sent, ...log.edits]) assert.ok(s.length <= 2000);
  assert.ok(log.sent.slice(1).some((s) => s.includes("b b")));
});

test("a submit error replaces the working message with the failure text", async () => {
  const log = fresh();
  const submit = async (): Promise<TurnResult> => {
    throw new Error("core down");
  };
  await runDiscordTurn({
    core: core({ submit }),
    channel: channel(log),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.equal(log.edits.at(-1), FAILURE_TEXT);
});

test("a stalled run replaces the working message with the failure text", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult | null> => {
    throw Object.assign(new Error("stalled"), { code: "run_stalled" });
  };
  await runDiscordTurn({ core: core({ wait }), channel: channel(log), body, mode: "stream", inFlightRuns: new Set() });
  assert.equal(log.edits.at(-1), FAILURE_TEXT);
});

test("failed and null results also end in the failure text", async () => {
  for (const r of [{ status: "failed" } as TurnResult, null]) {
    const log = fresh();
    await runDiscordTurn({
      core: core({ wait: async () => r }),
      channel: channel(log),
      body,
      mode: "stream",
      inFlightRuns: new Set(),
    });
    assert.equal(log.edits.at(-1), FAILURE_TEXT);
  }
});

test("silent and steered turns remove the working message", async () => {
  const log1 = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "silent" }) }),
    channel: channel(log1),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.equal(log1.deleted, 1);
  const log2 = fresh();
  await runDiscordTurn({
    core: core({ submit: async () => ({ status: "queued", runId: "r", steered: true }) }),
    channel: channel(log2),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.equal(log2.deleted, 1);
});

test("refusals and pending approvals are explained in place", async () => {
  const log1 = fresh();
  await runDiscordTurn({
    core: core({ wait: async () => ({ status: "refused", reason: "internal-only" }) }),
    channel: channel(log1),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.match(log1.edits.at(-1)!, /internal-only/);
  const log2 = fresh();
  await runDiscordTurn({
    core: core({
      wait: async () => ({ status: "pending_approval", adminUrl: "https://qm/x" }),
    }),
    channel: channel(log2),
    body,
    mode: "stream",
    inFlightRuns: new Set(),
  });
  assert.match(log2.edits.at(-1)!, /https:\/\/qm\/x/);
});

test("outbound files are sent after the text", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult> => ({
    status: "ok",
    reply: "here",
    attachments: [{ name: "r.csv", mimetype: "text/csv", sizeBytes: 3, blobId: "b" }],
  });
  await runDiscordTurn({ core: core({ wait }), channel: channel(log), body, mode: "stream", inFlightRuns: new Set() });
  assert.deepEqual(log.files, ["r.csv"]);
});

test("a files-only reply deletes the working message and sends the files", async () => {
  const log = fresh();
  const wait = async (): Promise<TurnResult> => ({
    status: "ok",
    attachments: [{ name: "r.csv", mimetype: "text/csv", sizeBytes: 3, blobId: "b" }],
  });
  await runDiscordTurn({ core: core({ wait }), channel: channel(log), body, mode: "stream", inFlightRuns: new Set() });
  assert.equal(log.deleted, 1);
  assert.deepEqual(log.files, ["r.csv"]);
  assert.ok(!log.edits.includes(FAILURE_TEXT));
});

test("in stream mode, reportRunEditRef is called with the status message id and ackRunDelivery after delivery", async () => {
  const calls: string[] = [];
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const inFlight = new Set<string>();
  const c = {
    ...core({}),
    reportRunEditRef: async (runId: string, ref: string) => void calls.push(`ref:${runId}:${ref}`),
    ackRunDelivery: async (runId: string) => void calls.push(`ack:${runId}:${inFlight.has(runId)}`),
    waitRun: async () => {
      calls.push(`waiting:${inFlight.has("r1")}`);
      return { status: "ok", reply: "done" } as TurnResult;
    },
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({ core: c, channel: channel(log), body: baseBody, mode: "stream", inFlightRuns: inFlight });
  assert.deepEqual(calls, ["ref:r1:s1", "waiting:true", "ack:r1:true"]);
  assert.equal(inFlight.size, 0);
});

test("the in-process reply acks its run delivery only after it was delivered", async () => {
  const calls: string[] = [];
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const broken: ReplyChannel = {
    ...channel(log),
    async send() {
      return {
        id: "s1",
        edit: async () => {
          throw new Error("discord down");
        },
        delete: async () => {},
      };
    },
  };
  const c = {
    ...core({}),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => void calls.push("ack"),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({ core: c, channel: broken, body: baseBody, mode: "stream", inFlightRuns: new Set() });
  assert.deepEqual(calls, []);
});

test("spine mode posts nothing itself when the agent spoke through deliveries", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = { ...core({ wait: async () => ({ status: "silent" }) }) } as unknown as SurfaceCoreClient;
  await runDiscordTurn({ core: c, channel: channel(log), body: baseBody, mode: "spine", inFlightRuns: new Set() });
  assert.deepEqual(log.sent, []);
});

test("spine mode posts a refusal, because core has nothing to deliver", async () => {
  const log: Log = { sent: [], edits: [], deleted: 0, files: [] };
  const c = {
    ...core({
      submit: async () => ({
        status: "refused",
        reason: "internal-only: shared audience includes a non-internal participant",
      }),
    }),
  } as unknown as SurfaceCoreClient;
  await runDiscordTurn({ core: c, channel: channel(log), body: baseBody, mode: "spine", inFlightRuns: new Set() });
  assert.deepEqual(log.sent, [REFUSED_GUEST_TEXT]);
});
