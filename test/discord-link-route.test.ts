import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, test, type TestContext } from "node:test";
import {
  discordLinkRoutes,
  DISCORD_LINK_STATE_TTL_MS,
  type DiscordAccountLink,
} from "../src/api/routes/discord-link.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { orgId } from "../src/config.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService, PrincipalLinkError } from "../src/identity/principal-links.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const PROVEN = "111111111111111111";
const CLAIMED = "666666666666666666";
const TEST_NONCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_NONCE_HASH = createHash("sha256").update(TEST_NONCE).digest("hex");
afterEach(() => installPrincipalLinks(null));

interface FixtureOpts {
  internal?: Set<string>;
  portalUrl?: string;
  discordDown?: boolean;
  unparsableUser?: boolean;
  userRefusal?: boolean;
  missingAppId?: boolean;
  missingSecret?: boolean;
  hasExistingCredentials?: boolean;
  tokenStatus?: number;
  tokenBody?: unknown;
  meStatus?: number;
  meBody?: unknown;
}

async function fixture(t: TestContext, opts: FixtureOpts = {}) {
  const internal = opts.internal ?? new Set(["ana@acme.com", "bob@acme.com"]);
  const links = createPrincipalLinkService(createMemoryMap());
  installPrincipalLinks(links);
  const tokenCalls: string[] = [];
  const recordedAudits: Array<Record<string, unknown>> = [];
  const deps = {
    signingSecret: "test-signing-secret",
    portalUrl: opts.portalUrl ?? "https://agent.example",
    principalLinks: links,
    discordAccounts: createMemoryMap<DiscordAccountLink>(),
    keychain: {
      listByOwner: async (owner: string) =>
        opts.hasExistingCredentials && owner === `discord:${PROVEN}` ? [{ id: "key-1" }] : [],
    },
    identity: {
      refresh: async () => {},
      classify: (id: string) => ({ id, type: internal.has(id) ? "internal" : "guest" }),
    },
    auditLog: {
      record: (e: Record<string, unknown>) => {
        recordedAudits.push(e);
      },
    },
    discordInstallation: {
      get: async () => ({
        applicationId: opts.missingAppId ? "" : "4242",
        oauthClientSecret: opts.missingSecret ? "" : "client-secret",
      }),
    },
    discordInstallationFetch: (async (url: string, init: RequestInit) => {
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      if (opts.discordDown) throw new TypeError("fetch failed");
      const u = new URL(url);
      if (u.pathname.endsWith("/oauth2/token")) {
        const form = new URLSearchParams(String(init.body));
        const code = form.get("code") ?? "";
        tokenCalls.push(code);
        if (opts.tokenStatus !== undefined) {
          return new Response(JSON.stringify(opts.tokenBody ?? {}), {
            status: opts.tokenStatus,
            headers: { "content-type": "application/json" },
          });
        }
        if (form.get("client_secret") !== "client-secret" || (!code.startsWith("good") && code !== "good"))
          return new Response("{}", { status: 400 });
        const token = code === "good-b" ? "user-token-b" : "user-token";
        return Response.json({ access_token: token, token_type: "Bearer" });
      }
      if (u.pathname.endsWith("/users/@me")) {
        if (opts.unparsableUser) {
          return new Response("not-valid-json{", { status: 200, headers: { "content-type": "application/json" } });
        }
        if (opts.meStatus !== undefined) {
          return new Response(JSON.stringify(opts.meBody ?? {}), {
            status: opts.meStatus,
            headers: { "content-type": "application/json" },
          });
        }
        if (opts.userRefusal) {
          return new Response("{}", { status: 403 });
        }
        const auth = (init.headers as Record<string, string>).Authorization;
        if (auth === "Bearer user-token-b") {
          return Response.json({ id: "222222222222222222", username: "ana_b", discriminator: "0" });
        }
        return auth === "Bearer user-token"
          ? Response.json({ id: PROVEN, username: "ana_d", discriminator: "0" })
          : new Response("{}", { status: 401 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
  };
  let actor: Record<string, unknown> | null = null;
  let capability: Record<string, unknown> | null = null;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = discordLinkRoutes.find(
      (r) => "method" in r && r.method === req.method && r.path === parsedUrl.pathname,
    );
    const ctx = { req, res, deps, body: raw ? JSON.parse(raw) : {}, actor, capability } as unknown as ApiCtx;
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      await route.handle(ctx);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const call = async (
    method: string,
    path: string,
    as: { p?: string; imp?: string; capability?: boolean },
    body?: unknown,
  ) => {
    actor = as.p ? { p: as.p, exp: 9e12, ...(as.imp ? { imp: as.imp } : {}) } : null;
    capability = as.capability ? { actorId: as.p ?? "x" } : null;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const text = await res.text();
    let resBody: Record<string, unknown> | null;
    try {
      resBody = JSON.parse(text);
    } catch {
      resBody = null;
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: resBody,
      rawBody: text,
    };
  };
  const stateFor = async (p: string, nonceHash: string = TEST_NONCE_HASH) =>
    new URL(
      String((await call("POST", "/v1/discord/link/authorize", { p }, { nonceHash })).body!.url),
    ).searchParams.get("state")!;
  return { call, stateFor, links, tokenCalls, recordedAudits, deps };
}

test("authorize returns Discord's identify URL with the stored client id and redirect", async (t) => {
  const f = await fixture(t);
  const res = await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: TEST_NONCE_HASH });
  assert.equal(res.headers["cache-control"], "no-store");
  const url = new URL(String(res.body!.url));
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "4242");
  assert.equal(url.searchParams.get("scope"), "identify");
  assert.equal(url.searchParams.get("redirect_uri"), "https://agent.example/settings");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.ok(url.searchParams.get("state"));
});

test("a trailing slash on the portal URL never doubles in the redirect URI", async (t) => {
  const f = await fixture(t, { portalUrl: "https://agent.example/" });
  const url = new URL(
    String(
      (await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: TEST_NONCE_HASH })).body!
        .url,
    ),
  );
  assert.equal(url.searchParams.get("redirect_uri"), "https://agent.example/settings");
});

