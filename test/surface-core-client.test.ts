import assert from "node:assert/strict";
import { test } from "node:test";
import { createSurfaceCoreClient, type SurfaceCoreClientDeps } from "../src/api/surface-core-client.ts";
import type { TurnRequest } from "../src/types.ts";

function fakeDeps(seen: TurnRequest[]): SurfaceCoreClientDeps {
  return {
    app: {
      turn: async (req: TurnRequest) => {
        seen.push(req);
        return { status: "ok", reply: "hi" };
      },
    },
    runs: { onTerminal: () => {} },
    turnStream: { snapshot: (runId: string) => (runId === "r1" ? "partial text" : null) },
    tasks: { list: async () => [] },
    blobTransfer: {},
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
