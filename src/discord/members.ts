import type { ActorAssertion } from "../types.ts";
import { discordExternalId, type DiscordPluginConfig } from "./config.ts";

export interface DiscordMemberFacts {
  userId: string;
  displayName: string;
  roleIds: readonly string[];
  isBot: boolean;
}

export type LinkedInternal = (userId: string) => Promise<boolean>;

export type CoreStatusOf = (userId: string) => Promise<{ notInternal: boolean; overrideInternal: boolean }>;

export async function classifyMember(
  m: DiscordMemberFacts,
  cfg: Pick<DiscordPluginConfig, "allowUserIds" | "internalRoleIds">,
  linkedInternal: LinkedInternal,
  coreStatusOf: CoreStatusOf,
): Promise<ActorAssertion> {
  const { notInternal, overrideInternal } = await coreStatusOf(m.userId);
  const internal =
    !notInternal &&
    (overrideInternal ||
      cfg.allowUserIds.has(m.userId) ||
      m.roleIds.some((r) => cfg.internalRoleIds.has(r)) ||
      (await linkedInternal(m.userId)));
  return {
    externalId: discordExternalId(m.userId),
    displayName: m.displayName,
    ...(m.isBot ? { isBot: true } : {}),
    ...(internal ? {} : { isExternalGuest: true }),
  };
}

export function mergeMemberships(
  userId: string,
  displayName: string,
  memberships: readonly DiscordMemberFacts[],
): DiscordMemberFacts {
  return {
    userId,
    displayName,
    roleIds: [...new Set(memberships.flatMap((m) => m.roleIds))].sort(),
    isBot: memberships.some((m) => m.isBot),
  };
}
