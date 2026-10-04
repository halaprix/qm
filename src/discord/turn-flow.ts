import type { CoreTurnBody, SurfaceCoreClient } from "../api/surface-core-client.ts";
import type { TurnResult } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { toDiscordFiles, type DiscordFile } from "./attachments.ts";
import { chunkMessage } from "./format.ts";

export interface StatusMessage {
  id: string;
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface ReplyChannel {
  send(content: string, files?: DiscordFile[]): Promise<StatusMessage>;
  typing(): Promise<void>;
}

const TYPING_REFRESH_MS = 8_000;
const WORKING_TEXT = "⚙ Working…";
export const FAILURE_TEXT = "Something went wrong on my side and I couldn't finish that. Please try again.";
const REFUSED_GUEST_TEXT =
  "I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM.";
const REFUSED_STREAM_TEXT = "I can't post this reply here right now.";
const EMPTY_REPLY_TEXT = "(no response)";
const APPROVAL_TEXT = "This needs an approval before I can continue. Approve it in the QM web app";
const APPROVAL_DM_TEXT =
  "This needs your approval — I sent you the buttons in a direct message. If they don't arrive, approve it in the QM web app";
const STREAM_EDIT_INTERVAL_MS = 1500;
const GUEST_REFUSAL = "internal-only: shared audience includes a non-internal participant";

export type TurnInput =
  | {
      core: SurfaceCoreClient;
      channel: ReplyChannel;
      body: CoreTurnBody;
      mode: "spine";
      inFlightRuns: Set<string>;
      mayPost: () => Promise<boolean>;
    }
  | {
      core: SurfaceCoreClient;
      channel: ReplyChannel;
      body: CoreTurnBody;
      mode: "stream";
      inFlightRuns: Set<string>;
      streamIntervalMs?: number;
      onAccepted?: () => Promise<void>;
      onSettled?: (result: TurnResult) => Promise<void>;
      mayPost: () => Promise<boolean>;
    };

function approvalText(result: TurnResult): string {
  if (!result.pendingApprovals?.length) {
    if (result.reason) return result.reason;
    return result.adminUrl ? `${APPROVAL_TEXT}: ${result.adminUrl}` : `${APPROVAL_TEXT}.`;
  }
  return result.adminUrl ? `${APPROVAL_DM_TEXT}: ${result.adminUrl}` : `${APPROVAL_DM_TEXT}.`;
}

export function refusalText(reason: string | undefined): string {
  return reason === GUEST_REFUSAL ? REFUSED_GUEST_TEXT : `I can't do that: ${reason ?? "refused"}`;
}

async function streamRun(
  core: SurfaceCoreClient,
  runId: string,
  status: StatusMessage,
  intervalMs: number,
  mayPost: () => Promise<boolean>,
): Promise<{ result: TurnResult | null; stoppedByGate: boolean }> {
  let shown = "";
  let stoppedByGate = false;
  let finished = false;
  let inFlight = false;
  let inFlightTick: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight || stoppedByGate || finished) return;
    inFlight = true;
    inFlightTick = (async () => {
      try {
        const preview = chunkMessage(core.streamSnapshot(runId) ?? "")[0];
        if (!preview || preview === shown) return;
        const allowed = await mayPost();
        if (stoppedByGate || finished) return;
        if (!allowed) {
          stoppedByGate = true;
          clearInterval(timer);
          await status.edit(REFUSED_STREAM_TEXT).catch(swallowAs("discord: refusal edit", undefined));
          return;
        }
        shown = preview;
        await status.edit(preview).catch(swallowAs("discord: stream edit", undefined));
      } finally {
        inFlight = false;
      }
    })().catch(swallowAs("discord: stream tick", undefined));
  }, intervalMs);
  try {
    const result = await core.waitRun(runId);
    return { result, stoppedByGate };
  } finally {
    finished = true;
    clearInterval(timer);
    await inFlightTick;
  }
}

