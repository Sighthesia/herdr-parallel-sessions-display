# AGENTS.md — Contributor Guide

This Herdr plugin lists **all running root sessions** from the local **OpenCode server**, **Codex**, and **Claude Code** under their working directories in Herdr's Agents sidebar as an ASCII tree. Default mode is **inline** (`MIRROR_INLINE=true`): no mirror panes, sessions are attached as tokens to the official agent row.

User docs: [README.md](README.md) (English) and [README.zh-CN.md](README.zh-CN.md) (Chinese) — keep both in sync when behavior changes. Design history lives in [SPEC.md](SPEC.md).

External contributors and coding agents are welcome. This file is the entry point: read it before changing code.

## Not a normal Node project

- **No `package.json`**, no third-party dependencies, no build, no lint, no CI. Plain `.mjs` on Node built-ins, run directly with `node src/*.mjs`.
- **No offline test suite.** Pure functions (e.g. `parseSs` / `parseLsof`) can be asserted with `node -e`, but behavioral correctness requires live testing (Herdr + agents running, watch the sidebar).
- Code comments and docs are in **English**. Comments should explain *why* and which measured pitfall they guard against, not restate the code.
- Commits follow Conventional Commits in English, e.g. `feat: support xx`, `fix: correct yy in zz`, `docs: document ww`.

## Layout

`herdr-plugin.toml` is the only assembly point. `command` entries are argv arrays — no shell, no variable expansion. Adding an executable entry = edit that file + add a `--mode` branch in `src/board.mjs`.

| File | Responsibility |
| --- | --- |
| `src/board.mjs` (~3.7k lines) | Resident manager. Modes: `startup` (one-shot hook), `pane` (resident, the only daemon logic), `action` (communicates via request files in the state dir), `once` (one round, then exit) |
| `src/opencode.mjs` | OpenCode HTTP client, v1/v2 auto-detected |
| `src/codex.mjs` | Codex app-server client, hand-written WebSocket over unix socket |
| `src/claude.mjs` | Claude Code discovery: `spawn claude agents --json` + field mapping and title fallback. No persistent connection |
| `src/herdr.mjs` | Herdr call wrapper: CLI first, raw socket only for what has no CLI (`agent.view.set`). Must never throw to callers |
| `src/state.mjs` | `.env` parsing + mapping/lock persistence under `HERDR_PLUGIN_STATE_DIR` |
| `src/mirror.mjs` | Keepalive process inside mirror panes; only used when `MIRROR_INLINE=false` |

`[[startup]]` is a one-shot init hook, not a supervised daemon — no resident logic there.

## Commands

```bash
# develop against a local checkout
herdr plugin link /absolute/path/herdr-parallel-sessions-display

# the real .env lives here (config/.env.example in the repo is only a template)
herdr plugin config-dir herdr-parallel-sessions-display

# open the board (the resident manager runs in this tab)
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board

# recompute now; starts the manager if it isn't running
herdr plugin action invoke herdr-parallel-sessions-display.sync

# clear all mirror rows / panes / fallback workspace
herdr plugin action invoke herdr-parallel-sessions-display.reap

# one-shot check (no resident lock; overwrites sidebar tokens, so prefer it when the manager is stopped)
node src/board.mjs --mode once
```

- Logs are **not** in `herdr plugin log list`. Find the board pane via `herdr pane list --json` (label `Herdr Sessions`) and read it with `herdr pane read <id> --lines 200`.
- Restart the board tab after editing `.env` or code.
- `LOG_LEVEL=debug` prints per-session keep/skip reasons.

## Adding a config key

`CONFIG_DEFAULTS` in `state.mjs` is an **allowlist**: unknown keys are silently dropped by `loadConfig` (startup logs a warn). A new key must touch all four places:

1. `CONFIG_DEFAULTS` in `src/state.mjs`
2. the `config` object in `src/board.mjs`
3. `config/.env.example`
4. the Configuration table in both READMEs

Precedence: real environment variables > `$HERDR_PLUGIN_CONFIG_DIR/.env` > defaults.

## Hard constraints (measured, do not relax without re-testing)

- **Never touch official integration files** (`~/.config/opencode/plugins/herdr-agent-state.js`, `~/.claude/hooks/herdr-agent-state.sh`, etc.) and never call `herdr integration install/uninstall`. Pane state ownership is exclusive. Treat `~/.claude/` as read-only.
- **Never run opencode or claude inside a mirror pane.** The resume command is always the resident process. A TUI in a mirror pane gets overwritten by the official integration on the same pane (the row disappears instead of duplicating).
- **Report in two steps**: `pane report-agent` (state + session id, no resume argv) first, then `pane report-agent-session -- <resume command>`. An invalid `resume_argv` fails the whole report (`invalid_resume_argv`), losing the session id with it.
- **Only `layout.set_split_ratio`, never `layout.apply`** (apply rebuilds the tab and kills all terminal processes).
- **Sidebar token limits**: single value truncated at 80 chars, newlines stripped, leading whitespace trimmed (including U+00A0 / U+2000–200A / U+3000). Tree prefixes must be part of the value; N sessions need N tokens / N rows.
- **Inline mount requires an existing record**: `pane.report_metadata --applies-to-source` silently writes null tokens when the target source has no record on that pane. `CODEX_ADOPT_SESSION` / `CLAUDE_ADOPT_SESSION` backfill the real session id first — backfill must precede mounting.
- **Resolve mount points per provider** using that provider's own official rows; a global lookup mixes agents. Prefer exact `foreground_cwd` match over pane counts.
- **Dedupe via the `oc_session` token**, not `agent_session` (Herdr 0.9.3 strips `agent_session` for third-party sources). Distinguish own mirror rows via `tokens.oc_mirror == "1"`.
- **`agent.view.set` is global**: never install a filtered projection when mirror rows are zero (auto-degrade to `sort-only`); calibration runs in every mode.
- **Busy spinner stays off by default** (measured ~12% vs ~4% of one core). The animation ticker only swaps characters in memory and must never speed up the main reconcile loop; stop the timer when no busy marker exists.
- **Every `claude` spawn needs its own timeout and full cleanup** (SIGKILL + destroy stdio streams, or inherited pipes stall the event loop). Claude has no persistent connection to close. Its poll cadence (`CLAUDE_POLL_MS`) is independent of the main loop; on throttle hits return the last good result instead of reporting failure.

## Debugging entry points

- Empty sidebar → check the board process is running (`ps -ef | grep 'board\.mjs --mode pane'`).
- Sidebar empty / `no matching agents` → run the `sync` action (recalibrates the projection).
- Fewer rows than expected → search the log for the yield message; matching the active-session count is correct (real TUIs own them).
- Rows under the `Sessions` group → no workspace exists for that directory.
- No Claude rows → check `herdr agent list` for a `claude` row, then `claude agents --json`, then `PATH` (`CLAUDE_BIN` takes an absolute path).
- `once` mode and the resident manager overwrite each other's tokens — use `once` when the manager is stopped.
