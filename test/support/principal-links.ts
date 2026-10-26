import { bootAdminGrantSeed, createAdminService } from "../../src/admin/admin-service.ts";
import {
  createAdminGrantStore,
  createMemoryAdminGrantPersistence,
  type AdminGrant,
} from "../../src/admin/admin-grant-store.ts";
import { orgId } from "../../src/config.ts";
import { createPrincipalLinkService, type PrincipalLink } from "../../src/identity/principal-links.ts";
import { createMemoryAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../../src/persistence/durable-map.ts";

export const memoryGrants = (seed: AdminGrant[] = []) =>
  createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed });

export const memoryPrincipalLinks = (
  backing: DurableMap<PrincipalLink> = createMemoryMap<PrincipalLink>(),
  grants = memoryGrants(),
) => createPrincipalLinkService(backing, createMemoryAdvisoryLock(), grants);

export function memoryAdmin(
  grants = memoryGrants(bootAdminGrantSeed(undefined, orgId(), false)),
  opts: { trustedOidcAdminIssuer?: string } = {},
) {
  return createAdminService(grants, { ...opts, principalLinks: memoryPrincipalLinks(undefined, grants) });
}