async function deliver(
  result: TurnResult | null,
  status: StatusMessage,
  channel: ReplyChannel,
  core: SurfaceCoreClient,
): Promise<void> {
  if (!result || result.status === "failed") {
    await status.edit(FAILURE_TEXT);
    return;
  }
  if (result.status === "silent") {
    await status.delete();
    return;
  }
  if (result.status === "refused") {
    await status.edit(refusalText(result.reason));
    return;
  }
  if (result.status === "pending_approval") {
    await status.edit(approvalText(result));
    return;
  }
  const { files, notes } = await toDiscordFiles(result.attachments ?? [], core);
  const chunks = chunkMessage([result.reply ?? "", ...notes].filter(Boolean).join("\n\n"));
  if (files.length && !chunks[0]) {
    await status.delete();
    await channel.send("", files);
    return;
  }
  await status.edit(chunks[0] ?? EMPTY_REPLY_TEXT);
  for (const chunk of chunks.slice(1)) await channel.send(chunk);
  if (files.length) await channel.send("", files);
}

async function runStream(input: Extract<TurnInput, { mode: "stream" }>): Promise<void> {
  const { core, channel, body, inFlightRuns, mayPost, streamIntervalMs = STREAM_EDIT_INTERVAL_MS } = input;
  const status = await channel.send(WORKING_TEXT);
  let submitted = false;
  let settled = false;
  const settle = async (result: TurnResult) => {
    if (!input.onSettled || settled) return;
    settled = true;
    await input.onSettled(result).catch(swallowAs("discord: onSettled", undefined));
  };
  let runId: string | undefined;
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    submitted = true;
    if (queued.status !== "refused" && queued.status !== "failed" && input.onAccepted) {
      await input.onAccepted().catch(swallowAs("discord: onAccepted", undefined));
    }
    if (queued.steered) {
      await settle(queued);
      await status.delete();
      return;
    }
    runId = queued.status === "queued" ? queued.runId : undefined;
    if (runId) {
      inFlightRuns.add(runId);
      if (!(await mayPost())) {
        await status.edit(REFUSED_STREAM_TEXT).catch(swallowAs("discord: refusal edit", undefined));
        if (input.onSettled) await settle((await core.waitRun(runId)) ?? { status: "failed" });
        return;
      }
      await core.reportRunEditRef(runId, status.id);
    }
    const { result, stoppedByGate } = runId
      ? await streamRun(core, runId, status, streamIntervalMs, mayPost)
      : { result: queued, stoppedByGate: false };
    await settle(result ?? { status: "failed" });
    if (stoppedByGate) return;
    if (!(await mayPost())) {
      await status.edit(REFUSED_STREAM_TEXT);
      return;
    }
    await deliver(result, status, channel, core);
    if (runId) await core.ackRunDelivery(runId);
  } catch (err) {
    swallowAs("discord: turn failed", undefined)(err);
    if (submitted) await settle({ status: "failed" });
    await status.edit(FAILURE_TEXT).catch(swallowAs("discord: failure edit", undefined));
  } finally {
    if (runId) inFlightRuns.delete(runId);
  }
}

async function runSpine(input: Extract<TurnInput, { mode: "spine" }>): Promise<void> {
  const { core, channel, body, mayPost } = input;
  const keepTyping = () => void channel.typing().catch(swallowAs("discord: typing", undefined));
  keepTyping();
  const timer = setInterval(keepTyping, TYPING_REFRESH_MS);
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    if (queued.steered) return;
    const result = queued.status === "queued" && queued.runId ? await core.waitRun(queued.runId) : queued;
    if (result?.status === "refused") {
      const allowed = result.reason === GUEST_REFUSAL || (await mayPost());
      await channel.send(allowed ? refusalText(result.reason) : REFUSED_STREAM_TEXT);
    } else if (result?.status === "pending_approval") {
      const allowed = await mayPost();
      await channel.send(allowed ? approvalText(result) : REFUSED_STREAM_TEXT);
    }
  } catch (err) {
    swallowAs("discord: spine turn failed", undefined)(err);
    const allowed = await mayPost().catch(() => false);
    await channel
      .send(allowed ? FAILURE_TEXT : REFUSED_STREAM_TEXT)
      .catch(swallowAs("discord: failure post", undefined));
  } finally {
    clearInterval(timer);
  }
}

export async function runDiscordTurn(input: TurnInput): Promise<void> {
  return input.mode === "spine" ? runSpine(input) : runStream(input);
}