test("Discord being unreachable is a 502 and links nothing", async (t) => {
  const f = await fixture(t, { discordDown: true });
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 502);
  assert.deepEqual(await f.links.list(), []);
});

test("Discord returning an unparsable response is a 502 and links nothing", async (t) => {
  const f = await fixture(t, { unparsableUser: true });
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 502);
  assert.equal(done.body?.error, "discord_unavailable");
  assert.deepEqual(await f.links.list(), []);
});

test("Discord clean refusal in user fetch is a 400 oauth_failed and links nothing", async (t) => {
  const f = await fixture(t, { userRefusal: true });
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "oauth_failed");
  assert.deepEqual(await f.links.list(), []);
});

test("a web user cannot link a Discord id they did not prove via OAuth", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE, discordUserId: CLAIMED, id: CLAIMED },
  );
  assert.equal(done.status, 200);
  assert.deepEqual(
    (await f.links.list()).map((l) => [l.principalId, l.canonicalId]),
    [[`discord:${PROVEN}`, "ana@acme.com"]],
  );
  assert.match((await f.links.list())[0]!.evidence, /OAuth2 identify/);
});

test("a failed code exchange links nothing", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "forged", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "oauth_failed");
  assert.deepEqual(await f.links.list(), []);
});

test("a non-internal web user cannot self-link", async (t) => {
  const f = await fixture(t, { internal: new Set(["bob@acme.com"]) });
  assert.equal(
    (await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: TEST_NONCE_HASH })).status,
    403,
  );
  const state = await f.stateFor("bob@acme.com");
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/discord/link/complete",
        { p: "ana@acme.com" },
        { code: "good", state, nonce: TEST_NONCE },
      )
    ).status,
    403,
  );
  assert.deepEqual(await f.links.list(), []);
  assert.deepEqual(f.tokenCalls, []);
});

