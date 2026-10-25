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
- **Reaction intents** (`GuildMessageReactions`, `DirectMessageReactions`): non-privileged, nothing to toggle in the portal.

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

An allow-listed or internal-role bot that mentions QM (or posts in a thread QM has a stake in) opens a turn like a person would, flagged as a bot actor so it never counts as a live human. An external-guest bot never opens a turn; its messages in staked threads are still mirrored as context.

## 7. Using it

### Direct Messages (DMs)

DM the bot directly for a 1:1 assistant session (one continuous session per DM channel). While working on your reply, the bot displays a **⚙ Working…** status message; as output streams in, it edits that message in place so the wait is visible without creating duplicate messages.

### Guild channels and threads

- **Start a thread**: `@mention` the bot in a configured guild channel. The bot opens a new public thread named from your prompt (`startThread`) and posts its reply there.
- **In-thread follow-ups**: Keep talking in the thread without `@mentioning` the bot. The bot tracks threads where it has a stake (where it created the thread, replied, or was mentioned) and listens ambiently to follow-up messages. Stakes are remembered in-process for the last 5,000 threads; a thread with no stake is re-checked after 5 minutes, concurrent checks of one thread share one history fetch, and a failed fetch is not remembered (the next message checks again).
- **Turn context**: each guild turn carries the last 20 messages before the trigger (thread history, plus the thread's starter message; for a new thread, the parent channel's recent messages) as prior turns and overheard lines, a conversation header naming the channel and members, and detect-time context. History is read only for channels whose whole audience is internal, and the bot's own `@mention` stays in the text as `@<bot name>`. The requester's timezone is not sent (Discord exposes none).
- **Replies and forwards**: a reply carries the referenced message as `[in reply to <name>] <excerpt>`; a forwarded message is rendered as `[forwarded message] <text>` with its attachments.
- **Acknowledgement**: when a prompted guild turn runs longer than two seconds, the bot reacts to the trigger message with an emoji and removes it when the turn settles.
- **Catch-up after offline or reconnect**: once the member cache has hydrated (startup, re-identify, resume), the bot fetches the newest page (100 messages) of each known channel and thread, keeps the ids above that channel's cursor (never reaching back more than 6 hours). The cursor is the in-process id of the newest message already handled in the channel when there is one, otherwise the mirrored watermark from the surface cache, and feeds them to the normal handlers one at a time, oldest first. Only messages that prompt the bot (a mention, or a reaction path) become turns; every other message is mirrored as context only, never answered. Known channels are the ones the surface cache mirrored (mentions, staked threads) plus every guild channel with live traffic since the process started; the cache is queried for Discord ids only, so Slack containers never use up the 500-row limit. A live message counts as seen once it passed the readiness gates, or once it got the "can't confirm who can read" notice: a noticed mention is never re-run by catch-up, because the notice asks the person to try again. Threads are always fetched (their cached last-message id can be stale after archiving). Duplicates are dropped by the per-message replay key (`discord:<message id>`); a mention that already opened a thread is skipped. Channels whose cached newest message is not past the starting id cost no request. A hydration that completes mid-sweep schedules exactly one more sweep. The cursor is one newest-id per channel and moves only through messages the handlers accepted. When the page holds only new messages, a note that history was only partly caught up is stored in that channel's memory so the model knows context may have a gap.
- **Typing indicator**: a prompted guild turn shows "typing" at once; an unprompted turn (staked-thread follow-up, reaction) shows it only after the run persists its durable replying state, so turns the model declines stay invisible. The durable replying state is set for Discord runs the same way as for Slack (every surface with a capabilities entry).
- **Edits and deletes**: edits and deletes of messages the bot mirrors (mentions, its own, staked threads) reach the surface cache and the session as `message_revision` entries. A message already mirrored keeps being tracked after an edit removes the mention (remembered in-process, last 5,000 messages). Edits to the message that opened a thread are caught up from the parent channel at turn end.

### Posting into other channels (reach)

The agent can post to another channel or thread of a configured server ("post this in #ops") through reach, by name (`#ops`, matched case-insensitively) or by channel/thread id. The name is tried against the Slack directory first and only then against the Discord channel cache.

