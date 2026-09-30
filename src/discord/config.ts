export const DISCORD_SURFACE = "discord";
const EXTERNAL_PREFIX = `${DISCORD_SURFACE}:`;

export interface DiscordPluginConfig {
  botToken: string;
  allowUserIds: ReadonlySet<string>;
  guildIds: ReadonlySet<string>;
  internalRoleIds: ReadonlySet<string>;
}

function idList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function discordPluginConfigFromEnv(env: Record<string, string | undefined>): DiscordPluginConfig | null {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) return null;
  return {
    botToken,
    allowUserIds: idList(env.DISCORD_ALLOW_USER_IDS),
    guildIds: idList(env.DISCORD_GUILD_IDS),
    internalRoleIds: idList(env.DISCORD_INTERNAL_ROLE_IDS),
  };
}

export function discordExternalId(userId: string): string {
  return `${EXTERNAL_PREFIX}${userId}`;
}

export function discordUserIdOf(externalId: string): string | null {
  return externalId.startsWith(EXTERNAL_PREFIX) ? externalId.slice(EXTERNAL_PREFIX.length) : null;
}
