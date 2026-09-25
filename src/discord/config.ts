export const DISCORD_SURFACE = "discord";

export interface DiscordPluginConfig {
  botToken: string;
  allowUserIds: ReadonlySet<string>;
  allowGuildIds: ReadonlySet<string>;
}

export type DiscordGate = (userId: string, guildId: string | null) => boolean;

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
  const allowUserIds = idList(env.DISCORD_ALLOW_USER_IDS);
  if (allowUserIds.size === 0) {
    throw new Error(
      "DISCORD_BOT_TOKEN is set but DISCORD_ALLOW_USER_IDS is empty; refusing to start an open Discord bot",
    );
  }
  return { botToken, allowUserIds, allowGuildIds: idList(env.DISCORD_GUILD_IDS) };
}

export function createDiscordGate(cfg: DiscordPluginConfig): DiscordGate {
  return (userId, guildId) => cfg.allowUserIds.has(userId) && (guildId === null || cfg.allowGuildIds.has(guildId));
}

export function discordExternalId(userId: string): string {
  return `${DISCORD_SURFACE}:${userId}`;
}
