import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createDeliveryStore, isPersonAddressed } from "../src/delivery/delivery-store.ts";
import { createDiscordPrincipalRoute, withPrincipalRouting } from "../src/delivery/principal-routing.ts";
import { linkedDiscordUserIds } from "../src/api/discord-core-client.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { principalDestination, relaySenderAttribution } from "../src/reach/reach.ts";
import { createPrincipalLinkService, type PrincipalLinkService } from "../src/identity/principal-links.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { DISCORD_DM_DELIVERY_TYPE, discordExternalId } from "../src/discord/config.ts";
import { createDiscordDispatcher, DISCORD_DELIVERY_CLAIM_MS, type DeliveryGuard } from "../src/discord/deliveries.ts";
import { createCardRenderer } from "../src/discord/approval-cards.ts";
import type { DiscordSender } from "../src/discord/sender.ts";
import type { Delivery, PendingApprovalRecord } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const toDiscord = async (p: string) => (p === "ana@acme.com" ? DISCORD_DM_DELIVERY_TYPE : null);

afterEach(() => {
  installPrincipalLinks(null);
});

test("person-addressed notices keep the original principal row and enqueue a discord-dm copy", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), toDiscord);
  const result = await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), keychainAskId: "k1" },
    text: "hi",
    idempotencyKey: "k1",
  });
  assert.equal(result.idempotencyKey, "k1");
  assert.equal(result.destination.type, "principal");

  await store.enqueue({
    destination: principalDestination("bob@acme.com", "ana@acme.com"),
    text: "hi",
    idempotencyKey: "k2",
  });
  await store.enqueue({ destination: { type: "slack", target: "C1" }, text: "hi", idempotencyKey: "k3" });

  const principalPending = await store.pending("principal");
  assert.deepEqual(
    principalPending.map((d) => d.idempotencyKey),
    ["k1", "k2"],
  );

  const discordPending = await store.pending(DISCORD_DM_DELIVERY_TYPE);
  assert.equal(discordPending.length, 1);
  const copy = discordPending[0]!;
  assert.equal(copy.idempotencyKey, "k1:discord-dm");
  assert.equal(copy.destination.type, DISCORD_DM_DELIVERY_TYPE);
  assert.equal(copy.destination.target, "ana@acme.com");
  assert.equal(copy.destination.keychainAskId, "k1");
  assert.equal(copy.destination.informational, true);

  assert.deepEqual(
    (await store.pending("slack")).map((d) => d.idempotencyKey),
    ["k3"],
  );
});

test("principal destinations with react, delete, or editRef do not produce a discord-dm copy", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), toDiscord);
  await store.enqueue({
    destination: {
      ...principalDestination("ana@acme.com", "bob@acme.com"),
      react: { messageTs: "123.456", emoji: "thumbsup" },
    },
    text: "",
    idempotencyKey: "k-react",
  });
  await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), delete: { messageTs: "123.456" } },
    text: "",
    idempotencyKey: "k-delete",
  });
  await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), editRef: "123.456" },
    text: "updated text",
    idempotencyKey: "k-edit",
  });
  await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "plain message",
    idempotencyKey: "k-plain",
  });

  const principalPending = await store.pending("principal");
  assert.equal(principalPending.length, 4);

  const discordPending = await store.pending(DISCORD_DM_DELIVERY_TYPE);
  assert.equal(discordPending.length, 1);
  assert.equal(discordPending[0]!.idempotencyKey, "k-plain:discord-dm");
});

test("non-principal destinations never produce a discord-dm copy even when the route returns discord-dm", async () => {
  const alwaysDiscord = async () => DISCORD_DM_DELIVERY_TYPE;
  const store = withPrincipalRouting(createDeliveryStore(), alwaysDiscord);
  await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "slack message",
    idempotencyKey: "k-slack",
  });
  await store.enqueue({
    destination: { type: "web", target: "web:user:thread" },
    text: "web message",
    idempotencyKey: "k-web",
  });
  await store.enqueue({
    destination: { type: "group", target: "G1" },
    text: "group message",
    idempotencyKey: "k-group",
  });

  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
  assert.equal((await store.pending("slack")).length, 1);
  assert.equal((await store.pending("web")).length, 1);
  assert.equal((await store.pending("group")).length, 1);
});

