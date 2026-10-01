import { RESTJSONErrorCodes } from "discord.js";
import type { SurfaceCoreClient } from "../api/surface-core-client.ts";
import type { ActorAssertion, Delivery } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { toDiscordFiles } from "./attachments.ts";
import { DISCORD_DM_DELIVERY_TYPE, DISCORD_SURFACE } from "./config.ts";
import { chunkMessage } from "./format.ts";
import type { ReaderResult } from "./readers.ts";
import type { DiscordSender, OutboundMessage } from "./sender.ts";

export const DISCORD_DELIVERY_CLAIM_MS = 15_000;
export const DISCORD_RUN_RECOVERY_GRACE_MS = 15_000;
const UNICODE_EMOJI = /^\p{Extended_Pictographic}/u;
const EMPTY_TEXT = "(no response)";
const DM_CLOSED_CODE = RESTJSONErrorCodes.CannotSendMessagesToThisUser;

export type PostVerdict = { ok: true } | { ok: false; retry: boolean; reason: string };
export interface DeliveryGuard {
  mayPost(channelId: string): Promise<PostVerdict>;
}
export type ChannelKind = { kind: "dm"; recipientId: string } | { kind: "guild"; baseChannelId: string };

export function createDeliveryGuard(deps: {
  channelKind(channelId: string): Promise<ChannelKind | null>;
  readers(baseChannelId: string): Promise<ReaderResult>;
  classifyUser(userId: string): Promise<ActorAssertion | null>;
}): DeliveryGuard {
  return {
    async mayPost(channelId) {
      const kind = await deps.channelKind(channelId);
      if (!kind) return { ok: false, retry: false, reason: "channel not found" };
      if (kind.kind === "dm") {
        const recipient = await deps.classifyUser(kind.recipientId);
        if (!recipient) return { ok: false, retry: true, reason: "DM recipient not classified yet" };
        return recipient.isExternalGuest
          ? { ok: false, retry: false, reason: "DM recipient is not internal" }
          : { ok: true };
      }
      const result = await deps.readers(kind.baseChannelId);
      if (!result.ok) return { ok: false, retry: result.retry, reason: result.reason };
      return result.readers.some((r) => r.isExternalGuest)
        ? { ok: false, retry: false, reason: "guest reader" }
        : { ok: true };
    },
  };
}

export function parseDiscordTarget(target: string): { channelId: string; replyTo?: string } {
  const [channelId, replyTo] = target.split(":");
  return replyTo ? { channelId: channelId!, replyTo } : { channelId: channelId! };
}

export interface DiscordDispatcher {
  drain(): Promise<boolean>;
}

type DispatcherCore = Pick<
  SurfaceCoreClient,
  | "claimDeliveries"
  | "ackDelivery"
  | "reportDeliveryUndeliverable"
  | "holdDeliveryDispatch"
  | "readBlob"
  | "readFileArtifact"
>;

export function createDiscordDispatcher(deps: {
  core: DispatcherCore;
  sender: DiscordSender;
  guard: DeliveryGuard;
  inFlightRuns: ReadonlySet<string>;
  renderCard?: (d: Delivery) => Promise<OutboundMessage | null>;
  recipientFor: (target: string) => string | null;
  now?: () => number;
}): DiscordDispatcher {
  const now = deps.now ?? Date.now;

  function waitingOnRun(d: Delivery): boolean {
    if (!d.idempotencyKey.startsWith("run:")) return false;
    const runId = d.idempotencyKey.slice("run:".length);
    return deps.inFlightRuns.has(runId) || now() - d.createdAt < DISCORD_RUN_RECOVERY_GRACE_MS;
  }

  async function drop(d: Delivery, reason: string): Promise<void> {
    await deps.core.reportDeliveryUndeliverable(d.id, reason);
    await deps.core.ackDelivery(d.id);
  }

  async function deliverTo(channelId: string, d: Delivery, replyTo: string | undefined): Promise<void> {
    const dest = d.destination;
    if (dest.react) {
      if (!UNICODE_EMOJI.test(dest.react.emoji)) {
        await deps.core.reportDeliveryUndeliverable(d.id, "Discord reactions need a Unicode emoji");
        return;
      }
      await deps.sender.react(channelId, dest.react.messageTs, dest.react.emoji);
      return;
    }
    if (dest.delete) {
      await deps.sender.remove(channelId, dest.delete.messageTs);
      return;
    }
    const card = await deps.renderCard?.(d);
    if (card) {
      await deps.sender.send(channelId, card);
      return;
    }
    const { files, notes } = await toDiscordFiles(d.attachments ?? [], deps.core);
    const chunks = chunkMessage([d.text, ...notes].filter(Boolean).join("\n\n"));
    const [first, ...rest] = chunks;
    if (dest.editRef) await deps.sender.edit(channelId, dest.editRef, { content: first ?? EMPTY_TEXT });
    else if (first) await deps.sender.send(channelId, { content: first, ...(replyTo ? { replyTo } : {}) });
    for (const chunk of rest) await deps.sender.send(channelId, { content: chunk });
    if (files.length) await deps.sender.send(channelId, { files });
  }

  async function deliverOne(d: Delivery): Promise<void> {
    if (waitingOnRun(d)) return;
    if (d.destination.type === DISCORD_DM_DELIVERY_TYPE) {
      const userId = deps.recipientFor(d.destination.target);
      if (!userId) return drop(d, "no linked Discord account");
      let dmChannelId: string;
      try {
        dmChannelId = await deps.sender.openDm(userId);
      } catch (err) {
        if ((err as { code?: unknown }).code === DM_CLOSED_CODE)
          return drop(d, "recipient does not accept DMs from the bot");
        throw err;
      }
      const verdict = await deps.guard.mayPost(dmChannelId);
      if (!verdict.ok) return verdict.retry ? undefined : drop(d, verdict.reason);
      try {
        await deliverTo(dmChannelId, d, undefined);
      } catch (err) {
        if ((err as { code?: unknown }).code === DM_CLOSED_CODE)
          return drop(d, "recipient does not accept DMs from the bot");
        throw err;
      }
      await deps.core.ackDelivery(d.id, { recipientThreadRef: `${DISCORD_SURFACE}:dm:${dmChannelId}` });
      return;
    }
    const { channelId, replyTo } = parseDiscordTarget(d.destination.target);
    const verdict = await deps.guard.mayPost(channelId);
    if (!verdict.ok) {
      if (verdict.retry) return;
      return drop(d, verdict.reason);
    }
    await deliverTo(channelId, d, replyTo);
    await deps.core.ackDelivery(d.id);
  }

  return {
    async drain() {
      const ran = await deps.core.holdDeliveryDispatch(async (lost) => {
        let leaseLost = false;
        void lost.then(() => {
          leaseLost = true;
        });
        for (const type of [DISCORD_SURFACE, DISCORD_DM_DELIVERY_TYPE]) {
          for (const d of await deps.core.claimDeliveries(type, DISCORD_DELIVERY_CLAIM_MS)) {
            if (leaseLost) break;
            await deliverOne(d).catch((err: unknown) => deps.core.reportDeliveryUndeliverable(d.id, errMessage(err)));
          }
          if (leaseLost) break;
        }
        return true;
      });
      return ran === true;
    },
  };
}