test("an inactive principal cannot self-link", async (t) => {
  const f = await fixture(t, { internal: new Set() });
  assert.equal((await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).status, 403);
  assert.equal((await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" })).status, 403);
  assert.equal((await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" })).status, 403);
});

test("a state minted for another principal is refused before any code exchange", async (t) => {
  const f = await fixture(t);
  const bobsState = await f.stateFor("bob@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: bobsState, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("a state with wrong purpose is refused", async (t) => {
  const f = await fixture(t);
  const state = await mintSignedPayload(
    {
      purpose: "other-purpose",
      principal: "ana@acme.com",
      org: orgId(),
      nonceHash: TEST_NONCE_HASH,
      exp: Date.now() + DISCORD_LINK_STATE_TTL_MS,
    },
    "test-signing-secret",
  );
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("a state with wrong org is refused", async (t) => {
  const f = await fixture(t);
  const state = await mintSignedPayload(
    {
      purpose: "discord-account-link",
      principal: "ana@acme.com",
      org: "different-org",
      nonceHash: TEST_NONCE_HASH,
      exp: Date.now() + DISCORD_LINK_STATE_TTL_MS,
    },
    "test-signing-secret",
  );
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("an expired state is refused", async (t) => {
  const f = await fixture(t);
  const state = await mintSignedPayload(
    {
      purpose: "discord-account-link",
      principal: "ana@acme.com",
      org: orgId(),
      nonceHash: TEST_NONCE_HASH,
      exp: Date.now() - 1000,
    },
    "test-signing-secret",
  );
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("a tampered or unsigned state is refused", async (t) => {
  const f = await fixture(t);
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: "tampered.state.payload", nonce: TEST_NONCE },
  );
  assert.equal(done.status, 400);
  assert.equal(done.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("missing state or code is refused", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const noCode = await f.call("POST", "/v1/discord/link/complete", { p: "ana@acme.com" }, { state, nonce: TEST_NONCE });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.body?.error, "invalid_link");
  const noState = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", nonce: TEST_NONCE },
  );
  assert.equal(noState.status, 400);
  assert.equal(noState.body?.error, "invalid_link");
  assert.deepEqual(f.tokenCalls, []);
});

test("impersonating and capability callers are refused", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/discord/link/authorize",
        { p: "ana@acme.com", imp: "admin" },
        { nonceHash: TEST_NONCE_HASH },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/discord/link/authorize",
        { p: "ana@acme.com", capability: true },
        { nonceHash: TEST_NONCE_HASH },
      )
    ).status,
    403,
  );
});

test("a Discord account linked to someone else cannot be taken over", async (t) => {
  const f = await fixture(t);
  await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: await f.stateFor("ana@acme.com"), nonce: TEST_NONCE },
  );
  const again = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "bob@acme.com" },
    { code: "good", state: await f.stateFor("bob@acme.com"), nonce: TEST_NONCE },
  );
  assert.equal(again.status, 409);
  assert.equal(again.body?.error, "already_linked");
  assert.equal((await f.links.list())[0]!.canonicalId, "ana@acme.com");
});

test("refuses to link when the Discord identity already owns credentials", async (t) => {
  const f = await fixture(t, { hasExistingCredentials: true });
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 409);
  assert.equal(done.body?.error, "established_account");
  assert.deepEqual(await f.links.list(), []);
});

test("re-linking to the same principal is idempotent", async (t) => {
  const f = await fixture(t);
  const first = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: await f.stateFor("ana@acme.com"), nonce: TEST_NONCE },
  );
  assert.equal(first.status, 200);
  assert.equal((await f.links.list()).length, 1);
  const second = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: await f.stateFor("ana@acme.com"), nonce: TEST_NONCE },
  );
  assert.equal(second.status, 200);
  assert.equal(second.body?.linked, true);
  assert.equal((await f.links.list()).length, 1);
});

