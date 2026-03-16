<img width="1633" height="851" alt="Image" src="https://github.com/user-attachments/assets/a3745a2d-6b3c-4176-98cd-a545a8affa64" />


# HivePing

Conversation-scoped mention bridge for OpenClaw channels (Discord, Slack, Microsoft Teams) with Codex as the default reasoning backend.

HivePing runs in mention-only mode.

- Slash commands are disabled.
- Use `@hiveping ...` in-channel, or mention the bot account directly (`<@...>`).
- Both `<@bot> ...` and `<@bot> @hiveping ...` forms are supported.
- Slack native mention tokens like `<@U123456|botname> ...` are supported; no Slack slash command registration is required for HivePing.

## OpenClaw Flow In HivePing

HivePing uses OpenClaw as the runtime and channel router.

- OpenClaw delivers inbound channel events to HivePing through plugin hooks (`message_received`).
- HivePing resolves conversation binding, role policy, and approval policy for that event.
- HivePing executes the configured reasoning backend for the bound repository (Codex by default).
- HivePing sends mention replies directly with `openclaw message send`.
- OpenClaw channel adapters deliver the final response to Discord, Slack, or Teams.

## Install In Docker

1. Build plugin:

```bash
cd /home/node/.openclaw/workspace/hiveping
npm run build
```

2. Install by link:

```bash
docker compose run --rm openclaw-cli plugins install --link /home/node/.openclaw/workspace/hiveping
```

3. Enable plugin:

```bash
docker compose run --rm openclaw-cli plugins enable hiveping
```

4. Ensure plugin allowlist includes `hiveping`:

```bash
docker compose run --rm openclaw-cli config set plugins.allow '["discord","device-pair","memory-core","phone-control","talk-voice","hiveping"]' --json
```

5. Configure plugin:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.reasoningCommand '/home/node/.openclaw/workspace/hiveping/bin/codex'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.reasoningArgs '["mcp-server"]' --json
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.reasoningToolName 'codex'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.openclawCommand 'openclaw'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.allowedRoots '["/home/node/.openclaw/workspace","/workspace/YOUR_DIR"]' --json
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.mentionHookEnabled true --json
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.mentionAliases '["@hiveping"]' --json
```

6. Restart gateway:

```bash
docker compose restart openclaw-gateway
```

7. Verify status:

```bash
docker compose run --rm openclaw-cli plugins info hiveping
docker compose run --rm openclaw-cli channels status
```

## Slack And Discord Bot Setup

Use this when creating fresh bots for mention-only `@hiveping` usage.

### Slack App (Minimum Required)

1. Create app:
   - Go to Slack API -> "Create New App" -> "From scratch".
   - Pick your workspace.
2. Enable bot user and install:
   - Add a bot user under "App Home".
   - Install app to workspace and copy the Bot User OAuth token (`xoxb-...`).
3. Configure bot token scopes (OAuth & Permissions):
   - Required: `app_mentions:read`
   - Required: `chat:write`
   - Optional (recommended for richer context): `channels:history`, `groups:history`, `im:history`, `mpim:history`
4. Configure event subscriptions:
   - Enable "Event Subscriptions".
   - Subscribe to bot event: `app_mention`
   - If your OpenClaw Slack adapter requires message events, also add: `message.channels`, `message.groups`, `message.im`, `message.mpim`
5. If using Socket Mode (adapter dependent):
   - Enable "Socket Mode".
   - Create app-level token with `connections:write`.
6. Invite app to channel:
   - In Slack channel: `/invite @YourBotName`

### Discord Application (Minimum Required)

1. Create app and bot:
   - Go to Discord Developer Portal -> "New Application" -> "Bot" -> "Add Bot".
   - Copy bot token.
2. Enable gateway intents:
   - Required: `MESSAGE CONTENT INTENT`
   - Required: `SERVER MEMBERS INTENT` only if your adapter/user mapping needs member metadata
   - Recommended: keep `GUILDS` and `GUILD_MESSAGES` enabled (non-privileged)
3. Bot permissions (OAuth2 URL Generator):
   - Required: `View Channels`
   - Required: `Send Messages`
   - Required: `Read Message History`
   - Recommended: `Embed Links`, `Attach Files`, `Add Reactions`
4. Invite bot using generated OAuth2 URL:
   - Scope: `bot`
   - Scope: `applications.commands` is optional (HivePing does not require slash commands)
5. Add bot to target channel and ensure role overrides do not block send/read.

### Verify After Bot Setup

```bash
docker compose run --rm openclaw-cli channels status
docker compose run --rm openclaw-cli plugins info hiveping
```

In channel:

```text
@hiveping status
```

Expected:
- Slack/Discord channel receives one HivePing mention reply.
- No duplicate default model reply for the same `@hiveping` message.

## Unit Tests

Run unit tests locally:

```bash
cd /home/node/.openclaw/workspace/hiveping
npm install
npm test
```

Run unit tests from Docker CLI:

```bash
docker compose run --rm openclaw-cli sh -lc "cd /home/node/.openclaw/workspace/hiveping && npm test"
```

## Local Role Policy (Recommended)

Enable local JSON role policy:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.rolePolicyEnabled true --json
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.skillsFile '/workspace/YOUR_DIR/<repo-name>/.hiveping/skills.md'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.skillsMode 'agent'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.approvalRequestsFile '.hiveping/approval-requests.json'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.changeSandbox 'workspace-write'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.changeApprovalPolicy 'on-request'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.actionWebhookUrl 'https://hooks.example.com/hiveping'
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.actionWebhookTimeoutMs 8000 --json
```

