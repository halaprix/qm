import { SNOWFLAKE } from "../util/snowflake.ts";

export const MESSAGE_ID_TOKEN = /^~([0-9a-z]+)$/;
const RADIX = 36;
export const SLACK_CONTAINER = /^[CDG][A-Z0-9]+$/;
export const SLACK_TS = /^(\d{6,})\.(\d{1,6})$/;
const MICROS_PER_SECOND = 1_000_000;

export interface MessageIdCodec {
  encode(id: string): string;
  decode(token: string): string | null;
}

export function encodeTs(ts: string): string {
  const m = SLACK_TS.exec(String(ts).trim());
  if (!m) return "";
  const seconds = Number(m[1]);
  const micros = Number(m[2]!.padEnd(6, "0"));
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros)) return "";
  const packed = seconds * MICROS_PER_SECOND + micros;
  if (!Number.isSafeInteger(packed)) return "";
  return `~${packed.toString(RADIX)}`;
}

export function decodeTs(id: string): string | null {
  const m = MESSAGE_ID_TOKEN.exec(String(id).trim());
  if (!m) return null;
  const packed = parseInt(m[1]!, RADIX);
  if (!Number.isSafeInteger(packed) || packed <= 0) return null;
  const seconds = Math.floor(packed / MICROS_PER_SECOND);
  const micros = packed % MICROS_PER_SECOND;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

function encodeSnowflake(id: string): string {
  const trimmed = String(id).trim();
  return SNOWFLAKE.test(trimmed) ? `~${BigInt(trimmed).toString(RADIX)}` : "";
}

function decodeSnowflake(token: string): string | null {
  const m = MESSAGE_ID_TOKEN.exec(String(token).trim());
  if (!m) return null;
  let packed = 0n;
  for (const digit of m[1]!) packed = packed * BigInt(RADIX) + BigInt(parseInt(digit, RADIX));
  const id = packed.toString();
  return SNOWFLAKE.test(id) ? id : null;
}

export const SLACK_MESSAGE_IDS: MessageIdCodec = { encode: encodeTs, decode: decodeTs };
export const DISCORD_MESSAGE_IDS: MessageIdCodec = { encode: encodeSnowflake, decode: decodeSnowflake };
