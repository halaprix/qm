import { DISCORD_DM_DELIVERY_TYPE } from "../discord/config.ts";
import type { DiscordInstallationStore } from "../surfaces/discord-installation.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export type PrincipalRoute = (principalId: string) => Promise<string | null>;

export function withPrincipalRouting(store: DeliveryStore, route: PrincipalRoute): DeliveryStore {
  return {
    ...store,
    async enqueue(input) {
      const original = await store.enqueue(input);
      if (
        input.destination.type !== "principal" ||
        input.destination.commandApprovalId ||
        input.destination.react ||
        input.destination.delete ||
        input.destination.editRef
      ) {
        return original;
      }
      try {
        const type = await route(input.destination.target);
        if (type) {
          await store.enqueue({
            ...input,
            destination: { ...input.destination, type, copyOf: original.id },
            idempotencyKey: `${input.idempotencyKey}:discord-dm`,
          });
        }
      } catch (err) {
        reportFailureAs("principal-routing discord copy", undefined)(err);
      }
      return original;
    },
  };
}

export function createDiscordPrincipalRoute(deps: {
  installation: Pick<DiscordInstallationStore, "status">;
  environmentConfigured: boolean;
  linkedDiscordUserIds(principalId: string): string[];
}): PrincipalRoute {
  return async (principalId) => {
    if (!deps.linkedDiscordUserIds(principalId).length) return null;
    const status = await deps.installation.status();
    if (status.disabled) return null;
    if (status.configured) return status.principalDeliveries ? DISCORD_DM_DELIVERY_TYPE : null;
    return deps.environmentConfigured ? DISCORD_DM_DELIVERY_TYPE : null;
  };
}