By default, when `rolePolicyDir` is not set, HivePing uses:

`<bound-repo>/.hiveping/policies`

Or do the same from mention chat (persisted):

```text
@hiveping config defaults
```

Fine-grained updates:

```text
@hiveping config set rolePolicyEnabled true
@hiveping config set reasoningCommand /home/node/.openclaw/workspace/hiveping/bin/codex
@hiveping config set reasoningArgs ["mcp-server"]
@hiveping config set reasoningToolName codex
@hiveping config set defaultModel gpt-5.4
@hiveping config set defaultProfile dev
@hiveping config set rolePolicyDir /workspace/YOUR_DIR/.hiveping/policies
@hiveping config set skillsFile /workspace/YOUR_DIR/<repo-name>/.hiveping/skills.md
@hiveping config set skillsMode agent
@hiveping config set approvalRequestsFile /workspace/YOUR_DIR/.hiveping/approval-requests.json
@hiveping config set changeSandbox workspace-write
@hiveping config set changeApprovalPolicy on-request
@hiveping config set actionWebhookUrl https://hooks.example.com/hiveping
@hiveping config set actionWebhookToken YOUR_WEBHOOK_TOKEN
@hiveping config set actionWebhookTimeoutMs 8000
@hiveping config show
```

Where to add policy files:

- Keep `rolePolicyDir` unset to use the default per-project location: `<bound-repo>/.hiveping/policies`.
- Or set `rolePolicyDir` to a shared directory accessible inside the gateway container.
- Recommended path per project repo: `/workspace/YOUR_DIR/<repo-name>/.hiveping/policies`

Where to add skill routing file:

- Keep `skillsFile` unset to use default: `<bound-repo>/.hiveping/skills.md`.
- Or set `skillsFile` to an explicit file path via `@hiveping config set skillsFile <path>`.
- Set `skillsMode` to control routing style:
  - `rules` (default): parses structured markdown keys (`action`, `method`, `url`, `match_any`).
  - `agent`: asks the configured reasoning backend to interpret `SKILLS.md` semantically, then falls back to `rules` if needed.

