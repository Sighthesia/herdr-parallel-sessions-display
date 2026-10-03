# herdr-parallel-sessions-display

[English](README.md) | [简体中文](README.zh-CN.md)

Shows running sessions from **OpenCode**, **Codex**, and **Claude Code** in Herdr's Agents view, grouped by working directory.

## Supported agents

| Agent | Session source | Requirement |
| --- | --- | --- |
| OpenCode | Server HTTP API + SSE | Any running opencode TUI (provides the server) |
| Codex | Shared app-server daemon | `herdr integration install codex`, plus Codex running in a Herdr pane |
| Claude Code | `claude agents --json` | Claude running in a Herdr pane |

Default mode is **inline**: no extra panes or tabs. The session list is attached to the official agent row for that directory and rendered as an ASCII tree.

```
[1] space                            ← workspace group
◐ opencode                           ← official agent row
│▸ ● Conversation 1                 ← selected in the TUI
│  ● Conversation 2                 ← still running in background
│  ○ Conversation 3                 ← idle session
```

## Why

Herdr's built-in integration only reports the session currently selected in that pane's TUI (plus its children). Other sessions running on the same server stay invisible unless you click through panes one by one.

This plugin lists every other root session under the same directory, with live state.

Scope:

- Only root sessions. Child/sub-agents are not listed separately.
- **Finished sessions don't vanish into thin air**: once one stops it stays in the list as `○`, so you can tell "finished" from "lost". The newest `IDLE_KEEP` per directory are kept; bring one to the foreground to read the result and it gets cleared.
- Read-only. To interact, switch back to the real TUI pane.
- No duplicates. The session your TUI has selected is yielded to the official row.

## How it works

```
opencode server / codex app-server / `claude agents --json`
    ▼
board.mjs (resident manager, runs inside a plugin tab)
    │  attaches session lists via pane.report_metadata --applies-to-source
    ▼
Herdr Agents view
```

- State comes from each agent's runtime API, not screen scraping.
- One mount point per directory: the official agent row whose `foreground_cwd` matches the session directory.
- Dedupes against sessions already reported by the official integration.

## Requirements

