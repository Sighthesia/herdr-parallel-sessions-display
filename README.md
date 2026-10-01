# opencode-session-mirror

把同一个 opencode server 里**所有正在运行的根 session**，镜像成 Herdr Agents 视图里的独立行。

## 它解决什么问题

你在一个目录里开着 OpenCode，同一个 server 里跑着好几个 session。Herdr 自带的
opencode 集成只上报「**当前 pane 的 TUI 选中的那一个** session 及其子 session」。
于是同一个 server 里其它正在跑的 session —— 那些你切过去之前就一直在后台干活的
session —— 在 Agents 视图里完全看不见。你只能一个个 pane 点过去确认谁还在跑。

这个插件补上这个缺口：每个未被打开的运行中根 session 各占一行，状态准确。

### 三条产品边界

| 决定 | 结论 |
| --- | --- |
| 镜像行能做什么 | **只看不聊**。镜像 pane 里不运行 opencode，也不接受输入。要交互请切回你真实的 TUI pane。 |
| 镜像哪些 session | **只有运行中的根 session**。子 agent 由官方集成汇总进父行，不单列。 |
| 会不会重复 | **不会**。用户真实 TUI 选中的 session 会主动让给官方集成那一行。 |

## 工作原理

Herdr 的 Agents 视图里，**每一行都必须绑定一个真实 pane**。插件 v1 也不能动态注册
action 或造原生 UI。所以方案是：

```
opencode server
   │  /api/session/active  谁在跑
   │  /api/event (SSE)     权限等待 / 状态变化
   │  /api/permission/request  待回复授权（轮询兜底）
   ▼
board.mjs（常驻管理器，以插件面板形式存在）
   │  为每个 session 分一个镜像 pane（只跑一个空转的 node 进程）
   │  用自己的 source 替这些 pane 上报状态和元数据
   ▼
Herdr Agents 视图
```

四个关键设计：

- **状态直接来自 opencode server 的运行态**，不是读屏幕识别。所以比官方集成更准，
  而且权限等待这种最有价值的信号能拿到。
- **管理器是面板而不是后台进程**。`[[startup]]` 只是一次性初始化钩子，不是受监管的
  守护进程，所以常驻逻辑放在 `[[panes]]` 里。
- **镜像 pane 里什么都不跑**，只保持前台进程存活（`setInterval` 保活）。这样官方集成
  不会在同一个 pane 上二次上报，重复行从源头就不可能发生。
- **去重靠 `agent_session`**。每轮重算前读 Herdr 的 agent 列表，把已经被别的来源
  （主要是官方集成）上报过的 session id 收集起来，从候选集里剔除。

状态映射：

| opencode | Herdr | 说明 |
| --- | --- | --- |
| 有未回复的权限请求 | `blocked` | 来自 SSE 的 `permission.asked` / `permission.replied` |
| `retry`（v1）/ 末尾消息有 retry（v2） | `blocked` | 通常是报错要处理，错误信息写进 `--message` |
| `busy` / `running` | `working` | 正在执行 |
| 以上都不满足 | `idle` | 过了宽限期就回收该行 |

优先级：权限等待 > retry > busy。

## 安装

```bash
# 1. 从本目录 link（开发）或从 GitHub install
herdr plugin link /path/to/opencode-session-mirror

# 2. 找到配置目录，把 config/.env.example 复制成 .env
herdr plugin config-dir opencode.session-mirror

# 3. 打开看板（这会在 Herdr 里开一个标签页，进程在里面常驻）
herdr plugin pane open --plugin opencode.session-mirror --entrypoint board
```

绑定快捷键的话，在 `~/.config/herdr/config.toml` 里加：

```toml
[[keys.command]]
key = "prefix+shift+o"
type = "plugin_action"
command = "opencode.session-mirror.board"
```

插件自带三个 action：

| action | 作用 |
| --- | --- |
| `opencode.session-mirror.board` | 打开看板（常驻管理器） |
| `opencode.session-mirror.sync` | 立刻触发一次全量重算 |
| `opencode.session-mirror.reap` | 回收所有镜像行和镜像 pane |

## 配置

写在 `herdr plugin config-dir opencode.session-mirror` 指出的目录下的 `.env`。
完整的带注释版本见 [`config/.env.example`](config/.env.example)。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | 空 | 显式指定地址，如 `http://127.0.0.1:4096`。留空则自动探测 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 空 | Basic Auth 密码 |
| `MIRROR_LABEL` | `Sessions` | 镜像所在工作区/标签名 |
| `AUTO_START` | `false` | Herdr 恢复后自动拉起管理器 |
| `INSTALL_AGENT_VIEW` | `false` | 是否安装全局 Agents 视图投影 |
| `POLL_INTERVAL_MS` | `5000` | 轮询兜底间隔 |
| `IDLE_GRACE_MS` | `15000` | 转为非活跃后保留行的宽限时间 |
| `AGENT_VIEW_SCOPE` | `mirror` | 投影范围：`mirror` 只显示镜像行 / `sort-only` 只排序 |
| `RESUME_MODE` | `opencode` | Herdr 重启后的恢复命令，见下 |
| `MIRROR_PANE_RATIO` | `0.25` | 镜像 pane 切分比例 |
| `MIRROR_PANE_DIRECTION` | `down` | 排列方向 `down` / `right` |
| `SESSION_LIST_LIMIT` | `200` | 每页拉多少条会话 |
| `SESSION_PAGE_LIMIT` | `8` | 最多翻几页找活跃 session |
| `RETRY_DETECTION` | `true` | 是否探测「正在重试」状态（v2 下每 session 多一次请求） |
| `RETRY_CHECK_LIMIT` | `8` | 每轮最多探测多少个 session |
| `AUTO_AUTH_SERVICE_JSON` | `true` | 允许自动读 `~/.config/opencode/service.json` 的密码 |
| `DISCOVERY_BACKOFF_MAX_MS` | `60000` | 服务端不可达时的退避上限 |
| `LOG_LEVEL` | `info` | `debug` 适合排查问题 |

