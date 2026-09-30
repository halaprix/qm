import type { Client, MessageCreateOptions } from "discord.js";
import type { DiscordFile } from "./attachments.ts";

const NO_MENTIONS = { parse: [] as [], repliedUser: false as const };

export interface OutboundMessage {
  content?: string;
  files?: DiscordFile[];
  replyTo?: string;
  components?: MessageCreateOptions["components"];
}

export interface DiscordSender {
  send(channelId: string, msg: OutboundMessage): Promise<{ id: string }>;
  edit(
    channelId: string,
    messageId: string,
    msg: { content: string; components?: MessageCreateOptions["components"] },
  ): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  openDm(userId: string): Promise<string>;
}

export function createDiscordSender(client: Pick<Client, "channels" | "users">): DiscordSender {
  async function sendable(channelId: string) {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased() || !("send" in ch)) throw new Error(`discord channel ${channelId} is not sendable`);
    return ch;
  }
  return {
    async send(channelId, msg) {
      const ch = await sendable(channelId);
      const sent = await ch.send({
        allowedMentions: NO_MENTIONS,
        ...(msg.content ? { content: msg.content } : {}),
        ...(msg.files?.length ? { files: msg.files } : {}),
        ...(msg.components ? { components: msg.components } : {}),
        ...(msg.replyTo ? { reply: { messageReference: msg.replyTo, failIfNotExists: false } } : {}),
      });
      return { id: sent.id };
    },
    async edit(channelId, messageId, msg) {
      const ch = await sendable(channelId);
      await ch.messages.edit(messageId, {
        content: msg.content,
        allowedMentions: NO_MENTIONS,
        components: msg.components ?? [],
      });
    },
    async react(channelId, messageId, emoji) {
      const ch = await sendable(channelId);
      await (await ch.messages.fetch(messageId)).react(emoji);
    },
    async remove(channelId, messageId) {
      const ch = await sendable(channelId);
      await ch.messages.delete(messageId);
    },
    async openDm(userId) {
      const dm = await (await client.users.fetch(userId)).createDM();
      return dm.id;
    },
  };
}
