import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type AnyThreadChannel,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { DiscordCoreClient } from "../api/discord-core-client.ts";
import type { ActorAssertion } from "../types.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";
import { ingestAttachments } from "./attachments.ts";
import { createCardRenderer } from "./approval-cards.ts";
import { DISCORD_SURFACE, discordUserIdOf, type DiscordPluginConfig } from "./config.ts";
import { createDeliveryGuard, createDiscordDispatcher, type DiscordDispatcher } from "./deliveries.ts";
import { conversationFor, deliveryTargetFor, needsStakeLookup, routeMessage, threadName } from "./events.ts";
import { createInteractionHandler, type ButtonClick } from "./interactions.ts";
import {
  cachedViewers,
  createChannelKind,
  createMergedClassify,
  createStakeHistory,
  createUserClassifier,
  toInbound,
} from "./gateway.ts";
import { createMemberHydrator, type MemberHydrator } from "./member-hydrator.ts";
import { shouldMirror, toIngestEvent } from "./mirror.ts";
import { audienceWith, channelReaders, type ReaderResult } from "./readers.ts";
import { createDiscordSender, NO_MENTIONS, sendable } from "./sender.ts";
import { createStakeTracker, type StakeTracker } from "./thread-stake.ts";
import { runDiscordTurn, type ReplyChannel } from "./turn-flow.ts";

type StreamGate = () => Promise<boolean>;
// A DM's only reader is the internal actor.
const allowDmStream: StreamGate = async () => true;

export const DISCORD_LOGIN_RETRY_BASE_MS = 5_000;
const DISCORD_LOGIN_RETRY_MAX_MS = 300_000;
export const DISCORD_DELIVERY_POLL_MS = 60_000;
const READERS_UNKNOWN_TEXT =
  "I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.";
const UNKNOWN_READER: ActorAssertion = {
  externalId: `${DISCORD_SURFACE}:unreadable-channel`,
  isExternalGuest: true,
};

export interface DiscordPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordPluginOptions {
  clientFactory?: () => Client;
  drainTimeoutMs: number;
}

interface ConnectionScope {
  inFlightRuns: Set<string>;
  hydrator: MemberHydrator;
  classifyUser: (userId: string, fallbackName: string) => Promise<ActorAssertion | null>;
  readersOf: (baseChannelId: string) => Promise<ReaderResult>;
  stakes: StakeTracker;
  dispatcher: DiscordDispatcher;
  interact: (click: ButtonClick) => Promise<void>;
}

function replyChannel(ch: {
  send(options: MessageCreateOptions): Promise<{
    id?: string;
    edit(content: string): Promise<unknown>;
    delete(): Promise<unknown>;
  }>;
  sendTyping?(): Promise<void>;
}): ReplyChannel {
  return {
    send: async (content, files) => {
      const sent = await ch.send({
        content: content || undefined,
        allowedMentions: NO_MENTIONS,
        ...(files?.length ? { files } : {}),
      });
      return {
        id: sent.id ?? "",
        edit: (c) => sent.edit(c),
        delete: () => sent.delete(),
      };
    },
    typing: async () => {
      if (typeof ch.sendTyping === "function") await ch.sendTyping();
    },
  };
}