改完 `.env` 需要重启看板面板（关掉标签页再打开）才生效。

### 关于 `RESUME_MODE`

`opencode`（默认）恢复命令是 `opencode --session <id>`。注意副作用：**Herdr 重启后
这个镜像 pane 会真的跑起 opencode**。此时官方集成会在同一个 pane 上报，那个 session
变成「已有人上报」，我们下一轮去重就主动让出这一行 —— 所以不会出现重复行，反而变成
了那一行可以直接交互的真实 session。

如果你要严格保证「镜像 pane 内永不运行 opencode」，设成 `mirror`，恢复命令就只是
重启空转的驻留进程。

### 关于 `INSTALL_AGENT_VIEW`

`agent.view.set` 是**全局**设置，会影响整个 Agents 侧边栏的所有 agent，不只是镜像行。
所以默认关闭。打开后：

- `AGENT_VIEW_SCOPE=mirror`：只显示镜像行（按上报的 `oc_mirror` token 过滤）
- `AGENT_VIEW_SCOPE=sort-only`：不过滤，只按「需要关注优先 + 最近状态变更」排序

而且它没有 CLI 封装，插件是自己写的一层裸 socket 客户端（newline-delimited JSON）。

## 兼容的 opencode 版本

插件同时适配 opencode v1 和 v2 的 HTTP 面，靠 `/api/info` 或 `/global/health` 自动判定：

| | v1 | v2（本机实测 2.0.21） |
| --- | --- | --- |
| 健康检查 | `GET /global/health` | `GET /api/info`（v2 没有 health 路由） |
| 活跃状态 | `GET /session/status` | `GET /api/session/active` |
| 根会话 | `GET /session?roots=true` | `GET /api/session?parentID=null` |
| 会话目录字段 | `directory` | `location.directory` |
| 权限等待 | 只能靠 SSE | SSE + `GET /api/permission/request` 轮询兜底 |
| SSE 事件名 | `event:` 字段 | `data:` 里 JSON 的 `type` 字段 |

v2 的两个坑插件都处理了：SSE 会发 `: heartbeat` 注释行、事件名不在 `event:` 里；
权限请求要靠 `x-opencode-directory` 头按目录分，所以是并发逐目录查再合并。

`opencode serve --discoverable` 还没发布，所以 server 发现走：显式 URL → 默认端口 4096 →
`ss -ltnp` / `lsof` 扫进程名含 opencode 的监听端口逐个验证。

## 故障排查

**先看插件日志：**

```bash
herdr plugin log list --plugin opencode.session-mirror
```

调不出细节就把 `LOG_LEVEL=debug` 写进 `.env` 再重启看板。debug 级别会打出每个
session 为什么建行 / 不建行（是让给真实 TUI 了，还是它是子 agent）。

**Agents 视图里一行都没有：**

1. 看板面板是不是真的在跑？`herdr plugin pane open --plugin opencode.session-mirror --entrypoint board`
2. opencode server 能不能访问？日志里搜「已连接 opencode」。没有这行说明没连上。
   手动试一下：

   ```bash
   curl -s http://127.0.0.1:4096/api/info
   curl -s -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/api/info
   ```

3. server 是不是在非默认端口？直接写 `OPENCODE_SERVER_URL` 最省事。
4. 日志里全是「让出 N 个」而 N 等于活跃 session 数？那说明所有 session 都被
   真实 TUI 占着了 —— 这本身就是正确行为，不是 bug。

**镜像行状态一直不更新：**

看日志里的 `SSE up/down`。SSE 断了会自动重连并在日志里 warn；重连期间退化成
`POLL_INTERVAL_MS` 轮询，权限等待的判定精度会下降但不会完全瞎。行会一直存在，
只是 `blocked` 可能晚几秒才亮。

**`Sessions` 工作区不见了 / 镜像 pane 残留：**

```bash
herdr plugin pane open --plugin opencode.session-mirror --entrypoint board
herdr plugin action invoke opencode.session-mirror.reap
```

`reap` 会先 release 再关掉所有镜像 pane，映射也会清干净。工作区本身留着无害，
下次需要时会自动复用。

**Herdr 重启后行没了：**

正常情况下 startup 钩子会从 `HERDR_PLUGIN_STATE_DIR` 恢复映射。检查两件事：
`AUTO_START` 是否为 `true`（管理器得有人跑），以及 `resume_agents_on_restore`
是否被关掉（那会让 Herdr 忽略所有恢复命令）。映射文件在插件 state 目录下的
`state.json`，可以直接看。

**行出现了但标题是 session id：**

说明那个 session 没出现在会话列表里（列表翻页没覆盖到，或者刚创建）。
插件会退化成用 id 当标题，下轮拿到真实标题就会自动改。

## 已知边界

- **一个运行中 session 一行 = 一个镜像 pane**，有终端资源成本。集中在 `Sessions`
  工作区里，不打开不占视野，但不是零成本。
- **镜像行只读**。要交互得切回真实 TUI 手动换 session。
- **状态准确性依赖 SSE**。断流时退化为轮询，`blocked` 精度下降。
- **不碰官方集成文件**（`~/.config/opencode/plugins/herdr-agent-state.js` 等），
  也不用 `herdr integration install/uninstall`。避免和官方集成抢同一个 pane 的状态归属。
- v2 下 `retry` 探测每个活跃 session 多一次 HTTP 请求，行多时可以在 `.env` 里
  关掉 `RETRY_DETECTION`。