test("status and self-unlink touch only the caller's own link", async (t) => {
  const f = await fixture(t);
  await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: await f.stateFor("ana@acme.com"), nonce: TEST_NONCE },
  );
  assert.deepEqual((await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body, {
    available: true,
    linked: true,
    canUnlink: true,
    tag: "ana_d",
  });
  assert.equal((await f.call("DELETE", "/v1/discord/link", { p: "bob@acme.com" })).status, 404);
  assert.equal((await f.links.list()).length, 1);
  assert.equal((await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" })).status, 200);
  assert.deepEqual(await f.links.list(), []);
  assert.equal((await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body!.linked, false);
});

test("self-unlink when not linked returns 404", async (t) => {
  const f = await fixture(t);
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 404);
  assert.equal(del.body?.error, "not_linked");
});

test("an admin-created link survives the user's self-unlink", async (t) => {
  const f = await fixture(t);
  await f.links.link({
    principalId: `discord:${PROVEN}`,
    canonicalId: "ana@acme.com",
    evidence: "verified by an administrator",
    linkedBy: "admin@acme.com",
  });
  await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: await f.stateFor("ana@acme.com"), nonce: TEST_NONCE },
  );
  const status = (await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body!;
  assert.equal(status.linked, true);
  assert.equal(status.canUnlink, false);
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 409);
  assert.equal(del.body!.error, "admin_link");
  assert.equal((await f.links.list()).length, 1);
});

test("available is false and authorize returns 404 when oauthClientSecret or applicationId is missing", async (t) => {
  const fNoSecret = await fixture(t, { missingSecret: true });
  assert.equal((await fNoSecret.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body?.available, false);
  assert.equal(
    (await fNoSecret.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: TEST_NONCE_HASH }))
      .status,
    404,
  );

  const fNoApp = await fixture(t, { missingAppId: true });
  assert.equal((await fNoApp.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body?.available, false);
  assert.equal(
    (await fNoApp.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: TEST_NONCE_HASH }))
      .status,
    404,
  );
});

test("responses and audits never contain client secret or bearer token", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const authRes = await f.call(
    "POST",
    "/v1/discord/link/authorize",
    { p: "ana@acme.com" },
    { nonceHash: TEST_NONCE_HASH },
  );
  assert.ok(!authRes.rawBody.includes("client-secret"));
  assert.ok(!authRes.rawBody.includes("user-token"));

  const compRes = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.ok(!compRes.rawBody.includes("client-secret"));
  assert.ok(!compRes.rawBody.includes("user-token"));

  assert.equal(f.recordedAudits.length, 1);
  const auditString = JSON.stringify(f.recordedAudits[0]);
  assert.ok(!auditString.includes("client-secret"));
  assert.ok(!auditString.includes("user-token"));
});

test("Cache-Control: no-store header is set on all routes", async (t) => {
  const f = await fixture(t);
  const getRes = await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(getRes.headers["cache-control"], "no-store");
  const authRes = await f.call(
    "POST",
    "/v1/discord/link/authorize",
    { p: "ana@acme.com" },
    { nonceHash: TEST_NONCE_HASH },
  );
  assert.equal(authRes.headers["cache-control"], "no-store");
  const delRes = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(delRes.headers["cache-control"], "no-store");
});

test("a principal already admin-linked to Discord A cannot self-link Discord B", async (t) => {
  const f = await fixture(t);
  await f.links.link({
    principalId: "discord:999999999999999999",
    canonicalId: "ana@acme.com",
    evidence: "verified by an administrator",
    linkedBy: "admin@acme.com",
  });
  const state = await f.stateFor("ana@acme.com");
  const done = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(done.status, 409);
  assert.equal(done.body?.error, "other_account_linked");
  assert.equal((await f.links.list()).length, 1);
});

test("unlink when an admin link remains returns linked: true", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const linked = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(linked.status, 200);
  await f.links.link({
    principalId: "discord:999999999999999999",
    canonicalId: "ana@acme.com",
    evidence: "verified by an administrator",
    linkedBy: "admin@acme.com",
  });
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 200);
  assert.equal(del.body?.linked, true);
  assert.equal((await f.links.list()).length, 1);
  assert.equal((await f.links.list())[0]!.principalId, "discord:999999999999999999");
});

