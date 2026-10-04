import { canonicalPerson, personIds } from "../directory/person.ts";
import { DISCORD_SURFACE, discordExternalId, discordUserIdOf } from "../discord/config.ts";
import { createSurfaceCoreClient, type SurfaceCoreClient, type SurfaceCoreClientDeps } from "./surface-core-client.ts";

interface CoreStatus {
  notInternal: boolean;
  overrideInternal: boolean;
}

export interface DiscordCoreClient extends SurfaceCoreClient {
  linkedInternal(discordUserId: string): Promise<boolean>;
  coreStatus(discordUserId: string): Promise<CoreStatus>;
  discordUserIdsFor(principalId: string): string[];
}

export function linkedDiscordUserIds(principalId: string): string[] {
  return personIds(principalId)
    .map(discordUserIdOf)
    .filter((id): id is string => id !== null);
}

export function createDiscordCoreClient(deps: SurfaceCoreClientDeps): DiscordCoreClient {
  return {
    ...createSurfaceCoreClient(deps, DISCORD_SURFACE),
    async linkedInternal(discordUserId) {
      await deps.identity.refresh();
      const alias = discordExternalId(discordUserId);
      const canonical = canonicalPerson(alias);
      return (
        canonical !== alias &&
        deps.identity.externalMember(canonical) === undefined &&
        deps.identity.classify(canonical).type === "internal"
      );
    },
    async coreStatus(discordUserId) {
      await deps.identity.refresh();
      const alias = discordExternalId(discordUserId);
      const canonical = canonicalPerson(alias);
      return {
        overrideInternal:
          deps.identity.classify(alias, true).type === "internal" ||
          deps.identity.classify(canonical, true).type === "internal",
        notInternal: deps.identity.classify(alias, false).type !== "internal",
      };
    },
    discordUserIdsFor(principalId) {
      return linkedDiscordUserIds(principalId);
    },
  };
}
