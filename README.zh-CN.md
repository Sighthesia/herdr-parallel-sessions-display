# herdr-parallel-sessions-display

[English](README.md) | [简体中文](README.zh-CN.md)

把 **OpenCode**、**Codex**、**Claude Code** 里正在运行的会话，按工作目录显示在 Herdr Agents 视图里。

## 支持的 agent

| Agent | 会话来源 | 需要条件 |
| --- | --- | --- |
| OpenCode | Server HTTP 接口 + SSE | 开着任意 opencode TUI（提供 server） |
| Codex | 共享 app-server 守护进程 | 先 `herdr integration install codex`，且 Codex 跑在 Herdr pane 里 |
| Claude Code | `claude agents --json` | Claude 跑在 Herdr pane 里 |

默认走**内联模式**：不建 pane、不建标签页。会话列表挂在该目录的官方 agent 行下面，画成 ASCII 树。

```
[1] space                     ← 工作区分组
◐ opencode                    ← 官方 agent 行
│▸ ● 对话 1                   ← TUI 当前选中的
│  ● 对话 2                   ← 切走但还在跑的
│  ○ 对话 3                   ← 空闲会话
```

## 为什么需要它

Herdr 自带集成只上报当前 pane 的 TUI 选中的那个会话（及其子会话）。同一 server 里其它正在跑的会话只能一个个 pane 点过去看。

这个插件把同一目录下其余运行中的根会话都列出来，并带实时状态。

范围：

- 只列运行中的根会话，子 agent / sub-agent 不单列。
- 只读。要交互请切回真实的 TUI pane。
- 不重复。真实 TUI 选中的会话会让给官方行。

## 工作原理

```
opencode server / codex app-server / `claude agents --json`
    ▼
board.mjs（常驻管理器，跑在插件标签页里）
    │  经 pane.report_metadata --applies-to-source 挂会话列表
    ▼
Herdr Agents 视图
```