test("authorize rejects missing or malformed nonceHash with 400", async (t) => {
  const f = await fixture(t);
  const noBody = await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" });
  assert.equal(noBody.status, 400);

  const missingNonce = await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, {});
  assert.equal(missingNonce.status, 400);

  const shortNonce = await f.call("POST", "/v1/discord/link/authorize", { p: "ana@acme.com" }, { nonceHash: "abcd" });
  assert.equal(shortNonce.status, 400);

  const upperNonce = await f.call(
    "POST",
    "/v1/discord/link/authorize",
    { p: "ana@acme.com" },
    { nonceHash: TEST_NONCE_HASH.toUpperCase() },
  );
  assert.equal(upperNonce.status, 400);
});

test("complete requires correct nonce matching state nonceHash", async (t) => {
  const f = await fixture(t);
  const state = await f.stateFor("ana@acme.com");
  const wrongNonce = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: "wrong-nonce" },
  );
  assert.equal(wrongNonce.status, 400);
  assert.equal(wrongNonce.body?.error, "invalid_link");

  const missingNonce = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state },
  );
  assert.equal(missingNonce.status, 400);
  assert.equal(missingNonce.body?.error, "invalid_link");
});

test("two concurrent completes with different Discord ids result in exactly one link and one 409", async (t) => {
  const f = await fixture(t);
  let getCalls = 0;
  let releaseBarrier: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const originalGet = f.deps.discordAccounts.get.bind(f.deps.discordAccounts);
  f.deps.discordAccounts.get = async (id: string) => {
    getCalls++;
    if (getCalls === 1) {
      await barrier;
    } else {
      releaseBarrier();
    }
    return originalGet(id);
  };

  const stateA = await f.stateFor("ana@acme.com");
  const stateB = await f.stateFor("ana@acme.com");
  const [resA, resB] = await Promise.all([
    f.call(
      "POST",
      "/v1/discord/link/complete",
      { p: "ana@acme.com" },
      { code: "good", state: stateA, nonce: TEST_NONCE },
    ),
    f.call(
      "POST",
      "/v1/discord/link/complete",
      { p: "ana@acme.com" },
      { code: "good-b", state: stateB, nonce: TEST_NONCE },
    ),
  ]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const rejected = resA.status === 409 ? resA : resB;
  assert.equal(rejected.body?.error, "other_account_linked");
  assert.equal((await f.links.list()).length, 1);
});

test("Discord 5xx or 429 on token is 502 discord_unavailable", async (t) => {
  const f500 = await fixture(t, { tokenStatus: 500 });
  const state1 = await f500.stateFor("ana@acme.com");
  const res500 = await f500.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: state1, nonce: TEST_NONCE },
  );
  assert.equal(res500.status, 502);
  assert.equal(res500.body?.error, "discord_unavailable");

  const f429 = await fixture(t, { tokenStatus: 429 });
  const state2 = await f429.stateFor("ana@acme.com");
  const res429 = await f429.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: state2, nonce: TEST_NONCE },
  );
  assert.equal(res429.status, 502);
  assert.equal(res429.body?.error, "discord_unavailable");
});

test("Discord 5xx or 429 on /users/@me is 502 discord_unavailable", async (t) => {
  const f500 = await fixture(t, { meStatus: 500 });
  const state1 = await f500.stateFor("ana@acme.com");
  const res500 = await f500.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: state1, nonce: TEST_NONCE },
  );
  assert.equal(res500.status, 502);
  assert.equal(res500.body?.error, "discord_unavailable");

  const f429 = await fixture(t, { meStatus: 429 });
  const state2 = await f429.stateFor("ana@acme.com");
  const res429 = await f429.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: state2, nonce: TEST_NONCE },
  );
  assert.equal(res429.status, 502);
  assert.equal(res429.body?.error, "discord_unavailable");
});

test("Discord 4xx other than 429 on token is 400 oauth_failed", async (t) => {
  const f = await fixture(t, { tokenStatus: 403 });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "oauth_failed");
});

