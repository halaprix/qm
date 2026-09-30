import assert from "node:assert/strict";
import { test } from "node:test";
import { createStakeTracker, hasBotStake, THREAD_NO_STAKE_TTL_MS } from "../src/discord/thread-stake.ts";

test("the bot has a stake if it posted or was mentioned", () => {
  assert.equal(hasBotStake([{ authorId: "9", mentionedUserIds: [] }], "9"), true);
  assert.equal(hasBotStake([{ authorId: "1", mentionedUserIds: ["9"] }], "9"), true);
  assert.equal(hasBotStake([{ authorId: "1", mentionedUserIds: [] }], "9"), false);
});

test("positive stakes stick; negatives expire; fetch failures mean no stake", async () => {
  let t = 0;
  let history = [{ authorId: "1", mentionedUserIds: [] as string[] }];
  let fetches = 0;
  const tracker = createStakeTracker({
    recent: async (id) => {
      fetches += 1;
      if (id === "boom") throw new Error("x");
      return history;
    },
    now: () => t,
  });
  assert.equal(await tracker.has("t1", "9"), false);
  history = [{ authorId: "9", mentionedUserIds: [] }];
  assert.equal(await tracker.has("t1", "9"), false);
  t = THREAD_NO_STAKE_TTL_MS + 1;
  assert.equal(await tracker.has("t1", "9"), true);
  assert.equal(fetches, 2);
  tracker.mark("t2");
  assert.equal(await tracker.has("t2", "9"), true);
  assert.equal(await tracker.has("boom", "9"), false);
});