Example:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.rolePolicyDir '/workspace/YOUR_DIR/account-service/.hiveping/policies'
docker compose run --rm openclaw-cli sh -lc "mkdir -p /workspace/YOUR_DIR/account-service/.hiveping/policies"
```

Create one JSON policy file per project under your configured `rolePolicyDir`.

Example file path:

`/workspace/YOUR_DIR/account-service/.hiveping/policies/account-service.json`

```json
{
  "version": 1,
  "defaultModel": "gpt-5.4",
  "defaultProfile": "dev",
  "members": {
    "email:engineer@company.com": "dev",
    "email:lead@company.com": "maintainer",
    "msteams:29:exec-user-id": "owner"
  },
  "permissions": {
    "ask": ["anyone"],
    "status": ["anyone"],
    "change": ["dev", "maintainer", "owner"],
    "bind": ["maintainer", "owner"],
    "unbind": ["maintainer", "owner"],
    "approve": ["maintainer", "owner"],
    "externalApi": ["owner"]
  },
  "approval": {
    "enabled": true,
    "approverRoles": ["maintainer", "owner"],
    "requireTicketForHeavyChange": true,
    "heavyKeywords": [
      "migration",
      "refactor",
      "architecture",
      "rewrite",
      "database schema"
    ]
  }
}
```

Notes:

- `projectId` is optional. If omitted, HivePing uses the bound repo folder name.
- `repoPath` is optional. If omitted, HivePing infers it from the default policy location (`<bound-repo>/.hiveping/policies`).
- `defaultModel` and `defaultProfile` are optional. If set, they override the HivePing-wide defaults for that bound project only.
- Keep `repoPath` explicit only when you use a shared/custom policy directory that is not under the bound repo.

Behavior:

- Run `@hiveping whoami` first and copy a returned key into `members`.
- Preferred key format is email-based (for example `email:engineer@company.com`) because it is easier to manage.
- You can also manage roles in-channel (writes to the same policy JSON):
  - `@hiveping role set engineer@company.com dev`
  - `@hiveping role remove engineer@company.com`
- Read asks follow `permissions.ask`.
- Write asks (`change`, `update`, `edit`, `fix`, or write-intent text) follow `permissions.change`.
- Reasoning model/profile fall back in this order: project policy -> HivePing runtime config -> reasoning backend defaults.
- If user is below minimum change role, HivePing creates an approval request and returns an ID.
- Maintainer/owner approves with `@hiveping approve <request-id>`.
- Heavy write requests require Jira/GitHub ticket reference in prompt (for example `ABC-123` or `#245`).
- Role changes are persisted to project policy JSON and survive gateway restarts.

## Skill Routing (`skills.md` / `SKILLS.md`)

HivePing can auto-route normal `@hiveping ...` messages to external HTTP actions based on a project skill file.

Flow:

1. User sends `@hiveping ...` in Discord/Slack/Teams.
2. HivePing checks the bound repo skills file.
3. If a skill matches, HivePing creates an approval request.
4. Maintainer/owner approves via `@hiveping approve <id>`.
5. HivePing executes real HTTP `GET` or `POST` to that skill's URL.
6. If no skill matches, it continues normal ask/change flow through the configured reasoning backend.

Default skills file path:

`<bound-repo>/.hiveping/skills.md`

Also supported automatically:

`<bound-repo>/.hiveping/SKILLS.md`

Important:

- Keep `skills.md` or `SKILLS.md` inside each project repository (the bound repo).
- Do not store project routing files under the HivePing plugin repository.

### `skillsMode=agent` (recommended for natural markdown)

Example `SKILLS.md`:

```md
# Project Automations

When users ask HivePing to create Jira tickets, use:
- method: POST
- url: https://automation.company.com/jira/create

When users ask HivePing for deploy status of a service, use:
- method: GET
- url: https://automation.company.com/deploy/status
- response: return only `version_deployed`

Only route when the request is clear. If unclear, do not call any endpoint.
```

### `skillsMode=rules` (structured parsing)

Example `skills.md`:

```md
# Skills

## Jira Issue Create
- action: jira.issue.create
- description: Create Jira issue from conversation
- match_any: create jira issue, jira ticket, raise jira
- method: POST
- url: https://automation.company.com/jira/create

## Deploy Status
- action: deploy.status
- description: Read deploy status
- match_regex: deploy\\s+status\\s+([a-z0-9-]+)
- method: GET
- url: https://automation.company.com/deploy/status
- response_field: version_deployed
```

Notes:

- Use markdown-native sections in `skills.md`.

You can inspect loaded routes with:

```text
@hiveping skills
```


## Docker Mounts Needed For Host Projects

If OpenClaw runs in Docker, bind host paths so HivePing can access repos and reasoning backend auth/config.

`YOUR_DIR` is a placeholder. Use your own folder name.

Create `docker-compose.override.yml` beside `docker-compose.yml`:

```yaml
services:
  openclaw-gateway:
    volumes:
      - ~/.codex:/home/node/.codex
      - ~/YOUR_DIR:/workspace/YOUR_DIR

  openclaw-cli:
    volumes:
      - ~/.codex:/home/node/.codex
      - ~/YOUR_DIR:/workspace/YOUR_DIR
```

