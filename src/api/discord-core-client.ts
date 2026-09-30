import { canonicalPerson, personIds } from "../directory/person.ts";
import { DISCORD_SURFACE, discordExternalId, discordUserIdOf } from "../discord/config.ts";
import { createSurfaceCoreClient, type SurfaceCoreClient, type SurfaceCoreClientDeps } from "./surface-core-client.ts";

export interface DiscordCoreClient extends SurfaceCoreClient {
  linkedInternal(discordUserId: string): Promise<boolean>;
  discordUserIdsFor(principalId: string): string[];
}

export function createDiscordCoreClient(deps: SurfaceCoreClientDeps): DiscordCoreClient {
  return {
    ...createSurfaceCoreClient(deps, DISCORD_SURFACE),
    async linkedInternal(discordUserId) {
      await deps.identity.refresh();
      const alias = discordExternalId(discordUserId);
      const canonical = canonicalPerson(alias);
      return canonical !== alias && deps.identity.classify(canonical).type === "internal";
    },
    discordUserIdsFor(principalId) {
      return personIds(principalId)
        .map(discordUserIdOf)
        .filter((id): id is string => id !== null);
    },
  };
}