- The requester's linked Discord account must have `ViewChannel` and `ReadMessageHistory` on the channel (the same check `read_thread` uses); a private thread additionally needs membership.
- The reader gate runs before anything is queued, exactly as for normal channel sends: a guest reader, an unconfigured server, too many readers, or readers still being hydrated refuses the post and the agent is told why. The dispatcher applies the same gate again at send time.
- Cron, loop, monitor, webhook and keychain fallbacks that target a Discord channel are delivered only while their owner's linked account can still view that channel. A trigger homed in a thread also needs the owner to see the thread itself: an archived or uncached thread is fetched by id, and a private thread needs the owner as a thread member (or Manage Threads). A home check that cannot be answered yet (members still loading, transient fetch failure) defers a scheduled fire until it is ten minutes late, then skips it; other destinations never delay the turn. Every trigger homed in a Discord channel or thread is checked against its owner's Discord access, with or without a destination. A lookup that times out counts as unanswered. A manual run skipped this way is logged as refused and leaves a one-shot cron enabled. A keychain resume waits under the same ten-minute bound (from the ask's resolution); a secret-drop resume whose home cannot be checked falls back to the owner's DM.

### People directory and hand-off by name

Internal members of the configured servers are synced into the org directory (display name and avatar), so the agent can reach a Discord-only teammate by name ("ask Dana to approve it", the `hand-off` skill) and project member lists show their Discord avatar. A message for a directory entry that is a Discord user (`discord:<user id>`) is delivered as a single DM from the bot; it is not queued for Slack. A teammate linked to a QM principal that has its own directory entry resolves under that entry and receives the DM at their linked Discord account. Guild channel turns carry the same hand-off instruction as Slack channel turns.

### Interactive approval buttons in DMs

When a tool call hits a command policy rule requiring authorization (`require_approval`):

- The bot posts an interactive card with buttons (**Allow once**, **Allow for this session**, **Always allow**, **Deny**) directly to the **requester's Discord DM**.
- The originating channel thread receives a status message directing the requester to check their DM, along with a fallback link to the QM web app.
- **Requester-only enforcement**: Only the user who requested the command can click the approval buttons. Clicks by any other user or guest are refused ephemerally.
- Clicks immediately acknowledge the interaction (`deferUpdate`), run concurrency guards, and update the card components to settle the decision.
- If the user has disabled DMs from server members, the DM delivery drops safely and the web link in the thread approves the command.
- A command longer than the inline limit, or one that would not fit the card in full, is never shown or approvable from the card: the card links to the conversation on the web (when a public web URL is configured) and offers Deny only.

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
- Deployment access notices sent as a Discord copy are informational (no buttons; decide on the primary surface or web). A recipient reachable only on Discord gets the notice itself, with **Approve** and **Decline** buttons.
- A keychain request that starts on Discord goes to the credential owner through the same routing: their Slack DM (plus a Discord copy when notices are on), or their Discord DM when Discord is their only surface. A person reachable only on Discord always gets their DM, even when personal notices are off.
- Command approvals from other surfaces (such as Slack) stay on their originating surface and never cross-route to Discord.

### File sharing

- **Send files**: Attach up to 10 files per message. The bot downloads attachments hosted on Discord CDN (`cdn.discordapp.com` and `media.discordapp.net`) and stages them as blobs for the agent. Off-CDN URLs are rejected.
- **Receive files**: When the agent generates files, the bot uploads them into the DM or thread (up to 10 files per message, max 10 MiB per file). Files exceeding 10 MiB are omitted from the message with a note directing the user to inspect the file in the QM web app.

### Emoji reactions and context tools

- The agent can react to messages with Unicode emojis (e.g. `👍`), `:shortcode:` names (e.g. `:tada:`), and custom guild emoji (`<:name:id>`, `<a:name:id>` or `name:id`).
- **Targeting any message**: guild turn context renders each message id as `[~base36]` (the shared codec in `src/surfaces/message-ids.ts`). When the id is unknown in the thread, the bot retries on the thread's parent channel (ids from the parent history and the thread starter). Custom emoji appear as `name:id` so the model can repeat them. The agent passes that token, or a raw message id, as `ts` to the `react` tool and the reaction lands on that message, not only the trigger.
- **Inbound reactions**: adding or removing a reaction starts an unprompted turn (`[Discord reaction] ...`) under the same gating as Slack: the reactor is not the bot, and the message is in a DM, is one of the bot's own messages, or is a thread root in a thread the bot has a stake in. External guests never trigger a turn, and guild turns apply the same reader audience guard as message turns. DM reactions run in stream mode; guild reactions run as a spine turn in the message's thread (a reaction on a top-level bot message opens a thread under it first).
- **React outcome**: when the detector decides the reaction itself is the right answer, the bot reacts to the reacted-to message (DMs) or the trigger message and posts nothing. In guilds the reaction is applied only when posting is allowed for the audience.
- Context tools (`read_thread`, `whats_new`) pull channel and thread history, verifying that the requesting viewer has both `ViewChannel` and `ReadMessageHistory` permissions. `read_thread` returns the current reactions of each message (`[]` when none), honours `match` (case-insensitive filter over the newest 100 messages, results flagged `hasMore`/`nextBefore`), and always reads live from Discord. Message text is whitespace-collapsed and clipped to 600 characters, and each message carries a UTC `time`.

## 8. Reader audience and security invariants

- **Guest guard**: If any member with `ViewChannel` permission on a guild channel (the parent channel for public threads; see Private threads below) is an external guest, the bot refuses to run channel turns there and drops outbound deliveries, preventing confidential context exposure.
- **Member hydration and reconnects**: While configured guilds are hydrating their member cache (at startup, or following Gateway reconnects via `ShardReconnecting` / `ShardDisconnect` until `ShardReady` / `ShardResume`), channel readers cannot be verified. Mentions during this window receive a retry notice:
  ```
  I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.
  ```
  Queued deliveries for those channels remain unacknowledged and retry once hydration completes.
- **Private threads**: a private thread is its own scope (`channel:<thread id>`), not its parent's; its readers are the parent's viewers who are thread members (fetched from Discord per turn) or hold `ManageThreads`. A failed member fetch means readers are unknown (retry later); a deleted thread is refused. Public threads keep the parent channel's scope and readers. Its config layers (instructions, command policy, security and sharing posture, approval grant modes, egress) come from the parent channel, so the parent's policy still applies inside it; memory, files, readers, sessions and entitlements stay under the thread's own scope. The thread-to-parent link is recorded server-side from Discord's own data, and no client field can set or change it. Every resolution of a private thread by the Discord surface links it first: its creation event, the active-thread scan on gateway ready, a turn in it, and every channel fetch or cache lookup the bot makes (channel lookups for reach and triggers, visibility and reader checks, history reads, sends). A failed link write fails closed: the lookup reports the channel as not visible yet (retry), and no turn runs there on an unlinked thread; a mention only gets the fixed retry notice above, which reads no config or content. If the thread scope already holds config layers of its own, the link is not recorded: turns in that thread are refused with a message telling an admin to clear that configuration, and the next sighting after it is cleared records the link. Every config read, including triggers (cron, loop, monitor) homed in the thread, the admin console and the control service, follows that link, and a config write to the thread's scope is refused with an error that names the parent, so a private thread is never configured weaker than its parent. Proof boundary: a private thread the Discord surface has not resolved yet (for example an archived one nobody has named) has no link, and nothing can act in it before then, because shared-scope entitlement for a Discord id comes only from a Discord lookup (which links it) or the channel directory (which the Discord surface never populates); clearing a thread's own security posture, command policy, approval modes, SOUL or egress has no admin control yet; other per-scope settings (for example the base model) are not inherited; content stored under the parent scope is not visible inside the thread; and a member added to the thread between the fetch and the reply is not seen until the next turn.
- **Audience cap**: Channels with more than 500 eligible viewers are treated as guest-accessible and refused to prevent unbounded permission scans.

## 9. Limits and out-of-scope ceilings

- **Command cap**: the card summary is clipped to 400 characters before the fit check (see Interactive approval buttons); the card links to the web app only when the public URL is http(s).
- **Message limit**: Discord enforces a 2,000-character limit. Replies exceeding this limit are split along paragraph, line, and word boundaries. Markdown code fences are cleanly closed before a cut and reopened in the next chunk.
- **Emoji reactions**: custom guild emoji need their id (`<:name:id>`); a bare custom `:name:` cannot be resolved and is reported undeliverable.
- **Cross-channel reach ceilings**: reach resolves a channel only when the Slack directory has no match for the name, so a Slack channel with the same name wins. Discord names are matched against the bot's cached channels and threads of the configured servers; an id that is not cached is fetched, so an archived thread is reachable by id; a name shared by several channels is refused with the candidate ids. Reach cannot start a new thread, and `threadTs` is Slack-only. Reading a named Discord channel through `/v1/surface-context` still resolves names through the Slack directory only.
- **Directory sync ceilings**: internal guild members (per section 6, bots and guests excluded) are pushed to the org directory as `discord:<user id>` with display name and avatar, from the hydrated member cache only (no extra gateway requests), after every full hydration and then every 5 minutes, single-flight and under the `discord:directory-sync` lease. A Discord member whose Discord id is linked to a QM principal that already has its own Slack directory entry is not listed again, so they resolve under that entry (and its Slack avatar); principals that only exist through sign-in or an email allow-list keep their Discord row. A name that matches both a Slack member and a Discord member is ambiguous rather than resolved to either (for example a Discord nickname equal to the start of a Slack display name), except that a Slack member whose name matches exactly wins over Discord members whose names only start with or contain it; an exact id still wins. The Discord rows are a separate slice of the directory: a Slack directory push never removes or deactivates them and a Discord push never touches Slack rows. A member who leaves the guild drops out of the directory at the next sync but is not deactivated. Channels, rosters and group DMs are not synced from Discord, and an allowlisted user who is in no configured guild is never listed.
- **Inbox**: Discord asks and mentions do not create Inbox items. Inbox items come from the Inbox loop reading a user's own connected Slack or Gmail, and the Slack events only refresh items already on a ledger; Discord has no per-user connector, no send-as-user action and no item source adapter.
- **Core ambient triggers**: Core ambient proactive wakeups are disabled for Discord; ambient responses occur only within staked threads.
- **Snowflake comparison**: `read_thread`, `whats_new` and catch-up order ids by length then value, which is correct for mixed 18/19-digit ids. The surface cache's stored last id per channel is still compared as text, so a channel that mixes 18- and 19-digit ids can start its catch-up from an older id than necessary (harmless: duplicates are dropped by the replay key).
- **Unprompted turns stay quiet**: ambient thread turns and reaction turns that are refused, fail, or need approval only log. In DMs they post no "Working…" message; a real reply is still posted.
- **Reaction directives**: the `[[react: ...]]` reply-text directive is not parsed on Discord. Guild turns react through the `react` tool; DM turns can only react through the detect-time outcome.
- **Message-id tokens**: `~id` tokens are decoded for reactions and the `whats_new` `since` cursor, not for edit or delete references.
- **Revisions in DMs**: DM messages are not mirrored, so DM edits and deletes are not tracked. Guild deletes of messages no longer cached are mirrored as tombstones without checking relevance.
- **Acknowledgement emoji**: picked at random from the default acknowledgement set (no model pick), guild turns only; DMs already show the Working status message.
- **Reaction threads**: a thread opened for a reaction is deleted when the turn ends silent or react-only, (also when it ends refused or failed, since unprompted turns stay quiet; a turn that ends pending approval keeps it, because the approved reply is delivered there later), but only if it holds nothing but the system thread-starter message and no other reaction turn has resolved it. Once another turn resolves a thread, this process never deletes it. The deletion applies only when the turn ended with a known non-reply status or a finished run with no stored result; a turn whose run is still live (for example a wait that gave up) never deletes it.
- **Catch-up ceilings**: the cursor is the in-process `seen` id when present, else the mirrored watermark, so DMs are never caught up (they are not mirrored, so no starting id exists) and a never-mirrored channel is covered only after it has live traffic in this process; at most the 500 most recently updated Discord containers are tracked; one page per channel per run; a mention mirrored just before a crash is not re-run when the mirror already advanced past it; messages older than 6 hours are not answered.
- **Half-streamed replies after a restart**: the stream status message is finalized in place by the recovered delivery (its id is saved on the run), so a single-message reply is neither duplicated nor lost. A reply that spilled into extra chunks or files, or an unprompted reply (no status message), can post again if the process died between sending and acknowledging; there is no verify-first step like Slack's. Chunk progress is not recorded either: a queued delivery whose later chunk fails (for example a transient Discord error) is retried from its first chunk, so the chunks already sent post again.
- **One installation per org**: Only one Discord application can be configured per QM organization.
