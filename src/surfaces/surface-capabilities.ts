import { orgId } from "../config.ts";
import { DISCORD_SURFACE } from "../discord/config.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { scopeId } from "../types.ts";

export interface SurfaceCapabilities {
  label: string;
  deliveryTypes: readonly string[];
  coreAmbient: boolean;
  approvalCardType: string | null;
  mentionHint: string;
  externalParticipantsAllowed(config: ScopedConfigStore | undefined): Promise<boolean>;
}

const SURFACES: Readonly<Record<string, SurfaceCapabilities>> = {
  slack: {
    label: "Slack",
    deliveryTypes: ["slack", "group", "principal"],
    coreAmbient: true,
    approvalCardType: "principal",
    mentionHint:
      " To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in People here / read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
    externalParticipantsAllowed: async (config) =>
      config ? config.getExternalSlackParticipantsDurable(scopeId("org", orgId())) : false,
  },
  [DISCORD_SURFACE]: {
    label: "Discord",
    deliveryTypes: [DISCORD_SURFACE],
    coreAmbient: false,
    approvalCardType: null,
    mentionHint:
      " On Discord, `<@123…>` shows a person's name but never pings anyone, and @everyone/@here never ping. React with a Unicode emoji character, not a :name:.",
    externalParticipantsAllowed: async () => false,
  },
};

export function surfaceCapabilities(surface: string | undefined): SurfaceCapabilities | undefined {
  return surface === undefined ? undefined : SURFACES[surface];
}

export function surfaceForDeliveryType(type: string): string | undefined {
  return Object.entries(SURFACES).find(([, caps]) => caps.deliveryTypes.includes(type))?.[0];
}