Then start/restart services:

```bash
docker compose up -d openclaw-gateway
```

## Usage (Mention-Only)

In any connected channel/thread:

```text
@hiveping bind /workspace/YOUR_DIR/<repo-name>
@hiveping config defaults
@hiveping whoami
@hiveping skills
@hiveping role list
@hiveping role set engineer@company.com dev
@hiveping role remove engineer@company.com
@hiveping status
@hiveping summarize this repo architecture
@hiveping update route validation for empty slug and add tests
@hiveping unbind
```

## Project-Specific Agent Profiles

HivePing can also run in an optional agent-profile mode alongside the existing conversation-scoped binding flow.

This lets you keep the current behavior for `@hiveping`, while also configuring fixed project agents such as `@hiveping1` and `@hiveping2`.

Example plugin config:

```json
{
  "mentionAliases": ["@hiveping"],
  "agents": [
    {
      "id": "fe",
      "aliases": ["@hiveping1"],
      "repoPath": "/workspace/YOUR_DIR/frontend-app",
      "homeConversationKey": "slack:T123:C_FE"
    },
    {
      "id": "api",
      "aliases": ["@hiveping2"],
      "repoPath": "/workspace/YOUR_DIR/api-service",
      "homeConversationKey": "slack:T123:C_API"
    }
  ]
}
```

Behavior:

- `@hiveping ...` keeps the current conversation-scoped flow and uses the repo bound in the current channel/thread.
- `@hiveping1 ...` uses the fixed `frontend-app` repo and the history stored under `slack:T123:C_FE`, even if the message was sent in a shared channel.
- `@hiveping2 ...` uses the fixed `api-service` repo and the history stored under `slack:T123:C_API`.
- If a single message mentions multiple configured agent aliases like `@hiveping1 @hiveping2 investigate checkout failure`, HivePing runs both agents independently and returns one consolidated reply with separate findings sections.
- This is useful for shared integration channels where multiple project-specific agents need to answer with their own repo context and home-channel memory.
- `bind` and `unbind` stay conversation-scoped commands. Agent profiles use fixed repo mappings from plugin config.
- If your platform sends raw bot mention IDs like `<@U123>`, set `mentionIds` on the agent profile so HivePing can distinguish multiple bot identities reliably.
- Every agent id also gets plain-text aliases automatically as both the raw id and the parenthesized form. For example, agent id `frontend` can be invoked as `frontend` or `(frontend)`.
- If an agent id contains spaces, use the parenthesized form like `(project a)` or `(frontend app)`.
- Parenthesized aliases are treated as leading routing indicators, so normal questions like `what is meta(meta tags) of this project` are not re-routed accidentally.
- If you want to keep project agents private to certain rooms, set `allowedChannels` on the agent profile. Matching is exact against the current conversation key, raw channel id, and provider metadata such as `channelName` when the adapter includes it.

How to configure agent profiles today:

- `homeConversationKey` can be discovered from chat by running `@hiveping status` in the channel or thread you want to use as that agent's shared memory home, then copying the `Key: ...` value from the reply.
- Saving `agents` is currently done through OpenClaw config / CLI, not through `@hiveping config set ...`.

Get the home keys from chat:

```text
# In the frontend home channel/thread
@hiveping status

# In the API home channel/thread
@hiveping status
```

Then persist the agent profiles:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.agents '[
  {
    "id": "fe",
    "aliases": ["@hiveping1"],
    "repoPath": "/workspace/YOUR_DIR/frontend-app",
    "homeConversationKey": "slack:T123:C_FE",
    "allowedChannels": ["frontend-room", "slack:default:C123FE"]
  },
  {
    "id": "api",
    "aliases": ["@hiveping2"],
    "repoPath": "/workspace/YOUR_DIR/api-service",
    "homeConversationKey": "slack:T123:C_API",
    "allowedChannels": ["api-room", "slack:default:C456API"]
  }
]' --json
```

Optional: keep the default conversation-scoped alias enabled too:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.mentionAliases '["@hiveping"]' --json
```

Optional: if your platform exposes stable bot/account mention IDs, add them for more reliable routing:

