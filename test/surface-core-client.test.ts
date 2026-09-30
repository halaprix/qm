import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSurfaceCoreClient,
  readOutgoingAttachment,
  type SurfaceCoreClientDeps,
} from "../src/api/surface-core-client.ts";
import type { Delivery, SurfaceContextRequest, TurnRequest } from "../src/types.ts";

function fakeDeps(seen: TurnRequest[] = []): SurfaceCoreClientDeps {
  return {
    app: {
      turn: async (req: TurnRequest) => {
        seen.push(req);
        return { status: "ok", reply: "hi" };
      },
      openFileForViewer: async (artifactId: string, viewerId: string) => {
        if (artifactId === "a1" && viewerId === "u1") {
          return {
            stream: (async function* () {
              yield Buffer.from("from-artifact");
            })(),
          };
        }
        return null;
      },
    },
    runs: { onTerminal: () => {} },
    turnStream: { snapshot: (runId: string) => (runId === "r1" ? "partial text" : null) },
    tasks: { list: async () => [] },
    blobTransfer: {
      open: async (blobId: string) => {
        if (blobId === "b-ok") {
          return {
            stream: (async function* () {
              yield Buffer.from("from-blob");
            })(),
          };
        }
        return null;
      },
    },
  } as unknown as SurfaceCoreClientDeps;
}

test("submitTurn stamps the surface it was created for", async () => {
  const seen: TurnRequest[] = [];
  const client = createSurfaceCoreClient(fakeDeps(seen), "discord");
  await client.submitTurn({
    actor: { externalId: "discord:1" },
    conversation: { kind: "dm", threadRef: "discord:dm:9" },
    text: "hello",
  });
  assert.equal(seen[0]!.surface, "discord");
});

test("streamSnapshot reads the live turn stream", () => {
  const client = createSurfaceCoreClient(fakeDeps([]), "discord");
  assert.equal(client.streamSnapshot("r1"), "partial text");
  assert.equal(client.streamSnapshot("r2"), null);
});

test("readOutgoingAttachment reads blob when available", async () => {
  const client = createSurfaceCoreClient(fakeDeps(), "discord");
  const buf = await readOutgoingAttachment(client, {
    name: "f.txt",
    mimetype: "text/plain",
    sizeBytes: 9,
    blobId: "b-ok",
  });
  assert.equal(buf.toString(), "from-blob");
});

test("readOutgoingAttachment falls back to artifact when blob is missing", async () => {
  const client = createSurfaceCoreClient(fakeDeps(), "discord");
  const buf = await readOutgoingAttachment(client, {
    name: "f.txt",
    mimetype: "text/plain",
    sizeBytes: 13,
    blobId: "b-missing",
    artifactId: "a1",
    artifactViewerId: "u1",
  });
  assert.equal(buf.toString(), "from-artifact");
});

test("readOutgoingAttachment throws when blob is missing and no artifact is provided", async () => {
  const client = createSurfaceCoreClient(fakeDeps(), "discord");
  await assert.rejects(
    () =>
      readOutgoingAttachment(client, {
        name: "f.txt",
        mimetype: "text/plain",
        sizeBytes: 13,
        blobId: "b-missing",
      }),
    /blob b-missing not found/,
  );
});

function liftedDeps(record: string[]): SurfaceCoreClientDeps {
  const listeners: Array<(r: SurfaceContextRequest) => void> = [];
  return {
    ...fakeDeps([]),
    app: {
      ...fakeDeps([]).app,
      pendingDeliveries: async (type: string, claimMs: number) => {
        record.push(`claim:${type}:${claimMs}`);
        return [] as Delivery[];
      },
      ackDeliveryByKey: async (key: string) => void record.push(`ackKey:${key}`),
      ingestSurfaceEvents: async (_e: unknown, surface: string) => {
        record.push(`ingest:${surface}`);
        return { upserted: 0 };
      },
      pendingContextRequests: async (source: string) => {
        record.push(`pending:${source}`);
        return [];
      },
      onContextRequestCreated: (l: (r: SurfaceContextRequest) => void) => {
        listeners.push(l);
        return () => {};
      },
      emitContext: (r: SurfaceContextRequest) => listeners.forEach((l) => l(r)),
    },
    identity: {} as never,
    deliveries: { onEnqueue: () => () => {}, get: async () => null } as never,
    leaderLease: {
      hold: async (key: string, fn: (lost: Promise<void>) => Promise<unknown>) => {
        record.push(`hold:${key}`);
        return fn(new Promise(() => {}));
      },
    },
  } as unknown as SurfaceCoreClientDeps;
}

test("lifted delivery and context methods are keyed by the client's surface", async () => {
  const record: string[] = [];
  const deps = liftedDeps(record);
  const client = createSurfaceCoreClient(deps, "discord");
  await client.claimDeliveries("discord", 15_000);
  await client.ackRunDelivery("r9");
  await client.ingestSurfaceEvents([{ container: "c", ts: "1" }]);
  await client.pendingContextRequests();
  await client.holdDeliveryDispatch(async () => "ok");
  const seen: string[] = [];
  client.onContextRequest((r) => seen.push(r.source));
  (deps.app as unknown as { emitContext(r: SurfaceContextRequest): void }).emitContext({ source: "slack" } as never);
  (deps.app as unknown as { emitContext(r: SurfaceContextRequest): void }).emitContext({ source: "discord" } as never);
  assert.deepEqual(record, [
    "claim:discord:15000",
    "ackKey:run:r9",
    "ingest:discord",
    "pending:discord",
    "hold:discord:delivery-dispatch",
  ]);
  assert.deepEqual(seen, ["discord"]);
});

test("ingestSurfaceEvents with no events does not call core", async () => {
  const record: string[] = [];
  await createSurfaceCoreClient(liftedDeps(record), "discord").ingestSurfaceEvents([]);
  assert.deepEqual(record, []);
});
