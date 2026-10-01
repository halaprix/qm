import type { Client, Message, MessageCreateOptions } from "discord.js";
import type { DiscordFile } from "./attachments.ts";

export const NO_MENTIONS = { parse: [] as [], repliedUser: false as const };

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

export type SendableChannel = {
  isTextBased(): boolean;
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping?(): Promise<void>;
  messages: {
    fetch(id: string): Promise<Message>;
    edit(id: string, options: MessageCreateOptions): Promise<Message>;
    delete(id: string): Promise<unknown>;
  };
};

function isSendableChannel(ch: unknown): ch is SendableChannel {
  return Boolean(
    ch &&
    typeof ch === "object" &&
    "isTextBased" in ch &&
    typeof (ch as { isTextBased: unknown }).isTextBased === "function" &&
    (ch as { isTextBased(): boolean }).isTextBased() &&
    "send" in ch,
  );
}

export async function sendable(client: Pick<Client, "channels">, channelId: string): Promise<SendableChannel> {
  const ch = await client.channels.fetch(channelId);
  if (!isSendableChannel(ch)) throw new Error(`discord channel ${channelId} is not sendable`);
  return ch;
}

export function createDiscordSender(client: Pick<Client, "channels" | "users">): DiscordSender {
  return {
    async send(channelId, msg) {
      const ch = await sendable(client, channelId);
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
      const ch = await sendable(client, channelId);
      await ch.messages.edit(messageId, {
        content: msg.content,
        allowedMentions: NO_MENTIONS,
        components: msg.components ?? [],
      });
    },
    async react(channelId, messageId, emoji) {
      const ch = await sendable(client, channelId);
      await (await ch.messages.fetch(messageId)).react(emoji);
    },
    async remove(channelId, messageId) {
      const ch = await sendable(client, channelId);
      await ch.messages.delete(messageId);
    },
    async openDm(userId) {
      const dm = await (await client.users.fetch(userId)).createDM();
      return dm.id;
    },
  };
}
