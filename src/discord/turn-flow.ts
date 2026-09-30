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

type TurnMode = "stream" | "spine";

const TYPING_REFRESH_MS = 8_000;
export const WORKING_TEXT = "⚙ Working…";
export const FAILURE_TEXT = "Something went wrong on my side and I couldn't finish that. Please try again.";
export const REFUSED_GUEST_TEXT =
  "I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM.";
const EMPTY_REPLY_TEXT = "(no response)";
const APPROVAL_TEXT = "This needs an approval before I can continue. Approve it in the QM web app";
const STREAM_EDIT_INTERVAL_MS = 1500;
const GUEST_REFUSAL = "internal-only: shared audience includes a non-internal participant";

export interface TurnInput {
  core: SurfaceCoreClient;
  channel: ReplyChannel;
  body: CoreTurnBody;
  mode: TurnMode;
  inFlightRuns: Set<string>;
  streamIntervalMs?: number;
}

function refusalText(reason: string | undefined): string {
  return reason === GUEST_REFUSAL ? REFUSED_GUEST_TEXT : `I can't do that: ${reason ?? "refused"}`;
}

async function streamRun(
  core: SurfaceCoreClient,
  runId: string,
  status: StatusMessage,
  intervalMs: number,
): Promise<TurnResult | null> {
  let shown = "";
  const timer = setInterval(() => {
    const preview = chunkMessage(core.streamSnapshot(runId) ?? "")[0];
    if (!preview || preview === shown) return;
    shown = preview;
    void status.edit(preview).catch(swallowAs("discord: stream edit", undefined));
  }, intervalMs);
  try {
    return await core.waitRun(runId);
  } finally {
    clearInterval(timer);
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
    await status.edit(result.adminUrl ? `${APPROVAL_TEXT}: ${result.adminUrl}` : `${APPROVAL_TEXT}.`);
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

async function runStream(input: TurnInput): Promise<void> {
  const { core, channel, body, inFlightRuns, streamIntervalMs = STREAM_EDIT_INTERVAL_MS } = input;
  const status = await channel.send(WORKING_TEXT);
  let runId: string | undefined;
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    if (queued.steered) {
      await status.delete();
      return;
    }
    runId = queued.status === "queued" ? queued.runId : undefined;
    if (runId) {
      inFlightRuns.add(runId);
      await core.reportRunEditRef(runId, status.id);
    }
    const result = runId ? await streamRun(core, runId, status, streamIntervalMs) : queued;
    await deliver(result, status, channel, core);
    if (runId) await core.ackRunDelivery(runId);
  } catch (err) {
    swallowAs("discord: turn failed", undefined)(err);
    await status.edit(FAILURE_TEXT).catch(swallowAs("discord: failure edit", undefined));
  } finally {
    if (runId) inFlightRuns.delete(runId);
  }
}

async function runSpine(input: TurnInput): Promise<void> {
  const { core, channel, body } = input;
  const keepTyping = () => void channel.typing().catch(swallowAs("discord: typing", undefined));
  keepTyping();
  const timer = setInterval(keepTyping, TYPING_REFRESH_MS);
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    if (queued.steered) return;
    const result = queued.status === "queued" && queued.runId ? await core.waitRun(queued.runId) : queued;
    if (result?.status === "refused") await channel.send(refusalText(result.reason));
    else if (result?.status === "pending_approval")
      await channel.send(result.adminUrl ? `${APPROVAL_TEXT}: ${result.adminUrl}` : `${APPROVAL_TEXT}.`);
  } catch (err) {
    swallowAs("discord: spine turn failed", undefined)(err);
    await channel.send(FAILURE_TEXT).catch(swallowAs("discord: failure post", undefined));
  } finally {
    clearInterval(timer);
  }
}

export async function runDiscordTurn(input: TurnInput): Promise<void> {
  return input.mode === "spine" ? runSpine(input) : runStream(input);
}
