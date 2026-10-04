import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createDiscordInstallationStore,
  discordLinkRedirectUri,
  discordPluginConfigFromInstallation,
  DiscordInstallationError,
  parseDiscordSettings,
  type StoredDiscordInstallation,
  validateDiscordToken,
} from "../src/surfaces/discord-installation.ts";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.SECRET.TOKENVALUE";
const CLIENT_SECRET = "oauth-client-SECRET-value";
const BOT = { token: TOKEN, userId: "123456789012345678", tag: "qm#1", applicationId: "123456789012345678" };
const settings = {
  allowUserIds: ["123456789012345678"],
  guildIds: [],
  internalRoleIds: [],
  principalDeliveries: false,
};

test("the token and the OAuth client secret are encrypted at rest and absent from status", async () => {
  const map = createMemoryMap<unknown>();
  const store = createDiscordInstallationStore("acme", map as never, "k");
  const status = await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "admin" });
  for (const secret of [TOKEN, CLIENT_SECRET]) {
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(JSON.stringify(await map.entries()).includes(secret), false);
  }
  assert.equal(status.oauthConfigured, true);
  const got = (await store.get())!;
  assert.equal(got.botToken, TOKEN);
  assert.equal(got.oauthClientSecret, CLIENT_SECRET);
});

test("personal notices default to on", () => {
  assert.equal(parseDiscordSettings({}).principalDeliveries, true);
  assert.equal(parseDiscordSettings({ principalDeliveries: false }).principalDeliveries, false);
});

test("parseDiscordSettings rejects when internalRoleIds contains a guild id", () => {
  assert.throws(
    () =>
      parseDiscordSettings({
        guildIds: ["123456789012345678"],
        internalRoleIds: ["123456789012345678"],
      }),
    (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("updating settings without a token keeps the stored token", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  await store.set({ ...settings, guildIds: ["900000000000000000"], updatedBy: "a" });
  const got = (await store.get())!;
  assert.equal(got.botToken, TOKEN);
  assert.deepEqual(got.guildIds, ["900000000000000000"]);
});

test("a first save without a token is refused", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  await assert.rejects(store.set({ ...settings, updatedBy: "a" }), /bot token is required/);
});

test("delete leaves a disabled tombstone", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  await store.delete("a");
  assert.equal(await store.get(), null);
  assert.equal((await store.status()).disabled, true);
});

test("settings-only set fails if update callback sees a disabled record", async () => {
  const map = createMemoryMap<StoredDiscordInstallation>();
  const store = createDiscordInstallationStore("acme", map, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  const realUpdate = map.update!.bind(map);
  map.update = (async (id: string, fn: (v: StoredDiscordInstallation) => StoredDiscordInstallation) => {
    return realUpdate(id, () =>
      fn({ disabled: true, version: "v-disabled", updatedAt: Date.now(), updatedBy: "deleter" }),
    );
  }) as never;
  await assert.rejects(
    store.set({ ...settings, updatedBy: "a" }),
    (err: unknown) =>
      err instanceof DiscordInstallationError && err.status === 400 && /bot token is required/.test(err.message),
  );
});

test("a first set where update rejects leaves an active record and not a disabled placeholder", async () => {
  const map = createMemoryMap<StoredDiscordInstallation>();
  map.update = (async () => {
    throw new Error("db failure during update");
  }) as never;
  const store = createDiscordInstallationStore("acme", map, "k");
  await assert.rejects(store.set({ ...settings, bot: BOT, updatedBy: "a" }), /db failure during update/);
  const status = await store.status();
  assert.equal(status.disabled, false);
  const raw = await map.get("acme");
  assert.ok(raw);
  assert.equal(raw.disabled, false);
  assert.notEqual(raw.version, "initial");
});

test("a set without client secret reports oauthConfigured false", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  const status = await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  assert.equal(status.oauthConfigured, false);
});

test("changing application id drops stored oauth client secret", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "a" });
  assert.equal((await store.status()).oauthConfigured, true);
  const bot2 = { ...BOT, applicationId: "different-app-id" };
  const status = await store.set({ ...settings, bot: bot2, updatedBy: "a" });
  assert.equal(status.oauthConfigured, false);
  const got = await store.get();
  assert.equal(got?.oauthClientSecret, null);
});