- 状态来自各 agent 的运行时接口，不是读屏识别。
- 每个目录一个挂载点：`foreground_cwd` 与会话目录一致的官方 agent 行。
- 与官方集成已上报的会话去重。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| [Herdr](https://herdr.dev/) ≥ 0.9.3 | `min_herdr_version` 声明的最低版本 |
| [Node.js](https://nodejs.org/) 在 `PATH` 上 | 管理器就是 `node src/board.mjs`，找不到 `node` 时启动钩子和 action 会静默失败 |
| 正在运行的 opencode server | 开着任意 opencode TUI 就行。codex / Claude Code 可选 |

无 `package.json`、无第三方依赖、无构建步骤，不需要 `npm install`。

## 安装

```bash
herdr plugin install Sighthesia/herdr-parallel-sessions-display --yes
herdr plugin config-dir herdr-parallel-sessions-display  # .env 写在这里

# 把插件检出目录里的 config/.env.example 复制成 .env，然后：
herdr plugin pane open --plugin herdr-parallel-sessions-display --entrypoint board
```

`.env` 可以留空，默认值直接能跑。改完 `.env` 需要关掉看板标签页再重开。

三个 action（命令面板里按 id 也能调）：

| action | 作用 |
| --- | --- |
| `herdr-parallel-sessions-display.board` | 打开看板（常驻管理器） |
| `herdr-parallel-sessions-display.sync` | 立刻全量重算一次（管理器没跑时会把它拉起来） |
| `herdr-parallel-sessions-display.reap` | 清掉所有镜像行和镜像 pane |

### 侧边栏模板（必须配）

内联模式需要这些行来显示会话列表，加到 `~/.config/herdr/config.toml`：

```toml
[ui.sidebar.agents]
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

## 配置

完整带注释版本见 [`config/.env.example`](config/.env.example)，常用只有这些：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | 空 | 如 `http://127.0.0.1:4096`，留空自动探测 |
| `OPENCODE_SERVER_PASSWORD` | 空 | server 开了 Basic Auth 时填 |
| `MIRROR_INLINE` | `true` | `false` = 旧的每个会话一个 pane 模式（只支持 opencode） |
| `PARALLEL_CONNECTOR` | `bar` | `bar`（默认）：TUI 选中的那个是根 `│▸`，其余是分支 `├─`/`└─`。另有 `tree` / `none` |
| `CODEX_ENABLED` / `CLAUDE_ENABLED` | `true` | 不需要哪家就设 `false` |
| `CLAUDE_BIN` | 空 | 看板进程的 `PATH` 里找不到 `claude` 时填绝对路径 |
| `POLL_INTERVAL_MS` / `CLAUDE_POLL_MS` | `5000` / `10000` | 轮询节奏 |
| `LOG_LEVEL` | `info` | 排查问题用 `debug` |

新增配置键必须同时改四处：`src/state.mjs`（`CONFIG_DEFAULTS`）、`src/board.mjs`（`config` 对象）、`config/.env.example`、本文档的配置表。`CONFIG_DEFAULTS` 里没有的键会被静默丢弃（启动日志会 warn）。

## codex / Claude Code 说明

- **codex**：先装 Herdr 集成（`herdr integration install codex`），没有官方行就无处挂载，一行都不显示。会话从共享 app-server 守护进程读；默认 `CODEX_ADOPT_SESSION=true` 会补报行身份，让 TUI 第一轮对话之前的会话也可见。
- **Claude Code**：不用装集成，在 Herdr 的某个 pane 里跑起 claude 就行。会话来自 `claude agents --json`（每 `CLAUDE_POLL_MS` 一次）。默认 `CLAUDE_ADOPT_SESSION=true` 补报行身份，不补则一条都不显示。

在没有官方行的目录下（常见是 `/tmp` 临时工程）的会话无处挂载，会跳过，看板日志里会写明。

## 故障排查

日志**不在** `herdr plugin log list` 里，看板面板的输出走 pane：

```bash
herdr pane list --json | jq -r '.result.panes[]|select(.label=="Herdr Sessions")|.pane_id'
herdr pane read <看板pane_id> --lines 200
```

常见情况：

- **列表不更新了**：看板标签页被关了或 Herdr 重启过。执行 `sync` action 拉起来；`AUTO_START=true` 可自动拉起。
- **侧边栏空了 / `no matching agents`**：全局 `agent.view.set` 筛选把所有行藏了。执行 `sync` 校准，不需要就保持 `INSTALL_AGENT_VIEW=false`。
- **行比预期少**：日志里搜让出记录，被真实 TUI 占住的会话是故意跳过的。
- **连不上 server**：检查 `OPENCODE_SERVER_URL`，非默认端口需要装 `ss` / `lsof` 才能自动探测。
- **claude 一行都没有**：依次确认 `herdr agent list` 里有 `claude` 行、`claude agents --json` 有会话、看板进程的 `PATH` 里有 `claude`（没有就填 `CLAUDE_BIN`）。

## 已知限制

- 内联模式下，没有官方行的目录的会话不显示。
- token 单值截断 80 字符，换行和前导空格存不住（所以树状前缀要写进值里）。
- 状态准确性依赖 SSE / 事件流，断流时退化为轮询。
- 旧 pane 模式（`MIRROR_INLINE=false`）每个会话占一个终端 pane，且只支持 opencode。

## 开发

贡献指南见 [`AGENTS.md`](AGENTS.md)，简版：

```bash
herdr plugin link /绝对路径/herdr-parallel-sessions-display
# 改完代码关掉看板标签页再重开
node src/board.mjs --mode once  # 跑一轮就退，管理器没跑时用
```

没有测试套件，真机联调验证（开着 Herdr 和各 agent，看侧边栏）。`LOG_LEVEL=debug` 会打出每个会话建行 / 不建行的原因。
