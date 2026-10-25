export const DISCORD_SURFACE = "discord";
export const DISCORD_DM_DELIVERY_TYPE = "discord-dm";
export const DISCORD_RETRY_BASE_MS = 5_000;
export const DISCORD_RETRY_MAX_MS = 300_000;
const EXTERNAL_PREFIX = `${DISCORD_SURFACE}:`;
export const discordDmThreadRef = (channelId: string): string => `${DISCORD_SURFACE}:dm:${channelId}`;
export const discordThreadRef = (threadId: string): string => `${DISCORD_SURFACE}:th:${threadId}`;
const DISCORD_THREAD_REF = new RegExp(`^${DISCORD_SURFACE}:th:(\\d+)$`);

export function discordRevisionThreadRefs(container: string, ts: string): string[] {
  return [...new Set([discordThreadRef(container), discordThreadRef(ts)])];
}

export function parseDiscordThreadRef(threadRef: string): { container: string } | null {
  const m = DISCORD_THREAD_REF.exec(threadRef);
  return m ? { container: m[1]! } : null;
}

export interface DiscordPluginConfig {
  botToken: string;
  allowUserIds: ReadonlySet<string>;
  guildIds: ReadonlySet<string>;
  internalRoleIds: ReadonlySet<string>;
}

function idList(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

export function discordPluginConfigFromEnv(env: Record<string, string | undefined>): DiscordPluginConfig | null {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) return null;
  const allowUserIds = idList(env.DISCORD_ALLOW_USER_IDS);
  const guildIds = idList(env.DISCORD_GUILD_IDS);
  const internalRoleIds = idList(env.DISCORD_INTERNAL_ROLE_IDS);
  for (const roleId of internalRoleIds) {
    if (guildIds.has(roleId)) {
      throw new Error(`DISCORD_INTERNAL_ROLE_IDS cannot contain guild id: ${roleId}`);
    }
  }
  return {
    botToken,
    allowUserIds,
    guildIds,
    internalRoleIds,
  };
}

export function discordExternalId(userId: string): string {
  return `${EXTERNAL_PREFIX}${userId}`;
}

export function discordUserIdOf(externalId: string): string | null {
  return externalId.startsWith(EXTERNAL_PREFIX) ? externalId.slice(EXTERNAL_PREFIX.length) : null;
}
