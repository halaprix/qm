import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemberHydrator, MEMBER_HYDRATE_RETRY_BASE_MS } from "../src/discord/member-hydrator.ts";

function timers() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    fire: () =>
      pending
        .splice(0)
        .filter((t) => !t.cancelled)
        .forEach((t) => t.fn()),
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("guilds are not ready until their one full fetch succeeds", async () => {
  let fail = true;
  const fetched: string[] = [];
  const t = timers();
  const h = createMemberHydrator({
    guildIds: new Set(["900", "901"]),
    fetchAll: async (g) => {
      fetched.push(g);
      if (g === "901" && fail) throw new Error("gateway timeout");
    },
    setTimer: t.setTimer,
  });
  assert.equal(h.allReady(), false);
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
  assert.equal(h.ready("901"), false);
  assert.equal(h.allReady(), false);
  assert.equal(t.pending[0]!.ms, MEMBER_HYDRATE_RETRY_BASE_MS);
  fail = false;
  t.fire();
  await tick();
  assert.equal(h.allReady(), true);
  assert.deepEqual(fetched, ["900", "901", "901"]);
});

test("a disconnect makes every guild unknown until the next hydrate", async () => {
  const h = createMemberHydrator({ guildIds: new Set(["900"]), fetchAll: async () => {}, setTimer: timers().setTimer });
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
  h.invalidate();
  assert.equal(h.ready("900"), false);
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
});

test("stop cancels a pending retry", async () => {
  const t = timers();
  const h = createMemberHydrator({
    guildIds: new Set(["900"]),
    fetchAll: async () => {
      throw new Error("x");
    },
    setTimer: t.setTimer,
  });
  h.hydrate();
  await tick();
  h.stop();
  assert.equal(
    t.pending.every((p) => p.cancelled),
    true,
  );
});