```bash
docker compose run --rm openclaw-cli config set plugins.entries.hiveping.config.agents '[
  {
    "id": "fe",
    "aliases": ["@webbot"],
    "mentionIds": ["U08FRONTEND"],
    "repoPath": "/workspace/YOUR_DIR/frontend-app",
    "homeConversationKey": "slack:T123:C_FE"
  },
  {
    "id": "api",
    "aliases": ["@apibot"],
    "mentionIds": ["U08BACKEND"],
    "repoPath": "/workspace/YOUR_DIR/api-service",
    "homeConversationKey": "slack:T123:C_API"
  }
]' --json
```

Restart the gateway after updating plugin config:

```bash
docker compose restart openclaw-gateway
```

Smoke test from a shared channel:

```text
@hiveping1 status
@hiveping2 status
@hiveping1 @hiveping2 investigate checkout failure
@hiveping (frontend) status
@hiveping (frontend) (api) investigate checkout failure
@hiveping (project a) status
```

Approval flow:

```text
@hiveping update payment route for retry logic
# -> returns: Approval request created: appr_xxx
@hiveping approve appr_xxx
```

Reusable external-action approvals:

```text
@hiveping what version is deployed right now?
# -> returns: Approval request created: appr_xxx

@hiveping approve appr_xxx --future 10 --scope requester
# allow the same requester to run the same external action 10 more times

@hiveping approve appr_xxx --future 1d --scope all
# allow everyone in that project context to run the same external action for 1 day

@hiveping grants
# list active reusable approvals for the current bound project / agent context

@hiveping revoke grant_xxx
@hiveping revoke appr_xxx
@hiveping revoke deployed.version
```

Notes:

- Reusable approvals currently apply only to external actions, not code changes.
- Matching is project-scoped and action-name scoped.
- In agent-profile mode, reusable approvals are also scoped to that agent profile by default.
- `--scope requester` reuses approval only for the original requester.
- `--scope all` allows any user in that same project context to reuse it until the limit expires.
- `--future 10` means the next 10 matching requests.
- `--future 1d`, `12h`, `30m`, and `1w` are also supported.
- Grants are persisted in the default local store at `.hiveping/approval-grants.json`.

Approval-gated external action:

```text
@hiveping action issue.create {"tracker":"github","title":"Login callback fails","description":"OAuth callback returns HTTP 500 for some users","labels":["bug","backend"]}
# -> returns: Approval request created: appr_xxx
@hiveping approve appr_xxx
```

Webhook payload notes:

- For `@hiveping action ...`, if payload has `mode=http`, HivePing directly executes that HTTP action after approval.
- For `@hiveping action ...` without `mode=http`, HivePing calls `actionWebhookUrl` with request metadata, approver metadata, action name, action payload, and recent discussion history.
- If `actionWebhookToken` is set, HivePing sends `Authorization: Bearer <token>`.

Reject flow:

```text
@hiveping reject appr_xxx not in current sprint
```

## Notes

- Bindings are conversation-scoped.
- Mention text defaults to ask mode when command keyword is omitted.
- Recent `@hiveping` conversation turns are persisted in `.hiveping/history.json` and included in subsequent prompts.
- History is shared per conversation key and stores actor-tagged user turns, so concurrent users in one channel stay distinguishable.
- `allowedRoots` controls which paths `@hiveping bind` can accept.
- `@hiveping role set` and `@hiveping role remove` require maintainer/owner by default (`permissions.bind`).
- `@hiveping config defaults` and `@hiveping config set` persist in `.hiveping/runtime-config.json`.
- `@hiveping ...` requires reasoning backend auth/config inside the container. For Codex, mount `/home/node/.codex`.

## Troubleshooting

- If you see `No API key found for provider "anthropic"` for `@hiveping ...` messages, verify that:
  - `plugins info hiveping` shows the plugin loaded.
- If mention replies are not sent, verify `openclawCommand` points to a valid CLI binary in the gateway runtime (default `openclaw`, fallback `openclaw-cli`).
- Confirm the reasoning backend auth/config is mounted and valid in the gateway container. For Codex, verify `/home/node/.codex`.
- Rebuild and restart after source edits:

```bash
cd /home/node/.openclaw/workspace/hiveping && npm run build
docker compose restart openclaw-gateway
```

- Verify plugin status:

```bash
docker compose run --rm openclaw-cli plugins info hiveping
docker compose run --rm openclaw-cli channels status
```