test("a Slack request's approval card stays on Slack with personal notices on", async () => {
  const deliveries = withPrincipalRouting(createDeliveryStore(), async () => DISCORD_DM_DELIVERY_TYPE);
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), deliveries);
  await approvals.put("A9", {
    sessionId: "s",
    command: "ls",
    createdAt: 1,
    request: {
      surface: "slack",
      actor: { externalId: "ana@acme.com" },
      conversation: { kind: "dm", threadRef: "dm:D1" },
      text: "t",
    },
  } as PendingApprovalRecord);
  assert.equal((await deliveries.pending("principal")).length, 1);
  assert.deepEqual(await deliveries.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("command-approval cards are never copied even when directly enqueued", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), async () => DISCORD_DM_DELIVERY_TYPE);
  await store.enqueue({
    destination: {
      type: "principal",
      target: "ana@acme.com",
      commandApprovalId: "apr-42",
    },
    text: "approve me",
    idempotencyKey: "direct-approval",
  });
  const pendingPrincipal = await store.pending("principal");
  assert.equal(pendingPrincipal.length, 1);
  assert.equal(pendingPrincipal[0]!.idempotencyKey, "direct-approval");
  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("a route error falls back to enqueueing the original principal row without dropping it", async () => {
  const failingRoute = async () => {
    throw new Error("store failure");
  };
  const store = withPrincipalRouting(createDeliveryStore(), failingRoute);
  await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "resilient notice",
    idempotencyKey: "resilient-key",
  });
  const pending = await store.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.idempotencyKey, "resilient-key");
  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("deploy-access copy renders without components while keychain copy keeps buttons", async () => {
  const renderer = createCardRenderer({
    getApproval: async () => null,
    keychainApprovals: {
      get: async (askId: string) => ({
        service: "aws",
        accountLabel: "prod",
        conversation: "dm",
        askId,
      }),
    } as never,
  });

  const deployCopy: Delivery = {
    id: "00000000-0000-0000-0000-000000000001",
    destination: {
      type: DISCORD_DM_DELIVERY_TYPE,
      target: "ana@acme.com",
      deploymentAccess: { deploymentId: "dep-1", requesterId: "bob@acme.com" },
      informational: true,
    },
    text: "Deploy access requested for dep-1",
    idempotencyKey: "dep-copy",
    createdAt: 1000,
    deliveredAt: null,
  };
  const deployResult = await renderer(deployCopy);
  assert.ok(deployResult);
  assert.equal(deployResult.components, undefined);
  assert.equal(deployResult.content, "Deploy access requested for dep-1");

  const keychainCopy: Delivery = {
    id: "00000000-0000-0000-0000-000000000002",
    destination: {
      type: DISCORD_DM_DELIVERY_TYPE,
      target: "ana@acme.com",
      keychainAskId: "ask-1",
      informational: true,
    },
    text: "Keychain ask",
    idempotencyKey: "key-copy",
    createdAt: 1000,
    deliveredAt: null,
  };
  const keychainResult = await renderer(keychainCopy);
  assert.ok(keychainResult);
  assert.equal(keychainResult.components?.length, 1);
});

test("isPersonAddressed covers principal and discord-dm across delivery-store thread recording", async () => {
  assert.equal(isPersonAddressed({ type: "principal" }), true);
  assert.equal(isPersonAddressed({ type: DISCORD_DM_DELIVERY_TYPE }), true);
  assert.equal(isPersonAddressed({ type: "slack" }), false);

  const store = createDeliveryStore();
  const dPrincipal = await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "principal text",
    idempotencyKey: "p1",
  });
  const dDiscord = await store.enqueue({
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com" },
    text: "discord text",
    idempotencyKey: "p2",
  });

  await store.recordRecipientThread(dPrincipal.id, "slack:dm:D1", 1000);
  await store.recordRecipientThread(dDiscord.id, "discord:dm:12345", 2000);

  const slackMatches = await store.listByRecipientThread("slack:dm:D1");
  assert.equal(slackMatches.length, 1);
  assert.equal(slackMatches[0]!.id, dPrincipal.id);

  const discordMatches = await store.listByRecipientThread("discord:dm:12345");
  assert.equal(discordMatches.length, 1);
  assert.equal(discordMatches[0]!.id, dDiscord.id);
});

