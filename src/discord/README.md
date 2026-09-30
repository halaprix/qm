# Discord surface (Gateway)

The Discord surface runs **in-process with the agent core**: core boots it when
Discord tokens are present in its env and hands it a direct client into core's
services. It connects via an outbound **Gateway WebSocket** (discord.js) to Discord —
no public URL, ingress, domain, or TLS needed, so you can run it from a laptop or any
box with internet.

DMs and guild channels are both supported. In a guild, `@mention` the bot in a
configured channel to open a thread; replies inside that thread follow the
conversation without needing to re-mention the bot.

```
Discord  ⇄ (WebSocket Gateway)  discord surface (in core)  ── direct calls ──▶  core services (Pi)
```

## 1. Create the Discord app

1. Go to <https://discord.com/developers/applications> → **New Application**. Give it a name and create.
2. Go to **Bot** → **Reset Token** (confirm) → copy the token → `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, turn **Server Members Intent** and **Message Content Intent** **ON**. The bot needs a live member cache to compute who can read a guild channel, and needs message content to route and reply to guild mentions. Leave **Presence Intent** off.

## 2. Invite the bot

1. In your application settings on the Discord Developer Portal, go to **OAuth2 → URL Generator**.
2. Under **Scopes**, select `bot`.
3. Under **Bot Permissions**, select:
   - **View Channels**
   - **Send Messages**
   - **Create Public Threads**
   - **Send Messages in Threads**
   - **Attach Files**
   - **Read Message History**
4. Copy the generated URL at the bottom, open it in your browser, and authorize the bot.

## 3. Configure and run

Environment variables control the surface:

- `DISCORD_BOT_TOKEN`: The bot token from step 1. If unset, core runs without the Discord surface.
- `DISCORD_GUILD_IDS`: Comma- or space-separated list of guild (server) IDs the bot should read and respond in. A message from a guild not in this list is ignored.
- `DISCORD_INTERNAL_ROLE_IDS`: Comma- or space-separated list of role IDs that make a guild member internal (staff), in any of the configured guilds.
- `DISCORD_ALLOW_USER_IDS`: Optional. Comma- or space-separated list of Discord user IDs that are always internal, independent of guild roles or links — useful for DMs from someone with no configured guild role. To find a Discord user ID: enable **Developer Mode** in Discord Settings (Advanced → Developer Mode), right-click the user's avatar or username, and select **Copy User ID**.

A member who is not allowlisted, does not hold an internal role in any configured guild, and is not linked to an internal principal is treated as a guest: any channel a guest can read makes the bot refuse to answer there, other bots included (a bot user is never itself a reader).

Run core with the Discord variables set:

```bash
cd ~/Programming/qm
nvm use
HARNESS=pi ORG_ID=acme ANTHROPIC_API_KEY=… \
DISCORD_BOT_TOKEN=… \
DISCORD_GUILD_IDS=900000000000000000 \
DISCORD_INTERNAL_ROLE_IDS=901000000000000000 \
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
- **@mention the bot in a guild channel** → it opens a thread and posts the reply there. Follow-up messages in that thread reach the bot without re-mentioning it, as long as the bot has a stake in the thread's recent history.
- **Send files** → attach files in a DM or a guild message. The bot downloads attachments hosted on Discord CDN (`cdn.discordapp.com` and `media.discordapp.net`) and stages them as blobs for the agent (up to 10 files per message; the size cap is whatever Discord allowed the sender to upload, plus core's `MAX_BLOB_BYTES` blob limit). URLs outside the Discord CDN are refused.
- **Receive files** → when the agent produces files, the bot uploads them into the DM or thread (up to 10 files per message, max 10 MiB per file).

## 5. Limits and design

- **Live member cache, no guessing**: guild readers are computed from `discord.js`'s member cache, hydrated once per Gateway session. While a configured guild's members are not yet hydrated — at startup, or after a `ShardReconnecting`/`ShardDisconnect` until the session resumes with `ShardReady`/`ShardResume` — the bot cannot confirm who can read a channel and says so with a short, friendly refusal instead of guessing. Deliveries queued for that channel are left unacknowledged and retried once readers are known.
- **Guest channels are refused**: any guild channel a non-internal reader (a guest) can see makes the bot refuse to answer there. The bot's own user is never counted as a reader; every other bot is classified like a person (a guest unless allowlisted, role-holding, or linked).
- **Message splitting (`DISCORD_MESSAGE_LIMIT = 2000`)**: Discord enforces a 2,000-character limit per message. Replies exceeding 2,000 characters are split into sequential messages along paragraph, line, and word boundaries. Splits inside markdown code blocks automatically close the fence before the split and re-open it in the next chunk, keeping code formatting intact.
- **Upload limits (`DISCORD_UPLOAD_LIMIT_BYTES = 10 MiB`, `DISCORD_MAX_FILES = 10`)**: Discord bot uploads cap at 10 MiB per file and at most 10 files per message. Outbound files exceeding 10 MiB are omitted from the message and replaced with a text note directing the user to inspect the file in the QM web app.
- **No mention pings**: Bot replies never ping users or roles (`allowedMentions` is configured with `parse: []` and `repliedUser: false`).
- **Identity scoping**: Discord users are assigned `discord:<userId>` external principals. They are isolated from Slack and web identities, with separate sessions and memory scopes.
- **Approvals**: Tool calls requiring operator approval cannot be approved via Discord chat buttons. Instead, the bot posts a link to the QM web app where the operator can review and approve or deny the action.
