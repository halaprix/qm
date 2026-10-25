import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceToolDeps } from "../src/core/orchestrator/surface-tools.ts";

const OLD_18_DIGIT = "999999999999999999";
const NEW_19_DIGIT = "1000000000000000005";
const NEWER_19_DIGIT = "1000000000000000009";

function tools(messages: Array<{ ts: string; threadTs?: string }>, surface = "discord") {
  return createSurfaceToolDeps({
    deps: { deliveries: {}, surfaceContext: { pull: async () => ({ messages }) } },
    input: { surface, surfaceTools: true, origin: { kind: "human" } },
    actor: { id: "reader@example.com" },
    conversation: { kind: "dm" },
    defaultDestination: { type: surface, target: "c1" },
  } as any)!;
}

test("whats_new counts a 19-digit id as newer than an 18-digit since cursor and reports the numeric latest", async () => {
  const result = await tools([{ ts: OLD_18_DIGIT }, { ts: NEW_19_DIGIT }, { ts: NEWER_19_DIGIT }]).whatsNew({
    since: OLD_18_DIGIT,
  });
  assert.equal(result.ok && result.hereNew, 2);
  assert.equal(result.ok && result.latest, NEWER_19_DIGIT);
});

test("whats_new reports the numerically newest id even when an older id sorts later as text", async () => {
  const result = await tools([{ ts: NEW_19_DIGIT }, { ts: OLD_18_DIGIT }]).whatsNew();
  assert.equal(result.ok && result.latest, NEW_19_DIGIT);
});

test("whats_new rejects a since that is neither a Discord id nor a Slack ts instead of counting everything as new", async () => {
  const msgs = [{ ts: OLD_18_DIGIT }, { ts: NEW_19_DIGIT }];
  for (const since of ["~zz", "17"]) {
    const result = await tools(msgs).whatsNew({ since });
    assert.equal(result.ok, false);
  }
});

test("Slack timestamps of different lengths compare as time, not by length", async () => {
  const result = await tools([{ ts: "1700000000.5" }, { ts: "1700000000.000100" }]).whatsNew({
    since: "1700000000.000100",
  });
  assert.equal(result.ok && result.hereNew, 1);
  assert.equal(result.ok && result.latest, "1700000000.5");
});

test("whats_new accepts a since given as the ~token the model sees, the same as the raw id", async () => {
  const discord = [{ ts: OLD_18_DIGIT }, { ts: NEW_19_DIGIT }, { ts: NEWER_19_DIGIT }];
  for (const since of [OLD_18_DIGIT, "~7lieexzx4kxr"]) {
    const result = await tools(discord).whatsNew({ since });
    assert.equal(result.ok && result.hereNew, 2, since);
  }
  const slack = [{ ts: "1700000000.000100" }, { ts: "1700000000.5" }];
  for (const since of ["1700000000.000100", "~gqll7vatt0"]) {
    const result = await tools(slack, "slack").whatsNew({ since });
    assert.equal(result.ok && result.hereNew, 1, since);
  }
});
