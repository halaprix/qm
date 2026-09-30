import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import type { SurfaceCoreClientDeps } from "../src/api/surface-core-client.ts";
import { createIdentityService, type IdentityService } from "../src/identity/identity-service.ts";
import { createPrincipalLinkService, type PrincipalLinkService } from "../src/identity/principal-links.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { discordExternalId } from "../src/discord/config.ts";

function createDeps(identity: IdentityService): SurfaceCoreClientDeps {
  return {
    identity,
    runs: { onTerminal: () => {} },
  } as unknown as SurfaceCoreClientDeps;
}

describe("discord core client identity links", () => {
  afterEach(() => {
    installPrincipalLinks(null);
  });

  it("classifies unlinked, linked internal, and deactivated discord users", async () => {
    const links: PrincipalLinkService = createPrincipalLinkService();
    installPrincipalLinks(links);
    const identity = createIdentityService(undefined, { principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    assert.equal(await client.linkedInternal("unlinked-user"), false);

    await links.link({
      principalId: discordExternalId("discord-user-1"),
      canonicalId: "user@example.test",
      evidence: "admin link",
      linkedBy: "admin",
    });

    assert.equal(await client.linkedInternal("discord-user-1"), true);

    await identity.deactivate("user@example.test");

    assert.equal(await client.linkedInternal("discord-user-1"), false);
  });

  it("discordUserIdsFor returns only the discord ids linked to a principal", async () => {
    const links: PrincipalLinkService = createPrincipalLinkService();
    installPrincipalLinks(links);
    const identity = createIdentityService(undefined, { principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    await links.link({
      principalId: discordExternalId("discord-1"),
      canonicalId: "member@example.test",
      evidence: "admin link 1",
      linkedBy: "admin",
    });
    await links.link({
      principalId: discordExternalId("discord-2"),
      canonicalId: "member@example.test",
      evidence: "admin link 2",
      linkedBy: "admin",
    });
    await links.link({
      principalId: "slack:U12345",
      canonicalId: "member@example.test",
      evidence: "admin link slack",
      linkedBy: "admin",
    });

    assert.deepEqual(client.discordUserIdsFor("member@example.test"), ["discord-1", "discord-2"]);
    assert.deepEqual(client.discordUserIdsFor("other@example.test"), []);
  });
});
