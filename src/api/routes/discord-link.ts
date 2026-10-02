import { createHash, timingSafeEqual } from "node:crypto";
import { mintSignedPayload, verifySignedPayload } from "../../auth/signed-token.ts";
import { orgId } from "../../config.ts";
import { canonicalPerson, foldPrincipalId, personIds, samePerson } from "../../directory/person.ts";
import { discordExternalId, discordUserIdOf } from "../../discord/config.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import { discordLinkRedirectUri } from "../../surfaces/discord-installation.ts";
import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { activePrincipal, audit } from "./shared.ts";

export interface DiscordAccountLink {
  discordUserId: string;
  tag: string;
  linkedAt: number;
}

export const DISCORD_LINK_STATE_TTL_MS = 10 * 60_000;
const DISCORD_OAUTH_TIMEOUT_MS = 10_000;
const LINK_PURPOSE = "discord-account-link";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;
const NONCE_HASH = /^[0-9a-f]{64}$/;

async function linkingPrincipal(ctx: ApiCtx): Promise<string | null> {
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!ctx.actor || ctx.actor.imp || ctx.capability) {
    sendJson(ctx.res, 403, { error: "browser_identity_required" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, ctx.actor.p))) {
    sendJson(ctx.res, 403, {
      error: "inactive_account",
      message: "Only active members of the organization can link Discord.",
    });
    return null;
  }
  return ctx.actor.p;
}

async function oauthConfig(ctx: ApiCtx) {
  const install = await ctx.deps.discordInstallation?.get();
  if (
    !install?.applicationId ||
    !install?.oauthClientSecret ||
    !ctx.deps.signingSecret ||
    !ctx.deps.portalUrl ||
    !ctx.deps.discordAccounts
  )
    return null;
  return {
    clientId: install.applicationId,
    clientSecret: install.oauthClientSecret,
    redirectUri: discordLinkRedirectUri(ctx.deps.portalUrl),
    signingSecret: ctx.deps.signingSecret,
    accounts: ctx.deps.discordAccounts,
  };
}

async function selfLink(ctx: ApiCtx, principal: string) {
  const record = (await ctx.deps.discordAccounts?.get(foldPrincipalId(principal))) ?? null;
  const links = ctx.deps.principalLinks ? await ctx.deps.principalLinks.list() : [];
  const discordAliases = personIds(principal).filter((id) => discordUserIdOf(id) !== null);

  let targetLink: (typeof links)[number] | null = null;
  let targetAlias: string | null = null;

  for (const alias of discordAliases) {
    const folded = foldPrincipalId(alias);
    const found = links.find((l) => foldPrincipalId(l.principalId) === folded) ?? null;
    if (found && ownedBy(found, principal)) {
      targetLink = found;
      targetAlias = alias;
      break;
    }
    if (!targetLink && found) {
      targetLink = found;
      targetAlias = alias;
    }
  }

  if (!targetLink && record) {
    const recordAlias = discordExternalId(record.discordUserId);
    const folded = foldPrincipalId(recordAlias);
    const found = links.find((l) => foldPrincipalId(l.principalId) === folded) ?? null;
    if (found) {
      targetLink = found;
      targetAlias = recordAlias;
    }
  }

  return { record, link: targetLink, alias: targetAlias };
}

function ownedBy(link: { linkedBy: string; canonicalId: string } | null, principal: string): boolean {
  return link !== null && samePerson(link.linkedBy, principal) && samePerson(link.canonicalId, principal);
}

async function status(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  const { record, link } = await selfLink(ctx, principal);
  return sendJson(ctx.res, 200, {
    available: cfg !== null,
    linked: personIds(principal).some((id) => discordUserIdOf(id) !== null),
    canUnlink: ownedBy(link, principal),
    ...(record ? { tag: record.tag } : {}),
  });
}

async function authorize(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  if (!cfg) return sendJson(ctx.res, 404, { error: "link_unavailable" });
  const { nonceHash } = (ctx.body ?? {}) as { nonceHash?: unknown };
  if (typeof nonceHash !== "string" || !NONCE_HASH.test(nonceHash)) {
    return sendJson(ctx.res, 400, {
      error: "invalid_request",
      message: "A valid nonceHash is required.",
    });
  }
  const state = await mintSignedPayload(
    { purpose: LINK_PURPOSE, principal, org: orgId(), nonceHash, exp: Date.now() + DISCORD_LINK_STATE_TTL_MS },
    cfg.signingSecret,
  );
  const url = new URL(DISCORD_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: cfg.redirectUri,
    state,
    prompt: "consent",
  }).toString();
  return sendJson(ctx.res, 200, { url: url.href });
}