export function createDiscordPlugin(
  cfg: DiscordPluginConfig,
  core: DiscordCoreClient,
  opts: DiscordPluginOptions,
): DiscordPlugin {
  const clientFactory =
    opts.clientFactory ??
    (() =>
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
        allowedMentions: NO_MENTIONS,
      }));
  const drainTimeoutMs = opts.drainTimeoutMs;
  const inFlightRuns = new Set<string>();

  let client: Client | null = null;
  let detachClient: (() => { client: Client; inFlight: Set<Promise<void>> }) | null = null;
  let stopPromise: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryDelay = DISCORD_LOGIN_RETRY_BASE_MS;
  let stopped = true;

  async function handle(message: Message, c: Client, run: ConnectionScope): Promise<void> {
    const botUserId = c.user?.id ?? "";
    const inbound = toInbound(message);
    if (inbound.guildId !== null && !cfg.guildIds.has(inbound.guildId)) return;
    const staked = needsStakeLookup(inbound, botUserId) ? await run.stakes.has(inbound.channelId, botUserId) : false;
    if (shouldMirror(inbound, botUserId, staked))
      void core
        .ingestSurfaceEvents([toIngestEvent(inbound, botUserId, { handled: false, createdAt: Date.now() })], {
          name: c.user?.tag,
          mentionId: botUserId,
        })
        .catch(swallowAs("discord: mirror", undefined));
    const routed = routeMessage(inbound, botUserId, cfg.guildIds);
    if (!routed) return;
    const prompted = routed.target !== "thread" || !routed.unprompted;
    if (!prompted && !staked) return;
    const actor = await run.classifyUser(inbound.authorId, inbound.authorName);
    if (!actor) {
      if (prompted) await message.reply({ content: READERS_UNKNOWN_TEXT, allowedMentions: NO_MENTIONS });
      return;
    }
    if (actor.isExternalGuest) return;
    const common = { actor, text: routed.text, redeliveryKey: `discord:${message.id}` };
    if (routed.target === "dm") {
      if (message.channel.type !== ChannelType.DM) return;
      const { attachments, notes } = await ingestAttachments(inbound.attachments, core);
      const target = { kind: "dm" as const, channelId: message.channelId };
      await runDiscordTurn({
        core,
        channel: replyChannel(message.channel),
        mode: "stream",
        inFlightRuns: run.inFlightRuns,
        mayPost: allowDmStream,
        body: {
          ...common,
          ...(attachments.length ? { attachments } : {}),
          ...(notes.length ? { inboundNotes: notes } : {}),
          conversation: conversationFor(target),
          deliveryTarget: deliveryTargetFor(target),
          triggerTs: message.id,
          entryTs: message.id,
        },
      });
      return;
    }
    const parentChannelId = inbound.threadParentId ?? message.channelId;
    const readers = await run.readersOf(parentChannelId);
    if (!readers.ok && readers.retry) {
      if (prompted) await message.reply({ content: READERS_UNKNOWN_TEXT, allowedMentions: NO_MENTIONS });
      return;
    }
    const thread =
      routed.target === "new-thread"
        ? await message.startThread({ name: threadName(routed.text) })
        : (message.channel as AnyThreadChannel);
    run.stakes.mark(thread.id);
    const target = {
      kind: "thread" as const,
      threadId: thread.id,
      parentChannelId,
      ...(thread.parent?.name ? { channelName: thread.parent.name } : {}),
    };
    const audience = readers.ok ? audienceWith(readers.readers, actor) : [actor, UNKNOWN_READER];
    const { attachments, notes } = await ingestAttachments(inbound.attachments, core);
    await runDiscordTurn({
      core,
      channel: replyChannel(thread),
      mode: "spine",
      inFlightRuns: run.inFlightRuns,
      body: {
        ...common,
        ...(attachments.length ? { attachments } : {}),
        ...(notes.length ? { inboundNotes: notes } : {}),
        conversation: conversationFor(target, audience),
        deliveryTarget: deliveryTargetFor(target),
        ...(prompted ? { triggerTs: message.id, entryTs: message.id } : { unprompted: true, entryTs: message.id }),
      },
    });
  }

  async function connect(): Promise<void> {
    if (stopped || client) return;
    let accepting = true;
    const inFlight = new Set<Promise<void>>();
    const c = clientFactory();
    client = c;

    const hydrator = createMemberHydrator({
      guildIds: cfg.guildIds,
      fetchAll: async (g) => {
        const guild = await c.guilds.fetch(g);
        const before = new Set(guild.members.cache.keys());
        const fetched = await guild.members.fetch();
        for (const id of before) {
          if (!fetched.has(id)) guild.members.cache.delete(id);
        }
      },
      onError: reportFailureAs("discord: member hydration", undefined),
    });
    const mergedClassify = createMergedClassify({
      client: c,
      cfg,
      linkedInternal: (userId) => core.linkedInternal(userId),
    });
    const classifyUser = createUserClassifier({
      client: c,
      cfg,
      hydrator,
      linkedInternal: (userId) => core.linkedInternal(userId),
    });
    const readersOf = (baseChannelId: string) =>
      channelReaders({
        viewers: cachedViewers(c, baseChannelId),
        guildIds: cfg.guildIds,
        ready: (guildId) => hydrator.ready(guildId),
        botUserId: c.user?.id ?? "",
        classify: (m) => mergedClassify(m.userId, m.displayName),
      });
    const stakes = createStakeTracker({ recent: createStakeHistory(c) });
    const dispatcher = createDiscordDispatcher({
      core,
      sender: createDiscordSender(c),
      guard: createDeliveryGuard({
        channelKind: createChannelKind(c),
        readers: readersOf,
        classifyUser: (id) => classifyUser(id, id),
      }),
      inFlightRuns,
      renderCard: createCardRenderer(core),
      recipientFor: (t) => discordUserIdOf(t) ?? core.discordUserIdsFor(t)[0] ?? null,
    });

    const interact = createInteractionHandler({
      core,
      classifyUser: (id) => classifyUser(id, id),
      readersOf,
      continueTurn: async (body, onAccepted) => {
        const target = body.deliveryTarget;
        if (!target) return;
        let ch;
        try {
          ch = await sendable(c, target);
        } catch {
          return;
        }
        const isDm = body.conversation.kind === "dm";
        if (!isDm && !body.conversation.channelRef) return;
        const mayPost = isDm
          ? allowDmStream
          : async () => {
              const res = await readersOf(body.conversation.channelRef!);
              return res.ok && !res.readers.some((r) => r.isExternalGuest);
            };
        return runDiscordTurn({
          core,
          channel: replyChannel(ch),
          body,
          mode: "stream",
          inFlightRuns,
          onAccepted,
          mayPost,
        });
      },
    });

    const scope: ConnectionScope = {
      inFlightRuns,
      hydrator,
      classifyUser,
      readersOf,
      stakes,
      dispatcher,
      interact,
    };

    let unsubscribeDeliveries: (() => void) | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    const drain = () => void scope.dispatcher.drain().catch(swallowAs("discord: delivery drain", undefined));
    const stopDeliverySubscription = () => unsubscribeDeliveries?.();

    detachClient = () => {
      accepting = false;
      scope.hydrator.stop();
      stopDeliverySubscription();
      if (pollTimer) clearInterval(pollTimer);
      return { client: c, inFlight };
    };

    c.on(Events.ShardReconnecting, () => scope.hydrator.invalidate());
    c.on(Events.ShardDisconnect, () => scope.hydrator.invalidate());
    c.on(Events.ShardReady, () => scope.hydrator.hydrate());
    c.on(Events.ShardResume, () => scope.hydrator.hydrate());
    c.once(Events.ClientReady, (ready) => {
      if (!accepting) return;
      console.log(`[qm] discord connected as @${ready.user.tag}`);
      scope.hydrator.hydrate();
      unsubscribeDeliveries = core.onDeliveryEnqueued(drain);
      pollTimer = setInterval(drain, DISCORD_DELIVERY_POLL_MS);
      drain();
    });

    c.on(Events.InteractionCreate, (interaction) => {
      if (!accepting || !interaction.isButton()) return;
      const p = scope
        .interact({
          customId: interaction.customId,
          userId: interaction.user.id,
          defer: async () => void (await interaction.deferUpdate()),
          refuse: async (content) => void (await interaction.followUp({ content, flags: MessageFlags.Ephemeral })),
          settle: async (content) =>
            void (await interaction.editReply({ content, components: [], allowedMentions: NO_MENTIONS })),
        })
        .catch(swallowAs("discord: interaction", undefined))
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    });

    c.on(Events.MessageCreate, (message) => {
      if (!accepting) return;
      const p = handle(message, c, scope)
        .catch(swallowAs("discord: message handler", undefined))
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    });

    try {
      await c.login(cfg.botToken);
      retryDelay = DISCORD_LOGIN_RETRY_BASE_MS;
    } catch (err) {
      reportFailureAs("discord plugin login", undefined)(err);
      scope.hydrator.stop();
      stopDeliverySubscription();
      if (pollTimer) clearInterval(pollTimer);
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
