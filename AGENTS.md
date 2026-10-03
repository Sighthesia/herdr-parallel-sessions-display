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
| `src/board.mjs` (~4.4k lines) | Resident manager. Modes: `startup` (one-shot hook), `watchdog` (detached, keeps the manager alive), `pane` (the resident manager itself), `action` (communicates via request files in the state dir), `once` (one round, then exit) |
| `src/opencode.mjs` | OpenCode HTTP client, v1/v2 auto-detected |
| `src/codex.mjs` | Codex app-server client, hand-written WebSocket over unix socket |
| `src/claude.mjs` | Claude Code discovery: `spawn claude agents --json` + field mapping and title fallback. No persistent connection |
| `src/herdr.mjs` | Herdr call wrapper: CLI first, raw socket only for what has no CLI (`agent.view.set`). Must never throw to callers |
| `src/state.mjs` | `.env` parsing + mapping/lock persistence under `HERDR_PLUGIN_STATE_DIR` |
| `src/mirror.mjs` | Keepalive process inside mirror panes; only used when `MIRROR_INLINE=false` |

`[[startup]]` is a one-shot init hook, not a supervised daemon — no resident logic there.

## The manager must NOT live in a pane

This is the single most load-bearing constraint in the repo, and it was learned the hard
way (three "it's broken again" reports in one session).

The manager runs **detached**, watched by a second detached process:

```
[[startup]] (once) ─→ watchdog (detached) ─→ manager (detached)
                            ↑                      │
                            └──── mutual liveness ─┘
```

Why, measured on this machine:

- Official docs: `tab / zoomed / overlay` plugin panes **are normal panes**. A pane-hosted
  manager is a tab in one of the user's project workspaces — they close it while working
  across 9 workspaces and it dies.
- `[[startup]]` fires **once per server lifetime**. Observed: `herdr server` pid 2487 ran
  14h40m continuously while `AUTO_START` fired exactly once. Nothing can revive the manager
  after that except a Herdr restart.
- The failure is **silent**: no error anywhere, tokens just stop being refreshed, and from
  outside it is indistinguishable from a feature bug. That is why it was reported as a bug
  three times instead of "the board is dead".

Invariants to preserve:

- **Watchdog and manager check each other.** One direction is not enough: whichever one
  dies degrades to "no crash recovery", which is the state this design exists to eliminate.
  `modePane` re-spawns the watchdog every 30s; the watchdog checks every 5s.
- **The watchdog's heartbeat timer must NOT be `unref()`'d.** `sleep()` in board.mjs unrefs
  its timer (callers hold the loop open some other way); the watchdog holds nothing, so
  `for(;;) { await sleep() }` exits immediately after the first tick. Measured: it logged
  "respawned the manager" once and then vanished, leaving a stale pid file. `modeWatchdog`
  uses a plain ref'd `setTimeout` for exactly this reason.
- **Detaching needs no plumbing.** `HERDR_PANE_ID` appears in board.mjs exactly once (a log
  line); `HERDR_SOCKET_PATH` is a fixed path (`~/.config/herdr/herdr.sock`), not per-instance;
  `herdrBin()` never hardcodes. `childEnv()` strips the pane-scoped vars so logs don't imply
  a pane still exists.
- **Cross-platform by construction.** Only `spawn(detached:true)` + `unref()` + `windowsHide`.
  No systemd, no launchd, no Windows service — those need per-platform files and macOS
  already rules systemd out (manifest declares `platforms = ["linux","macos"]`).
- **The log must land in a file.** `stdio:"ignore"` means nowhere to read logs otherwise, and
  "sidebar stopped updating with no error" needs a diagnostic. `STATE_DIR/board.log`, one
  generation of rotation, local-time timestamps.

`[[panes]] id = "board"` is now only a **log viewer**: the detached manager holds the board
lock, so that process exits immediately. Do not treat it as the resident process, and do not
assume you can restart the manager by opening a pane — you cannot.

`prefix+shift+o` / the `board` action means **"make sure it's running"**, not "open a window".

## Windows is not supported

