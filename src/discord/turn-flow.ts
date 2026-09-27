import type { CoreTurnBody, SurfaceCoreClient } from "../api/surface-core-client.ts";
import type { TurnResult } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { toDiscordFiles, type DiscordFile } from "./attachments.ts";
import { chunkMessage } from "./format.ts";

export interface StatusMessage {
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface ReplyChannel {
  send(content: string, files?: DiscordFile[]): Promise<StatusMessage>;
}

export const WORKING_TEXT = "⚙ Working…";
export const FAILURE_TEXT = "Something went wrong on my side and I couldn't finish that. Please try again.";
const EMPTY_REPLY_TEXT = "(no response)";
const APPROVAL_TEXT = "This needs an approval before I can continue. Approve it in the QM web app";
const STREAM_EDIT_INTERVAL_MS = 1500;

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
    await status.edit(`I can't do that: ${result.reason ?? "refused"}`);
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

export async function runDiscordTurn(input: {
  core: SurfaceCoreClient;
  channel: ReplyChannel;
  body: CoreTurnBody;
  streamIntervalMs?: number;
}): Promise<void> {
  const { core, channel, body, streamIntervalMs = STREAM_EDIT_INTERVAL_MS } = input;
  const status = await channel.send(WORKING_TEXT);
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    if (queued.steered) {
      await status.delete();
      return;
    }
    const result =
      queued.status === "queued" && queued.runId
        ? await streamRun(core, queued.runId, status, streamIntervalMs)
        : queued;
    await deliver(result, status, channel, core);
  } catch (err) {
    swallowAs("discord: turn failed", undefined)(err);
    await status.edit(FAILURE_TEXT).catch(swallowAs("discord: failure edit", undefined));
  }
}