test("Discord 4xx other than 429 on /users/@me is 400 oauth_failed", async (t) => {
  const f = await fixture(t, { meStatus: 403 });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "oauth_failed");
});

test("!token.ok guard: 4xx token response with valid-shaped body returns 400", async (t) => {
  const f = await fixture(t, {
    tokenStatus: 400,
    tokenBody: { access_token: "user-token", token_type: "Bearer" },
  });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "oauth_failed");
  assert.deepEqual(await f.links.list(), []);
});

test("!me.ok guard: 4xx /users/@me response with valid body returns 400", async (t) => {
  const f = await fixture(t, {
    meStatus: 403,
    meBody: { id: PROVEN, username: "ana_d", discriminator: "0" },
  });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "oauth_failed");
  assert.deepEqual(await f.links.list(), []);
});

test("SNOWFLAKE guard: /users/@me returns short id returns 400 and links nothing", async (t) => {
  const f = await fixture(t, {
    meStatus: 200,
    meBody: { id: "123", username: "ana_d", discriminator: "0" },
  });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "oauth_failed");
  assert.deepEqual(await f.links.list(), []);
});

test("other_account_linked through self-link record path refuses second Discord id", async (t) => {
  const f = await fixture(t);
  await f.deps.discordAccounts.put("ana@acme.com", {
    discordUserId: "222222222222222222",
    tag: "ana_prior",
    linkedAt: Date.now() - 10000,
  });
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 409);
  assert.equal(res.body?.error, "other_account_linked");
  assert.deepEqual(await f.links.list(), []);
});

test("a link with no record created by the caller has canUnlink true and DELETE unlinks it", async (t) => {
  const f = await fixture(t);
  await f.links.link({
    principalId: `discord:${PROVEN}`,
    canonicalId: "ana@acme.com",
    evidence: "caller self link",
    linkedBy: "ana@acme.com",
  });
  const status = (await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body!;
  assert.equal(status.linked, true);
  assert.equal(status.canUnlink, true);
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 200);
  assert.equal(del.body?.linked, false);
  assert.deepEqual(await f.links.list(), []);
});

test("an admin-created link with no record returns 409 admin_link on DELETE", async (t) => {
  const f = await fixture(t);
  await f.links.link({
    principalId: `discord:${PROVEN}`,
    canonicalId: "ana@acme.com",
    evidence: "admin link",
    linkedBy: "admin@acme.com",
  });
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 409);
  assert.equal(del.body?.error, "admin_link");
  assert.equal((await f.links.list()).length, 1);
});

test("same-id double-click concurrent completes leave record intact and allow self-unlink", async (t) => {
  const f = await fixture(t);
  const stateA = await f.stateFor("ana@acme.com");
  const stateB = await f.stateFor("ana@acme.com");
  const [resA, resB] = await Promise.all([
    f.call(
      "POST",
      "/v1/discord/link/complete",
      { p: "ana@acme.com" },
      { code: "good", state: stateA, nonce: TEST_NONCE },
    ),
    f.call(
      "POST",
      "/v1/discord/link/complete",
      { p: "ana@acme.com" },
      { code: "good", state: stateB, nonce: TEST_NONCE },
    ),
  ]);
  const statuses = [resA.status, resB.status];
  assert.ok(statuses.includes(200));
  for (const s of statuses) {
    assert.ok(s === 200 || s === 409);
  }
  const rec = await f.deps.discordAccounts.get("ana@acme.com");
  assert.ok(rec);
  assert.equal(rec.discordUserId, PROVEN);
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 200);
  assert.equal(del.body?.linked, false);
  assert.deepEqual(await f.links.list(), []);
});

test("link rejects after persisting leaves user able to self-unlink", async (t) => {
  const f = await fixture(t);
  const originalLink = f.links.link.bind(f.links);
  f.links.link = async (input) => {
    await originalLink(input);
    throw new Error("refresh failed after persist");
  };
  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 500);
  assert.equal((await f.links.list()).length, 1);
  const status = (await f.call("GET", "/v1/discord/link", { p: "ana@acme.com" })).body!;
  assert.equal(status.linked, true);
  assert.equal(status.canUnlink, true);
  const del = await f.call("DELETE", "/v1/discord/link", { p: "ana@acme.com" });
  assert.equal(del.status, 200);
  assert.equal(del.body?.linked, false);
  assert.deepEqual(await f.links.list(), []);
});

