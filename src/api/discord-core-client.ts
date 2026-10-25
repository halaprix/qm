import { type DirectoryMember } from "../directory/directory-store.ts";
import { canonicalPerson, personIds } from "../directory/person.ts";
import { DISCORD_SURFACE, discordExternalId, discordUserIdOf } from "../discord/config.ts";
import { SNOWFLAKE } from "../util/snowflake.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { scopeId } from "../types.ts";
import { createSurfaceCoreClient, type SurfaceCoreClient, type SurfaceCoreClientDeps } from "./surface-core-client.ts";

const WATERMARK_CONTAINERS_MAX = 500;

interface CoreStatus {
  notInternal: boolean;
}

interface DiscordChannelWatermark {
  container: string;
  lastTs: string;
}

export interface DiscordCoreClient extends SurfaceCoreClient {
  channelWatermarks(): Promise<DiscordChannelWatermark[]>;
  linkedInternal(discordUserId: string): Promise<boolean>;
  coreStatus(discordUserId: string): Promise<CoreStatus>;
  discordUserIdsFor(principalId: string): string[];
  syncDirectory(members: DirectoryMember[]): Promise<void>;
  linkPrivateThread(threadId: string, parentId: string): Promise<void>;
}

export function linkedDiscordUserIds(principalId: string): string[] {
  return personIds(principalId)
    .map(discordUserIdOf)
    .filter((id): id is string => id !== null);
}

export function createDiscordCoreClient(
  deps: SurfaceCoreClientDeps & { config: Pick<ScopedConfigStore, "linkConfigParent"> },
): DiscordCoreClient {
  return {
    ...createSurfaceCoreClient(deps, DISCORD_SURFACE),
    async channelWatermarks() {
      const containers = await deps.app.listSurfaceContainers({
        limit: WATERMARK_CONTAINERS_MAX,
        containerPattern: SNOWFLAKE.source,
      });
      return containers.flatMap((c) => (c.lastTs ? [{ container: c.container, lastTs: c.lastTs }] : []));
    },
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
      return { notInternal: deps.identity.classify(alias, false).type !== "internal" };
    },
    discordUserIdsFor(principalId) {
      return linkedDiscordUserIds(principalId);
    },
    async syncDirectory(members) {
      await deps.identity.refresh();
      await deps.app.upsertDiscordDirectory(members);
    },
    linkPrivateThread(threadId, parentId) {
      return deps.config.linkConfigParent(scopeId("channel", threadId), scopeId("channel", parentId));
    },
  };
}
