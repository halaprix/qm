export const SNOWFLAKE = /^\d{17,20}$/;
const SNOWFLAKE_EPOCH_MS = 1_420_070_400_000;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

export function snowflakeMs(id: string): number {
  return Number(BigInt(id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + SNOWFLAKE_EPOCH_MS;
}

export function snowflakeAt(ms: number): string {
  return ((BigInt(ms) - BigInt(SNOWFLAKE_EPOCH_MS)) << SNOWFLAKE_TIMESTAMP_SHIFT).toString();
}