test("complete requires atomic accounts map methods", async (t) => {
  const f = await fixture(t);
  delete (f.deps.discordAccounts as { insertIfAbsent?: unknown }).insertIfAbsent;
  const state = await f.stateFor("ana@acme.com");
  const completeRoute = discordLinkRoutes.find(
    (r) => "method" in r && r.method === "POST" && r.path === "/v1/discord/link/complete",
  )!;
  await assert.rejects(
    async () =>
      completeRoute.handle({
        req: {} as unknown as ApiCtx["req"],
        res: { setHeader: () => {}, writeHead: () => {}, end: () => {} } as unknown as ApiCtx["res"],
        deps: f.deps,
        body: { code: "good", state, nonce: TEST_NONCE },
        actor: { p: "ana@acme.com", exp: 9e12 },
        capability: null,
      } as unknown as ApiCtx),
    /Atomic Discord account updates are required/,
  );

  const f2 = await fixture(t);
  delete (f2.deps.discordAccounts as { deleteIf?: unknown }).deleteIf;
  const state2 = await f2.stateFor("ana@acme.com");
  await assert.rejects(
    async () =>
      completeRoute.handle({
        req: {} as unknown as ApiCtx["req"],
        res: { setHeader: () => {}, writeHead: () => {}, end: () => {} } as unknown as ApiCtx["res"],
        deps: f2.deps,
        body: { code: "good", state: state2, nonce: TEST_NONCE },
        actor: { p: "ana@acme.com", exp: 9e12 },
        capability: null,
      } as unknown as ApiCtx),
    /Atomic Discord account updates are required/,
  );
});

test("a failed second attempt does not delete the first attempt's record", async (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_000);
  const f = await fixture(t);
  const stateA = await f.stateFor("ana@acme.com");
  const first = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: stateA, nonce: TEST_NONCE },
  );
  assert.equal(first.status, 200);
  const firstRecord = await f.deps.discordAccounts.get("ana@acme.com");
  assert.ok(firstRecord);
  assert.equal(firstRecord.linkedAt, 1_700_000_000_000);

  await f.links.unlink(`discord:${PROVEN}`);
  f.links.link = async () => {
    throw new PrincipalLinkError(409, "simulated conflict");
  };

  const stateB = await f.stateFor("ana@acme.com");
  const second = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state: stateB, nonce: TEST_NONCE },
  );
  assert.equal(second.status, 409);
  const remaining = await f.deps.discordAccounts.get("ana@acme.com");
  assert.ok(remaining);
  assert.equal(remaining.linkedAt, firstRecord.linkedAt);
  assert.equal(remaining.discordUserId, PROVEN);
});

test("rollback removes only this attempt's own record", async (t) => {
  const f = await fixture(t);
  let replacedLinkedAt = 0;
  f.links.link = async () => {
    const inserted = await f.deps.discordAccounts.get("ana@acme.com");
    assert.ok(inserted);
    replacedLinkedAt = inserted.linkedAt + 10_000;
    await f.deps.discordAccounts.put("ana@acme.com", {
      discordUserId: PROVEN,
      tag: "ana_concurrent",
      linkedAt: replacedLinkedAt,
    });
    throw new PrincipalLinkError(409, "simulated link failure");
  };

  const state = await f.stateFor("ana@acme.com");
  const res = await f.call(
    "POST",
    "/v1/discord/link/complete",
    { p: "ana@acme.com" },
    { code: "good", state, nonce: TEST_NONCE },
  );
  assert.equal(res.status, 409);
  const remaining = await f.deps.discordAccounts.get("ana@acme.com");
  assert.ok(remaining);
  assert.equal(remaining.tag, "ana_concurrent");
  assert.equal(remaining.linkedAt, replacedLinkedAt);
});
