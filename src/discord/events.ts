import type { CoreTurnBody } from "../api/surface-core-client.ts";
import type { ActorAssertion } from "../types.ts";
import { DISCORD_SURFACE } from "./config.ts";

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
  threadParentId: string | null;
  channelName: string | null;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  mentionedUserIds: readonly string[];
  attachments: DiscordAttachmentRef[];
}

export type Routed =
  | { target: "dm"; text: string }
  | { target: "new-thread"; text: string }
  | { target: "thread"; text: string; unprompted: boolean };

export type DiscordConversationTarget =
  | { kind: "dm"; channelId: string }
  | { kind: "thread"; threadId: string; parentChannelId: string; channelName?: string };

const THREAD_NAME_MAX = 100;

export function needsStakeLookup(msg: DiscordInbound, botUserId: string): boolean {
  return msg.threadParentId !== null && msg.authorId !== botUserId && !msg.mentionedUserIds.includes(botUserId);
}

export function routeMessage(msg: DiscordInbound, botUserId: string, guildIds: ReadonlySet<string>): Routed | null {
  if (msg.authorIsBot || msg.authorId === botUserId) return null;
  const text = msg.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  if (!text && msg.attachments.length === 0) return null;
  if (msg.guildId === null) return { target: "dm", text };
  if (!guildIds.has(msg.guildId)) return null;
  const mentioned = msg.mentionedUserIds.includes(botUserId);
  if (msg.threadParentId !== null) return { target: "thread", text, unprompted: !mentioned };
  return mentioned ? { target: "new-thread", text } : null;
}

export function conversationFor(
  target: DiscordConversationTarget,
  audience?: ActorAssertion[],
): CoreTurnBody["conversation"] {
  if (target.kind === "dm")
    return { kind: "dm", threadRef: `${DISCORD_SURFACE}:dm:${target.channelId}`, channelRef: target.channelId };
  return {
    kind: "channel",
    threadRef: `${DISCORD_SURFACE}:th:${target.threadId}`,
    channelRef: target.parentChannelId,
    ...(target.channelName ? { channelName: target.channelName } : {}),
    ...(audience ? { audience } : {}),
  };
}

export function deliveryTargetFor(target: DiscordConversationTarget): string {
  return target.kind === "dm" ? target.channelId : target.threadId;
}

export function threadName(text: string): string {
  const first = text.trim().split("\n")[0]!.trim();
  return (first || "QM").slice(0, THREAD_NAME_MAX);
}
