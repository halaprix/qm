import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { App } from "./app.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { GoalView, TurnStream } from "../runs/turn-stream.ts";
import type { TaskStore, TaskStatus } from "../tasks/task-store.ts";
import type {
  ActorAssertion,
  Delivery,
  OutgoingAttachment,
  PendingApproval,
  ScopeId,
  SurfaceContextRequest,
  SurfaceContextResult,
  TurnRequest,
  TurnResult,
} from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import type { IngestEvent } from "../surface-cache/surface-cache.ts";
import { decideDeploymentAccess } from "../deploy/access-decision.ts";

interface SurfaceRunHooks {
  onReplying?(): void;
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
  onTasks?(tasks: Array<{ id: string; title: string; status: TaskStatus }>): void | Promise<void>;
  onGoal?(goal: GoalView): void | Promise<void>;
}

export type CoreTurnBody = Omit<TurnRequest, "surface">;

interface StoredApprovalView extends Omit<PendingApproval, "reason"> {
  createdAt?: number;
  reason?: string;
  request?: Record<string, unknown>;
}

export interface SurfaceCoreClient {
  submitTurn(body: CoreTurnBody): Promise<TurnResult>;
  waitRun(runId: string, hooks?: SurfaceRunHooks): Promise<TurnResult | null>;
  streamSnapshot(runId: string): string | null;
  activeRunForThread(threadRef: string): Promise<string | undefined>;
  stopConversation(threadRef: string): Promise<boolean>;
  signalRunAbort(runId: string): Promise<void>;
  stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
  ingestSurfaceEvents(events: IngestEvent[], self?: { name?: string; mentionId?: string }): Promise<void>;
  ackRunDelivery(runId: string): Promise<void>;
  reportRunEditRef(runId: string, editRef: string): Promise<void>;
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  getDelivery(id: string): Promise<Delivery | null>;
  ackDelivery(id: string, body?: { recipientThreadRef?: string; slackApiMs?: number }): Promise<void>;
  reportDeliveryUndeliverable(id: string, reason: string): Promise<void>;
  onDeliveryEnqueued(listener: () => void): () => void;
  holdDeliveryDispatch<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  pendingContextRequests(): Promise<SurfaceContextRequest[]>;
  onContextRequest(listener: (request: SurfaceContextRequest) => void): () => void;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<void>;
  getApproval(requestId: string): Promise<StoredApprovalView | null>;
  decideDeploymentAccess(value: string, actor: ActorAssertion, approve: boolean): Promise<string>;
  keychainApprovals?: KeychainApprovals;
}

export async function readOutgoingAttachment(
  source: Pick<SurfaceCoreClient, "readBlob" | "readFileArtifact">,
  a: OutgoingAttachment,
): Promise<Buffer> {
  try {
    return await source.readBlob(a.blobId);
  } catch (err) {
    if (!a.artifactId || !a.artifactViewerId) throw err;
    return source.readFileArtifact(a.artifactId, a.artifactViewerId);
  }
}

