export const MEMBER_HYDRATE_RETRY_BASE_MS = 5_000;
const MEMBER_HYDRATE_RETRY_MAX_MS = 300_000;

export interface MemberHydrator {
  hydrate(): void;
  invalidate(): void;
  ready(guildId: string): boolean;
  allReady(): boolean;
  stop(): void;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

export function createMemberHydrator(opts: {
  guildIds: ReadonlySet<string>;
  fetchAll(guildId: string): Promise<void>;
  onError?: (guildId: string, err: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}): MemberHydrator {
  const setTimer = opts.setTimer ?? defaultTimer;
  const ready = new Set<string>();
  const retries = new Map<string, { cancel(): void }>();
  let generation = 0;
  let stopped = false;

  function fetchGuild(guildId: string, delay: number, gen: number): void {
    void opts.fetchAll(guildId).then(
      () => {
        if (gen === generation && !stopped) ready.add(guildId);
      },
      (err: unknown) => {
        opts.onError?.(guildId, err);
        if (gen !== generation || stopped) return;
        retries.set(
          guildId,
          setTimer(() => {
            retries.delete(guildId);
            fetchGuild(guildId, Math.min(delay * 2, MEMBER_HYDRATE_RETRY_MAX_MS), gen);
          }, delay),
        );
      },
    );
  }

  function cancelRetries(): void {
    for (const r of retries.values()) r.cancel();
    retries.clear();
  }

  return {
    hydrate() {
      if (stopped) return;
      generation += 1;
      cancelRetries();
      ready.clear();
      for (const guildId of opts.guildIds) fetchGuild(guildId, MEMBER_HYDRATE_RETRY_BASE_MS, generation);
    },
    invalidate() {
      generation += 1;
      cancelRetries();
      ready.clear();
    },
    ready: (guildId) => ready.has(guildId),
    allReady: () => [...opts.guildIds].every((g) => ready.has(g)),
    stop() {
      stopped = true;
      cancelRetries();
      ready.clear();
    },
  };
}