type ProvenUserResult =
  | { ok: true; user: { id: string; tag: string } }
  | { ok: false; status: 400 | 502; error: "oauth_failed" | "discord_unavailable" };

function logOAuthFailure(category: "network" | "parse" | "timeout"): void {
  console.error(`[discord-link] Discord OAuth call failed (${category})`);
}

function failureCategory(err: unknown): "network" | "timeout" {
  if (err && typeof err === "object") {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  return "network";
}

async function provenDiscordUser(
  ctx: ApiCtx,
  cfg: NonNullable<Awaited<ReturnType<typeof oauthConfig>>>,
  code: string,
): Promise<ProvenUserResult> {
  const fetchImpl = ctx.deps.discordInstallationFetch ?? fetch;
  const guarded = { redirect: "error" as const };
  let token: Response;
  try {
    token = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
      ...guarded,
      signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.redirectUri,
      }).toString(),
    });
  } catch (err) {
    logOAuthFailure(failureCategory(err));
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (token.status >= 500 || token.status === 429) {
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (!token.ok) {
    return { ok: false, status: 400, error: "oauth_failed" };
  }
  let tokenBody: { access_token?: unknown };
  try {
    tokenBody = (await token.json()) as { access_token?: unknown };
  } catch {
    logOAuthFailure("parse");
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  const { access_token: accessToken } = tokenBody;
  if (typeof accessToken !== "string") {
    return { ok: false, status: 400, error: "oauth_failed" };
  }

  let me: Response;
  try {
    me = await fetchImpl(`${DISCORD_API}/users/@me`, {
      ...guarded,
      signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    logOAuthFailure(failureCategory(err));
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (me.status >= 500 || me.status === 429) {
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (!me.ok) {
    return { ok: false, status: 400, error: "oauth_failed" };
  }
  let userBody: { id?: unknown; username?: unknown; discriminator?: unknown };
  try {
    userBody = (await me.json()) as { id?: unknown; username?: unknown; discriminator?: unknown };
  } catch {
    logOAuthFailure("parse");
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (typeof userBody.id !== "string" || !SNOWFLAKE.test(userBody.id) || typeof userBody.username !== "string") {
    return { ok: false, status: 400, error: "oauth_failed" };
  }
  const tag =
    userBody.discriminator && userBody.discriminator !== "0"
      ? `${userBody.username}#${String(userBody.discriminator)}`
      : userBody.username;
  return { ok: true, user: { id: userBody.id, tag } };
}

async function complete(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  if (!cfg || !ctx.deps.principalLinks) return sendJson(ctx.res, 404, { error: "link_unavailable" });
  const { code, state, nonce } = (ctx.body ?? {}) as { code?: unknown; state?: unknown; nonce?: unknown };
  const proof =
    typeof state === "string"
      ? ((await verifySignedPayload(state, cfg.signingSecret)) as Record<string, unknown> | null)
      : null;
  if (
    typeof code !== "string" ||
    !proof ||
    proof.purpose !== LINK_PURPOSE ||
    proof.org !== orgId() ||
    proof.principal !== principal ||
    typeof proof.nonceHash !== "string" ||
    !NONCE_HASH.test(proof.nonceHash) ||
    typeof proof.exp !== "number" ||
    proof.exp <= Date.now()
  )
    return sendJson(ctx.res, 400, {
      error: "invalid_link",
      message: "This Discord connection expired or belongs to another QM account. Start again from your settings.",
    });
  if (typeof nonce !== "string")
    return sendJson(ctx.res, 400, {
      error: "invalid_link",
      message: "This Discord connection expired or belongs to another QM account. Start again from your settings.",
    });
  const computedHash = createHash("sha256").update(nonce).digest();
  const expectedHash = Buffer.from(proof.nonceHash, "hex");
  if (computedHash.length !== expectedHash.length || !timingSafeEqual(computedHash, expectedHash))
    return sendJson(ctx.res, 400, {
      error: "invalid_link",
      message: "This Discord connection expired or belongs to another QM account. Start again from your settings.",
    });
  const proven = await provenDiscordUser(ctx, cfg, code);
  if (!proven.ok) {
    if (proven.status === 502) {
      return sendJson(ctx.res, 502, {
        error: "discord_unavailable",
        message: "Discord did not answer. Try again in a minute.",
      });
    }
    return sendJson(ctx.res, 400, {
      error: "oauth_failed",
      message: "Discord did not confirm the account. Try again.",
    });
  }
  const user = proven.user;
  const alias = discordExternalId(user.id);
  const key = foldPrincipalId(principal);
  const existing = canonicalPerson(alias);
  if (existing !== alias && !samePerson(existing, principal))
    return sendJson(ctx.res, 409, {
      error: "already_linked",
      message: "This Discord account is connected to another QM account. Ask your administrator for help.",
    });
  const hasOtherDiscordLink = personIds(principal).some((id) => {
    const did = discordUserIdOf(id);
    return did !== null && did !== user.id;
  });
  if (hasOtherDiscordLink)
    return sendJson(ctx.res, 409, {
      error: "other_account_linked",
      message: "Disconnect your current Discord account first.",
    });
  const record: DiscordAccountLink = { discordUserId: user.id, tag: user.tag, linkedAt: Date.now() };
  const current = await cfg.accounts.get(key);
  if (current && current.discordUserId !== user.id)
    return sendJson(ctx.res, 409, {
      error: "other_account_linked",
      message: "Disconnect your current Discord account first.",
    });

  if (!cfg.accounts.insertIfAbsent || !cfg.accounts.deleteIf)
    throw new Error("Atomic Discord account updates are required");
  const deleteIf = cfg.accounts.deleteIf;

  const newlyClaimed = await cfg.accounts.insertIfAbsent(key, record);
  if (!newlyClaimed) {
    const existingRecord = await cfg.accounts.get(key);
    if (existingRecord && existingRecord.discordUserId !== user.id)
      return sendJson(ctx.res, 409, {
        error: "other_account_linked",
        message: "Disconnect your current Discord account first.",
      });
  }

  const rollbackClaim = async () => {
    if (!newlyClaimed) return;
    await deleteIf(key, (r) => r.linkedAt === record.linkedAt && r.discordUserId === record.discordUserId);
  };

  if (existing === alias) {
    const credentials = (await ctx.deps.keychain?.listByOwner(alias)) ?? [];
    if (credentials.length) {
      await rollbackClaim();
      return sendJson(ctx.res, 409, {
        error: "established_account",
        message: "This Discord identity already has saved credentials. Ask your administrator to combine the accounts.",
      });
    }
    try {
      await ctx.deps.principalLinks.link({
        principalId: alias,
        canonicalId: principal,
        evidence: `Discord OAuth2 identify: user ${user.id} (${user.tag}) authorized by ${principal}`,
        linkedBy: principal,
      });
    } catch (err) {
      await rollbackClaim();
      if (err instanceof PrincipalLinkError)
        return sendJson(ctx.res, 409, { error: "already_linked", message: "Ask your administrator for help." });
      throw err;
    }
    audit(ctx.deps, {
      principalId: principal,
      action: "principal_link.create",
      resource: `${alias} -> ${principal}`,
      scopeLabel: scopeId("org", orgId()),
    });
  }
  await cfg.accounts.put(key, record);
  await ctx.deps.identity?.refresh(true);
  return sendJson(ctx.res, 200, { linked: true, tag: user.tag });
}

async function unlink(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  if (!ctx.deps.principalLinks || !ctx.deps.discordAccounts) return sendJson(ctx.res, 404, { error: "not_linked" });
  const key = foldPrincipalId(principal);
  const { record, link, alias } = await selfLink(ctx, principal);
  const linked = personIds(principal).some((id) => discordUserIdOf(id) !== null);
  if (record && !link) {
    await ctx.deps.discordAccounts.delete(key);
    return sendJson(ctx.res, 200, { linked });
  }
  if (!ownedBy(link, principal)) {
    if (!linked) return sendJson(ctx.res, 404, { error: "not_linked" });
    return sendJson(ctx.res, 409, {
      error: "admin_link",
      message: "An administrator linked this Discord account. Ask an administrator to remove it.",
    });
  }
  const targetAlias = alias ?? link!.principalId;
  await ctx.deps.principalLinks.unlink(targetAlias);
  if (record) {
    await ctx.deps.discordAccounts.delete(key);
  }
  await ctx.deps.identity?.refresh(true);
  audit(ctx.deps, {
    principalId: principal,
    action: "principal_link.delete",
    resource: `${targetAlias} -> ${principal}`,
    scopeLabel: scopeId("org", orgId()),
  });
  return sendJson(ctx.res, 200, {
    linked: personIds(principal).some((id) => discordUserIdOf(id) !== null),
  });
}

export const discordLinkRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/discord/link", auth: "source", handle: status },
  { method: "POST", path: "/v1/discord/link/authorize", auth: "source", handle: authorize },
  { method: "POST", path: "/v1/discord/link/complete", auth: "source", handle: complete },
  { method: "DELETE", path: "/v1/discord/link", auth: "source", handle: unlink },
];