export interface SurfaceCoreClientDeps {
  app: App;
  runs: RunStore;
  turnStream: TurnStream;
  tasks: TaskStore;
  blobTransfer: BlobTransferStore;
  identity: IdentityService;
  deliveries: DeliveryStore;
  leaderLease?: LeaderLease;
  errors?: ErrorLog;
  keychainApprovals?: KeychainApprovals;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;

export function createSurfaceCoreClient(deps: SurfaceCoreClientDeps, surface: string): SurfaceCoreClient {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    submitTurn(body) {
      return deps.app.turn({ ...body, surface });
    },

    streamSnapshot(runId) {
      return deps.turnStream.snapshot(runId);
    },

    async stageBlob(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const info = await deps.blobTransfer.put(Readable.from([Buffer.from(bytes)]), {
        maxBytes: MAX_BLOB_BYTES,
        expectedSha256: sha256,
      });
      return { blobId: info.blobId, sizeBytes: info.sizeBytes };
    },

    async readBlob(blobId) {
      const blob = await deps.blobTransfer.open(blobId);
      if (!blob) throw new Error(`blob ${blobId} not found`);
      return buffer(blob.stream);
    },

    async readFileArtifact(artifactId, viewerId) {
      const opened = await deps.app.openFileForViewer(artifactId, viewerId);
      if (!opened) throw new Error(`file artifact ${artifactId} not found (or not visible to ${viewerId})`);
      return buffer(opened.stream);
    },

    async waitRun(runId, hooks = {}) {
      let replyingSignaled = false;
      let firstBlockSignaled = false;
      let surfaceSignaled = false;
      const signalReplying = (durable = false): void => {
        if (replyingSignaled || !(durable || deps.turnStream.replying(runId))) return;
        replyingSignaled = true;
        hooks.onReplying?.();
      };
      const signalFirstBlock = (text: string): void => {
        if (firstBlockSignaled || !text.trim()) return;
        firstBlockSignaled = true;
        hooks.onFirstBlock?.(text);
      };
      const signalSurface = (): void => {
        if (surfaceSignaled) return;
        surfaceSignaled = true;
        hooks.onSurfacePosted?.();
      };
      const waiters = terminalWaiters.get(runId) ?? new Set();
      terminalWaiters.set(runId, waiters);
      const unsubscribe = deps.turnStream.subscribe(runId, {
        onFirstBlock: signalFirstBlock,
        onSurfacePosted: signalSurface,
      });
      let lastProgressAt = Date.now();
      let lastMark = "";
      let taskSnapshot = "";
      let goalSnapshot = "";
      const emitGoal = async (): Promise<void> => {
        if (!hooks.onGoal) return;
        const goal = deps.turnStream.goal(runId);
        if (!goal) return;
        const next = JSON.stringify(goal);
        if (next === goalSnapshot) return;
        goalSnapshot = next;
        await hooks.onGoal(goal);
      };
      const emitTasks = async (): Promise<void> => {
        if (!hooks.onTasks) return;
        const tasks = (await deps.tasks.list({ originRunId: runId })).map(({ id, title, status }) => ({
          id,
          title,
          status,
        }));
        if (!tasks.length) return;
        const next = JSON.stringify(tasks);
        if (next === taskSnapshot) return;
        taskSnapshot = next;
        await hooks.onTasks(tasks);
      };
      try {
        for (;;) {
          let run;
          try {
            run = await deps.runs.get(runId);
          } catch (err) {
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) throw err;
            run = undefined;
          }
          if (run !== undefined) {
            if (!run) throw new Error(`run ${runId} not found`);
            if (deps.turnStream.surfacePosted(runId)) signalSurface();
            if (isTerminal(run.status)) {
              const view = await deps.app.getRun(runId);
              await emitTasks().catch(swallowAs("surface-core-client: terminal task refresh", undefined));
              await emitGoal().catch(swallowAs("surface-core-client: terminal goal refresh", undefined));
              if (view?.surfacePosted) signalSurface();
              return (view?.result as TurnResult | null | undefined) ?? null;
            }
            signalReplying(run.deliveryState?.replying === true);
            await emitTasks();
            await emitGoal().catch(swallowAs("surface-core-client: goal refresh", undefined));
            const fb = deps.turnStream.firstBlock(runId);
            if (fb?.closed) signalFirstBlock(fb.text);
            const mark = `${run.status}:${run.attempts}:${run.leaseExpiresAt ?? ""}`;
            if (mark !== lastMark) {
              lastMark = mark;
              lastProgressAt = Date.now();
            }
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) {
              throw Object.assign(
                new Error(`run ${runId} made no progress for ${Math.round(RUN_STALL_BUDGET_MS / 1000)}s — giving up`),
                { code: "run_stalled" },
              );
            }
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, RUN_FALLBACK_POLL_MS);
            function done(): void {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
          });
        }
      } finally {
        unsubscribe();
        if (waiters.size === 0) terminalWaiters.delete(runId);
      }
    },

    async activeRunForThread(threadRef) {
      return (await deps.app.activeRunForThread(threadRef))?.runId;
    },

    stopConversation(threadRef) {
      return deps.app.stopConversation(threadRef);
    },

    async signalRunAbort(runId) {
      const outcome = await deps.app.signalRun(runId, { kind: "abort" });
      if (!outcome.accepted) throw new Error(`signal abort not accepted: ${outcome.reason ?? "unknown"}`);
    },

    decideDeploymentAccess: (value, actor, approve) =>
      decideDeploymentAccess(deps.app, deps.identity, value, actor, approve),
    ...(deps.keychainApprovals ? { keychainApprovals: deps.keychainApprovals } : {}),

    async ingestSurfaceEvents(events, self) {
      if (!events.length) return;
      await deps.app.ingestSurfaceEvents(events, surface, self);
    },

    async ackRunDelivery(runId) {
      await deps.app.ackDeliveryByKey(`run:${runId}`);
    },

    async reportRunEditRef(runId, editRef) {
      const found = await deps.app.setRunDeliveryState(runId, { editRef });
      if (!found) throw new Error(`run ${runId} not found`);
    },

    async getApproval(requestId) {
      const record = await deps.app.getApproval(requestId);
      if (!record) return null;
      return {
        requestId: record.requestId,
        ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
        command: record.command,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.summaryDetail !== undefined ? { summaryDetail: record.summaryDetail } : {}),
        ...(record.grantModes !== undefined ? { grantModes: record.grantModes } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.request !== undefined ? { request: record.request as unknown as Record<string, unknown> } : {}),
      };
    },

    claimDeliveries(type, claimMs) {
      return deps.app.pendingDeliveries(type, claimMs);
    },

    getDelivery(id) {
      return deps.deliveries.get(id);
    },

    holdDeliveryDispatch(fn) {
      return lease.hold(`${surface}:delivery-dispatch`, fn);
    },

    async ackDelivery(id, body) {
      if (body?.recipientThreadRef) await deps.app.recordPrincipalDelivery(id, body.recipientThreadRef);
      await deps.app.ackDelivery(id, body?.slackApiMs);
    },

    async reportDeliveryUndeliverable(id, reason) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_undeliverable",
        message: `delivery ${id} cannot be delivered (${reason}) — retrying until the TTL expires it`,
        scopeLabel: `${surface}:deliveries` as ScopeId,
      });
    },

    onDeliveryEnqueued(listener) {
      return deps.deliveries.onEnqueue(listener);
    },

    pendingContextRequests() {
      return deps.app.pendingContextRequests(surface);
    },

    onContextRequest(listener) {
      return deps.app.onContextRequestCreated((request) => {
        if (request.source === surface) listener(request);
      });
    },

    async fulfillContextRequest(id, outcome) {
      await deps.app
        .fulfillContextRequest(id, outcome)
        .then((ok) => {
          if (!ok) return;
        })
        .catch(swallowAs("surface-core-client: fulfill context request", undefined));
    },
  };
}
