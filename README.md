# climbx-mcp

An [MCP](https://modelcontextprotocol.io) server for the [ClimbX](https://climbx.so) API: publish and schedule X posts, read your analytics, voice profile, and learnings, pull outlier posts from the inspiration feeds, and draft replies in your voice, all from any MCP client (Claude Desktop, Claude Code, Claude Cowork, and others).

> **Community project.** Not affiliated with or endorsed by ClimbX. It wraps the official public API documented at [climbx.so/developers/docs](https://climbx.so/developers/docs).

> **Want the finished workflow?** The [climbx-cowork Cowork plugin](https://github.com/iret77/climbx-cowork/blob/main/plugin/README.md) is built on this server and turns the raw tools into scanning, drafting in your voice, guarded publishing, a reply workflow, and a live dashboard. This README covers the standalone MCP server on its own.

## Requirements

- A ClimbX account on an active plan or trial
- A ClimbX API key: create one in the app under **Settings > API** (the full key is shown only once)
- Node.js >= 20

## Run it

`npx` fetches and runs the committed self-contained bundle straight from this repo. No install, no build, and no npm account needed.

```bash
CLIMBX_API_KEY=climbx_sk_... npx -y github:iret77/climbx-mcp
```

Point any MCP client at that command. Examples:

### Claude Code

Avoid typing the key inline (it would land in your shell history). Reference an environment variable instead, e.g. one loaded from your shell profile or a secret manager:

```bash
claude mcp add climbx --env CLIMBX_API_KEY="$CLIMBX_API_KEY" -- npx -y github:iret77/climbx-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "climbx": {
      "command": "npx",
      "args": ["-y", "github:iret77/climbx-mcp"],
      "env": { "CLIMBX_API_KEY": "climbx_sk_..." }
    }
  }
}
```

### Claude Cowork

Install the [climbx-cowork plugin](https://github.com/iret77/climbx-cowork); it launches this server for you via the same `npx` command. You do not add this server separately.

> **Zero-install alternative:** ClimbX hosts an official remote MCP server at `https://climbx.so/mcp` (HTTP transport, same Bearer key). This project is the community-built local stdio alternative wrapping the same API.

## Configuration

The server reads its configuration from environment variables:

| Variable | Required | Description |
|---|---|---|
| `CLIMBX_API_KEY` | one key source | Your ClimbX API key (`climbx_sk_...`) inline. Never commit it anywhere. |
| `CLIMBX_API_KEY_FILE` | one key source | Path to a file containing the API key instead of passing it inline. The file is read and trimmed, so the key stays out of every config and process listing. |
| `CLIMBX_BASE_URL` | no | API base URL. Defaults to `https://climbx.so/api/v1`. Must be an https `climbx.so` URL unless `CLIMBX_ALLOW_CUSTOM_BASE_URL=1` is set. |
| `CLIMBX_ALLOW_CUSTOM_BASE_URL` | no | Set to `1` to allow a non-climbx.so base URL (dev/staging). Off by default so the key can't be sent to an unexpected host. |

The key is resolved in this order: `CLIMBX_API_KEY`, then `CLIMBX_API_KEY_FILE`, then the default key file at `~/.climbx/api_key` (mode 0600) if it exists. Providing the key through a file (or the default path) keeps it out of your shell history and any config file.

## Tools

| Tool | What it does |
|---|---|
| `publish_post` | Publish a post to X immediately (text + up to 4 image URLs) |
| `list_posts` | Recent published posts with metrics (impressions, likes, replies, and more) |
| `schedule_post` | Queue a post for a future time |
| `list_scheduled` | Upcoming pending posts |
| `reschedule_post` | Move a pending scheduled post to a new time |
| `cancel_scheduled` | Cancel a pending scheduled post |
| `get_analytics` | Headline KPIs + per-format breakdown over a lookback window |
| `get_format_performance` | Format table with medians and trends |
| `get_niche_performance` | Same, bucketed by niche |
| `get_voice_profile` | Voice persona, learnings, cadence targets, posting schedule |
| `get_learnings` | Current do-more/do-less rules with evidence |
| `get_learnings_history` | Snapshots of the learnings set over time |
| `get_inspiration_options` | Filter values the inspiration feeds accept, plus your tracked creators |
| `get_following_outliers` | Outlier posts from the creators you track (multiplier vs author baseline) |
| `get_surprise_outliers` | Discovery feed: outliers from across the network with filters |
| `suggest_reply` | Draft one reply suggestion in the owner's voice (spends a daily AI credit) |

## Good to know (ClimbX API limits)

- **API keys have scopes:** read & write (full API) or read-only (analytics, voice, learnings, inspiration). The posting tools and `suggest_reply` need a read & write key.
- **5 posts per day** per account across publish and schedule, resets 00:00 UTC. Cancelling a scheduled post does **not** refund the slot.
- **`suggest_reply` spends one shared daily AI credit** per call and stays locked until you have written enough replies by hand in the app. Replies cannot be published through the API; you post them on X yourself.
- **No URLs in post text.** ClimbX rejects link posts. This server also rejects them locally before spending a request.
- Read endpoints allow ~60 requests/minute; the server honors `Retry-After` and retries once.
- Using the API refreshes your ClimbX data in the background, so there is no need to open the web app.

## Development

```bash
npm install
npm run build:bin   # tsc, then esbuild bundle -> dist/index.mjs (the published entry point)
npm start           # run the bundle (node dist/index.mjs)
npm test            # unit tests (mocked, no network)
npm run smoke       # live read-only test against the real API (needs CLIMBX_API_KEY)
npm run smoke -- --write   # + schedule/cancel roundtrip (consumes a daily-cap slot!)
```

`dist/index.mjs` is a committed, self-contained bundle so `npx github:iret77/climbx-mcp` needs no install step. CI rebuilds it and fails if it drifts from source, so always run `npm run build:bin` and commit the result when you change `src/`.

## License

[MIT](LICENSE)
