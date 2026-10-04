import assert from "node:assert/strict";
import { test } from "node:test";
import { cardCustomId, createCardRenderer, parseCardCustomId } from "../src/discord/approval-cards.ts";
import type { Delivery } from "../src/types.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const row = (destination: Partial<Delivery["destination"]>, text = "Approval needed: ls"): Delivery =>
  ({
    id: UUID,
    text,
    idempotencyKey: "k",
    createdAt: 0,
    deliveredAt: null,
    destination: { type: "discord-dm", target: "discord:111", ...destination },
  }) as Delivery;
const buttons = (m: { components?: readonly unknown[] } | null) =>
  (m?.components ?? []).flatMap(
    (r) => (r as { toJSON(): { components: Array<{ custom_id: string; label: string }> } }).toJSON().components,
  );

test("custom ids round-trip and fit Discord's limit", () => {
  const id = cardCustomId("cmd", "session", UUID);
  assert.ok(id.length <= 100);
  assert.deepEqual(parseCardCustomId(id), { kind: "cmd", action: "session", deliveryId: UUID });
});

test("unknown kinds, actions and malformed ids are rejected", () => {
  assert.equal(parseCardCustomId("qm:cmd:nuke:" + UUID), null);
  assert.equal(parseCardCustomId("qm:zzz:once:" + UUID), null);
  assert.equal(parseCardCustomId("qm:cmd:once:not-a-uuid"), null);
  assert.equal(parseCardCustomId("other"), null);
});

test("a command approval renders four buttons, minus modes the grant forbids", async () => {
  const render = createCardRenderer({
    getApproval: async () => ({
      requestId: "A1",
      command: "rm -rf build",
      reason: "destructive",
      grantModes: { session: true, always: false },
    }),
  } as never);
  const card = await render(row({ commandApprovalId: "A1" }));
  assert.match(card!.content!, /rm -rf build/);
  assert.deepEqual(
    buttons(card).map((b) => b.custom_id),
    [
      "qm:cmd:once:0f8fad5b-d9cb-469f-a165-70867728950e",
      "qm:cmd:session:0f8fad5b-d9cb-469f-a165-70867728950e",
      "qm:cmd:deny:0f8fad5b-d9cb-469f-a165-70867728950e",
    ],
  );
});

test("a vanished approval renders the expiry note with no buttons", async () => {
  const render = createCardRenderer({ getApproval: async () => null } as never);
  const card = await render(row({ commandApprovalId: "A1" }));
  assert.equal(card!.content, "That approval request is no longer pending.");
  assert.deepEqual(buttons(card), []);
});

test("deploy-access and keychain rows render their own buttons; plain rows render nothing", async () => {
  const render = createCardRenderer({
    getApproval: async () => null,
    keychainApprovals: {
      get: async () => ({ ask: { id: "k1", status: "pending" }, service: "github", conversation: "#eng" }),
      decide: async () => {
        throw new Error("unused");
      },
    },
  } as never);
  const dep = await render(
    row({ deploymentAccess: { deploymentId: "d", requesterId: "bob@acme.com" } }, "bob wants access"),
  );
  assert.deepEqual(
    buttons(dep).map((b) => b.label),
    ["Approve", "Decline"],
  );
  const key = await render(row({ keychainAskId: "k1", target: "ana@acme.com" }));
  assert.deepEqual(
    buttons(key).map((b) => b.label),
    ["Allow once", "Always allow", "Deny"],
  );
  assert.equal(await render(row({})), null);
});

test("a keychain ask that is no longer pending renders plain status text without buttons", async () => {
  const view = (ask: object, mode?: string) => ({ ask, service: "github", conversation: "#eng", mode });
  const views = [
    [view({ id: "k1", status: "approved" }, "once"), "Allowed once."],
    [view({ id: "k1", status: "approved" }, "standing"), "Always allowed."],
    [view({ id: "k1", status: "declined" }), "Denied."],
  ] as const;
  for (const [v, text] of views) {
    const render = createCardRenderer({
      getApproval: async () => null,
      keychainApprovals: { get: async () => v },
    } as never);
    const card = await render(row({ keychainAskId: "k1", target: "ana@acme.com" }));
    assert.equal(card!.content, text);
    assert.deepEqual(buttons(card), []);
  }
});