| Dependency | Notes |
| --- | --- |
| [Herdr](https://herdr.dev/) ≥ 0.9.3 | Declared as `min_herdr_version` |
| [Node.js](https://nodejs.org/) on `PATH` | The manager is `node src/board.mjs`. If `node` is missing, startup and actions fail silently |
| An OpenCode server running | Any open opencode TUI is enough. Codex / Claude Code are optional |

No `package.json`, no dependencies, no build step. No `npm install`.

## Install

### Let an agent install it for you

Copy-paste this to your agent:

```text
Install and verify herdr-parallel-sessions-display in this machine's Herdr.
Steps: 1) check herdr >= 0.9.3 and `node --version` works on PATH;
2) run `herdr plugin install Sighthesia/herdr-parallel-sessions-display --yes`;
3) copy config/.env.example from the plugin checkout to the .env in
`herdr plugin config-dir herdr-parallel-sessions-display` (empty defaults are fine);
4) merge the $oc_sess1..6 rows into [ui.sidebar.agents] in ~/.config/herdr/config.toml
without dropping existing rows; 5) open the board
(`herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board`),
run the sync action, and confirm session rows appear in the Agents sidebar.
If anything fails, read the board pane (label "Herdr Sessions") with
`herdr pane read` and fix it. Do not edit other plugins' configs.
```

### Manual install

```bash
herdr plugin install Sighthesia/herdr-parallel-sessions-display --yes
herdr plugin config-dir herdr-parallel-sessions-display  # .env goes here

# copy config/.env.example from the plugin checkout to .env, then:
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board
```

.env` can stay empty; defaults work. After editing `.env`, close and reopen the board tab.

The board lives in a `Herdr Sessions` tab. `AUTO_START=true` (the default) relaunches it
after every Herdr restart; with it off the sidebar stops updating silently — no error, the
rows just freeze at their last state. Don't disable it.

Three actions (also available from the command palette):

| action | Effect |
| --- | --- |
| `herdr-parallel-sessions-display.board` | Open the board (resident manager) |
| `herdr-parallel-sessions-display.sync` | Run one full recompute now (also restarts the manager if needed) |
| `herdr-parallel-sessions-display.reap` | Clear all mirror rows and panes |

### Sidebar template (required)

Inline mode needs rows for the session list. Add to `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

## Configuration

Full commented list: [`config/.env.example`](config/.env.example). Most users only need these:

| Key | Default | Notes |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | empty | e.g. `http://127.0.0.1:4096`. Empty = auto-detect |
| `OPENCODE_SERVER_PASSWORD` | empty | Basic Auth password, if the server has one |
| `MIRROR_INLINE` | `true` | `false` = legacy one-pane-per-session mode (opencode only) |
| `AUTO_START` | `true` | Relaunch the board on Herdr restart. **Leave it on** — turning it off freezes the sidebar silently (no error) |
| `PARALLEL_CONNECTOR` | `bar` | `bar` (default): TUI-selected session is the root `│▸`, others are branches `├─`/`└─`. `tree` / `none` also available |
| `CODEX_ENABLED` / `CLAUDE_ENABLED` | `true` | Set `false` to skip that provider |
| `CLAUDE_BIN` | empty | Absolute path if the board process can't find `claude` on its `PATH` |
| `IDLE_KEEP` | `3` | Inline mode: how many finished-but-unreviewed sessions to keep **per directory**. They stay visible as `○` so you can tell "finished" from "lost"; they are dropped once you bring one to the foreground. `0` restores the old behaviour (they vanish) |
| `POLL_INTERVAL_MS` / `CLAUDE_POLL_MS` | `5000` / `10000` | Polling cadence |
| `LOG_LEVEL` | `info` | Use `debug` for troubleshooting |

New config keys must be registered in four places: `src/state.mjs` (`CONFIG_DEFAULTS`), `src/board.mjs` (`config`), `config/.env.example`, and this README. Keys missing from `CONFIG_DEFAULTS` are silently dropped (startup logs a warn).

## Codex / Claude Code notes

- **Codex**: install Herdr's integration first (`herdr integration install codex`), otherwise there is no official row to mount on and nothing is shown. Sessions are read from the shared app-server daemon socket; `CODEX_ADOPT_SESSION=true` (default) backfills the row identity so sessions are visible before their first turn.
- **Claude Code**: no integration install needed; just run Claude inside a Herdr pane. Sessions come from `claude agents --json` every `CLAUDE_POLL_MS`. `CLAUDE_ADOPT_SESSION=true` (default) backfills the row identity; without it nothing is shown.

Sessions in directories with no official row (e.g. `/tmp` scratch projects) have nowhere to mount and are skipped; the board log names them.

## Troubleshooting

Logs are **not** in `herdr plugin log list`. Read the board pane:

```bash
herdr pane list --json | jq -r '.result.panes[]|select(.label=="Herdr Sessions")|.pane_id'
herdr pane read <board_pane_id> --lines 200
```

Common cases:

- **List stopped updating**: the board tab was closed or Herdr restarted. Run the `sync` action; set `AUTO_START=true` to relaunch automatically.
- **Empty sidebar / `no matching agents`**: a global `agent.view.set` filter hid everything. Run `sync` to recalibrate, keep `INSTALL_AGENT_VIEW=false` unless you need it.
- **Fewer rows than expected**: search the log for the yield message. Sessions owned by a real TUI are intentionally skipped.
- **Can't reach the server**: check `OPENCODE_SERVER_URL`, or install `ss`/`lsof` so non-default ports can be auto-detected.
- **No Claude rows**: confirm `herdr agent list` has a `claude` row, `claude agents --json` lists sessions, and `CLAUDE_BIN` is set if the board's `PATH` lacks `claude`.

## Known limits

- Inline mode shows nothing for directories without an official row.
- Token values are truncated at 80 chars; newlines and leading whitespace don't survive (hence the ASCII-tree prefixes).
- State accuracy depends on SSE/event streams; on disconnect it degrades to polling.
- Legacy pane mode (`MIRROR_INLINE=false`) costs one terminal pane per session and supports opencode only.

## Development

See [`AGENTS.md`](AGENTS.md) for the contributor guide. Quick version:

```bash
herdr plugin link /absolute/path/herdr-parallel-sessions-display
# edit code, then close and reopen the board tab
node src/board.mjs --mode once  # one-shot check, use when the manager is not running
```

No test suite; verify on a real machine (Herdr + agents running, watch the sidebar). Use `LOG_LEVEL=debug` to see per-session decisions.
