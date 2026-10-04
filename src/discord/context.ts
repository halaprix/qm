import type { DiscordCoreClient } from "../api/discord-core-client.ts";
import type { SurfaceContextRequest } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { discordExternalId } from "./config.ts";
import { parseDiscordTarget } from "./deliveries.ts";

export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  threadTs?: string;
}

export interface DiscordHistoryReader {
  recent(channelId: string, opts: { count: number; before?: string }): Promise<HistoryMessage[]>;
  canView(channelId: string, userId: string): Promise<boolean>;
}

const DISCORD_READ_MAX = 100;
const NOT_VISIBLE = "You can't read that Discord channel.";

export function createContextFulfiller(deps: {
  core: Pick<DiscordCoreClient, "fulfillContextRequest" | "discordUserIdsFor">;
  reader: DiscordHistoryReader;
  botUserId: () => string;
}): (request: SurfaceContextRequest) => Promise<void> {
  async function answer(q: SurfaceContextRequest["query"]) {
    if (q.openGroup) return { error: "Discord has no group DMs the bot can open." };
    if (q.searchAll || q.file || q.syncDirectory) return { error: "That lookup isn't available on Discord." };
    const target = q.conversationTarget ?? q.channelId;
    if (!target) return { error: "No Discord conversation to read." };
    const { channelId } = parseDiscordTarget(target);
    const viewers = q.viewer ? deps.core.discordUserIdsFor(q.viewer) : [];
    const visible = await Promise.all(viewers.map((id) => deps.reader.canView(channelId, id)));
    if (!visible.some(Boolean)) return { error: NOT_VISIBLE };
    const count = Math.max(1, Math.min(DISCORD_READ_MAX, q.count ?? DISCORD_READ_MAX));
    const rows = await deps.reader.recent(channelId, { count, ...(q.before ? { before: q.before } : {}) });
    const bot = deps.botUserId();
    return {
      result: {
        messages: rows.map((m) => ({
          ts: m.id,
          ...(m.threadTs ? { threadTs: m.threadTs } : {}),
          author: m.authorId === bot ? "you" : m.authorName,
          authorId: discordExternalId(m.authorId),
          text: m.text,
        })),
      },
    };
  }
  return async (request) => {
    const outcome = await answer(request.query).catch((err: unknown) => ({ error: errMessage(err) }));
    await deps.core.fulfillContextRequest(request.id, outcome);
  };
}
