import { createDiscordChannels } from "../../src/discord/gateway.ts";

export const noLinkChannels = (client: unknown) => createDiscordChannels(client as never, async () => {});
