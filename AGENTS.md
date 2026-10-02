# AGENTS.md

Herdr 插件：把**同一个 opencode server 内所有运行中的根 session**（以及 codex 的会话）
按工作目录挂到 Herdr Agents 侧边栏的**官方 agent 行**上，显示成 ASCII 树状会话列表。
设计背景与实测依据见 [SPEC.md](SPEC.md)，用户向说明与排障见 [README.md](README.md)。

## 这不是常规 Node 项目

- **没有 `package.json`**，无第三方依赖，无构建、无测试、无 lint、无 CI。全部是
  Node 内置模块的 `.mjs`，直接 `node src/*.mjs` 跑。
- **验证只能靠真机联调**（本机：herdr 0.9.3 + opencode v2 + codex 0.160）。没有可
  离线跑的测试套件，别去找、别假装有。
- 代码注释与文档一律**中文**，且注释写的是「为什么这样、实测踩到什么坑」，不是复述
  代码。改代码时保持这个密度——这些注释是这个项目唯一的知识载体。
- 提交用 conventional commit，**中文描述**（与仓库历史一致）。

## 入口与装配

`herdr-plugin.toml` 是唯一装配点，且 `command` 一律是 argv 数组，**不过 shell、没有变量
展开**。新增可执行入口 = 改这个文件 + 往 `src/board.mjs` 的 `--mode` 分支加一个 case。

| 文件 | 职责 |
| --- | --- |
| `src/board.mjs`（3.7k 行） | 常驻管理器。四种模式：`startup`（一次性钩子）、`pane`（常驻，唯一守护逻辑）、`action`（靠 state 目录请求文件与常驻进程通信）、`once`（自检，跑一轮就退） |
| `src/opencode.mjs` | opencode server 客户端，v1/v2 双协议适配（先探测版本再发业务请求） |
| `src/codex.mjs` | codex app-server 客户端，**手写 WebSocket over unix socket** |
| `src/herdr.mjs` | herdr 调用封装：CLI 为主，CLI 没封装的（`agent.view.set`）才走裸 socket。**任何调用都不许抛给调用方** |
| `src/state.mjs` | `.env` 解析 + `HERDR_PLUGIN_STATE_DIR` 下的映射/锁持久化 |
| `src/mirror.mjs` | 仅 `MIRROR_INLINE=false` 时用：镜像 pane 里的保活进程 |

`[[startup]]` **不是**受监管的守护进程，别往里放常驻逻辑。

## 常用命令

```bash
# 开发：link 本目录，改完重启看板标签页即生效
herdr plugin link /home/Sighthesia/0_Files/Producing/Software/herdr

# 真正的 .env 在这里（仓库里的 config/.env.example 只是模板，已 gitignore）
herdr plugin config-dir opencode.session-mirror

# 打开看板（常驻管理器跑在这个标签页里）
herdr plugin pane open --plugin opencode.session-mirror --entrypoint board

# 立刻全量重算；管理器没在跑时这个 action 会自己把它拉起来
herdr plugin action invoke opencode.session-mirror.sync

# 收工：清所有镜像行 / 镜像 pane / 兜底工作区
herdr plugin action invoke opencode.session-mirror.reap

# 跑一轮就退的自检（不抢常驻锁，可在管理器运行时调试）
node src/board.mjs --mode once
```

- **日志不在 plugin log 里**，看板面板的输出要走
  `herdr pane list --json | jq -r '.result.panes[]|select(.label=="OpenCode Sessions")|.pane_id'`
  再 `herdr pane read <id> --lines 200`。排障先看这里。
- 改完 `.env` **必须重启看板标签页**才生效。
- 调不通就把 `LOG_LEVEL=debug`，debug 会逐条打出每个 session 建/不建行的原因。

## 改配置前必读

`state.mjs` 的 `CONFIG_DEFAULTS` 是**白名单**，不在里面的键会被 `loadConfig` 静默丢弃
——「改了配置完全没反应且无提示」的历史事故就是这么来的（`MIRROR_INLINE` 等 7 个键白写
了很久）。**新增配置键必须同时改四处**：`state.mjs` 的 `CONFIG_DEFAULTS`、`board.mjs` 的
`config` 对象、`config/.env.example`、README 配置表。startup / pane 模式的启动日志会对
未知键打 warn（拼错的键也走这里），看到就别再怀疑时序。

优先级：真实环境变量 > `$HERDR_PLUGIN_CONFIG_DIR/.env` > 默认值。

## 已知的硬约束（改代码前必须知道）

- **不要碰官方集成文件**（`~/.config/opencode/plugins/herdr-agent-state.js` 等），也不要用
  `herdr integration install/uninstall`。同一 pane 的状态归属是独占的。
- **镜像 pane 里绝不运行 opencode**。历史上 `RESUME_MODE=opencode` 会让官方集成在同
  一个 pane 上**覆盖**（不是新增）我们那一行，导致整行消失且插件以为它还活着。
  恢复命令恒为常驻进程。
- **上报必须拆两次**：`pane report-agent`（状态 + `--agent-session-id`，不带 resume
  argv）→ 再 `pane report-agent-session -- <恢复命令>`。`resume_argv` 非法时 herdr
  返回 `invalid_resume_argv` 且**整条上报不生效**，会把 session id 一起丢掉。
- **只用 `layout.set_split_ratio`，绝不用 `layout.apply`**（apply 重建标签页、销毁所有
  终端进程）。
- **Herdr 侧边栏 token 限制**：单值硬截断 80 字符、换行被去掉、**前导空白被 trim**
  （含 U+00A0 / U+2000–200A / U+3000）。所以树状连接线只能写进 token 值里（靠
  `PARALLEL_TRUNK` / `PARALLEL_CONNECTOR`），N 个 session 必须 N 个 token / N 行。
- **内联模式（默认）靠 `pane.report_metadata --applies-to-source` 挂 token**，而该参数
  要求目标 source **已在那个 pane 上有记录**，否则写完即消失（tokens 变 null）。codex
  这边官方 hook 不触发，靠 `CODEX_ADOPT_SESSION` 先补报 `agent_session`。
- **多 agent 分桶**：挂载点解析必须在该 provider 自己的行集合里做。同一 workspace 里
  opencode 行和 codex 行的目录可能相同，用全局集合解析必然串味。清理循环同理。
- **挂载点优先按官方行的 `foreground_cwd` 精确匹配**，不能只按 pane 数量——实测会挂到
  不相干的工作区。
- **去重靠 `oc_session` token，不是 `agent_session`**：herdr 0.9.3 对第三方 source 一律
  省略 `agent_session`。同时要能区分自己的镜像行（`tokens.oc_mirror == "1"`）和别人的。
- **`agent.view.set` 是全局的**，会隐藏所有 agent 行（含官方的）。插件的安全底线：镜像行
  为 0 时自动降级成 `sort-only`，绝不装带 filter 的投影。
- **忙标记转轮默认关**：实测开 12% 单核 vs 关 4%。动画 ticker 只在内存换字，**绝不能**
  为动画提速主重算循环；没有忙标记时定时器要停掉。

## 排障入口

侧边栏没内容 → 先确认看板进程在跑（`ps -ef | grep 'board\.mjs --mode pane'`）。
侧边栏空了 / `no matching agents` → 立刻跑 `sync` action，它启动时会做投影校准。
session 少了 → 日志搜「让出 N 个」，`N` 等于活跃 session 数是**正确行为**（真实 TUI 已占用）。
行落到 `Sessions` 分组 → 那个目录在 herdr 里没有对应 workspace。