test("relaySenderAttribution formats attribution string and discord dispatcher renders it", async () => {
  assert.equal(relaySenderAttribution("@charlie"), "Sent for @charlie");
  assert.equal(relaySenderAttribution("charlie"), "Sent for @charlie");
  assert.equal(relaySenderAttribution(undefined), null);

  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}`);
      return { id: "m1" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    openDm: async (userId) => {
      log.push(`openDm:${userId}`);
      return "dm-chan-42";
    },
  };
  const deliveryRow: Delivery = {
    id: "deliv-relay",
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com", relaySender: "bob@acme.com" },
    text: "relayed message",
    idempotencyKey: "pnotice-relay",
    createdAt: 1000,
    deliveredAt: null,
  };
  const core = {
    claimDeliveries: async (surface: string) => (surface === DISCORD_DM_DELIVERY_TYPE ? [deliveryRow] : []),
    ackDelivery: async (id: string) => {
      log.push(`ack:${id}`);
    },
    reportDeliveryUndeliverable: async () => {},
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const guard: DeliveryGuard = {
    mayPost: async () => ({ ok: true }),
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard,
    inFlightRuns: new Set<string>(),
    recipientFor: () => "discord-user-111",
    now: () => 100_000,
  });
  await dispatcher.drain();
  assert.deepEqual(log, [
    "openDm:discord-user-111",
    "send:dm-chan-42:relayed message\n\nSent for @bob@acme.com",
    "ack:deliv-relay",
  ]);
});

function installationStatus(opts: { configured: boolean; disabled: boolean; principalDeliveries: boolean }) {
  return {
    status: async () => ({
      configured: opts.configured,
      disabled: opts.disabled,
      principalDeliveries: opts.principalDeliveries,
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      oauthConfigured: false,
    }),
    get: async () => {
      throw new Error("get() must not be called");
    },
  };
}
const linked = (p: string) => (p === "ana@acme.com" ? ["111"] : []);

test("createDiscordPrincipalRoute uses status alone without calling decrypting get", async () => {
  const on = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true, disabled: false, principalDeliveries: true }),
    environmentConfigured: false,
    linkedDiscordUserIds: linked,
  });
  const off = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true, disabled: false, principalDeliveries: false }),
    environmentConfigured: false,
    linkedDiscordUserIds: linked,
  });
  const env = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: false, disabled: false, principalDeliveries: true }),
    environmentConfigured: true,
    linkedDiscordUserIds: linked,
  });
  const disconnected = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: false, disabled: true, principalDeliveries: true }),
    environmentConfigured: true,
    linkedDiscordUserIds: linked,
  });
  const none = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: false, disabled: false, principalDeliveries: true }),
    environmentConfigured: false,
    linkedDiscordUserIds: linked,
  });
  assert.equal(await on("ana@acme.com"), DISCORD_DM_DELIVERY_TYPE);
  assert.equal(await on("bob@acme.com"), null);
  assert.equal(await off("ana@acme.com"), null);
  assert.equal(await env("ana@acme.com"), DISCORD_DM_DELIVERY_TYPE);
  assert.equal(await disconnected("ana@acme.com"), null);
  assert.equal(await none("ana@acme.com"), null);
});

test("linkedDiscordUserIds extracts linked discord user ids from principal links", async () => {
  const links: PrincipalLinkService = createPrincipalLinkService();
  installPrincipalLinks(links);
  await links.link({
    principalId: discordExternalId("discord-456"),
    canonicalId: "ana@acme.com",
    evidence: "oauth",
    linkedBy: "ana@acme.com",
  });
  await links.link({
    principalId: "slack:U999",
    canonicalId: "ana@acme.com",
    evidence: "slack-link",
    linkedBy: "ana@acme.com",
  });
  assert.deepEqual(linkedDiscordUserIds("ana@acme.com"), ["discord-456"]);
  assert.deepEqual(linkedDiscordUserIds("unlinked@acme.com"), []);
});

test("withPrincipalRouting feeds discord-dm copies to the discord dispatcher", async () => {
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}`);
      return { id: "m1" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    openDm: async (userId) => {
      log.push(`openDm:${userId}`);
      return "dm-chan-42";
    },
  };
  const baseStore = createDeliveryStore();
  const store = withPrincipalRouting(baseStore, toDiscord);

  await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "personal notice text",
    idempotencyKey: "pnotice-1",
  });

  const core = {
    claimDeliveries: async (surface: string, claimMs: number) => {
      assert.equal(claimMs, DISCORD_DELIVERY_CLAIM_MS);
      return store.claimPending(surface, claimMs);
    },
    ackDelivery: async (id: string) => {
      log.push(`ack:${id}`);
      await store.ack(id, Date.now());
    },
    reportDeliveryUndeliverable: async (id: string, reason: string) => {
      log.push(`undeliverable:${id}:${reason}`);
    },
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const guard: DeliveryGuard = {
    mayPost: async (channelId) => {
      log.push(`mayPost:${channelId}`);
      return { ok: true };
    },
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard,
    inFlightRuns: new Set<string>(),
    recipientFor: (t) => (t === "ana@acme.com" ? "discord-user-111" : null),
    now: () => 100_000,
  });
  await dispatcher.drain();

  assert.equal(log[0], "openDm:discord-user-111");
  assert.equal(log[1], "mayPost:dm-chan-42");
  assert.equal(log[2], "send:dm-chan-42:personal notice text");
  assert.match(log[3]!, /^ack:/);

  const pendingPrincipal = await store.pending("principal");
  assert.equal(pendingPrincipal.length, 1);
  assert.equal(pendingPrincipal[0]!.idempotencyKey, "pnotice-1");

  const pendingDiscord = await store.pending(DISCORD_DM_DELIVERY_TYPE);
  assert.equal(pendingDiscord.length, 0);
});

