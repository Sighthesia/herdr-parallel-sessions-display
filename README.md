# herdr-parallel-sessions-display

[English](README.md) | [简体中文](README.zh-CN.md)

Shows the sessions that are currently running in **OpenCode**, **Codex** and **Claude
Code**, grouped by working directory in Herdr's Agents view.

By default it uses **inline mode**: no pane and no tab is created, and the session list is
attached as tokens underneath the official agent row for that directory, drawn as an ASCII
tree.

If you want to work on the plugin itself, see [Development](#development) at the end of
this document.

## What problem it solves

You have OpenCode open on a directory, with several sessions running on the same server.
Herdr's built-in OpenCode integration only reports the one session the TUI in the current
pane has selected, plus its child sessions. So every other session running on that same
server — the ones that have been working away in the background since before you switched
away — is completely invisible in the Agents view. The only way to find out which ones are
still running is to click through pane by pane.

This plugin fills that gap: every running root session that is not opened gets its own row,
with accurate state.

### Three product boundaries

| Decision | Conclusion |
| --- | --- |
| What a mirror row can do | **Look, don't talk.** No OpenCode runs inside the mirror pane and it does not accept input. To interact, switch back to your real TUI pane. |
| Which sessions get mirrored | **Only running root sessions.** Child agents are aggregated into the parent row by the official integration, they are not listed separately. |
| Will anything be duplicated | **No.** The session your real TUI has selected is actively yielded to the official integration's row. |

## How it works

Every row in Herdr's Agents view has to be bound to a real pane, and plugin v1 can neither
register actions dynamically nor build native UI. So the approach is:

```
opencode server
   │  /api/session/active  who is running
   │  /api/event (SSE)     permission pending / state changes
   │  /api/permission/request  authorization awaiting a reply (polling fallback)
   ▼
board.mjs (resident manager, living in a plugin pane)
   │  one mirror pane per session (a single idling node process)
   │  reports state and metadata on those panes under our own source
   ▼
Herdr Agents view
```

Six key design decisions:

- **State comes straight from the OpenCode server's runtime**, not from reading the screen
  and recognising it. That makes it more accurate than the official integration, and it
  means high-value signals like permission pending are actually available.
- **A mirror row lands in the workspace that belongs to its own directory.** The grouping
  token of the Agents sidebar is `workspace` and nothing else, there is no group-by-directory
  option, so the mirror pane has to land in the workspace the user opened for that
  directory — only then does the row fall under the matching `[n] <project name>` group.
  See "Where rows end up" below.
- **Each directory gets a tab of its own in its workspace** to hold the mirrors (fixed name
  `oc-sessions`). That way the plugin never inserts panes into the work tabs you are
  actually using, so multi-pane layouts never get squeezed and never jitter.
- **The manager is a pane, not a background process.** `[[startup]]` is only a one-shot
  init hook, not a supervised daemon, so the resident logic lives in `[[panes]]`.
- **Nothing runs inside a mirror pane**, it only keeps a foreground process alive
  (`setInterval` keepalive). That way the official integration can never report a second
  time on the same pane, and duplicate rows are impossible at the source.
- **Deduplication is based on session identity.** Before each recompute it reads Herdr's
  agent list, collects the session ids already reported by another source (mainly the
  official integration), and removes them from the candidate set.

### Where rows end up

The sidebar looks like this:

```
[1] afloat
  ├ opencode  Tray hover 2nd-level menu collapse, no exit animation…   ← official row (the one the TUI has selected)
  └ opencode  Move the old branch's fullscreen glow effect to notification cards and bar   ← mirror row (another one running in the same directory)
[2] ReimuMoePCB_DAPLink
  └ opencode  Use DAPLink to recognize H750          ← official row
```

Concretely: take the session's `directory` and look up Herdr's panes in reverse (`cwd` /
`foreground_cwd` strict equality, and failing that, whether this directory sits underneath
some pane's directory), find the matching `workspace_id`, then open a dedicated tab
`oc-sessions` in that workspace to hold this directory's mirrors. **Never guess by
directory name** — the same project name can show up under any path, and a wrong guess
files the mirror row under somebody else's group.

Only when no workspace matches at all (for example the session is under `/tmp/...` and you
never opened that directory) does it fall back to the central `Sessions` workspace, and
the log then says `该目录没有对应的工作区，已归入 Sessions 兜底工作区` ("no workspace matches
this directory, filed into the Sessions fallback workspace").

### How mirror panes are laid out

Once the new pane is split out, the plugin immediately **rebalances the whole mirror
subtree in that tab**: for every split node it sets the ratio to "leaf count of the first
subtree ÷ total leaf count of the subtree", so all mirror panes divide the space exactly
evenly.

It uses `layout.set_split_ratio` (ratios only) and **never** `layout.apply` — apply
rebuilds the tab and destroys every live terminal process, killing and restarting all
existing mirror panes.

Mirror rows get created no matter how many there are. When the window is not tall enough
rows get shorter and you have to scroll, but the plugin never refuses to create a row
because it "does not fit".

### Cleaning up when done

- All sessions under a directory have stopped → that `oc-sessions` tab is **closed
  automatically, the whole page**.
- Nothing uses the fallback anymore → the `Sessions` fallback workspace is closed too
  (Herdr reaps empty workspaces on its own).
- To clear everything immediately: the `reap` action.

### Why reporting is split into two steps

When `resume_argv` is invalid, Herdr's failure code is `invalid_resume_argv`, and the
official docs state "the report is not applied" — meaning that a bad resume command takes
the `agent_session_id` down with it and the session id is reported for nothing. Hence:

1. `pane report-agent --state ... --agent-session-id <id>` — no resume command, land the
   state and the session identity first
2. `pane report-agent-session --agent-session-id <id> -- <resume command>` — attach the
   resume command separately

A failure in step 2 only affects "how to resume after a Herdr restart"; the row itself is
unaffected. Both steps are logged.

State mapping:

| opencode | Herdr | Notes |
| --- | --- | --- |
| An unreplied permission request | `blocked` | From the SSE `permission.asked` / `permission.replied` events |
| `retry` (v1) / a retry in the last message (v2) | `blocked` | Usually an error that needs handling, the error text goes into `--message` |
| `busy` / `running` | `working` | Currently executing |
| None of the above | `idle` | Once the idle grace period passes, the row is reaped |

Priority: permission pending > retry > busy.

## Installation

### Requirements

| Dependency | Requirement | Notes |
| --- | --- | --- |
| [Herdr](https://herdr.dev/) | ≥ 0.9.3 | The minimum version declared as `min_herdr_version` in `herdr-plugin.toml`, and Herdr refuses to install anything older |
| [Node.js](https://nodejs.org/) | **must be on `PATH`** | The resident process is `node src/board.mjs`, and Herdr looks up `node` on `PATH`. **When it cannot find it there is no error**: the startup hook and all three actions fail silently and nothing shows up in the sidebar. Verify with `node --version` |
| Operating system | Linux or macOS | The manifest declares both platforms. **Live testing on a real machine has only been done on Linux**, macOS currently has code-review conclusions only |
| OpenCode server | Running | Every bit of the plugin's data comes from its HTTP interface, and without it the plugin shows nothing. Having any opencode TUI open is enough |

**Codex and Claude Code are optional**: if they are not installed, that part is simply not
collected. If they are, you also need an **official agent row** that Herdr recognizes to
mount on — the default inline mode hangs the session list underneath official rows, so
with not a single official row there is nowhere to mount (see "Codex support" and "Claude
Code support" below).

The plugin has **zero third-party dependencies and no build step**: there is no `[[build]]`
in the manifest, all the code is `.mjs` built on Node built-ins, and the repo has no
`package.json`. So there is no `npm install` — clone it and run.

### Installing from GitHub

```bash
herdr plugin install Sighthesia/herdr-parallel-sessions-display
```

`install` only accepts the GitHub shorthand (`owner/repo` or `owner/repo/subdirectory`). It
clones the repo with `git` and **shows a preview first in an interactive terminal** (source
address plus the command that will be executed) before asking you to confirm; add `--yes`
to skip the confirmation if you already trust the repo, and add `--ref` to pin a branch,
tag or commit:

```bash
herdr plugin install Sighthesia/herdr-parallel-sessions-display --yes
herdr plugin install Sighthesia/herdr-parallel-sessions-display --ref <branch-or-commit>
```

This plugin has no `[[build]]`, so the install runs no build commands at all.

Then write the config and open the board:

```bash
# 1. Find the config directory (already created at install time)
herdr plugin config-dir herdr-parallel-sessions-display

# 2. Copy config/.env.example from the plugin directory into .env in that directory
#    (the plugin directory is the checkout, herdr-plugin.toml sits at its root)

# 3. Open the board —— the resident manager runs inside this tab
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board
```

The plugin directory of a GitHub install is a Herdr-managed checkout, so **take the
template from there and write `.env` into the directory that `herdr plugin config-dir`
points at** — do not write it into the plugin directory.

`.env` **can be left completely empty**, the defaults work as-is; every key in the template
carries a Chinese comment, and what each option means is in the "Configuration" table
below. **After editing `.env` you must close the board tab and reopen it for it to take
effect** — config is read exactly once, at process start.

### Optional: binding a shortcut

Not binding keys is fine too — all three actions can be invoked by id from Herdr's command
palette. To bind keys, add this to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+o"
type = "plugin_action"
command = "herdr-parallel-sessions-display.board"
```

The plugin ships three actions:

| action | Effect |
| --- | --- |
| `herdr-parallel-sessions-display.board` | Open the board (the resident manager) |
| `herdr-parallel-sessions-display.sync` | Trigger one full recompute immediately |
| `herdr-parallel-sessions-display.reap` | Reap all mirror rows and mirror panes |

### If nothing shows up in the sidebar after installing

Walk these three steps in order, the full version is in [Troubleshooting](#troubleshooting)
below:

1. **Is the board tab there.** The resident manager is the node process inside that tab,
   and while it is not running the plugin does nothing at all (the sidebar keeps whatever
   the last successful recompute left there, which looks completely normal). Bring it up:
   `herdr plugin action invoke herdr-parallel-sessions-display.sync`
2. **The board pane's output does not go to the plugin log**, you have to read the pane:

   ```bash
   herdr pane list --json | jq -r '.result.panes[]|select(.label=="Herdr Sessions")|.pane_id'
   herdr pane read <board_pane_id> --lines 200
   ```

3. **Turn on debug.** Put `LOG_LEVEL=debug` into `.env`, then close the board tab and
   reopen it. debug prints, line by line, why each session got a row or did not.

#### Can't find the OpenCode server?

The auto-detection order is: an explicit `OPENCODE_SERVER_URL` in `.env` → the default
port `4096` → scan the listening ports and try every one whose process name contains
`opencode`.

The last step depends on the system `lsof` (on Linux `ss` is preferred, from `iproute2`).
**If you have neither, there is no error** — the only candidate left is the default port,
your server is on a different port, so it never connects, and the symptom is identical to
"the plugin is broken". A server running on a non-default port produces the same symptom.

Pick one of two fixes: install `lsof` (or `iproute2`), or hardcode it in `.env`:

```bash
OPENCODE_SERVER_URL=http://127.0.0.1:4096
```

## Configuration

It goes into `.env` under the directory that
`herdr plugin config-dir herdr-parallel-sessions-display` points at. The complete
commented version is in [`config/.env.example`](config/.env.example).

| Key | Default | Notes |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | empty | Explicit address, e.g. `http://127.0.0.1:4096`. Left empty means auto-detection |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic Auth username |
| `OPENCODE_SERVER_PASSWORD` | empty | Basic Auth password |
| `MIRROR_LABEL` | `Sessions` | Name of the **fallback** workspace, only created when a directory matches no workspace at all |
| `MIRROR_TAB_LABEL` | `oc-sessions` | Name of the mirror tab each directory gets inside its own workspace |
| `AUTO_START` | `false` | Bring the manager up automatically after Herdr restores |
| `INSTALL_AGENT_VIEW` | `false` | Whether to install the global Agents view projection |
| `POLL_INTERVAL_MS` | `5000` | Polling fallback interval |
| `IDLE_GRACE_MS` | `15000` | How long a row is kept after it turns inactive |
| `AGENT_VIEW_SCOPE` | `mirror` | Projection scope: `mirror` shows only mirror rows / `sort-only` only sorts |
| `RESUME_MODE` | — | **Deprecated**, ignored if set and noted in the startup log. The resume command is always the resident process, see below |
| `MIRROR_PANE_RATIO` | `0.5` | Initial split ratio, overwritten by the rebalance the moment the pane is created |
| `MIRROR_PANE_DIRECTION` | `down` | Layout direction `down` / `right` |
| `MIRROR_INLINE` | `true` | **Inline mode**: no mirror panes and no `oc-sessions` tabs at all, see below. `false` = back to the old one-mirror-row-per-session model |
| `PARALLEL_TOKEN_MAX` | `78` | Upper bound for the `oc_par` token value. Herdr hard-truncates a single token value at 80 characters |
| `PARALLEL_CONNECTOR` | `bar` | Connector for session rows: `bar` (`│▸ ● title`, the bar runs all the way down and the whole column lines up) / `tree` (`├─ ▸ title`) / `none` (`▸ title`) |
| `PARALLEL_BUSY_FRAME_MS` | `150` | Milliseconds per spinner frame. 10 frames × 150ms ≈ 1.5s per cycle |
| `PARALLEL_BUSY_ANIMATE` | `false` | **Off by default** (measured: it costs 8% more of a single core). See below for the braille dot matrix spinner |
| `PARALLEL_BUSY_FRAMES` | `●` | The **frame sequence** of the "running" marker. The single-character default is a solid dot, static |
| `PARALLEL_TRUNK` | empty | The parent bar (`│`) in the tree prefix of session rows. Empty by default — to bring it back, set a non-whitespace character such as `│` (spaces do not survive, Herdr trims them) |
| `INLINE_ALWAYS_LIST` | `true` | Whether the **official session's own row** is still written when that agent's workspace has no parallel session. `terminal_title_stripped` is already gone from the template, so turning this off means the official title disappears |
| `REBALANCE_INTERVAL_MS` | `30000` | Interval of the routine rebalance sweep. Creating and reaping rows are immediate, this only fixes layout that somebody else (a sidebar plugin, a user dragging panes) has messed up |
| `FOCUS_REDIRECT` | `true` | When focus lands on a mirror row, jump to the real foreground agent in the same directory, see below |
| `FOCUS_REDIRECT_COOLDOWN_MS` | `2500` | Redirect cooldown for the same mirror row, debounce |
| `SESSION_LIST_LIMIT` | `200` | How many sessions to fetch per page |
| `SESSION_PAGE_LIMIT` | `8` | How many pages to walk at most while looking for active sessions |
| `RETRY_DETECTION` | `true` | Whether to probe for the "retrying" state (on v2 that is one extra request per session) |
| `RETRY_CHECK_LIMIT` | `8` | How many sessions to probe per round at most |
| `AUTO_AUTH_SERVICE_JSON` | `true` | Allow reading the password from `~/.config/opencode/service.json` automatically |
| `DISCOVERY_BACKOFF_MAX_MS` | `60000` | Upper bound for the backoff when the server is unreachable |
| `LOG_LEVEL` | `info` | `debug` is the one you want for troubleshooting |
| `CODEX_ENABLED` | `true` | Whether to collect Codex sessions. Off means the Codex app-server is never contacted at all |
| `CODEX_SOCKET` | empty | Path to the Codex app-server control socket. Empty uses the default `~/.codex/app-server-control/app-server-control.sock` |
| `CODEX_CLIENT_NAME` | `herdr-parallel-sessions-display` | Client name reported in the `initialize` handshake |
| `CODEX_SOURCE_KINDS` | empty | Empty = built-in `cli,exec,appServer,vscode` (sub-agents are filtered out by exclusion). **Do not put only `cli`**, measured: it filters out every vscode-sourced session without complaining |
| `CODEX_SESSION_LIMIT` | `100` | How many threads to fetch per page |
| `CODEX_TIMEOUT_MS` | `8000` | Timeout for a single app-server request |
| `CODEX_ADOPT_SESSION` | `true` | When the official row has no `agent_session`, the plugin backfills one as `herdr:codex` (it reads from Codex's own app-server and writes the real thread id). **Without the backfill Codex is completely invisible while the TUI has just started and has not run a single turn yet**, see below |
| `CLAUDE_ENABLED` | `true` | Whether to collect Claude Code sessions. Turning it off removes the lists already mounted on Claude rows |
| `CLAUDE_BIN` | empty | Path to the `claude` executable, empty uses the one on `PATH`. **The PATH of a GUI-launched Herdr is not necessarily the same as your terminal's**, so if `claude` runs in the terminal but the board pane cannot spawn it, put the absolute path here |
| `CLAUDE_TIMEOUT_MS` | `8000` | Timeout for a single `claude agents --json`. Measured: a normal call takes about 260ms |
| `CLAUDE_POLL_MS` | `10000` | Claude's collection cadence (**independent of the main loop's 5 seconds**). Every collection spawns one process, so at 5 seconds you burn 260ms of resident time every 20 seconds for nothing |
| `CLAUDE_SESSION_LIMIT` | `50` | How many sessions to recognize at most (newest first) |
| `CLAUDE_ADOPT_SESSION` | `true` | When the official row has no `agent_session`, the plugin backfills one as `herdr:claude` (it writes the real session id). **Without the backfill not a single Claude session shows up**, see below |
| `CLAUDE_READ_TITLES` | `true` | When the title is the default display name, fall back to the first user message of the transcript. Only the first 64KB of the file is read, and it is memoized per session |

After editing `.env` you have to restart the board pane (close the tab and reopen it) for it
to take effect.

### About the resume command (`RESUME_MODE` is deprecated)

The resume command is **always the resident process** (`node mirror.mjs`), and OpenCode
never runs inside a mirror pane.

There used to be a `RESUME_MODE=opencode` option whose resume command was
`opencode --session <id>`, on the theory that "after a restart the mirror row can keep
chatting". **Measurement showed it destroys the whole plugin, and it has been deleted**: on
a Herdr restart it launched the OpenCode TUI inside the mirror pane, and the official
integration immediately reported the official agent row on **the same pane**, overwriting
the `oc_mirror` / `oc_session` markers outright — not one extra duplicate row, but **the
whole row disappearing**. Meanwhile `paneId` was still in the state file, so the plugin
thought it was alive, neither rebuilt the row nor yielded it, and mirroring for that
directory silently stopped working.

> The old docs claimed "the next dedupe round sees the session is already taken and yields
> the row, so no duplicate row ever appears" — that reasoning assumes the official
> integration **adds** a row. Measured, it **overwrites** the same row.

To talk to a session directly at a mirror position, just type `opencode --session <id>`
yourself: that row becomes the official row, the plugin detects the lost markers and yields
it by itself, and the two do not fight.

### Inline mode (default): no panes at all

With `MIRROR_INLINE=true` the plugin **creates no mirror panes and no `oc-sessions` tabs**.
It uses `--applies-to-source` of `pane.report_metadata` to hang the session list as
`$oc_sess*` tokens off that directory's **official agent row**, and it **does not take over
that row**:

- measured: neither the `agent` field nor `agent_session.source` is affected
- when the official integration re-reports (`working` → `idle`) the tokens survive anyway
- so the sidebar contains **only official rows**, and clicking one naturally lands on the
  real foreground agent

The sidebar template in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

The result is an ASCII tree, and **the official session is in it too** (marked with `▸`):

```
[1] afloat
◐ opencode
│▸ ● Debugging the slow init of Shell reload startup    ← the one the official TUI has selected
│  ● Debugging the wallpaper reveal transition on shell startup    ← switched away but still running
│  ○ Tray hover 2nd-level menu collapse, no exit animation…
```

The connector is switchable (`PARALLEL_CONNECTOR`):

| Value | Result |
| --- | --- |
| `bar` (default) | `│▸ ● title` — the bar runs to the bottom, markers and titles line up as one column |
| `tree` | `├─ ▸ title` / `└─ title` — the classic tree connectors |
| `none` | `▸ title` — no prefix at all |

In `bar` mode the official row takes the two cells of `▸ ` and every other row is padded
with two spaces, so all rows line up. The padding is **interior** whitespace, which Herdr's
trim of leading whitespace does not touch.

### The "running" marker: a solid dot (the braille dot matrix spinner is kept but not enabled by default)

By default it is a **solid dot `●`, motionless**.

Making this marker spin like OpenCode v2 is possible (see below for how), but it is **off
by default** — measured: about 12% of a single core while spinning versus 4% with it off,
and the extra 8% buys very little visually: the `state_icon` on the same row is already
running Herdr's own braille dot matrix spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), and **it is that row that
spins, not our marker**.

**Why the default solid dot is not a dot matrix**: OpenCode v2's running indicator
([`session-progress-indicator-v2.tsx`](https://github.com/anomalyco/opencode/blob/1ddb0873aee50d209d1a8d7f91b89c5daf692d49/packages/session-ui/src/v2/components/session-progress-indicator-v2.tsx))
is a 5×5 matrix of 25 dots animated by changing opacity along a diagonal wave. The sidebar
cannot reproduce that as-is: a token is static text, newlines are stripped, values are
hard-truncated at 80 characters, and Herdr does not animate on our behalf — a
two-dimensional dot matrix does not fit into one line.

**To turn the braille dot matrix spinner on** (you need both settings, setting only the
sequence still gives you a still frame):

```bash
PARALLEL_BUSY_FRAMES=⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
PARALLEL_BUSY_ANIMATE=true
PARALLEL_BUSY_FRAME_MS=300    # 3s per cycle, roughly half the cost
```

**How the animation works**: Herdr only animates its own `state_icon`, custom tokens get
nothing, so the plugin has to write the next frame back periodically. It opens a separate
ticker for that and deliberately **does not** speed up the main recompute loop — one round
of the main loop is heavy (fetch the active set, scan sessions, scan panes, query
permissions), and running it for a 150ms animation would drag Herdr and OpenCode down.
The ticker only swaps characters in memory: after the main loop has rendered, it caches the
rows that carry a busy marker (marker replaced by a placeholder), and the ticker only swaps
the placeholder for the next frame and writes it back, doing no queries at all. **When there
is no busy marker the timer stops outright: zero cost while idle.**

**Measured cost**: 12% (spinning) versus 4% (off). The bottleneck is **not** process
spawning — a socket-based write path was added specifically for this and it only saved 2%
(14% → 12%); what cannot be saved is that Herdr repaints the sidebar on every token change,
4 busy rows × 6.7/s ≈ 27 repaints per second. So the frame rate has to be adjustable, which
is exactly why it is off by default.

The official row is generated by the plugin as well, because the built-in
`terminal_title_stripped` cannot carry a tree connector (built-in token contents are not
editable and `rules` only change styles), and mixing the two formats makes the hierarchy
unreadable because the indents disagree — the plugin row ends up further left than the
parent node it is supposed to sit under.

**Why the indent is `├─` and not spaces**: Herdr **trims leading whitespace in custom
tokens** (measured: passing `"  └─ x"` stores `"└─ x"`), and Unicode whitespace (U+00A0,
U+2000–200A, U+3000) is trimmed too. So the connector has to be written into the token
value itself. If you want to drop `├─` and write it some other way, change the plugin's
`PARALLEL_TRUNK`.

**How the mount point is chosen**: an exact match against the official agent row's
`foreground_cwd` first — the OpenCode TUI runs in that pane, and the foreground process's
cwd is the directory of its session; measured, every row matched. Only when that fails does
it fall back to "the directory with the most panes that also has an official row". **Pane
count alone is not enough**: measured, `Software/herdr` is the cwd of 7 panes in `w19` (the
user runs a pile of herdr-sidebar instances there) and only 4 in `w1J`, so counting alone
would mount into an unrelated workspace.

**Four hard limits** (measured, not conservative estimates):

- A single token value is **hard-truncated at 80 characters**. The plugin does the
  arithmetic itself and ends with `+N` when it does not fit.
- **Newlines inside the value are stripped**, so one token can only render one line → N
  sessions need N tokens and N rows.
- **Leading whitespace is trimmed**, so indentation with spaces does not survive.
- **Empty slots do not render as blank rows**, so slots can be added without worry. Six
  right now (`rows` caps out at 16 lines in total).

**Known loss of function**: when a session lives in a directory where the user has not
opened a TUI (typically a scratch project under `/tmp`), that workspace has no official row
to mount on, so the information is simply **not shown** (the log says which session and
which directory). To make those sessions visible too, set `MIRROR_INLINE` to `false` and go
back to the pane-creating model.

### Codex support

Besides OpenCode, the plugin also reads **the sessions Codex has running** and mounts them
the same way, on Codex's official agent rows. Each agent shows its own list in the sidebar,
they never mix.

**How it reads them**: through Codex's **app-server** (JSON-RPC over WebSocket), not by
reading sqlite. Measured: reading the `threads` table of `~/.codex/state_5.sqlite` directly
gives **0 rows** (the data is in `-wal`), while the app-server returns the real data
straight away.

It uses the **shared app-server daemon**
(`~/.codex/app-server-control/app-server-control.sock`), because only connecting to that
one yields **live state** (`active` / `idle` / `notLoaded` / `systemError`) — starting your
own instance can list sessions too, but every state comes back `notLoaded` and there is no
way to tell "currently running" from "left over from the past". The daemon is resident
anyway; we are just one more client connection, which adds no resident cost.

**Prerequisite**: install Herdr's Codex integration first, it reports agent rows to Herdr
through a hook:

```bash
herdr integration install codex
herdr integration status        # confirm codex: current
```

**Without it not a single Codex session is displayed** — inline mode only mounts tokens
onto official rows, and with no official row there is nowhere to mount. When the plugin
collects sessions but cannot find a matching official row it writes one info log line
saying so (only once). Note that this command injects a hook into `~/.codex/hooks.json`; if
that file already contains other hooks (say `dcg`), check that the merge did not clobber
them.

Once that is in place, start a Codex session and the sidebar shows:

```
[1] afloat
◐ codex
├─ ▸ ● The task you are working on
└─ ● Another session that is still running
```

**Tuning**: leaving `CODEX_SOURCE_KINDS` empty is the right thing (built-in
`cli,exec,appServer,vscode`, filtering sub-agents out by exclusion). **Do not put only
`cli`** — measured, it filters out every vscode-sourced session and does not complain, and
the symptom is the list simply vanishing. Sub-agents are not listed separately.

### Why `CODEX_ADOPT_SESSION` is required

Inline mode mounts tokens onto official rows via
`pane.report_metadata --applies-to-source`, and that parameter requires **the target source
to already have a record on that pane**. Without a record the write disappears immediately
(measured: `tokens` goes null).

On the Codex side it is genuinely missing: **Codex 0.160's `SessionStart` hook does not fire
when the TUI starts** (in the binary it is `run_pending_session_start_hook`, deferred until
the session actually starts working). Measured both ways — watching the hook directly, and
re-running the test with `bypass_hook_trust` to rule out "trust expired" as a confounder.
Both give the same answer.

So the official row keeps an empty `agent_session` and not a single Codex session shows up.
The plugin therefore backfills once: it reads the real thread id of that directory from
**Codex's own app-server** and writes it into `agent_session` as `herdr:codex`. It writes
the true value — the official hook, if it ever does run, writes the same value.

After the backfill, `agent_session.value` is Codex's thread id and matches the `id` the
app-server returns exactly — which incidentally also brings the "use the session's own
title instead of the terminal title" exact-match path into play.

**Which session counts as "the official one"**: an exact match between the official row's
`foreground_cwd` and the session's `cwd`. When several sessions share a directory, keep
using the one already backfilled if it is still valid, otherwise prefer the one that is
running, otherwise take the most recently touched.

**Turning it off** (`CODEX_ADOPT_SESSION=false`) goes back to purely passive: only what the
official integration has reported is shown, and the plugin never writes on its behalf. The
price is that Codex is completely invisible until it has finished its first turn.

> Worth mentioning while we are here: guessing a source for
> `--applies-to-source herdr:codex` does **not** mount. The token is written and reads back
> as null. So "backfill" and "mount" both have to happen, neither one is optional.

### Claude Code support

It mounts **the sessions Claude Code has running** onto Claude's official agent rows the
same way, rendered exactly like Codex. **The prerequisite is different**: you do not need
`herdr integration install claude` first — the moment Claude runs inside some Herdr pane
there is an official row, and the plugin fills in the session identity itself (see below).

**How it reads them**: `claude agents --json`. The official docs say plainly that this is
the only supported programmatic interface (`~/.claude/jobs/` and `roster.json` are unstable
interfaces, do not parse them). One call takes about 260ms and runs every 10 seconds
(`CLAUDE_POLL_MS`); when Herdr has not a single Claude row, even the spawn is skipped.

**No daemon to install**: when `claude daemon status` reports `not running`, the sessions
that are running are still listed.

**Titles**: Claude's default display name is something like `herdr-fe` (directory name plus
two characters), which carries no information, and a background task that has not got a
title yet will even use its own short id as a name. The plugin reads the session
transcript's **first user message** and uses it as the title (only the head of the file,
memoized per session). To turn the disk read off, set `CLAUDE_READ_TITLES=false`; the price
is that those sessions display as `(无标题)`.

### Why `CLAUDE_ADOPT_SESSION` is required

The same problem as Codex, but for a different reason: Herdr 0.9.3's Claude integration
reports through a hook (`~/.claude/hooks/herdr-agent-state.sh`), and **with the integration
not installed the Claude rows from `herdr agent list` have no `agent_session` field at
all**. Inline mode only mounts tokens onto "official rows", so not one of those rows can be
used and the sessions are completely invisible.

So the plugin backfills once: as `herdr:claude` it writes the real session id from
`claude agents --json` into that row's `agent_session`. It writes the true value — the
official hook, if it ever runs, writes the same value. Turning it off
(`CLAUDE_ADOPT_SESSION=false`) goes back to purely passive, at the price that not a single
Claude session is displayed.

**Which session counts as "the official one"**: Claude is more precise than Codex here —
the `foreground_process_group_id` reported by Herdr is **byte-for-byte equal** to the `pid`
in `claude agents` (measured: `w1J:p12` → 2440557 → some session id), so this is an **exact
match** rather than a guess; the command line of a background task even carries
`--session-id <uuid>` directly. Only cases like "that session never showed up in the list"
fall back to matching by directory, and when they do, the log says `目录匹配（降级，pid 没对上）`
("directory match (degraded, pid did not match)").

### About `FOCUS_REDIRECT` (only active when `MIRROR_INLINE=false`)

> With `MIRROR_INLINE=true` (the default) **this section does not apply**: the sidebar only
> has official rows, clicking one jumps to the official pane anyway, and no subscription is
> ever established. Inline mode is the end state of "make the jump land somewhere useful"
> below — it does not even need mirror rows.

Herdr's sidebar has **no switch for "this row is not clickable"**. `agent.view.set` only
offers filter / sort / label; the only relevant field in `AgentInfo`, `interactive_ready`,
is not returned at all in 0.9.3; there is nothing in the config; and plugin v1 explicitly
excludes non-terminal UI. So under the old "create panes" model, mirror rows can only stay
clickable.

With `FOCUS_REDIRECT=true` (the default) the behaviour is: **the moment focus lands on a
mirror pane, it jumps straight to the real foreground agent of that directory** — the row
Herdr detected itself and that is not one we reported. The landing rules:

1. Candidates inside the `oc-sessions` tab are excluded first. The official OpenCode may
   well be running in that tab (a leftover from a mirror pane that the official integration
   took over), and jumping there is the same as never leaving the mirror tab.
2. Within the user's own tabs, prefer the currently focused one, then
   `working` → `blocked` → `idle` → `done`.
3. When the workspace has not a single official agent (for example the `Sessions` fallback
   workspace) it **does not jump** and keeps the original read-only card — popping into the
   wrong pane is worse than not popping at all.

**Know the side effect**: focus landing on a mirror pane does not only come from clicking a
sidebar row. When you switch workspaces with `prefix+alt+N`, Herdr restores whichever pane
was focused last in that workspace, and if that happens to be a mirror pane it gets bounced
too. Most of the time that is what you want (you went to that workspace to work), but if
you specifically wanted to look at the `oc-sessions` tab you get bounced back and have to
click the official row once more. Set `FOCUS_REDIRECT=false` to turn it off completely.

`agent.view.set` is a **global** setting: it affects every agent in the whole Agents
sidebar, not just mirror rows. So it is off by default. Once you enable it:

- `AGENT_VIEW_SCOPE=mirror`: show only mirror rows (filtered by the reported `oc_mirror`
  token)
- `AGENT_VIEW_SCOPE=sort-only`: no filtering, only sorting by "needs attention first, then
  most recently changed"

And it has no CLI wrapper; the plugin implements a bare socket client of its own
(newline-delimited JSON).

**One safety floor: the plugin never installs a filtered projection while there is not a
single mirror row.** The filter is global, so in that state it would hide every row of the
official integration and the sidebar would go straight to `no matching agents`. So when the
mirror row count is 0 it degrades to `sort-only` automatically, and promotes itself back as
soon as mirror rows return.

And this calibration logic runs once in **every operating mode** (startup / pane / action /
once), so after you turn `INSTALL_AGENT_VIEW` off, running any action at all clears the
projection — you never end up with "the config was turned off ages ago but the filter is
still living inside a running Herdr".

### Making sidebar rows show readable titles

Mirror rows report these tokens, and you can use them directly in your sidebar row template:

| token | Content | Example |
| --- | --- | --- |
| `$oc_title` | Session title | `Debugging the slow init of Shell reload` |
| `$oc_project` | Project name (basename of the session directory) | `afloat` |
| `$oc_state` | State | `working` |
| `$oc_session` | OpenCode session id | `ses_f37dc43f...` |
| `$oc_mirror` | Mirror row marker, always `1` | `1` |

The plugin also `pane rename`s the mirror pane (`● afloat · Debugging the slow init…`,
within 40 characters), and that label is separate data from the terminal title.

> Note: if you have a plugin such as `herdr-sidebar` installed, its `hs_title` token has
> higher priority and overrides the terminal title. To make mirror rows display
> `$oc_title`, add `$oc_title` to **your own** sidebar row template — the plugin does not
> go editing your other plugins' configuration.

## Compatible OpenCode versions

The plugin adapts to both the OpenCode v1 and v2 HTTP surfaces and decides automatically
via `/api/info` or `/global/health`:

| | v1 | v2 |
| --- | --- | --- |
| Health check | `GET /global/health` | `GET /api/info` (v2 has no health route) |
| Active state | `GET /session/status` | `GET /api/session/active` |
| Root sessions | `GET /session?roots=true` | `GET /api/session?parentID=null` |
| Session directory field | `directory` | `location.directory` |
| Permission pending | SSE only | SSE + `GET /api/permission/request` polling fallback |
| SSE event name | the `event:` field | the `type` field of the JSON inside `data:` |

The plugin handles both v2 traps: the SSE stream sends `: heartbeat` comment lines and the
event name is not in `event:`; permission requests are separated per directory by the
`x-opencode-directory` header, so it queries each directory concurrently and merges the
results.

`opencode serve --discoverable` has not shipped yet, so server discovery goes: explicit
URL → default port 4096 → `ss -ltnp` / `lsof` to scan listening ports whose process name
contains opencode and verify them one by one.

## Troubleshooting

**Start with the plugin logs:**

```bash
# The board pane's output does not go to the plugin log, you have to use pane read
# —— first find the board's pane:
herdr pane list --json | jq -r '.result.panes[] | select(.label=="Herdr Sessions") | .pane_id'
herdr pane read <board_pane_id> --lines 200
```

If you cannot get any detail, put `LOG_LEVEL=debug` into `.env` and restart the board. The
debug level prints, for every session, why it got a row or did not (was it yielded to a
real TUI, or is it a sub-agent). When `.env` contains a key the plugin does not recognize,
the startup log lists it explicitly (misspelled keys included) — **once you see that warn,
stop suspecting timing: the key was never read**.

**The session list in the sidebar stopped updating (most common after closing the board
tab or restarting Herdr):**

The manager is the resident process inside that board tab. **While it is not running the
plugin does nothing at all**, and what remains in the sidebar is the content from the last
successful recompute, which looks completely normal — this is the hardest kind of "broken"
to recognize. How to confirm and how to recover:

```bash
# 1) Is the board there (the node process inside the board tab)?
ps -ef | grep 'board\.mjs --mode pane' | grep -v grep

# 2) Not there? Bring it up. The sync action checks and restarts it by itself
herdr plugin action invoke herdr-parallel-sessions-display.sync
```

To have it come up automatically after a Herdr restart, set `AUTO_START` to `true` in
`.env`.

**Not a single row in the Agents view:**

1. Is the board pane actually running? `herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board`
2. Can the OpenCode server be reached? Search the log for `已连接 opencode`. If that line
   is missing, it did not connect. Try it by hand:

   ```bash
   curl -s http://127.0.0.1:4096/api/info
   curl -s -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/api/info
   ```

3. Is the server on a non-default port? Writing `OPENCODE_SERVER_URL` is the least effort.
4. Is the log full of `让出 N 个` with N equal to the number of active sessions? See "Fewer
   mirror rows than expected" below.

**The sidebar suddenly went empty / shows `no matching agents` (handle this first):**

The plugin's global filtering projection hid the **official rows as well**. Get yourself
out first, then find out why.

```bash
# 1) Clear the projection first. It only clears the one this plugin really installed,
#    and will not touch anybody else's view.
herdr plugin action invoke herdr-parallel-sessions-display.sync
```

> That action does the projection calibration the moment it starts: when
> `INSTALL_AGENT_VIEW=false` but the plugin believes it installed one, it immediately runs
> `agent.view.clear` and clears the record. The sidebar should recover right away. Every
> operating mode (startup / board pane / action / once) does the same thing, so "reopen the
> board pane" works just as well.

Then find out why the filter was installed while there were no mirror rows:

```bash
# 2) Search the board pane's log for these two lines
#    「重平衡镜像布局」      —— it means the mirror panes really are there
#    「镜像行 N」            —— N=0 while the projection still carries a filter is the anomaly
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board
herdr pane read <board_pane_id> --lines 200
```

3. Confirm `INSTALL_AGENT_VIEW=false` in `.env` and restart the board.
4. If you **really** want the `mirror` scope: first get at least one session running on the
   OpenCode side, and once mirror rows appear the plugin promotes the projection back to
   the filtered version.

**Fewer mirror rows than expected:**

Search the log for `让出 N 个`. When `N` equals the number of active sessions, every
session is taken by a real user TUI — that is correct behaviour, not a bug.

**One row still has no name (it displays as `'/usr/bin/node' …`):**

The default text of that sidebar row comes from the terminal title (OSC), and what runs
inside a mirror pane is a node process. The plugin has already given the pane a readable
name with `pane rename` and has reported the `$oc_title` / `$oc_project` tokens. If you
have `herdr-sidebar` installed, its `hs_title` has higher priority — just add `$oc_title`
to your own sidebar row template (see "Making sidebar rows show readable titles" above).

**A mirror row's state never updates:**

Look at `SSE up/down` in the log. A dropped SSE reconnects automatically and warns in the
log; while reconnecting it degrades to `POLL_INTERVAL_MS` polling, so permission pending is
detected less precisely but not completely blind. The row stays there, only `blocked` may
light up a few seconds late.

**The `Sessions` fallback workspace is gone / mirror tabs are left over:**

```bash
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board
herdr plugin action invoke herdr-parallel-sessions-display.reap
```

`reap` releases first and then closes every mirror pane, closes each directory's mirror tab
as a whole page, closes the fallback workspace too, and wipes the mappings clean. If the
sessions are still running they are rebuilt on the next round.

**Rows show up in the `Sessions` group instead of a project group:**

That means the session's directory has **no matching workspace** in your Herdr (you never
opened a workspace/tab in that directory). The board log will have a line like:

```
/tmp/xxx/yyy 没有对应的工作区，已归入 Sessions 兜底工作区
```

Fix: create a workspace in that directory with Herdr
(`herdr workspace create --cwd <dir>`), and the next mirror round moves itself into that
workspace as a mirror row under the correct group.

**The order of mirror rows within the same directory changes:**

The layout inside the mirror tab is decided by a balanced BSP tree that divides the space
evenly. Whichever session starts first gets created first, so the order is not guaranteed
stable — as long as the grouping is right that is fine.

**Not a single Claude session is displayed:**

Check these three things in order:

```bash
# 1) Does Herdr actually have Claude rows at all? (inline mode can only mount on official
#    rows; with no row there is nowhere to mount)
herdr agent list | grep -o '"agent":"claude"' | head -1

# 2) Does Claude Code itself recognize these sessions?
claude agents --json

# 3) Is the claude executable on the PATH of the **board process**? Herdr is launched by
#    the GUI, so its PATH is not necessarily your terminal's. If it runs in the terminal but
#    the plugin cannot spawn it, set CLAUDE_BIN.
herdr plugin config-dir herdr-parallel-sessions-display   # put the absolute path into CLAUDE_BIN
```

- Step 1 coming back empty = no Claude is running inside a Herdr pane (background
  `claude -p` sessions are exactly that, no pane means no row to mount). The log will
  contain `Herdr 里没有 claude 的 agent 行（= 没有 claude 跑在 Herdr 的 pane 里），无处挂载`.
- There are Claude rows but no identity was backfilled = the backfill did not succeed.
  Search the log for `补报 claude 会话身份`.
  `pane.report_metadata --applies-to-source herdr:claude` requires a record for
  `herdr:claude` to already exist on that pane, so **the backfill must come before the
  mount**.
- After changing config you **must restart the board tab** for it to take effect.

**A Claude session title shows up as `(无标题)`:**

It means the transcript of that session has no first user message written yet (Claude Code
just started, or the user has not said anything). One message and it updates — the plugin
**does not cache** a failed parse, precisely for this.

**Claude's state is stuck ten minutes in the past:**

`CLAUDE_POLL_MS` collects every 10000 by default. That is by design (it saves CPU), not a
hang. If you want it snappier, set it to `5000`.

**Rows are gone after a Herdr restart:**

Normally the startup hook restores the mappings from `HERDR_PLUGIN_STATE_DIR`. Check two
things: whether `AUTO_START` is `true` (something has to be running the manager), and
whether `resume_agents_on_restore` has been turned off (that makes Herdr ignore every
resume command). The mapping file is `state.json` in the plugin state directory, and you
can read it directly.

**Rows appear but the title is a session id:**

It means that session did not show up in the session list (pagination did not reach it, or
it was just created). The plugin falls back to using the id as the title and fixes it
automatically once the real title arrives.

## Known limits

The first three below apply only when `MIRROR_INLINE=false` (the old model, one mirror pane per
session). The default inline mode creates no panes and no tabs, so none of that terminal
resource cost applies.

- **One row per running session = one mirror pane**, and that has a terminal resource cost.
  The mirrors are collected into each directory's own `oc-sessions` tab, so they take up no
  screen space until opened, but it is not free. With many rows each row gets shorter and
  you have to scroll — the plugin never refuses to create a row because it does not fit.
- **Each directory gains one extra tab in its workspace**, named `oc-sessions` (Herdr adds
  a prefix). Closing it affects nothing except the mirror rows; when the mirrors are rebuilt
  they open another one by themselves.
- **`herdr-sidebar` injects a Sidebar pane into the mirror tab** (it injects into every
  tab). That pane has no agent row, so it neither takes part in the mirror layout balancing
  nor blocks the tab from being reaped.
- **Mirror rows are read-only.** To interact you have to switch back to the real TUI and
  change session by hand.
- **State accuracy depends on SSE.** When the stream breaks it degrades to polling and
  `blocked` gets less precise.
- **It does not touch the official integration files**
  (`~/.config/opencode/plugins/herdr-agent-state.js` and friends) and does not use
  `herdr integration install/uninstall`. That avoids fighting the official integration over
  who owns the state of the same pane.
- **Deduplication does not rely on `agent_session`.** Herdr 0.9.3 only stores native session
  references for the official integration, and a third-party source has `agent_session_id`
  stripped even when it passes one (measured: with `plugin:` / `user:` / `custom:` sources,
  with or without `resume_argv`, at any seq — all identical). So deduplication goes through
  the `oc_session` token the plugin reports itself. The side effect is that native session
  restore after a Herdr restart is unavailable on mirror rows.
- **It does not take over the display layer of third-party plugins.** Mirror rows report
  the `$oc_title` / `$oc_project` / `$oc_state` tokens and set a pane label, but
  `herdr-sidebar`'s `hs_title` has higher priority, and changing that is on you.
- On v2, `retry` detection costs one extra HTTP request per active session, and with many
  rows you can turn `RETRY_DETECTION` off in `.env`.

## Development

Read this whole section before changing the plugin itself. Only the author works on the
plugin: `install` is for users, `link` is for the author, and the two must not be mixed
up.

### Local development workflow

```bash
git clone https://github.com/Sighthesia/herdr-parallel-sessions-display.git
cd herdr-parallel-sessions-display
herdr plugin link /absolute/path/herdr-parallel-sessions-display
```

`link` **does not run `[[build]]`** (this plugin has no build step anyway); it just registers
the current working directory, so making sure it actually runs is up to you. After changing
code you **must close the board tab and reopen it** for it to take effect — if you do not,
the old code keeps running. If you already `install`ed the same plugin, Herdr refuses the
`link`; run `herdr plugin unlink herdr-parallel-sessions-display` first.

### No test suite; verification is live testing on a real machine

This repo has **no `package.json`, no third-party dependencies, no build, no lint, no CI and
nothing that can run offline as a test**. Do not go looking for a test framework, do not add
CI — none of that exists here.

Pure functions (for example `parseSs` / `parseLsof`) can be asserted individually with
`node -e`, but **behavioural correctness can only be verified live**: open the board, open a
few opencode / codex / claude sessions, look at the sidebar.

### Self-check mode

```bash
node src/board.mjs --mode once
```

It runs one round and exits, and it does not take the resident lock. But precisely because
both write tokens to the same set of panes, **when it runs alongside the resident manager
they overwrite each other's content in the sidebar** — only use it when the manager is not
running (or when you know the consequence and use it anyway).

### How to read the logs

The board pane's output **does not go to the plugin log** (you will not find it in
`herdr plugin log list`), you have to go through the pane:

```bash
herdr pane list --json | jq -r '.result.panes[]|select(.label=="Herdr Sessions")|.pane_id'
herdr pane read <board_pane_id> --lines 200
```

With `LOG_LEVEL=debug` in `.env` and the board tab restarted, it prints, line by line, why
each session got a row or did not. When `.env` contains a key the plugin does not
recognize, the startup log warns.

### Adding a config key means changing four places

The easiest trap to fall into: `CONFIG_DEFAULTS` in `src/state.mjs` is an **allowlist**, and
keys that are not in it get **silently dropped** by `loadConfig` — the symptom is "I changed
the config and absolutely nothing happened, with no hint at all", which historically wasted
seven perfectly good keys. Adding a key means changing all of these:

1. `CONFIG_DEFAULTS` in `src/state.mjs`
2. the `config` object in `src/board.mjs`
3. [`config/.env.example`](config/.env.example)
4. the "Configuration" table in this document

The startup log warns about unknown keys (misspelled keys take the same route); once you
see it, stop suspecting timing — the key was never read.

### Commit conventions

Conventional commits, with descriptions in Chinese (consistent with this repo's history):

```
feat: 支持 xx
fix: xx 场景下 yy 不对
docs: 补上 zz 的说明
perf: 降低忙标记开销
```

### Read before changing code

The full list is in [`AGENTS.md`](AGENTS.md) — **it is Chinese-only**: entry points and how
everything is assembled (`herdr-plugin.toml` plus the four modes of `src/board.mjs`), what
each file is responsible for, the hard constraints that were measured the hard way, and the
troubleshooting entry points. The three most important ones:

- **Do not touch the official integration files**
  (`~/.config/opencode/plugins/herdr-agent-state.js`,
  `~/.claude/hooks/herdr-agent-state.sh` and so on), and do not use
  `herdr integration install/uninstall` — ownership of a pane's state is exclusive.
- **Never run OpenCode inside a mirror pane, and never run Claude either.** The resume
  command is always the resident process.
- **Only use `layout.set_split_ratio`, never `layout.apply`** (apply rebuilds the tab and
  destroys every terminal process).

The density of those comments in `AGENTS.md` is intentional: they record why it is done
this way and what pit was measured on the way, not a restatement of the code. Keep that
density when you change code.