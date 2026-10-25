import { EMOJI_QUALIFIED_BY_NAME } from "../surfaces/emoji-map.ts";

const UNICODE_EMOJI = /^\p{Extended_Pictographic}/u;
const CUSTOM_EMOJI = /^(?:<(a?):(\w{2,32}):(\d{17,20})>|(\w{2,32}):(\d{17,20}))$/;
const SHORTCODE = /^:?([a-z0-9_+'-]+):?$/i;

export function resolveDiscordEmoji(raw: string): string | null {
  const emoji = raw.trim();
  if (UNICODE_EMOJI.test(emoji)) return emoji;
  const custom = CUSTOM_EMOJI.exec(emoji);
  if (custom) return custom[3] ? `${custom[1] ? "a:" : ""}${custom[2]}:${custom[3]}` : `${custom[4]}:${custom[5]}`;
  const shortcode = SHORTCODE.exec(emoji);
  return (shortcode && EMOJI_QUALIFIED_BY_NAME[shortcode[1]!.toLowerCase()]) || null;
}
