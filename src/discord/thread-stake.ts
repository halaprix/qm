import { swallowAs } from "../util/errors.ts";

export interface StakeMessage {
  authorId: string;
  mentionedUserIds: readonly string[];
}

export const THREAD_NO_STAKE_TTL_MS = 5 * 60_000;

export function hasBotStake(messages: readonly StakeMessage[], botUserId: string): boolean {
  return messages.some((m) => m.authorId === botUserId || m.mentionedUserIds.includes(botUserId));
}

export interface StakeTracker {
  has(threadId: string, botUserId: string): Promise<boolean>;
  mark(threadId: string): void;
}

export function createStakeTracker(opts: {
  recent(threadId: string): Promise<StakeMessage[]>;
  now?: () => number;
}): StakeTracker {
  const now = opts.now ?? Date.now;
  const staked = new Set<string>();
  const noStakeAt = new Map<string, number>();
  return {
    async has(threadId, botUserId) {
      if (staked.has(threadId)) return true;
      const checked = noStakeAt.get(threadId);
      if (checked !== undefined && now() - checked <= THREAD_NO_STAKE_TTL_MS) return false;
      let recent: StakeMessage[];
      try {
        recent = await opts.recent(threadId);
      } catch (err) {
        swallowAs("discord: thread stake", undefined)(err);
        return false;
      }
      if (hasBotStake(recent, botUserId)) {
        staked.add(threadId);
        return true;
      }
      noStakeAt.set(threadId, now());
      return false;
    },
    mark(threadId) {
      staked.add(threadId);
      noStakeAt.delete(threadId);
    },
  };
}
