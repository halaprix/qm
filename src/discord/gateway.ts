import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type GuildMember,
  type Message,
} from "discord.js";
import type { ActorAssertion } from "../types.ts";
import type { DiscordPluginConfig } from "./config.ts";
import type { DiscordHistoryReader, HistoryMessage } from "./context.ts";
import type { ChannelKind } from "./deliveries.ts";
import type { DiscordInbound } from "./events.ts";
import type { MemberHydrator } from "./member-hydrator.ts";
import { classifyMember, mergeMemberships, type DiscordMemberFacts, type LinkedInternal } from "./members.ts";
import type { ChannelViewers } from "./readers.ts";
import type { StakeMessage } from "./thread-stake.ts";

const STAKE_HISTORY_LIMIT = 100;

export function memberFacts(m: GuildMember): DiscordMemberFacts {
  return { userId: m.id, displayName: m.displayName, roleIds: [...m.roles.cache.keys()], isBot: m.user.bot };
}

function cachedBase(client: Client, channelId: string) {
  const ch = client.channels.cache.get(channelId);
  if (!ch) return null;
  const base = ch.isThread() ? ch.parent : ch;
  return base && "guild" in base && "permissionsFor" in base ? base : null;
}

export function cachedViewers(client: Client, baseChannelId: string): ChannelViewers {
  const base = cachedBase(client, baseChannelId);
  if (!base) return { ok: false, reason: "not_a_guild_channel" };
  const members = [...base.guild.members.cache.values()]
    .filter((m) => base.permissionsFor(m).has(PermissionFlagsBits.ViewChannel))
    .map(memberFacts);
  return { ok: true, guildId: base.guild.id, members };
}

export function createChannelKind(client: Client): (channelId: string) => Promise<ChannelKind | null> {
  return async (channelId) => {
    let ch;
    try {
      ch = await client.channels.fetch(channelId);
    } catch (err) {
      if ((err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownChannel) return null;
      throw err;
    }
    if (!ch) return null;
    if (ch.type === ChannelType.DM) return { kind: "dm", recipientId: ch.recipientId };
    const base = ch.isThread() ? ch.parent : ch;
    if (!base || !("guild" in base)) return null;
    return { kind: "guild", baseChannelId: base.id };
  };
}

export function createMergedClassify(deps: {
  client: Client;
  cfg: DiscordPluginConfig;
  linkedInternal: LinkedInternal;
}): (userId: string, fallbackName: string) => Promise<ActorAssertion> {
  return async (userId, fallbackName) => {
    const memberships = [...deps.cfg.guildIds]
      .map((g) => deps.client.guilds.cache.get(g)?.members.cache.get(userId))
      .filter((m): m is GuildMember => m !== undefined)
      .map(memberFacts);
    const displayName = memberships.map((m) => m.displayName).sort()[0] ?? fallbackName;
    return classifyMember(mergeMemberships(userId, displayName, memberships), deps.cfg, deps.linkedInternal);
  };
}

export function createUserClassifier(deps: {
  client: Client;
  cfg: DiscordPluginConfig;
  hydrator: Pick<MemberHydrator, "allReady">;
  linkedInternal: LinkedInternal;
}): (userId: string, fallbackName: string) => Promise<ActorAssertion | null> {
  const merged = createMergedClassify(deps);
  return async (userId, fallbackName) => {
    const actor = await merged(userId, fallbackName);
    return actor.isExternalGuest && !deps.hydrator.allReady() ? null : actor;
  };
}

export function createStakeHistory(client: Client): (threadId: string) => Promise<StakeMessage[]> {
  return async (threadId) => {
    const ch = await client.channels.fetch(threadId);
    if (!ch?.isTextBased()) return [];
    const recent = await ch.messages.fetch({ limit: STAKE_HISTORY_LIMIT });
    return [...recent.values()].map((m) => ({ authorId: m.author.id, mentionedUserIds: [...m.mentions.users.keys()] }));
  };
}

export function toInbound(message: Message): DiscordInbound {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    threadParentId: message.channel.isThread() ? message.channel.parentId : null,
    channelName: "name" in message.channel ? message.channel.name : null,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    authorIsBot: message.author.bot,
    content: message.content,
    mentionedUserIds: [...message.mentions.users.keys()],
    attachments: [...message.attachments.values()].map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

export function createDiscordHistoryReader(deps: {
  client: Client;
  guildIds: ReadonlySet<string>;
  hydrator: Pick<MemberHydrator, "ready">;
}): DiscordHistoryReader {
  return {
    async recent(channelId: string, opts: { count: number; before?: string }): Promise<HistoryMessage[]> {
      const cached = deps.client.channels.cache.get(channelId);
      const ch = cached ?? (await deps.client.channels.fetch(channelId));
      if (!ch || !ch.isTextBased()) return [];
      const fetched = await ch.messages.fetch({
        limit: opts.count,
        ...(opts.before ? { before: opts.before } : {}),
      });
      const isThread = ch.isThread();
      return [...fetched.values()]
        .sort((a, b) => {
          const diff = BigInt(a.id) - BigInt(b.id);
          if (diff < 0n) return -1;
          if (diff > 0n) return 1;
          return 0;
        })
        .map((m) => {
          const authorName = m.member ? m.member.displayName : (m.author.globalName ?? m.author.username);
          return {
            id: m.id,
            authorId: m.author.id,
            authorName,
            text: m.content,
            ...(isThread ? { threadTs: ch.id } : {}),
          };
        });
    },

    async canView(channelId: string, userId: string): Promise<boolean> {
      try {
        const ch = deps.client.channels.cache.get(channelId);
        if (!ch) return false;
        if (ch.type === ChannelType.DM) {
          return ch.recipientId === userId;
        }
        const base = cachedBase(deps.client, channelId);
        if (!base) return false;
        if (!deps.guildIds.has(base.guild.id)) return false;
        if (!deps.hydrator.ready(base.guild.id)) return false;
        const member = base.guild.members.cache.get(userId);
        if (!member) return false;
        const perms = base.permissionsFor(member);
        if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return false;
        if (ch.type === ChannelType.PrivateThread) {
          const inMembers = ch.members.cache.has(userId);
          return inMembers || perms.has(PermissionFlagsBits.ManageThreads);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
