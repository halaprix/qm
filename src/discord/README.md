# Discord surface (Gateway)

The Discord surface runs **in-process with the agent core**: core boots it when
Discord tokens are present in its env and hands it a direct client into core's
services. It connects via an outbound **Gateway WebSocket** (discord.js) to Discord —
no public URL, ingress, domain, or TLS needed, so you can run it from a laptop or any
box with internet.

```
Discord  ⇄ (WebSocket Gateway)  discord surface (in core)  ── direct calls ──▶  core services (Pi)
```

## 1. Create the Discord app

1. Go to <https://discord.com/developers/applications> → **New Application**. Give it a name and create.
2. Go to **Bot** → **Reset Token** (confirm) → copy the token → `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, leave all three intents (**Presence Intent**, **Server Members Intent**, **Message Content Intent**) **OFF**. The bot does not request or require privileged intents: Discord delivers message content for DMs and for messages that explicitly mention the bot without the Message Content intent.

## 2. Invite the bot to your server

1. In your application settings on the Discord Developer Portal, go to **OAuth2 → URL Generator**.
2. Under **Scopes**, select `bot`.
3. Under **Bot Permissions**, select:
   - **View Channels**
   - **Send Messages**
   - **Send Messages in Threads**
   - **Create Public Threads**
   - **Attach Files**
   - **Read Message History**
4. Copy the generated URL at the bottom, open it in your browser, select your server, and authorize.

## 3. Configure and run

Three environment variables control the surface:

- `DISCORD_BOT_TOKEN`: The bot token from step 1. If unset, core runs without the Discord surface.
- `DISCORD_ALLOW_USER_IDS`: **Required** when `DISCORD_BOT_TOKEN` is set. Comma- or space-separated list of allowed Discord user IDs. Core refuses to start if this is unset or empty to prevent open access. To find a Discord user ID: enable **Developer Mode** in Discord Settings (Advanced → Developer Mode), right-click the user's avatar or username, and select **Copy User ID**.
- `DISCORD_GUILD_IDS`: Optional. Comma- or space-separated list of allowed Discord guild (server) IDs. If omitted or empty, the bot operates in **DMs only** and ignores all server messages. To find a guild ID: right-click the server icon with Developer Mode enabled and select **Copy Server ID**.

Run core with the Discord variables set:

```bash
cd ~/Programming/qm
nvm use
HARNESS=pi ORG_ID=acme ANTHROPIC_API_KEY=… \
DISCORD_BOT_TOKEN=… \
DISCORD_ALLOW_USER_IDS=123456789012345678 \
DISCORD_GUILD_IDS=987654321098765432 \
npm start
```

(Or put them in the repo-root `.env` file — `npm start` loads it automatically.)

When connected, core logs:

```
[qm] discord connected as @<bot-tag>
```

Without `DISCORD_BOT_TOKEN`, core runs without Discord.

## 4. Use it

- **DM the bot** anything → it replies directly in the DM (one continuous session per DM channel). While working, the bot posts a **⚙ Working…** status message. As the agent generates output, the reply streams in place by editing that status message, keeping the wait visible without duplicate messages.
- **@mention it in a channel** → in a server channel, mentioning `@bot` triggers the bot to create a new public thread named after your prompt (up to 100 characters) and reply inside that thread (one session per thread).
- **Continue a thread conversation** → to follow up in a thread, mention the bot again: `@bot <follow-up>`. Each turn in a server requires an explicit @mention.
- **Send files** → attach files in a DM or alongside an @mention. The bot downloads attachments hosted on Discord CDN (`cdn.discordapp.com` and `media.discordapp.net`) and stages them as blobs for the agent (up to 10 files per message; the size cap is whatever Discord allowed the sender to upload, plus core's `MAX_BLOB_BYTES` blob limit). URLs outside the Discord CDN are refused.
- **Receive files** → when the agent produces files, the bot uploads them into the channel or thread (up to 10 files per message, max 10 MiB per file).

## 5. Limits and design

- **Message splitting (`DISCORD_MESSAGE_LIMIT = 2000`)**: Discord enforces a 2,000-character limit per message. Replies exceeding 2,000 characters are split into sequential messages along paragraph, line, and word boundaries. Splits inside markdown code blocks automatically close the fence before the split and re-open it in the next chunk, keeping code formatting intact.
- **Upload limits (`DISCORD_UPLOAD_LIMIT_BYTES = 10 MiB`, `DISCORD_MAX_FILES = 10`)**: Discord bot uploads cap at 10 MiB per file and at most 10 files per message. Outbound files exceeding 10 MiB are omitted from the message and replaced with a text note directing the user to inspect the file in the QM web app.
- **Server message visibility**: In server channels and threads, the bot only sees messages that explicitly @mention it. The surface intentionally avoids the privileged `Message Content` intent.
- **No mention pings**: Bot replies never ping users or roles (`allowedMentions` is configured with `parse: []` and `repliedUser: false`).
- **Identity scoping**: Discord users are assigned `discord:<userId>` external principals. They are isolated from Slack and web identities, with separate sessions and memory scopes.
- **Approvals**: Tool calls requiring operator approval cannot be approved via Discord chat buttons. Instead, the bot posts a link to the QM web app where the operator can review and approve or deny the action.
- **Fail-closed allowlist**: Messages from users not listed in `DISCORD_ALLOW_USER_IDS`, messages from other bots, or messages from unlisted guilds are silently ignored.
