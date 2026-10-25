import { EMOJI_QUALIFIED_BY_NAME } from "../surfaces/emoji-map.ts";
import { SNOWFLAKE_SOURCE } from "../util/snowflake.ts";

const PICTOGRAPHIC = /^\p{Extended_Pictographic}/u;
const GRAPHEMES = new Intl.Segmenter();
const CUSTOM_EMOJI = new RegExp(`^(?:<(a?):(\\w{2,32}):(${SNOWFLAKE_SOURCE})>|(\\w{2,32}):(${SNOWFLAKE_SOURCE}))$`);
const SHORTCODE = /^:?([a-z0-9_+'-]+):?$/i;

const isUnicodeEmoji = (text: string): boolean => PICTOGRAPHIC.test(text) && [...GRAPHEMES.segment(text)].length === 1;

export function resolveDiscordEmoji(raw: string): string | null {
  const emoji = raw.trim();
  if (isUnicodeEmoji(emoji)) return emoji;
  const custom = CUSTOM_EMOJI.exec(emoji);
  if (custom) {
    const id = custom[3] ?? custom[5]!;
    return custom[3] ? `${custom[1] ? "a:" : ""}${custom[2]}:${id}` : `${custom[4]}:${id}`;
  }
  const shortcode = SHORTCODE.exec(emoji);
  return (shortcode && EMOJI_QUALIFIED_BY_NAME[shortcode[1]!.toLowerCase()]) || null;
}
