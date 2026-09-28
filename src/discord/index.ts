import { Client, Events, GatewayIntentBits, Partials, type Message, type MessageCreateOptions } from "discord.js";
import type { SurfaceCoreClient } from "../api/surface-core-client.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";
import { ingestAttachments } from "./attachments.ts";
import { createDiscordGate, type DiscordPluginConfig } from "./config.ts";
import { conversationFor, routeMessage, type DiscordInbound } from "./events.ts";
import { runDiscordTurn, type ReplyChannel, type StatusMessage } from "./turn-flow.ts";

export const DISCORD_LOGIN_RETRY_BASE_MS = 5_000;
const DISCORD_LOGIN_RETRY_MAX_MS = 300_000;

export interface DiscordPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordPluginOptions {
  clientFactory?: () => Client;
  drainTimeoutMs: number;
}

function toInbound(message: Message): DiscordInbound {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    authorIsBot: message.author.bot,
    content: message.content,
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

export function createDiscordPlugin(
  cfg: DiscordPluginConfig,
  core: SurfaceCoreClient,
  opts: DiscordPluginOptions,
): DiscordPlugin {
  const gate = createDiscordGate(cfg);
  const clientFactory =
    opts.clientFactory ??
    (() =>
      new Client({
        intents: [GatewayIntentBits.DirectMessages],
        partials: [Partials.Channel],
        allowedMentions: { parse: [], repliedUser: false },
      }));
  const drainTimeoutMs = opts.drainTimeoutMs;

  let client: Client | null = null;
  let detachClient: (() => { client: Client; inFlight: Set<Promise<void>> }) | null = null;
  let stopPromise: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelay = DISCORD_LOGIN_RETRY_BASE_MS;
  let stopped = true;

  async function handle(message: Message, activeClient: Client): Promise<void> {
    const botUserId = activeClient.user?.id ?? "";
    const inbound = toInbound(message);
    const routed = routeMessage(inbound, botUserId, gate);
    if (!routed) return;
    const target = message.channel;
    if (!("send" in target)) return;
    const { attachments, notes } = await ingestAttachments(inbound.attachments, core);
    await runDiscordTurn({
      core,
      channel: replyChannel(target),
      body: {
        actor: routed.actor,
        conversation: conversationFor(target.id),
        text: routed.text,
        triggerTs: message.id,
        entryTs: message.id,
        redeliveryKey: `discord:${message.id}`,
        ...(attachments.length ? { attachments } : {}),
        ...(notes.length ? { inboundNotes: notes } : {}),
      },
    });
  }

  async function connect(): Promise<void> {
    if (stopped || client) return;
    let accepting = true;
    const inFlight = new Set<Promise<void>>();
    const c = clientFactory();
    client = c;
    detachClient = () => {
      accepting = false;
      return { client: c, inFlight };
    };
    c.on(Events.MessageCreate, (message) => {
      if (!accepting) return;
      const p = handle(message, c)
        .catch(swallowAs("discord: message handler", undefined))
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    });
    c.once(Events.ClientReady, (readyClient) => console.log(`[qm] discord connected as @${readyClient.user.tag}`));
    try {
      await c.login(cfg.botToken);
      retryDelay = DISCORD_LOGIN_RETRY_BASE_MS;
    } catch (err) {
      reportFailureAs("discord plugin login", undefined)(err);
      await c.destroy().catch(swallowAs("discord client cleanup", undefined));
      const isCurrent = client === c;
      if (isCurrent) {
        client = null;
        detachClient = null;
      }
      accepting = false;
      if (!stopped && !retryTimer && isCurrent) {
        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, DISCORD_LOGIN_RETRY_MAX_MS);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, delay);
      }
    }
  }

  return {
    async start() {
      stopped = false;
      if (client || retryTimer) return;
      await connect();
    },

    async stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      retryDelay = DISCORD_LOGIN_RETRY_BASE_MS;
      const detached = detachClient?.();
      client = null;
      detachClient = null;
      if (!detached) return stopPromise ?? Promise.resolve();
      const previousStop = stopPromise;
      const drainCurrent = async () => {
        if (detached.inFlight.size > 0) {
          let timer: NodeJS.Timeout;
          const timeoutPromise = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainTimeoutMs);
          });
          await Promise.race([Promise.allSettled([...detached.inFlight]).then(() => {}), timeoutPromise]).finally(() =>
            clearTimeout(timer),
          );
        }
        await detached.client.destroy();
      };
      let drainPromise: Promise<void> | null = null;
      drainPromise = (async () => {
        try {
          if (previousStop) {
            const [prevResult, currentResult] = await Promise.allSettled([previousStop, drainCurrent()]);
            if (prevResult.status === "rejected") throw prevResult.reason;
            if (currentResult.status === "rejected") throw currentResult.reason;
          } else {
            await drainCurrent();
          }
        } finally {
          if (stopPromise === drainPromise) {
            stopPromise = null;
          }
        }
      })();
      stopPromise = drainPromise;
      return stopPromise;
    },
  };
}
