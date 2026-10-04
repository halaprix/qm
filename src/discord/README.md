# Discord surface (Gateway)

The Discord surface runs **in-process with the agent core**: core boots it when
Discord tokens or stored installation settings are present and hands it a direct
client into core's services. It connects via an outbound **Gateway WebSocket**
(`discord.js`) to Discord — no public URL, ingress, domain, or TLS needed, so you
can run it from a laptop or any server with outbound internet access.

Both Direct Messages (DMs) and guild channels/threads are supported. In a configured
guild channel, `@mention` the bot to open a thread; follow-up messages inside that
thread continue the conversation without needing to re-mention the bot.

```
Discord  ⇄ (WebSocket Gateway)  discord surface (in core)  ── direct calls ──▶  core services (Pi)
```

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Give it a name and create.
2. In the left navigation, go to **Bot** → click **Reset Token** (confirm) → copy the token (`DISCORD_BOT_TOKEN`).
3. Under **General Information**, note the **Application ID** (used as the OAuth2 Client ID; when configuring via the admin card, QM can also derive this automatically from your bot token).

## 2. Privileged Gateway Intents

Under **Bot** → **Privileged Gateway Intents**, configure the following:

- **Server Members Intent** (`GatewayIntentBits.GuildMembers`): **Turn ON**. The bot hydrates guild members once per Gateway session into a live member cache (`guild.members.cache`) to compute who can view each channel (`ViewChannel`) and enforce guest access guards.
- **Message Content Intent** (`GatewayIntentBits.MessageContent`): **Turn ON**. Required to read message text and attachments in guild messages and threads where the bot has a stake (ambient follow-ups in threads without an explicit mention) and to mirror guild conversation events. Without this intent, guild messages arrive with empty content.
- **Presence Intent**: Leave **OFF** (not used).

> At 100+ servers, Discord requires application verification to enable privileged intents. This does not apply to private organization installations.

## 3. Invite URL and bot permissions

Generate your bot invite URL in the Developer Portal under **OAuth2 → URL Generator**:

1. Under **Scopes**, select `bot` only. (Slash commands are not used; button interactions and Gateway events function with the `bot` scope alone.)
2. Under **Bot Permissions**, select:
   - **View Channels** (`PermissionFlagsBits.ViewChannel`): to read channel structure and check channel viewing permissions.
   - **Send Messages**: to send message replies in DMs and channels.
   - **Send Messages in Threads**: to send replies within discussion threads.
   - **Create Public Threads**: to open a new thread when `@mentioned` in a channel.
   - **Read Message History** (`PermissionFlagsBits.ReadMessageHistory`): to inspect previous messages for thread stake tracking and fulfill `read_thread` context requests.
   - **Attach Files**: to upload agent-generated file artifacts.
   - **Add Reactions**: to apply emoji reactions on messages.
3. Unneeded permissions:
   - **Manage Threads**: the bot only creates public threads.
   - **Manage Messages**: the bot only edits and deletes its own messages.
   - **Use Application Commands**: no slash commands are registered.
4. Copy the generated invite URL, open it in your browser, select your server, and authorize the bot.

