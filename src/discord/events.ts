import type { CoreTurnBody } from "../api/surface-core-client.ts";
import type { ActorAssertion } from "../types.ts";
import { DISCORD_SURFACE, discordExternalId, type DiscordGate } from "./config.ts";

export interface DiscordAttachmentRef {
  url: string;
  name: string;
  contentType: string | null;
  size: number;
}

export interface DiscordInbound {
  id: string;
  channelId: string;
  channelName?: string;
  guildId: string | null;
  isThread: boolean;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  mentionsBot: boolean;
  attachments: DiscordAttachmentRef[];
}

export type RouteTarget = "dm" | "new-thread" | "thread";

export interface Routed {
  target: RouteTarget;
  actor: ActorAssertion;
  text: string;
}

const THREAD_NAME_MAX = 100;
const DEFAULT_THREAD_NAME = "QM";

export function routeMessage(msg: DiscordInbound, botUserId: string, gate: DiscordGate): Routed | null {
  if (msg.authorIsBot || msg.authorId === botUserId) return null;
  if (!gate(msg.authorId, msg.guildId)) return null;
  const text = msg.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  if (!text && msg.attachments.length === 0) return null;
  const actor: ActorAssertion = { externalId: discordExternalId(msg.authorId), displayName: msg.authorName };
  if (msg.guildId === null) return { target: "dm", actor, text };
  if (!msg.mentionsBot) return null;
  return { target: msg.isThread ? "thread" : "new-thread", actor, text };
}

export function conversationFor(
  target: RouteTarget,
  channelId: string,
  channelName?: string,
): CoreTurnBody["conversation"] {
  if (target === "dm") return { kind: "dm", threadRef: `${DISCORD_SURFACE}:dm:${channelId}`, channelRef: channelId };
  return {
    kind: "channel",
    threadRef: `${DISCORD_SURFACE}:thread:${channelId}`,
    channelRef: channelId,
    ...(channelName ? { channelName } : {}),
  };
}

export function threadName(text: string): string {
  return text.trim().slice(0, THREAD_NAME_MAX) || DEFAULT_THREAD_NAME;
}