test("keeping application id keeps stored oauth client secret", async () => {
  const store = createDiscordInstallationStore("acme", createMemoryMap() as never, "k");
  await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "a" });
  assert.equal((await store.status()).oauthConfigured, true);
  const botSameApp = { ...BOT, tag: "qm#2" };
  const status = await store.set({ ...settings, bot: botSameApp, updatedBy: "a" });
  assert.equal(status.oauthConfigured, true);
  const got = await store.get();
  assert.equal(got?.oauthClientSecret, CLIENT_SECRET);
});

test("settings reject non-snowflake ids", () => {
  assert.throws(() => parseDiscordSettings({ ...settings, guildIds: ["abc"] }), /Discord id/);
});

test("settings reject numeric ids with 400", () => {
  const parsed = JSON.parse('{"guildIds": [123456789012345678]}') as { guildIds: unknown[] };
  assert.throws(
    () => parseDiscordSettings({ ...settings, guildIds: parsed.guildIds }),
    (err: unknown) => err instanceof DiscordInstallationError && err.status === 400,
  );
});

test("validateDiscordToken maps 401 and 403 to 400 with fixed message without leaking token", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = (async () => new Response("{}", { status })) as typeof fetch;
    await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 400);
      assert.equal(err.message, "Discord rejected the bot token");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("validateDiscordToken maps 429 and 5xx to 502 without leaking token", async () => {
  for (const status of [429, 500, 502, 503]) {
    const fetchImpl = (async () => new Response("{}", { status })) as typeof fetch;
    await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 502);
      assert.equal(err.message, "Discord did not answer. Try again in a minute.");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("validateDiscordToken maps 200 with non-JSON body to 502 without leaking token", async () => {
  const fetchImpl = (async () => new Response("<html>Bad Gateway</html>", { status: 200 })) as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
});

test("validateDiscordToken maps 200 with malformed body to 502 without leaking token", async () => {
  const fetchImpl = (async (u: string) => {
    return new URL(u).pathname.endsWith("/applications/@me")
      ? Response.json({ id: null })
      : Response.json({ id: "42", username: "qm" });
  }) as unknown as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
});

test("a valid token returns the bot identity and the application id", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => {
    seen.push(`${new URL(u).pathname} ${String((init.headers as Record<string, string>).Authorization)}`);
    return new URL(u).pathname.endsWith("/applications/@me")
      ? Response.json({ id: "4242" })
      : Response.json({ id: "42", username: "qm", discriminator: "0" });
  }) as unknown as typeof fetch;
  assert.deepEqual(await validateDiscordToken(TOKEN, fetchImpl), { userId: "42", tag: "qm", applicationId: "4242" });
  assert.deepEqual(seen, [`/api/v10/users/@me Bot ${TOKEN}`, `/api/v10/oauth2/applications/@me Bot ${TOKEN}`]);
});

test("validateDiscordToken fails closed on timeout or network error without leaking token", async () => {
  let seenSignal: unknown;
  let seenRedirect: unknown;
  const timeoutFetch = (async (_u: string, init?: RequestInit) => {
    seenSignal = init?.signal;
    seenRedirect = init?.redirect;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as unknown as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, timeoutFetch), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenRedirect, "error");
});

test("discordLinkRedirectUri formats portal redirect URL", () => {
  assert.equal(discordLinkRedirectUri("https://portal.example.com"), "https://portal.example.com/settings");
  assert.equal(discordLinkRedirectUri("https://portal.example.com///"), "https://portal.example.com/settings");
});

test("discordPluginConfigFromInstallation maps installation fields", () => {
  const cfg = discordPluginConfigFromInstallation({
    botToken: TOKEN,
    botUserId: "123456789012345678",
    botTag: "qm#0",
    applicationId: "123456789012345678",
    oauthClientSecret: CLIENT_SECRET,
    allowUserIds: ["123456789012345678"],
    guildIds: ["987654321098765432"],
    internalRoleIds: ["111222333444555666"],
    principalDeliveries: true,
    version: "v1",
  });
  assert.equal(cfg.botToken, TOKEN);
  assert.deepEqual([...cfg.allowUserIds], ["123456789012345678"]);
  assert.deepEqual([...cfg.guildIds], ["987654321098765432"]);
  assert.deepEqual([...cfg.internalRoleIds], ["111222333444555666"]);
});