test("buildApp person-addressed enqueue with linked alias and notices on yields both principal row and discord-dm copy", async () => {
  const built = buildApp(testConfig({ discordEnvironmentConfigured: true }));
  await built.principalLinks.link({
    principalId: discordExternalId("discord-user-888"),
    canonicalId: "ana@acme.com",
    evidence: "oauth",
    linkedBy: "ana@acme.com",
  });

  await built.deliveries.enqueue({
    destination: principalDestination("ana@acme.com", "system"),
    text: "buildApp notice",
    idempotencyKey: "ba-1",
  });

  const principalRows = await built.deliveries.pending("principal");
  assert.equal(principalRows.length, 1);
  assert.equal(principalRows[0]!.idempotencyKey, "ba-1");

  const discordRows = await built.deliveries.pending(DISCORD_DM_DELIVERY_TYPE);
  assert.equal(discordRows.length, 1);
  assert.equal(discordRows[0]!.idempotencyKey, "ba-1:discord-dm");
  assert.equal(discordRows[0]!.destination.type, DISCORD_DM_DELIVERY_TYPE);
  assert.equal(discordRows[0]!.destination.target, "ana@acme.com");
});

test("recordPrincipalDelivery records recipient thread for discord-dm deliveries", async () => {
  const built = buildApp(testConfig());
  const delivery = await built.deliveries.enqueue({
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com" },
    text: "discord dm text",
    idempotencyKey: "test-rec-1",
  });
  await built.app.recordPrincipalDelivery(delivery.id, "discord:dm:channel-99");
  const threadDeliveries = await built.deliveries.listByRecipientThread("discord:dm:channel-99");
  assert.equal(threadDeliveries.length, 1);
  assert.equal(threadDeliveries[0]!.id, delivery.id);
});
