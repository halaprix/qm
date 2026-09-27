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
  guildId: string | null;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  attachments: DiscordAttachmentRef[];
}

export interface Routed {
  target: "dm";
  actor: ActorAssertion;
  text: string;
}

export function routeMessage(msg: DiscordInbound, botUserId: string, gate: DiscordGate): Routed | null {
  if (msg.guildId !== null) return null;
  if (msg.authorIsBot || msg.authorId === botUserId) return null;
  if (!gate(msg.authorId)) return null;
  const text = msg.content.trim();
  if (!text && msg.attachments.length === 0) return null;
  const actor: ActorAssertion = { externalId: discordExternalId(msg.authorId), displayName: msg.authorName };
  return { target: "dm", actor, text };
}

export function conversationFor(channelId: string): CoreTurnBody["conversation"] {
  return { kind: "dm", threadRef: `${DISCORD_SURFACE}:dm:${channelId}`, channelRef: channelId };
}
