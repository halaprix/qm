import { DISCORD_DM_DELIVERY_TYPE, discordUserIdOf } from "../discord/config.ts";
import type { DiscordInstallationStore } from "../surfaces/discord-installation.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export type PrincipalRoute = (principalId: string) => Promise<string | null>;

export function withPrincipalRouting(store: DeliveryStore, route: PrincipalRoute): DeliveryStore {
  return {
    ...store,
    async enqueue(input) {
      if (
        input.destination.type !== "principal" ||
        input.destination.commandApprovalId ||
        input.destination.keychainResolution ||
        input.destination.react ||
        input.destination.delete ||
        input.destination.editRef
      ) {
        return store.enqueue(input);
      }
      const report = reportFailureAs("principal-routing discord copy", undefined);
      const discordOnly = discordUserIdOf(input.destination.target) !== null;
      const type = await route(input.destination.target).catch((err: unknown) => {
        if (discordOnly) throw err;
        report(err);
        return null;
      });
      if (discordOnly) {
        if (!type) throw new Error(`discord delivery unavailable for ${input.destination.target}`);
        return store.enqueue({ ...input, destination: { ...input.destination, type } });
      }
      const original = await store.enqueue(input);
      if (type) {
        await store
          .enqueue({
            ...input,
            destination: { ...input.destination, type, copyOf: original.id },
            idempotencyKey: `${input.idempotencyKey}:discord-dm`,
          })
          .catch(report);
      }
      return original;
    },
  };
}

export function createDiscordPrincipalRoute(deps: {
  installation: Pick<DiscordInstallationStore, "status">;
  linkedDiscordUserIds(principalId: string): string[];
}): PrincipalRoute {
  return async (principalId) => {
    if (!deps.linkedDiscordUserIds(principalId).length) return null;
    const status = await deps.installation.status();
    if (!status.configured) return null;
    return DISCORD_DM_DELIVERY_TYPE;
  };
}
