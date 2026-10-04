export const DISCORD_MESSAGE_LIMIT = 2000;
const CLOSE_FENCE = "\n```";
const BARE_FENCE = "```";
const MAX_REOPEN_FENCE_DIVISOR = 4;
const SEPARATORS = ["\n\n", "\n", " "];

function fenceAfter(piece: string, open: string | null): string | null {
  let state = open;
  for (const m of piece.matchAll(/^(```[^\n]*)$/gm)) state = state ? null : m[1]!;
  return state;
}

function cutPoint(text: string, max: number): number {
  const cap = Math.max(1, max);
  if (text.length <= cap) return text.length;
  const window = text.slice(0, cap);
  for (const sep of SEPARATORS) {
    const i = window.lastIndexOf(sep);
    if (i > cap / 2) return i + sep.length;
  }
  return cap;
}

export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let open: string | null = null;
  while (rest) {
    const head = open ? `${open.length <= limit / MAX_REOPEN_FENCE_DIVISOR ? open : BARE_FENCE}\n` : "";
    const cut = cutPoint(rest, limit - head.length - CLOSE_FENCE.length);
    const piece = rest.slice(0, cut).trimEnd();
    const after = fenceAfter(piece, open);
    chunks.push(`${head}${piece}${after ? CLOSE_FENCE : ""}`);
    open = after;
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return chunks;
}
