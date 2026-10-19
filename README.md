# pi-claude

Standalone **Claude (`claude`)** subscription provider extension for [Pi Coding Agent](https://pi.dev) — written in TypeScript, implementing the exact first-party OAuth 2.0 PKCE authentication, inter-process credential locking, wire headers, and attribution billing block of `claude` CLI (`v2.1.303`) **without requiring `claude.exe` to be installed**.

---

## Key Features

1. **Zero Binary Dependency**: Communicates directly with `https://api.anthropic.com/v1/messages` over native HTTPS/SSE (`streamSimpleAnthropic`) — no subprocess cold start, no transcript serialization overhead, and no `claude.exe` binary needed.
2. **Native Pi `/login claude` & `/logout` Support**:
   - Registers provider ID `claude` (and display name `claude` in `/model`, `/login`, and `/logout`).
   - Adopts an existing valid sign-in from `~/.claude/.credentials.json` if present (preventing single-use refresh token collisions) or runs a standalone OAuth 2.0 PKCE browser login.
   - Single-account architecture stored in `~/.pi/agent/auth.json` under `"claude"`, enabling clean `/logout`.
3. **Live Model Catalog & Dynamic Refresh (`/v1/models`)**:
   - Automatically discovers and updates models from `GET https://api.anthropic.com/v1/models` on startup and via `/claude-refresh`.
   - Includes **Claude Sonnet 5.5**, **Claude Opus 5.5**, **Claude Haiku 5.5**, **Claude Fable 5.1**, **Claude Sonnet 5**, **Claude Opus 5**, **Claude Opus 4.8 / 4.7 / 4.6**, and **Claude Sonnet 4.6 / 4.5** with full thinking effort levels (`low`, `medium`, `high`, `xhigh`, `max`).
4. **Usage, Rate Limits & Model Availability**:
   - `/claude-usage`: Fetches live 5-hour session and 7-day weekly quota windows from `GET /api/oauth/usage`.
   - `/claude-models`: Lists all available Claude models alongside live remaining plan quota percentage, reset countdowns, context windows, and supported thinking effort levels.
5. **Health & Diagnostics (`/claude-doctor`)**:
   - Inspects authentication state, shared credential lock status, wire version (`2.1.303`), attribution fingerprint, last response status, and live unified rate-limit headers.

---

## Installation

### From GitHub
```bash
pi install git:github.com/amirulaliffcherahim/pi-claude
```

### From Local Directory
```bash
pi install /path/to/pi-claude
```

---

## Authentication

### Sign In
Run in Pi:
```text
/login claude
```
- If a valid, unexpired OAuth grant exists in `~/.claude/.credentials.json`, `pi-claude` adopts it immediately so it never invalidates an active CLI session's single-use refresh token.
- Otherwise, `pi-claude` starts a local loopback listener (`http://localhost:<port>/callback`), opens `https://claude.com/cai/oauth/authorize` with PKCE (`S256`), exchanges the authorization code at `https://platform.claude.com/v1/oauth/token`, and saves the grant to both `~/.pi/agent/auth.json` and `~/.claude/.credentials.json` under an advisory lockfile.

### Sign Out
Run in Pi:
```text
/logout
```
Select `claude` from the selector to remove the stored credentials from `~/.pi/agent/auth.json`.

---

## Model Selection

Open `/model` or select directly:
```text
/model claude/claude-sonnet-5-5
/model claude/claude-opus-5-5
/model claude/claude-haiku-5-5
/model claude/claude-opus-4-6
/model claude/claude-sonnet-4-6
```
Use `/thinking` (or `Ctrl+T`) to switch reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/claude-doctor` | Show sanitized `pi-claude` provider health, auth status, attribution header, rate-limit headers, and catalog summary. |
| `/claude-usage` | Show live 5-hour session and 7-day weekly subscription quota windows (`/api/oauth/usage`). |
| `/claude-models` | List all Claude models with live quota availability, context window sizes, and thinking effort levels. |
| `/claude-refresh` | Force refresh the dynamic model catalog from `GET /v1/models`. |

---

## Architecture & Wire Protocol Details

### 1. First-Party Attribution Header (`x-anthropic-billing-header`)
Anthropic's `/v1/messages` endpoint requires first-party OAuth requests to carry an uncached leading system block with a deterministic 3-character hex fingerprint derived from the first user message:
```text
x-anthropic-billing-header: cc_version=2.1.303.<fp>; cc_entrypoint=cli; cch=00000;
```
Where `<fp>` is the first 3 hex characters of:
```text
SHA256("59cf53e54c78" + (userText[4] || "0") + (userText[7] || "0") + (userText[20] || "0") + "2.1.303")
```
Followed by the system identity block:
```text
You are Claude Code, Anthropic's official CLI for Claude.
```

### 2. Wire Headers & Beta Flags
Every `/v1/messages` request includes:
- `Authorization: Bearer <accessToken>`
- `User-Agent: claude-cli/2.1.303 (external, cli)`
- `x-app: cli`
- `X-Claude-Code-Session-Id: <session_uuid>`
- `anthropic-version: 2023-06-01`
- `anthropic-beta`:
  - `claude-code-20250219` (omitted on Haiku models)
  - `oauth-2025-04-20`
  - `interleaved-thinking-2025-05-14`
  - `redact-thinking-2026-02-12`
  - `context-management-2025-06-27`
  - `prompt-caching-scope-2026-01-05`

### 3. Single-Use Refresh Token Concurrency
Anthropic OAuth refresh tokens are single-use. Before refreshing a token at `https://platform.claude.com/v1/oauth/token`, `pi-claude` acquires an inter-process lockfile (`~/.claude/.credentials.json.lock`), re-reads `~/.claude/.credentials.json` to check if another process already rotated the token, and writes updated credentials atomically via a temporary file rename.

---

## License

MIT
