import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSurfaceCoreClient,
  readOutgoingAttachment,
  type SurfaceCoreClientDeps,
} from "../src/api/surface-core-client.ts";
import type { TurnRequest } from "../src/types.ts";

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