> **DM setting for approvals**: Users who want to approve commands via interactive buttons must allow direct messages from server members (Discord's default setting under **Privacy & Safety**). If DMs are closed, approval fallback links in the channel thread still work.

## 4. OAuth2 configuration (for account linking)

To let teammates link their Discord accounts to their QM user profiles ("Connect Discord" in QM web settings):

1. In the Developer Portal, go to **OAuth2**.
2. Under **Client Information**, click **Reset Secret** and copy the **Client Secret**.
3. Under **Redirects**, click **Add Redirect** and enter the redirect URI displayed in the QM admin card (`<portalUrl>/settings`, e.g. `https://qm.example.com/settings`).
4. Save changes.

During account linking, the web UI uses the OAuth2 `identify` scope with a browser-bound cryptographic nonce to securely prove identity without requesting server or messaging permissions.

## 5. Configure and run

Discord can be configured either through the **Admin UI card** (recommended, stored in Postgres) or via **environment variables** (bootstrap).

### Option A: Admin UI card (Stored config)

Open the QM web app → **Admin** → **Integrations** → **Discord**:

- **Bot token**: Enter your bot token.
- **OAuth2 client secret**: Enter the client secret from the Developer Portal.
- **Server (guild) ids**: Comma- or space-separated snowflake IDs of the servers the bot will monitor.
- **Internal role ids**: Comma- or space-separated snowflake IDs of the roles that classify a member as internal staff in any configured server.
- **Allowlisted user ids**: Optional comma- or space-separated Discord user IDs that are always considered internal staff.
- **Deliver personal notices**: Checkbox (enabled by default) to deliver copies of personal notices (keychain requests, access requests, user messages) to linked Discord DMs.

Click **Save**. The runtime reconciler activates or updates the Discord surface within a few seconds without restarting the core process.

**Stored config precedence & Disconnect**: Stored settings take precedence over environment variables. Clicking **Disconnect** in the admin card marks the installation disabled; the surface shuts down immediately and remains disconnected even across restarts, even if `DISCORD_BOT_TOKEN` is still present in the environment.

### Option B: Environment variables (Bootstrap)

For initial bootstrapping or headless deployments, configure via environment variables:

- `DISCORD_BOT_TOKEN`: The bot token from step 1. If unset and no stored config exists, core runs without Discord.
- `DISCORD_GUILD_IDS`: Comma- or space-separated server IDs the bot listens to and responds in.
- `DISCORD_INTERNAL_ROLE_IDS`: Comma- or space-separated role IDs that mark members as internal staff in any configured server.
- `DISCORD_ALLOW_USER_IDS`: Optional comma- or space-separated user IDs that are always treated as internal staff.

> Note: The OAuth2 client secret and the toggle for personal notices can only be configured in stored config via the admin card.

Start the core:

```bash
cd ~/Programming/qm
nvm use
HARNESS=pi ORG_ID=acme ANTHROPIC_API_KEY=… \
  DISCORD_BOT_TOKEN=… \
  DISCORD_GUILD_IDS=900000000000000000 \
  DISCORD_INTERNAL_ROLE_IDS=901000000000000000 \
  npm start
```

When connected, core logs:

```
[qm] discord connected as @<bot-tag>
```

## 6. Access and identity (Who counts as internal)

Every interaction and delivery is guarded by audience classification. A Discord user is treated as **internal (staff)** if:

1. Their Discord user ID is in the configured allowlist (`allowUserIds` / `DISCORD_ALLOW_USER_IDS`), OR
2. They hold an internal role (`internalRoleIds` / `DISCORD_INTERNAL_ROLE_IDS`) in **any** configured guild (the any-guild rule, independent of guild evaluation order), OR
3. Their Discord account is linked to an active internal QM web principal.

**External Guests**: Any user who does not satisfy at least one of these criteria is classified as an external guest (`isExternalGuest: true`).

**Third-Party Bots**: Every other bot in the server is treated like a human user — an external guest unless explicitly allowlisted or granted an internal role. There is no trusted-bots bypass. The bot's own user is excluded from reader lists.

## 7. Using it

### Direct Messages (DMs)

DM the bot directly for a 1:1 assistant session (one continuous session per DM channel). While working on your reply, the bot displays a **⚙ Working…** status message; as output streams in, it edits that message in place so the wait is visible without creating duplicate messages.

### Guild channels and threads

- **Start a thread**: `@mention` the bot in a configured guild channel. The bot opens a new public thread named from your prompt (`startThread`) and posts its reply there.
- **In-thread follow-ups**: Keep talking in the thread without `@mentioning` the bot. The bot tracks threads where it has a stake (where it created the thread, replied, or was mentioned) and listens ambiently to follow-up messages.

### Interactive approval buttons in DMs

When a tool call hits a command policy rule requiring authorization (`require_approval`):

- The bot posts an interactive card with buttons (**Allow once**, **Allow for this session**, **Always allow**, **Deny**) directly to the **requester's Discord DM**.
- The originating channel thread receives a status message directing the requester to check their DM, along with a fallback link to the QM web app.
- **Requester-only enforcement**: Only the user who requested the command can click the approval buttons. Clicks by any other user or guest are refused ephemerally.
- Clicks immediately acknowledge the interaction (`deferUpdate`), run concurrency guards, and update the card components to settle the decision.
- If the user has disabled DMs from server members, the DM delivery drops safely and the web link in the thread approves the command.

### Connect Discord (Account linking)

In the QM web app under **Settings**, users can click **Connect Discord**:

- A browser-bound nonce and signed `state` payload (valid for 10 minutes) initiate Discord's OAuth2 consent flow (`identify` scope).
- Upon authorization, Discord redirects back to `/settings`. The web app captures the authorization code, strips it from the browser URL history, and exchanges it for user identity.
- Linking associates the user's `discord:<userId>` principal with their QM account, unifying context, memory, and permissions.
- Users can unlink their account from settings at any time (accounts linked by an administrator cannot be self-unlinked).

### Personal notices

When personal notices are enabled (the default):

- Personal notices (keychain access requests, deployment access notifications, person-addressed messages) are forwarded as an **additional Discord DM copy** to the recipient's linked Discord account.
- The original notice on its primary surface (Slack, web, etc.) is preserved unchanged.
- Keychain requests delivered to Discord DMs include decision buttons (**Allow once**, **Always allow**, **Deny**).
- Deployment access notices on Discord are informational (no buttons; access decisions are made on the primary surface or web).
- Command approvals from other surfaces (such as Slack) stay on their originating surface and never cross-route to Discord.

### File sharing

- **Send files**: Attach up to 10 files per message. The bot downloads attachments hosted on Discord CDN (`cdn.discordapp.com` and `media.discordapp.net`) and stages them as blobs for the agent. Off-CDN URLs are rejected.
- **Receive files**: When the agent generates files, the bot uploads them into the DM or thread (up to 10 files per message, max 10 MiB per file). Files exceeding 10 MiB are omitted from the message with a note directing the user to inspect the file in the QM web app.

### Emoji reactions and context tools

- The agent can react to messages using standard Unicode emojis (e.g. `👍`, `✅`). Custom `:name:` guild emoji are dropped.
- Context tools (`read_thread`, `whats_new`) pull channel and thread history, verifying that the requesting viewer has both `ViewChannel` and `ReadMessageHistory` permissions.

## 8. Reader audience and security invariants

- **Guest guard**: If any member with `ViewChannel` permission on a guild channel (or parent channel for threads) is an external guest, the bot refuses to run channel turns there and drops outbound deliveries, preventing confidential context exposure.
- **Member hydration and reconnects**: While configured guilds are hydrating their member cache (at startup, or following Gateway reconnects via `ShardReconnecting` / `ShardDisconnect` until `ShardReady` / `ShardResume`), channel readers cannot be verified. Mentions during this window receive a retry notice:
  ```
  I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.
  ```
  Queued deliveries for those channels remain unacknowledged and retry once hydration completes.
- **Audience cap**: Channels with more than 500 eligible viewers (`DISCORD_AUDIENCE_CAP = 500`) are treated as guest-accessible and refused to prevent unbounded permission scans.

## 9. Limits and out-of-scope ceilings

- **Message limit**: Discord enforces a 2,000-character limit (`DISCORD_MESSAGE_LIMIT = 2000`). Replies exceeding this limit are split along paragraph, line, and word boundaries. Markdown code fences are cleanly closed before a cut and reopened in the next chunk.
- **Attachment limits**: Bot uploads cap at 10 MiB per file (`DISCORD_UPLOAD_LIMIT_BYTES`) and 10 files per message (`DISCORD_MAX_FILES`).
- **Emoji reactions**: Unicode emojis only. Custom guild emoji names are ignored.
- **Cross-channel reach**: The agent can post in its current channel/thread or DM linked individuals, but cannot reach across into other Discord channels.
- **No agent requests**: Personal agent hand-offs (`[[ask-agent: …]]`) are a Slack-specific adapter directive and are not available on Discord.
- **No directory sync**: Discord members are not synced into the QM org directory table. Membership and roles are evaluated live against Discord Gateway cache. Discord-only users cannot be reached by name in directory lookups unless linked.
- **Core ambient triggers**: Core ambient proactive wakeups are disabled for Discord; ambient responses occur only within staked threads.
- **Snowflake comparison in history tools**: `whats_new` compares message ids as strings, which is wrong only when one channel mixes older 17/18-digit ids with newer 19-digit ids.
- **Private threads**: Reader audience for private threads is computed from the parent channel's viewers (a safe superset).
- **One installation per org**: Only one Discord application can be configured per QM organization.

## 10. How it maps to the core

| Discord                                             | Core                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Direct Message (`message.guildId === null`)         | `POST /v1/turns` with `conversation.kind = "dm"`                                      |
| `@mention` in guild channel                         | `message.startThread` → `POST /v1/turns` with `mode: "spine"`                         |
| In-thread reply (staked thread)                     | `POST /v1/turns` with `unprompted: true` (+ conversation audience)                    |
| Audience check                                      | Every viewer with `ViewChannel` classified; any guest reader → refused                |
| Gateway reconnect / unhydrated members              | Refused with retry notice (`READERS_UNKNOWN_TEXT`); deliveries stay unacknowledged    |
| Command approval needed                             | `discord-dm` delivery with buttons to requester's DM; fallback web link in thread     |
| Interactive button click (`InteractionCreate`)      | Checked for requester identity → `continueTurn` continuation                          |
| Personal notices (keychain, access, person message) | Enqueued as additional `discord-dm` delivery copy to linked Discord user              |
| File attachments                                    | Downloaded from Discord CDN → staged blobs; outbound uploaded up to 10 MiB            |
| Context requests (`read_thread`, `whats_new`)       | Fulfill via `DiscordHistoryReader` if viewer has `ViewChannel` + `ReadMessageHistory` |
