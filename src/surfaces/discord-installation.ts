import { randomUUID } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { discordPluginConfigFromEnv, type DiscordPluginConfig } from "../discord/config.ts";
import type { ReloadableSurfaceConfig } from "./surface-runtime.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_IDS = 500;
const DISCORD_API_TIMEOUT_MS = 10_000;

export class DiscordInstallationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DiscordInstallationSettings {
  allowUserIds: string[];
  guildIds: string[];
  internalRoleIds: string[];
  principalDeliveries: boolean;
}

interface ActiveRecord extends DiscordInstallationSettings {
  disabled: false;
  botTokenEnc: string;
  oauthClientSecretEnc: string | null;
  botUserId: string;
  botTag: string;
  applicationId: string;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

interface DisabledRecord {
  disabled: true;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

export type StoredDiscordInstallation = ActiveRecord | DisabledRecord;

export interface DiscordInstallation extends DiscordInstallationSettings {
  botToken: string;
  botUserId: string;
  botTag: string;
  applicationId: string;
  oauthClientSecret: string | null;
  version: string;
}

interface DiscordInstallationStatus extends DiscordInstallationSettings {
  configured: boolean;
  disabled: boolean;
  botUserId?: string;
  botTag?: string;
  applicationId?: string;
  oauthConfigured: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export interface DiscordBotIdentity {
  userId: string;
  tag: string;
  applicationId: string;
}

const DISCORD_LINK_RETURN_PATH = "/settings";

export function discordLinkRedirectUri(portalUrl: string): string {
  return `${portalUrl.replace(/\/+$/, "")}${DISCORD_LINK_RETURN_PATH}`;
}

export interface DiscordInstallationStore {
  get(): Promise<DiscordInstallation | null>;
  status(): Promise<DiscordInstallationStatus>;
  set(
    input: DiscordInstallationSettings & {
      bot?: DiscordBotIdentity & { token: string };
      oauthClientSecret?: string;
      updatedBy: string;
    },
  ): Promise<DiscordInstallationStatus>;
  delete(updatedBy: string): Promise<void>;
}

const EMPTY_SETTINGS: DiscordInstallationSettings = {
  allowUserIds: [],
  guildIds: [],
  internalRoleIds: [],
  principalDeliveries: true,
};

function idsFrom(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IDS) {
    throw new DiscordInstallationError(400, `${field} must be a list of at most ${MAX_IDS} ids`);
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") {
      throw new DiscordInstallationError(400, `${field} has an invalid Discord id`);
    }
    const id = v.trim();
    if (!SNOWFLAKE.test(id)) {
      throw new DiscordInstallationError(400, `${field} has an invalid Discord id`);
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

function secretFrom(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function parseDiscordSettings(
  body: unknown,
): DiscordInstallationSettings & { botToken?: string; oauthClientSecret?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const botToken = secretFrom(b.botToken);
  const oauthClientSecret = secretFrom(b.oauthClientSecret);
  return {
    allowUserIds: idsFrom(b.allowUserIds, "allowUserIds"),
    guildIds: idsFrom(b.guildIds, "guildIds"),
    internalRoleIds: idsFrom(b.internalRoleIds, "internalRoleIds"),
    principalDeliveries: b.principalDeliveries !== false,
    ...(botToken ? { botToken } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
  };
}

async function botGet(path: string, token: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
    });
  } catch {
    throw new DiscordInstallationError(502, "Discord did not answer. Try again in a minute.");
  }
  if (res.status === 429 || res.status >= 500) {
    throw new DiscordInstallationError(502, "Discord did not answer. Try again in a minute.");
  }
  if (!res.ok) {
    throw new DiscordInstallationError(400, "Discord rejected the bot token");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new DiscordInstallationError(502, "Discord returned an unexpected response");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DiscordInstallationError(502, "Discord returned an unexpected response");
  }
  return data as Record<string, unknown>;
}

export async function validateDiscordToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordBotIdentity> {
  const me = await botGet("/users/@me", token, fetchImpl);
  const app = await botGet("/oauth2/applications/@me", token, fetchImpl);
  if (typeof me.id !== "string" || typeof me.username !== "string" || typeof app.id !== "string") {
    throw new DiscordInstallationError(502, "Discord returned an unexpected bot identity");
  }
  const tag =
    typeof me.discriminator === "string" && me.discriminator !== "0"
      ? `${me.username}#${me.discriminator}`
      : me.username;
  return { userId: me.id, tag, applicationId: app.id };
}

export function createDiscordInstallationStore(
  orgId: string,
  map: DurableMap<StoredDiscordInstallation>,
  keyMaterial: Buffer | string,
): DiscordInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "discord-installation");
  const read = () => map.get(orgId);
  const getStatus = async (): Promise<DiscordInstallationStatus> => {
    const r = await read();
    if (!r) return { configured: false, disabled: false, oauthConfigured: false, ...EMPTY_SETTINGS };
    if (r.disabled) {
      return {
        configured: false,
        disabled: true,
        oauthConfigured: false,
        ...EMPTY_SETTINGS,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
      };
    }
    return {
      configured: true,
      disabled: false,
      botUserId: r.botUserId,
      botTag: r.botTag,
      applicationId: r.applicationId,
      oauthConfigured: r.oauthClientSecretEnc !== null,
      allowUserIds: r.allowUserIds,
      guildIds: r.guildIds,
      internalRoleIds: r.internalRoleIds,
      principalDeliveries: r.principalDeliveries,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    };
  };
  return {
    async get() {
      const r = await read();
      if (!r || r.disabled) return null;
      return {
        botToken: decryptSecret(r.botTokenEnc, key),
        oauthClientSecret: r.oauthClientSecretEnc ? decryptSecret(r.oauthClientSecretEnc, key) : null,
        botUserId: r.botUserId,
        botTag: r.botTag,
        applicationId: r.applicationId,
        allowUserIds: r.allowUserIds,
        guildIds: r.guildIds,
        internalRoleIds: r.internalRoleIds,
        principalDeliveries: r.principalDeliveries,
        version: r.version,
      };
    },
    status: getStatus,
    async set(input) {
      if (!map.update) throw new Error("Atomic installation updates are required");
      const previous = await read();
      const initialActive = previous && !previous.disabled ? previous : null;
      if (!input.bot && !initialActive) throw new DiscordInstallationError(400, "a bot token is required");
      const updatedAt = Date.now();
      const toRecord = (active: ActiveRecord | null): ActiveRecord => {
        if (!input.bot && !active) throw new DiscordInstallationError(400, "a bot token is required");
        const botTokenEnc = input.bot ? encryptSecret(input.bot.token, key) : active!.botTokenEnc;
        let oauthClientSecretEnc: string | null = null;
        if (input.oauthClientSecret) {
          oauthClientSecretEnc = encryptSecret(input.oauthClientSecret, key);
        } else if (active) {
          if (!input.bot || input.bot.applicationId === active.applicationId) {
            oauthClientSecretEnc = active.oauthClientSecretEnc;
          }
        }
        const botUserId = input.bot ? input.bot.userId : active!.botUserId;
        const botTag = input.bot ? input.bot.tag : active!.botTag;
        const applicationId = input.bot ? input.bot.applicationId : active!.applicationId;
        return {
          disabled: false,
          botTokenEnc,
          oauthClientSecretEnc,
          botUserId,
          botTag,
          applicationId,
          allowUserIds: input.allowUserIds,
          guildIds: input.guildIds,
          internalRoleIds: input.internalRoleIds,
          principalDeliveries: input.principalDeliveries,
          version: `${updatedAt}:${randomUUID()}`,
          updatedAt,
          updatedBy: input.updatedBy,
        };
      };
      if (!initialActive) {
        await map.putIfAbsent(orgId, toRecord(null));
      }
      const stored = await map.update(orgId, (current) => {
        const active = current && !current.disabled ? current : null;
        return toRecord(active);
      });
      if (!stored) throw new Error("Discord installation disappeared during update");
      return getStatus();
    },
    async delete(updatedBy) {
      const updatedAt = Date.now();
      const tombstone: DisabledRecord = {
        disabled: true,
        version: `${updatedAt}:${randomUUID()}`,
        updatedAt,
        updatedBy,
      };
      if (map.update) {
        const record = await map.update(orgId, () => tombstone);
        if (record) return;
      }
      await map.put(orgId, tombstone);
    },
  };
}

export function discordPluginConfigFromInstallation(i: DiscordInstallation): DiscordPluginConfig {
  return {
    botToken: i.botToken,
    allowUserIds: new Set(i.allowUserIds),
    guildIds: new Set(i.guildIds),
    internalRoleIds: new Set(i.internalRoleIds),
  };
}

export async function loadDiscordRuntimeConfig(
  store: Pick<DiscordInstallationStore, "get" | "status">,
  env: Record<string, string | undefined>,
): Promise<ReloadableSurfaceConfig<DiscordPluginConfig> | null> {
  const status = await store.status();
  if (status.disabled) return null;
  if (status.configured) {
    const stored = await store.get();
    if (stored) return { version: stored.version, config: discordPluginConfigFromInstallation(stored) };
  }
  const fromEnv = discordPluginConfigFromEnv(env);
  return fromEnv ? { version: "environment", config: fromEnv } : null;
}
