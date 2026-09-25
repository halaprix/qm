import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { SurfaceCoreClient } from "../api/surface-core-client.ts";
import { swallowAs } from "../util/errors.ts";
import { ingestAttachments } from "./attachments.ts";
import { createDiscordGate, type DiscordPluginConfig } from "./config.ts";
import { conversationFor, routeMessage, threadName, type DiscordInbound } from "./events.ts";
import { runDiscordTurn, STREAM_EDIT_INTERVAL_MS, type ReplyChannel, type StatusMessage } from "./turn-flow.ts";

function toInbound(message: Message, botUserId: string): DiscordInbound {
  const ch = message.channel;
  return {
    id: message.id,
    channelId: message.channelId,
    ...("name" in ch && ch.name ? { channelName: ch.name } : {}),
    guildId: message.guildId,
    isThread: ch.isThread(),
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    authorIsBot: message.author.bot,
    content: message.content,
    mentionsBot: message.mentions.users.has(botUserId),
    attachments: [...message.attachments.values()].map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

function replyChannel(ch: { send(options: MessageCreateOptions): Promise<StatusMessage> }): ReplyChannel {
  return {
    send: (content, files) => ch.send({ content: content || undefined, ...(files?.length ? { files } : {}) }),
  };
}

export async function startDiscordPlugin(
  cfg: DiscordPluginConfig,
  core: SurfaceCoreClient,
): Promise<{ stop(): Promise<void> }> {
  const gate = createDiscordGate(cfg);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });

  async function handle(message: Message): Promise<void> {
    const botUserId = client.user!.id;
    const inbound = toInbound(message, botUserId);
    const routed = routeMessage(inbound, botUserId, gate);
    if (!routed) return;
    const target =
      routed.target === "new-thread" && message.channel.type === ChannelType.GuildText
        ? await message.startThread({ name: threadName(routed.text) })
        : message.channel;
    if (!("send" in target)) return;
    const { attachments, notes } = await ingestAttachments(inbound.attachments, core);
    await runDiscordTurn({
      core,
      channel: replyChannel(target),
      streamIntervalMs: STREAM_EDIT_INTERVAL_MS,
      body: {
        actor: routed.actor,
        conversation: conversationFor(
          routed.target === "new-thread" ? "thread" : routed.target,
          target.id,
          inbound.channelName,
        ),
        text: routed.text,
        triggerTs: message.id,
        entryTs: message.id,
        ...(attachments.length ? { attachments } : {}),
        ...(notes.length ? { inboundNotes: notes } : {}),
      },
    });
  }

  client.on(Events.MessageCreate, (message) => {
    void handle(message).catch(swallowAs("discord: message handler", undefined));
  });
  client.once(Events.ClientReady, (c) => console.log(`[qm] discord connected as @${c.user.tag}`));
  await client.login(cfg.botToken);
  return {
    async stop() {
      await client.destroy();
    },
  };
}