`platforms = ["linux", "macos"]` is honest. Two real blockers: `codex.mjs` speaks
`http.request({socketPath})` (a Unix domain socket; Windows uses a named pipe and the path is
hardcoded `.sock`), and Claude discovery matches on `foreground_process_group_id` / kills by
process group, which does not exist on Windows. Everything else is already portable — the
win32 named-pipe socket path, `ss`-only-on-Linux port discovery, and `herdrBin()` are all
handled. Pure-OpenCode mode would probably work on Windows but has never been run there.

## Required manual step: the sidebar template

**The plugin never writes `~/.config/herdr/config.toml`.** Session rows are rendered by
template tokens (`$oc_sess1` … `$oc_sessN`), and Herdr's stock
`ui.sidebar.agents.rows` is `["state_icon","machine","workspace","tab"]` — it contains
none of them. Without this edit the tokens are still written, the board runs, the logs
are clean, **and the sidebar shows nothing at all**. It looks like a healthy install,
which is exactly why it is easy to lose an afternoon on.

Merge these rows into the existing `[ui.sidebar.agents]` in
`~/.config/herdr/config.toml` **without dropping rows the user already has**:

```toml
[ui.sidebar.agents]
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

Then `herdr server reload-config`. **The board reads this table and sizes itself to it**
(`resolveSessionSlots` → `herdr.countSessionRows`), so adding more `["$oc_sessN"]` rows
here is all it takes — there is no slot count to keep in sync any more, and
`ui.sidebar.agents.rows` caps at 16 rows. `SESSION_ROWS` overrides the detected number
when a user wants to cap it in the plugin instead.

Herdr **stores tokens the template never references** (measured: `oc_sess16` lands in
`pane.list` with only 6 rows configured) — it just never renders them. So a successful
`report-metadata` is not proof that a row is visible, and over-allocating slots is not
free of consequences in the other direction either: sessions past the template's count
vanish with no `+N` at all.

## Keep `AUTO_START` on

`AUTO_START` ships `true`. Turning it off causes **silent failure**: nothing starts the
watchdog, so no manager runs, so tokens stop being refreshed, so the sidebar quietly
freezes at its last state — no error anywhere. Users hit this weeks after install,
usually right after a Herdr restart. The cost of leaving it on is now **zero** (no tab
is opened any more). Do not "optimise" it away, and do not weaken the startup log
message that explains the consequence.

## Commands

```bash
# develop against a local checkout
herdr plugin link /absolute/path/herdr-parallel-sessions-display

# the real .env lives here (config/.env.example in the repo is only a template)
herdr plugin config-dir herdr-parallel-sessions-display

# make sure the manager is running (this is the recovery entry point)
herdr plugin action invoke herdr-parallel-sessions-display.board

# recompute now
herdr plugin action invoke herdr-parallel-sessions-display.sync

# clear all mirror rows / panes / fallback workspace
herdr plugin action invoke herdr-parallel-sessions-display.reap

# one-shot check (no resident lock; overwrites sidebar tokens, so prefer it when the manager is stopped)
node src/board.mjs --mode once
```

- **Logs:** `tail -f "$(herdr plugin config-dir herdr-parallel-sessions-display)"/../state/board.log`
  — or the real path from `HERDR_PLUGIN_STATE_DIR`, shown in the manager's own first log line.
  Nothing lands in `herdr plugin log list` (that only covers plugin *commands*).
- Restart the manager after editing `.env` or code: kill the `--mode pane` process and let the
  watchdog respawn it (`kill $(cat "$STATE_DIR/board.lock")`), or invoke the `board` action.
- `LOG_LEVEL=debug` prints per-session keep/skip reasons.
- **Is it alive?** Compare the pid in `board.lock` against reality, and check
  `board.log`'s mtime — it is rewritten every poll. A stale mtime with a live-looking pid is
  exactly the silent failure this repo keeps fighting.
- Sidebar shows no session rows at all → the template step above was skipped; check `[ui.sidebar.agents]` first, it is by far the most common cause.
- Sidebar froze → check `board.lock`/`watchdog.lock` first; both are pid files and
  `pidAlive()` reclaims stale ones, so a leftover file is harmless.

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
