import type { IngestEvent } from "../surface-cache/types.ts";
import { discordExternalId } from "./config.ts";
import type { DiscordInbound } from "./events.ts";

export function shouldMirror(msg: DiscordInbound, botUserId: string, staked: boolean): boolean {
  if (msg.guildId === null) return false;
  return msg.authorId === botUserId || msg.mentionedUserIds.includes(botUserId) || staked;
}

export function toIngestEvent(
  msg: DiscordInbound,
  botUserId: string,
  opts: { handled: boolean; createdAt: number },
): IngestEvent {
  return {
    container: msg.channelId,
    ts: msg.id,
    authorId: discordExternalId(msg.authorId),
    authorName: msg.authorName,
    text: msg.content,
    mentionsSelf: msg.mentionedUserIds.includes(botUserId),
    self: msg.authorId === botUserId,
    bot: msg.authorIsBot,
    handled: opts.handled,
    createdAt: opts.createdAt,
    kind: "channel",
    ...(msg.channelName ? { containerName: msg.channelName } : {}),
  };
}
