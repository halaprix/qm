import type { IdentityService } from "../identity/identity-service.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import { createTaskAcknowledgements, type TaskAckState, type TaskAcknowledgements } from "../slack/task-ack.ts";
import { orgId as configOrgId } from "../config.ts";
import type { StagedEnvelope } from "../slack/envelope-staging.ts";
import { resolveBranding } from "../resolution/branding.ts";
import type { App } from "./app.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type { Delivery, ScopeId, SurfaceContextRequest } from "../types.ts";
import { scopeId } from "../types.ts";
import type { CachedMessage, ReadMessagesOpts, SurfaceCache, IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { TurnStream } from "../runs/turn-stream.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { modelDisplayName } from "../model/pi-models.ts";
import type { ConversationEvent } from "../loops/sources/adapter.ts";
import { slackConversationRef } from "../loops/sources/slack.ts";
import { createSurfaceCoreClient, type SurfaceCoreClient, type SurfaceCoreClientDeps } from "./surface-core-client.ts";

export interface SlackAgentRequestContext {
  requestId: string;
  requesterId: string | undefined;
  targetUserId: string;
  targetDisplayName?: string;
  originChannel: string;
  originConversationKind?: "dm" | "channel" | "group";
  originThreadTs?: string;
  originThreadOnly: boolean;
  originChannelName?: string;
  originStatusTs?: string;
  dmChannel: string;
  dmMessageTs?: string;
  task: string;
  originAgentLabel: string;
  targetAgentLabel: string;
  createdAt: number;
  approvalRequestIds?: string[];
}

interface DirectoryPush {
  members?: Array<{ principalId: string; displayName: string; type: "internal"; slackId?: string }>;
  channels?: Array<{ channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean }>;
  channelMembers?: Array<{ channelId: string; principalId: string }>;
  channelRosterIds?: string[];
  channelRevocations?: Array<{ channelId: string; principalId: string }>;
  groupMembers?: Array<{ groupId: string; principalId: string }>;
  groupIds?: string[];
  groupRosterIds?: string[];
  workspaceUrl?: string;
  membersSyncedAt?: number;
  channelsSyncedAt?: number;
  groupsSyncedAt?: number;
}

export interface SlackCoreClient extends Omit<
  SurfaceCoreClient,
  "streamSnapshot" | "getDelivery" | "reportDeliveryUndeliverable"
> {
  streamSnapshot?(runId: string): string | null;
  getDelivery?(id: string): Promise<Delivery | null>;
  reportDeliveryUndeliverable?(id: string, reason: string): Promise<void>;
  taskAcknowledgements?: TaskAcknowledgements;
  externalSlackParticipants(): Promise<boolean>;
  internalMemberOverrides(): Promise<string[]>;
  ackEmojiOverride(): Promise<string[] | null>;
  publishEmojiCatalog(emoji: Record<string, string>): Promise<void>;
  surfaceHeaderFacts(scope: ScopeId): Promise<{ agentLabel?: string; modelName: string }>;
  channelHeaderPinEnabled(scope: ScopeId): Promise<boolean>;
  onScopeModelChanged(listener: (scope: ScopeId) => void): void;
  onChannelHeaderPinChanged(listener: (scope: ScopeId) => void): void;
  rememberSurfaceHistory?(events: IngestEvent[]): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  reportTurnMetrics(runId: string, patch: { deliverMs?: number; slackInflightMs?: number }): Promise<void>;
  putAgentRequest(requestId: string, record: SlackAgentRequestContext): Promise<void>;
  getAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null>;
  takeAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null>;
  agentRequestForApproval(approvalRequestId: string): Promise<SlackAgentRequestContext | null>;
  pushDirectory(body: DirectoryPush): Promise<boolean>;
  reportSlowDeliveryDrain?(info: { durationMs: number; rows: number }): Promise<void>;
  holdEnvelopeReplay<T>(account: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined>;
  recordAckPick(pick: AckPickInput): Promise<void>;
  inboxSlackMessage(msg: {
    channel: string;
    ts: string;
    threadTs?: string;
    text?: string;
    senderEmail?: string;
    isDirectMessage?: boolean;
  }): Promise<void>;
}

type AckPickInput = {
  channel: string;
  ts: string;
  outcome: "picked" | "declined";
  picked?: string;
  icon?: string;
  message?: string;
  candidates?: string;
  latencyMs?: number;
};

export type { SurfaceContextRequest };

export interface SlackCoreClientDeps extends SurfaceCoreClientDeps {
  identity: IdentityService;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: DurableMap<TaskAckState>;
  app: App;
  config: ScopedConfigStore;
  runtimeFallback: RuntimeChoice;
  blobTransfer: BlobTransferStore;
  deliveries: DeliveryStore;
  errors?: ErrorLog;
  metrics: MetricsSink;
  runs: RunStore;
  turnStream: TurnStream;
  tasks: TaskStore;
  agentRequests: DurableMap<SlackAgentRequestContext>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: OrgBranding;
  leaderLease?: LeaderLease;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
  surfaceCache?: SurfaceCache;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

const AGENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function agentRequestExpired(record: SlackAgentRequestContext): boolean {
  return Date.now() - record.createdAt > AGENT_REQUEST_TTL_MS;
}

export type AgentRequestStore = Pick<
  SlackCoreClient,
  "putAgentRequest" | "getAgentRequest" | "takeAgentRequest" | "agentRequestForApproval"
>;

export function createAgentRequestStore(map: DurableMap<SlackAgentRequestContext>): AgentRequestStore {
  return {
    async putAgentRequest(requestId, record) {
      await map.put(requestId, record);
      await (async () => {
        for (const [id, existing] of await map.entries()) {
          if (agentRequestExpired(existing)) await map.delete(id);
        }
      })().catch(swallowAs("agent-requests: expired sweep", undefined));
    },

    async getAgentRequest(requestId) {
      const record = await map.get(requestId);
      return record && !agentRequestExpired(record) ? record : null;
    },

    async takeAgentRequest(requestId) {
      const record = await map.take(requestId);
      return record && !agentRequestExpired(record) ? record : null;
    },

    async agentRequestForApproval(approvalRequestId) {
      for (const [, record] of await map.entries()) {
        if (record.approvalRequestIds?.includes(approvalRequestId) && !agentRequestExpired(record)) return record;
      }
      return null;
    },
  };
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const orgScope: ScopeId = scopeId("org", configOrgId());

  return {
    ...createSurfaceCoreClient(deps, "slack"),
    ...(deps.taskAcknowledgements
      ? { taskAcknowledgements: createTaskAcknowledgements(deps.taskAcknowledgements, lease, deps) }
      : {}),
    async externalSlackParticipants() {
      return (await deps.config.getExternalSlackParticipantsDurable(orgScope)) === true;
    },

    async internalMemberOverrides() {
      return deps.config.getInternalMemberOverridesDurable();
    },

    async ackEmojiOverride() {
      return await deps.config.getAckEmojiDurable(orgScope);
    },

    async publishEmojiCatalog(emoji) {
      deps.config.setSlackEmojiCatalog(orgScope, emoji);
    },

    async surfaceHeaderFacts(scope) {
      const [choice, branding] = await Promise.all([
        resolveRuntimeChoiceDurable(deps.config, orgScope, scope, deps.runtimeFallback),
        resolveBranding(deps.config, orgScope, deps.brandingDefault),
      ]);
      return {
        ...(branding.selfLabel ? { agentLabel: branding.selfLabel } : {}),
        modelName: modelDisplayName(choice.modelId),
      };
    },

    async channelHeaderPinEnabled(scope) {
      return deps.config.getChannelHeaderPinDurable(scope);
    },

    onScopeModelChanged(listener) {
      deps.config.onRuntimeSelectionChanged((scope) => listener(scope));
    },

    onChannelHeaderPinChanged(listener) {
      deps.config.onChannelHeaderPinChanged((scope) => listener(scope));
    },

    async rememberSurfaceHistory(events) {
      await deps.surfaceCache?.ingest(events);
    },

    async readSurfaceMessages(container, opts) {
      return deps.app.readSurfaceMessages(container, { ...opts, noFallback: true });
    },

    async reportTurnMetrics(runId, patch) {
      await deps.metrics.updateByRunId(runId, patch);
    },

    ...createAgentRequestStore(deps.agentRequests),

    async pushDirectory(body) {
      if (body.workspaceUrl) await deps.app.setDirectoryWorkspaceUrl(body.workspaceUrl);
      let applied = true;
      if (body.members) applied = (await deps.app.upsertDirectory(body.members, body.membersSyncedAt)) && applied;
      if (body.channels) {
        applied =
          (await deps.app.upsertChannels(
            body.channels,
            body.channelMembers,
            body.channelsSyncedAt,
            body.channelRosterIds,
            body.channelRevocations,
          )) && applied;
      }
      if (body.groupMembers) {
        applied =
          (await deps.app.upsertGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)) &&
          applied;
      }
      return applied;
    },

    holdDirectorySync(fn) {
      return lease.hold("slack:directory-sync", fn);
    },
    holdEnvelopeReplay(account, fn) {
      return lease.hold(`slack:envelope-replay:${account}`, fn);
    },
    stagedEnvelopes: deps.stagedEnvelopes,

    async reportSlowDeliveryDrain(info) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_drain_slow",
        message: `drain cycle took ${Math.round(info.durationMs / 1000)}s for ${info.rows} rows`,
        scopeLabel: "slack:deliveries" as ScopeId,
      });
    },

    pickAckEmoji(text, candidates) {
      return deps.pickAckEmoji?.(text, candidates) ?? Promise.resolve(undefined);
    },

    async inboxSlackMessage(msg) {
      const at = Math.round(Number.parseFloat(msg.ts) * 1000);
      if (!Number.isFinite(at)) return;
      await deps.inboxEvent?.({
        source: "slack",
        conversationRef: slackConversationRef(msg.channel, msg.ts, msg.threadTs, msg.isDirectMessage),
        at,
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.senderEmail ? { senderEmail: msg.senderEmail } : {}),
      });
    },
    async recordAckPick(pick) {
      if (!deps.ackPicks) return;
      const ackModel = deps.ackModelId?.();
      await deps.ackPicks
        .record({
          surface: "slack",
          channel: pick.channel,
          ts: pick.ts,
          outcome: pick.outcome,
          ...(pick.picked ? { picked: pick.picked } : {}),
          ...(pick.icon ? { icon: pick.icon } : {}),
          ...(pick.message ? { message: pick.message } : {}),
          ...(pick.candidates ? { candidates: pick.candidates } : {}),
          ...(ackModel ? { model: ackModel } : {}),
          ...(pick.latencyMs != null ? { latencyMs: pick.latencyMs } : {}),
          createdAt: Date.now(),
        })
        .catch(() => {});
    },
  };
}
