# opencode-session-mirror

把 **opencode** 和 **codex** 里正在运行的会话，按工作区分组显示在 Herdr Agents 视图里。

默认走**内联模式**：不创建任何 pane、不创建任何标签页，session 列表以 token 的形式挂在
该目录的官方 agent 行下面，画成 ASCII 树状图。

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

五个关键设计：

- **状态直接来自 opencode server 的运行态**，不是读屏幕识别。所以比官方集成更准，
  而且权限等待这种最有价值的信号能拿到。
- **镜像行落在它自己目录对应的工作区里**。Agents 侧边栏的分组 token 只有 `workspace`，
  没有「按目录分组」这个选项，所以镜像 pane 必须落在用户为这个目录开的工作区里，
  那一行才会归到对应的 `[n] <项目名>` 分组下。见下面「行出现在哪」。
- **每个目录在自己的工作区里独占一个标签页**放镜像（固定名 `oc-sessions`）。
  这样绝不往你正在用的工作标签页里插 pane，多 pane 布局不会被挤压、不会抖。
- **管理器是面板而不是后台进程**。`[[startup]]` 只是一次性初始化钩子，不是受监管的
  守护进程，所以常驻逻辑放在 `[[panes]]` 里。
- **镜像 pane 里什么都不跑**，只保持前台进程存活（`setInterval` 保活）。这样官方集成
  不会在同一个 pane 上二次上报，重复行从源头就不可能发生。
- **去重靠 session 身份**。每轮重算前读 Herdr 的 agent 列表，把已经被别的来源
  （主要是官方集成）上报过的 session id 收集起来，从候选集里剔除。

### 行出现在哪

侧边栏长这样：

```
[1] afloat
  ├ opencode  Tray hover二级菜单点击收起无退场效果…   ← 官方行（TUI 当前选中的）
  └ opencode  旧分支全屏辉光效果迁移至通知卡片和bar   ← 镜像行（同目录另一个在跑的）
[2] ReimuMoePCB_DAPLink
  └ opencode  使用 DAPLink 识别 H750                ← 官方行
```

具体做法：从 session 的 `directory` 反查 herdr 的 pane（`cwd` / `foreground_cwd` 严格相等，
再不行就看这个目录是不是在某个 pane 的目录之下），找到对应的 `workspace_id`，
然后在那个工作区里开一个专属标签页 `oc-sessions` 放这个目录的镜像。
**绝不靠目录名猜** —— 同一个项目名可以出现在任意路径下，猜错就把镜像行归到别人的分组里了。

一个工作区都匹配不上时（例如 session 在 `/tmp/...` 下而你没开过这个目录），
才退回 central `Sessions` 工作区，日志里会写明「该目录没有对应的工作区，已归入 Sessions 兜底工作区」。

### 镜像 pane 怎么排布

新 pane 切出来之后，插件会立刻**重平衡这个标签页里的整棵镜像子树**：对每个 split 节点
把比例设成「first 子树的叶子数 ÷ 子树总叶子数」，于是所有镜像 pane 精确均分空间。

用 `layout.set_split_ratio`（只改比例），**不用** `layout.apply` —— apply 会重建标签页、
销毁所有活着的终端进程，把已有镜像 pane 全杀掉重启。

镜像行再多也照建。窗口不够高时行会变矮、需要滚动，但插件不会因为「放不下」就拒绝建行。

### 用完怎么收

- 某个目录下的 session 全停了 → 那个 `oc-sessions` 标签页**整页自动关掉**。
- 没有目录再用兜底了 → `Sessions` 兜底工作区也关掉（Herdr 本身也会回收空工作区）。
- 想立刻全清：`reap` action。

### 上报为什么拆成两步

`resume_argv` 非法时 herdr 的失败码是 `invalid_resume_argv`，而且官方文档写明
「the report is not applied」—— 也就是说带一个坏恢复命令，会把 `agent_session_id`
一起丢掉，session id 白报。所以：

1. `pane report-agent --state ... --agent-session-id <id>` —— 不带恢复命令，先把状态和
   session 身份落库
2. `pane report-agent-session --agent-session-id <id> -- <恢复命令>` —— 再单独挂恢复命令

第 2 步失败只影响「Herdr 重启后怎么恢复」，这一行本身不受影响。两步都写日志。

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
| `MIRROR_LABEL` | `Sessions` | **兜底**工作区名，仅当某目录匹配不上任何工作区时才会建 |
| `MIRROR_TAB_LABEL` | `oc-sessions` | 每个目录在自己工作区里那个镜像标签页的名字 |
| `AUTO_START` | `false` | Herdr 恢复后自动拉起管理器 |
| `INSTALL_AGENT_VIEW` | `false` | 是否安装全局 Agents 视图投影 |
| `POLL_INTERVAL_MS` | `5000` | 轮询兜底间隔 |
| `IDLE_GRACE_MS` | `15000` | 转为非活跃后保留行的宽限时间 |
| `AGENT_VIEW_SCOPE` | `mirror` | 投影范围：`mirror` 只显示镜像行 / `sort-only` 只排序 |
| `RESUME_MODE` | — | **已废弃**，写了会被忽略并在启动日志里提示。恢复命令恒为常驻进程，见下 |
| `MIRROR_PANE_RATIO` | `0.5` | 初始切分比例，建完立刻被重平衡覆盖 |
| `MIRROR_PANE_DIRECTION` | `down` | 排列方向 `down` / `right` |
| `MIRROR_INLINE` | `true` | **内联模式**：完全不建镜像 pane / `oc-sessions` 标签页，见下。`false` = 回到「每个 session 一个镜像行」的旧模型 |
| `PARALLEL_TOKEN_MAX` | `78` | `oc_par` token 的值上限。Herdr 侧对单个 token 值硬截断在 80 字符 |
| `PARALLEL_CONNECTOR` | `bar` | 会话行的连接符：`bar`（`│▸ ● 标题`，竖线通到底、整列对齐）/ `tree`（`├─ ▸ 标题`）/ `none`（`▸ 标题`） |
| `PARALLEL_BUSY_FRAME_MS` | `150` | 转轮每帧多少毫秒。10 帧 × 150ms ≈ 1.5s 一轮 |
| `PARALLEL_BUSY_ANIMATE` | `true` | 关掉就退回静态单帧（取序列第一个字符） |
| `PARALLEL_BUSY_FRAMES` | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 「正在跑」标记的**帧序列**（Herdr 自己的点阵转轮）。给单个字符如 `●` 即为静态 |
| `PARALLEL_TRUNK` | 空 | session 行树状前缀里的父级竖线（`│`）。默认空 —— 想加回来设成 `│` 之类的非空白字符（空格存不住，Herdr 会 trim） |
| `INLINE_ALWAYS_LIST` | `true` | 该 agent 的工作区里没有并行 session 时，**官方 session 自己那一行**还要不要写。模板里已经没有 `terminal_title_stripped` 了，关掉就等于官方标题消失 |
| `REBALANCE_INTERVAL_MS` | `30000` | 常规重平衡巡检间隔。建行/回收时是即时的，这里只负责把别人（sidebar 插件、用户手动拖动）改乱的布局纠回来 |
| `FOCUS_REDIRECT` | `true` | 焦点落到镜像行时，自动转到同目录真正的前台 agent，见下 |
| `FOCUS_REDIRECT_COOLDOWN_MS` | `2500` | 同一个镜像行的重定向冷却，防抖 |
| `SESSION_LIST_LIMIT` | `200` | 每页拉多少条会话 |
| `SESSION_PAGE_LIMIT` | `8` | 最多翻几页找活跃 session |
| `RETRY_DETECTION` | `true` | 是否探测「正在重试」状态（v2 下每 session 多一次请求） |
| `RETRY_CHECK_LIMIT` | `8` | 每轮最多探测多少个 session |
| `AUTO_AUTH_SERVICE_JSON` | `true` | 允许自动读 `~/.config/opencode/service.json` 的密码 |
| `DISCOVERY_BACKOFF_MAX_MS` | `60000` | 服务端不可达时的退避上限 |
| `LOG_LEVEL` | `info` | `debug` 适合排查问题 |
| `CODEX_ENABLED` | `true` | 是否采集 codex 的 session。关掉就完全不连 codex 的 app-server |
| `CODEX_SOCKET` | 空 | codex app-server 控制 socket 路径。留空用默认 `~/.codex/app-server-control/app-server-control.sock` |
| `CODEX_CLIENT_NAME` | `herdr-session-mirror` | `initialize` 握手里上报的客户端名 |
| `CODEX_SOURCE_KINDS` | 空 | 留空 = 内置 `cli,exec,appServer,vscode`（排除法滤掉子 agent）。**不要只填 `cli`**，实测会把 vscode 源的会话全滤掉且不报错 |
| `CODEX_SESSION_LIMIT` | `100` | 每页拉多少条 thread |
| `CODEX_TIMEOUT_MS` | `8000` | 单次 app-server 请求超时 |
| `CODEX_ADOPT_SESSION` | `true` | 官方行没有 `agent_session` 时，由插件以 `herdr:codex` 的身份补报一次（读的是 codex 自己的 app-server，写的是真实 thread id）。**不补的话 codex 在 TUI 刚启动、还没跑过一轮对话时完全不可见**，见下 |

改完 `.env` 需要重启看板面板（关掉标签页再打开）才生效。

### 关于恢复命令（`RESUME_MODE` 已废弃）

恢复命令**恒为常驻进程**（`node mirror.mjs`），镜像 pane 内绝不运行 opencode。

曾经有个 `RESUME_MODE=opencode` 选项，恢复命令是 `opencode --session <id>`，理由是
「重启后镜像行还能接着聊」。**实测证明它会摧毁整个插件，已删除**：Herdr 重启时它在
镜像 pane 里拉起 opencode TUI，官方集成随即在**同一个 pane** 上报官方 agent 行，把
`oc_mirror` / `oc_session` 标记直接覆盖掉 —— 不是多出一行重复行，而是**这一行整个
消失**。同时状态文件里 `paneId` 还在，插件以为它活着，既不重建也不让出，该目录的镜像
功能静默失效。

> 旧文档里写「下一轮去重会看到该 session 已被占用，主动让出这一行，所以不会出现重复
> 行」—— 这个推理假设官方集成会**新增**一行，实测是**覆盖**同一行。

想在某个镜像位置直接和 session 对话，手动敲 `opencode --session <id>` 即可：那一行会
变成官方行，插件检测到标记丢失后主动让出，不会打架。

### 内联模式（默认）：不建任何 pane

`MIRROR_INLINE=true` 时插件**不创建任何镜像 pane，也不创建 `oc-sessions` 标签页**。
它用 `pane.report_metadata` 的 `--applies-to-source` 把 session 列表作为
`$oc_sess*` token 挂到该目录**官方 agent 行**上，而**不接管那一行**：

- 实测 `agent` 字段和 `agent_session.source` 都不受影响
- 官方集成随后重报（`working` → `idle`）token 照样存活
- 侧边栏里因此**只有官方行**，点击天然就跳到真正的前台 agent

`~/.config/herdr/config.toml` 的侧边栏模板：

```toml
[ui.sidebar.agents]
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

效果是 ASCII 树状图，**官方 session 也在里面**（用 `▸` 点出）：

```
[1] afloat
◐ opencode
│▸ ● 排查 Shell 重载启动初始化卡顿      ← 官方 TUI 当前选中的
│  ● 排查Shell启动时壁纸揭露过渡卡顿      ← 切走但还在跑的
│  ○ Tray hover二级菜单点击收起无退场效果…
```

连接符可换（`PARALLEL_CONNECTOR`）：

| 值 | 效果 |
| --- | --- |
| `bar`（默认） | `│▸ ● 标题` —— 竖线通到底，标记和标题整列对齐 |
| `tree` | `├─ ▸ 标题` / `└─ 标题` —— 经典树状连接符 |
| `none` | `▸ 标题` —— 完全不加前缀 |

`bar` 模式下官方行占 `▸ ` 两格、其余行用两个空格补位，所以所有行对齐。补出来的
是**中间**的空格，不受 Herdr trim 前导空白的影响。

### 「正在跑」的标记：盲文点阵转轮

「运行中」那个标记会**转起来**，用的是 Herdr 自己的点阵转轮帧序列
`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`（从 0.9.3 二进制里扫出来的 `braille_spinner_working`）。同一行的
`state_icon` 此刻正在用这套字符转圈，我们的 session 标记用的是同一种视觉语言。

**为什么是盲文**：opencode v2 的运行指示器
（[`session-progress-indicator-v2.tsx`](https://github.com/anomalyco/opencode/blob/1ddb0873aee50d209d1a8d7f91b89c5daf692d49/packages/session-ui/src/v2/components/session-progress-indicator-v2.tsx)）
是**点阵**风格 —— 5×5 共 25 个点，靠改 opacity 播一道对角波纹。侧边栏复现不了原样：
token 是静态文本、换行会被去掉、值硬截断 80 字符、Herdr 不会替我们播动画，那个二维点阵
画不进一行。而盲文每个字符本身就是 2×4 的点阵，所以「一格点阵」是能做到的最接近形态。

**动画是自己播的**：Herdr 只会为它自己的 `state_icon` 播动画，自定义 token 拿不到，所以
插件得周期性地把下一帧写回去。为此单开了一个 ticker 而**没有**把主重算循环跑快 ——
主循环一轮要做的事很重（拉活跃集合、扫会话、扫 pane、查权限），为了一次 150ms 的动画去
跑它会把 Herdr 和 opencode 拖垮。ticker 只在内存里换字：主循环渲染完把带忙标记的行缓存
下来（标记换成占位符），ticker 只负责把占位符换成下一帧写回去，不做任何查询。**没有忙
标记时定时器直接停掉，空闲期零开销。**

**开销**：转轮期间约 12% 单核（关掉是 5%）。瓶颈不在进程 spawn，而在 Herdr 每次 token
变化都要重绘侧边栏 —— 4 个忙行 × 6.7 次/秒 ≈ 27 次/秒。所以帧率是可调的：
`PARALLEL_BUSY_FRAME_MS` 调大到 300 就是 3s 一轮、开销减半。想彻底关掉动画：
`PARALLEL_BUSY_ANIMATE=false`。想换回实心圆：`PARALLEL_BUSY_FRAMES=●`（单字符即静态）。

官方那一行也由插件生成，是因为内置 `terminal_title_stripped` 拿不到树形连接线
（内置 token 内容不可改，`rules` 只能改样式），两种格式混在一起会因为缩进不一致而
读不出层级 —— 插件行反而比它 supposed 的父节点更靠左。

**为什么缩进用 `├─` 而不是空格**：Herdr 会 **trim 自定义 token 的前导空白**
（实测传 `"  └─ x"` 存下来是 `"└─ x"`），Unicode 空白字符（U+00A0、U+2000–200A、
U+3000）同样会被 trim。所以连接线只能自己写进 token 值里。想去掉 `├─` 换成别的写法，
改插件的 `PARALLEL_TRUNK`。

**挂载点怎么选**：优先用官方 agent 行的 `foreground_cwd` 精确匹配——那个 pane 里跑着
opencode TUI，前台进程的 cwd 就是它那个 session 的目录，实测每一行都对得上。匹配不
上才退到「该目录 pane 最多且有官方行」。**不能只用 pane 数量**：实测
`Software/herdr` 在 `w19` 里有 7 个 pane 的 cwd 指向它（用户在那儿跑了一堆
herdr-sidebar 实例）、在 `w1J` 里只有 4 个，光按数量会挂到不相干的工作区。

**四个硬限制**（实测，不是保守估计）：

- 单个 token 值**硬截断在 80 字符**。插件自己先算好，放不下就用 `+N` 收尾。
- 值里的**换行会被去掉**，所以一个 token 只能渲染一行 → N 个 session 必须 N 个
  token、N 个 row。
- **前导空白被 trim**，所以空格缩进存不住。
- **空槽位不渲染成空白行**，所以槽位可以放心加。现在 6 个（上限是 `rows` 共 16 行）。

**已知的功能损失**：session 在用户没开 TUI 的目录下（典型是 `/tmp` 下的临时工程）时，
那个工作区里没有可挂载的官方行，这条信息就**不显示**（日志里会说明是哪个 session、
哪个目录）。想让这类 session 也可见，把 `MIRROR_INLINE` 设成 `false` 回到建 pane 模式。

### codex 支持

除了 opencode，插件也会读 **codex 正在跑的会话**，用同样方式挂到 codex 的官方 agent 行上。
侧边栏里每个 agent 各显示自己那份列表，不会串。

**怎么读到的**：走 codex 的 **app-server**（JSON-RPC over WebSocket），不是读 sqlite。
实测 `~/.codex/state_5.sqlite` 的 `threads` 表直接读是 **0 行**（数据在 `-wal` 里），
而 app-server 直接返回真实数据。

用的是**共享 app-server 守护进程**（`~/.codex/app-server-control/app-server-control.sock`），
因为只有连它才拿得到**实时状态**（`active` / `idle` / `notLoaded` / `systemError`）——
自起一个实例虽然也能列出会话，但状态全是 `notLoaded`，分不出「正在跑」和「历史遗留」。
守护进程本来就常驻，我们只是多一个客户端连接，不增加常驻成本。

**前置条件**：需要先装 herdr 的 codex 集成，它靠 hook 向 herdr 上报 agent 行：

```bash
herdr integration install codex
herdr integration status        # 确认 codex: current
```

**没装的话 codex 的会话一行都不显示**——内联模式只往官方行上挂 token，没有官方行就
无处可挂。插件采集到会话但找不到对应官方行时会打一条 info 日志说明这件事（只说一次）。
注意这个命令会往 `~/.codex/hooks.json` 注入 hook，如果那文件里已有别的 hook（比如
`dcg`），确认合并没有覆盖。

装完之后，开一个 codex 会话就能在侧边栏看到：

```
[1] afloat
◐ codex
├─ ▸ ● 你正在做的那个任务
└─ ● 另一个还在跑的会话
```

**调优**：`CODEX_SOURCE_KINDS` 留空就是对的（内置 `cli,exec,appServer,vscode`，用排除法
滤掉子 agent）。**不要只填 `cli`** —— 实测会把 vscode 源的会话全部滤掉，而且不报错，
表现是列表凭空消失。子 agent 不单列。

### 为什么需要 `CODEX_ADOPT_SESSION`

内联模式靠 `pane.report_metadata --applies-to-source` 往官方行上挂 token，而这个参数
要求**目标 source 已经在那个 pane 上有记录**。没有记录时写完立刻消失（实测 `tokens`
变 null）。

codex 这边会真的缺：**Codex 0.160 的 `SessionStart` hook 在 TUI 启动时不触发**
（二进制里是 `run_pending_session_start_hook`，挂起到会话真正开始干活才跑）。实测两种
方式都确认过——直接观察 hook 是否被调用、以及用 `bypass_hook_trust` 排除「信任失效」
这个干扰因素后重测，结论一致。

于是官方行一直空着 `agent_session`，codex 会话一条都显示不出来。所以插件会自己补报一次：
从 **codex 自己的 app-server** 读出该目录的真实 thread id，以 `herdr:codex` 的身份写进
`agent_session`。写的是真值，官方 hook 将来真跑起来时写的是同一个值。

补报之后，`agent_session.value` 就是 codex 的 thread id，和 app-server 返回的 `id` 完全
对上——于是「用会话自己的标题而不是终端标题」这条精确匹配路径也顺带生效了。

**挑哪个会话当「官方那个」**：用官方行的 `foreground_cwd` 精确匹配会话的 `cwd`。同目录
有多个时，已补报过的那个仍然有效就继续用它，否则优先正在跑的，再否则取最近动过的。

**关掉它**（`CODEX_ADOPT_SESSION=false`）就回到纯被动：只显示官方集成已经报上来的，绝不
代替它写。代价是 codex 在跑完第一轮对话之前完全不可见。

> 顺带说明：`--applies-to-source herdr:codex` 猜一个 source 去挂是**挂不上**的，
> token 写完再查就是 null。所以「补报」和「挂载」必须都做，缺一不可。

### 关于 `FOCUS_REDIRECT`（只在 `MIRROR_INLINE=false` 时生效）

> `MIRROR_INLINE=true`（默认）下**这段不适用**：侧边栏里只有官方行，点它本来就跳官方
> pane，订阅不会被建立。内联模式就是下面那条「让跳转落到有用的地方」的最终形态 ——
> 连镜像行都不需要了。

Herdr 的侧边栏**没有「某行不可点击」的开关**。`agent.view.set` 只有 filter / sort /
label；`AgentInfo` 里唯一相关的 `interactive_ready` 在 0.9.3 根本不返回；config 里
没有相关项；插件 v1 明确排除非终端 UI。所以在旧的「建 pane」模型下，镜像行只能保持
可点击。

`FOCUS_REDIRECT=true`（默认）时的行为是：**焦点一旦落到镜像 pane，就立刻转到该目录
真正的前台 agent**——也就是 Herdr 自己侦测到、且不是我们上报的那一行。落点规则：

1. 先排除 `oc-sessions` 标签页里的候选。官方 opencode 有可能就开在这个标签页里
   （镜像 pane 被官方集成接管后的遗留），跳过去等于没离开镜像标签页。
2. 在用户自己的标签页里，优先当前聚焦的，其次 `working` → `blocked` → `idle` → `done`。
3. 该工作区一个官方 agent 都没有时（例如 `Sessions` 兜底工作区）**不跳转**，保留原来
   的只读卡片——弹到一个不对的 pane 比不弹更糟。

**副作用要知道**：焦点落在镜像 pane 上不只由点侧边栏行产生。按 `prefix+alt+N` 切工作区
时 Herdr 会恢复该工作区上次聚焦的 pane，如果那正好是镜像 pane，同样会被弹走。多数
情况下这是合心意的（你去这个工作区就是为了干活），但如果你就是想去 `oc-sessions` 标签页
看看，会被弹回来，需要再点一次官方行。设 `FOCUS_REDIRECT=false` 可完全关掉。



`agent.view.set` 是**全局**设置，会影响整个 Agents 侧边栏的所有 agent，不只是镜像行。
所以默认关闭。打开后：

- `AGENT_VIEW_SCOPE=mirror`：只显示镜像行（按上报的 `oc_mirror` token 过滤）
- `AGENT_VIEW_SCOPE=sort-only`：不过滤，只按「需要关注优先 + 最近状态变更」排序

而且它没有 CLI 封装，插件是自己写的一层裸 socket 客户端（newline-delimited JSON）。

**一条安全底线：插件绝不会在「一条镜像行都没有」的时候安装带筛选的投影。**
筛选是全局的，那种情况下会把官方集成的行全部隐藏掉，侧边栏直接变成
`no matching agents`。所以镜像行为 0 时会自动降级成 `sort-only`，镜像行回来再自动升回去。

而且这段校准逻辑在**每一种运行模式**（startup / pane / action / once）里都会跑一次，
所以你把 `INSTALL_AGENT_VIEW` 关掉之后随便执行一个 action，投影就会被清掉 ——
不会出现「配置早就关了，筛选还赖在运行中的 Herdr 里」的情况。

### 让侧边栏行显示可读标题

镜像行上报了这些 token，可以在你的侧边栏行模板里直接用：

| token | 内容 | 例 |
| --- | --- | --- |
| `$oc_title` | session 标题 | `Tray hover二级菜单点击收起无退场效果` |
| `$oc_project` | 项目名（会话目录的 basename） | `afloat` |
| `$oc_state` | 状态 | `working` |
| `$oc_session` | opencode session id | `ses_f37dc43f...` |
| `$oc_mirror` | 镜像行标记，恒为 `1` | `1` |

同时插件也会 `pane rename` 镜像 pane（`● afloat · Tray hover…`，40 字内），这个 label
和终端标题是分开的两份数据。

> 注意：如果你装了 `herdr-sidebar` 这类插件，它的 `hs_title` token 优先级更高，会盖掉
> 终端标题。要让镜像行按 `$oc_title` 显示，在**你自己的** sidebar 行模板里加
> `$oc_title` 即可 —— 插件不会去改你其它插件的配置。

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
# 看板面板的输出不进 plugin log，要走 pane read —— 先找到看板那个 pane：
herdr pane list --json | jq -r '.result.panes[] | select(.label=="OpenCode Sessions") | .pane_id'
herdr pane read <看板pane_id> --lines 200
```

调不出细节就把 `LOG_LEVEL=debug` 写进 `.env` 再重启看板。debug 级别会打出每个
session 为什么建行 / 不建行（是让给真实 TUI 了，还是它是子 agent）。
`.env` 里写了插件不认识的键时，启动日志会明确列出来（拼错的键同样会）——
**看到这个 warn 就别再怀疑时序了，那个键根本没被读**。

**侧边栏上的会话列表不更新了（关了看板标签页 / Herdr 重启之后最常见）：**

管理器就是那个看板标签页里的常驻进程。**它不在跑的时候插件什么都不做**，
侧边栏上留下的是最后一次成功重算时的内容，看起来完全正常 —— 这就是最难认的
一种「坏了」。确认与恢复：

```bash
# 1) 看板在不在（看板标签页里那个 node 进程）
ps -ef | grep 'board\.mjs --mode pane' | grep -v grep

# 2) 不在就拉起来。sync 动作会自己检查并重启它
herdr plugin action invoke opencode.session-mirror.sync
```

想让 Herdr 重启后自动拉起，把 `.env` 里的 `AUTO_START` 设成 `true`。

**Agents 视图里一行都没有：**

1. 看板面板是不是真的在跑？`herdr plugin pane open --plugin opencode.session-mirror --entrypoint board`
2. opencode server 能不能访问？日志里搜「已连接 opencode」。没有这行说明没连上。
   手动试一下：

   ```bash
   curl -s http://127.0.0.1:4096/api/info
   curl -s -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/api/info
   ```

3. server 是不是在非默认端口？直接写 `OPENCODE_SERVER_URL` 最省事。
4. 日志里全是「让出 N 个」而 N 等于活跃 session 数？见下面「镜像行比预期少」。

**侧边栏突然空了 / 显示 `no matching agents`（最优先处理）：**

这是插件的全局筛选投影把**官方的行也一起藏了**。先自救，再排查。

```bash
# 1) 先把投影清掉。只清「确实是本插件装的」那一份，不会动别人的视图。
herdr plugin action invoke opencode.session-mirror.sync
```

> 上面这条 action 一启动就会做投影校准：`INSTALL_AGENT_VIEW=false` 而插件以为自己装过时，
> 会立刻 `agent.view.clear` 并把记录置空。侧边栏应该立刻恢复正常。
> 任何一种运行模式（startup / 看板面板 / action / once）都会做同一件事，
> 所以「重新打开看板面板」同样有效。

然后再排查为什么筛选会在没有镜像行的时候装上：

```bash
# 2) 看板面板里搜这两行日志
#    「重平衡镜像布局」      —— 说明镜像 pane 确实在
#    「镜像行 N」            —— N=0 且投影仍带 filter 就是异常
herdr plugin pane open --plugin opencode.session-mirror --entrypoint board
herdr pane read <看板pane_id> --lines 200
```

3. `.env` 里把 `INSTALL_AGENT_VIEW=false` 确认一遍，重启看板。
4. 如果你**确实想要** `mirror` 范围：先让 opencode 那边至少有一个 session 在跑，
   镜像行出现后插件会自动把投影升回带筛选的版本。

**镜像行比预期少：**

日志里搜「让出 N 个」。`N` 等于活跃 session 数时说明所有 session 都被用户真实 TUI
占着了 —— 这是正确行为，不是 bug。

**某一行还是没有名字（显示成 `'/usr/bin/node' …`）：**

侧边栏那一行的默认文本来自终端标题（OSC），镜像 pane 里跑的是 node 进程。
插件已经用 `pane rename` 给 pane 起了可读名字，也上报了 `$oc_title` / `$oc_project`
token。如果你装了 `herdr-sidebar`，它的 `hs_title` 优先级更高 —— 在你自己的 sidebar
行模板里加 `$oc_title` 就行（见上面「让侧边栏行显示可读标题」）。

**镜像行状态一直不更新：**

看日志里的 `SSE up/down`。SSE 断了会自动重连并在日志里 warn；重连期间退化成
`POLL_INTERVAL_MS` 轮询，权限等待的判定精度会下降但不会完全瞎。行会一直存在，
只是 `blocked` 可能晚几秒才亮。

**`Sessions` 兜底工作区不见了 / 镜像标签页残留：**

```bash
herdr plugin pane open --plugin opencode.session-mirror --entrypoint board
herdr plugin action invoke opencode.session-mirror.reap
```

`reap` 会先 release 再关掉所有镜像 pane，把每个目录的镜像标签页整页关掉，
兜底工作区也关掉，映射清干净。session 还在跑的话，下一轮会重新建回来。

**行出现在了 `Sessions` 分组里，而不是项目分组里：**

说明那个 session 的目录在你的 herdr 里**没有对应的工作区**（你没在那个目录开过
workspace/tab）。看板日志里会有一行：

```
/tmp/xxx/yyy 没有对应的工作区，已归入 Sessions 兜底工作区
```

解决办法：在那个目录下用 herdr 开一个 workspace（`herdr workspace create --cwd <目录>`），
下一轮镜像就会自动挪进那个工作区，成为正确分组下的镜像行。

**同一目录的镜像行顺序会变：**

镜像标签页内部的排列由平衡 BSP 树决定，等分空间。哪个 session 先跑就先建哪个，
顺序不保证稳定 —— 分组是对的就行。

**Herdr 重启后行没了：**

正常情况下 startup 钩子会从 `HERDR_PLUGIN_STATE_DIR` 恢复映射。检查两件事：
`AUTO_START` 是否为 `true`（管理器得有人跑），以及 `resume_agents_on_restore`
是否被关掉（那会让 Herdr 忽略所有恢复命令）。映射文件在插件 state 目录下的
`state.json`，可以直接看。

**行出现了但标题是 session id：**

说明那个 session 没出现在会话列表里（列表翻页没覆盖到，或者刚创建）。
插件会退化成用 id 当标题，下轮拿到真实标题就会自动改。

## 已知边界

- **一个运行中 session 一行 = 一个镜像 pane**，有终端资源成本。镜像集中在各目录自己的
  `oc-sessions` 标签页里，不打开不占视野，但不是零成本。行数很多时每行会变矮、需要滚动 ——
  插件不会因为放不下就拒绝建行。
- **每个目录会在它的工作区里多出一个标签页**，叫 `oc-sessions`（前缀由 Herdr 加）。
  关掉它不影响镜像行以外的任何东西；镜像重建时会自己再开一个。
- **镜像标签页里会被 `herdr-sidebar` 注入一个 Sidebar pane**（它给每个标签页都注入）。
  那个 pane 没有 agent 行，既不参与镜像的布局平衡，也不会挡住标签页回收。
- **镜像行只读**。要交互得切回真实 TUI 手动换 session。
- **状态准确性依赖 SSE**。断流时退化为轮询，`blocked` 精度下降。
- **不碰官方集成文件**（`~/.config/opencode/plugins/herdr-agent-state.js` 等），
  也不用 `herdr integration install/uninstall`。避免和官方集成抢同一个 pane 的状态归属。
- **去重不靠 `agent_session`**。herdr 0.9.3 只给官方集成存原生 session 引用，
  第三方 source 传了 `agent_session_id` 也会被省略（实测：`plugin:` / `user:` /
  `custom:` source、带不带 `resume_argv`、seq 多大都一样）。所以去重走自己上报的
  `oc_session` token，副作用是 Herdr 重启后的原生 session 恢复在镜像行上不可用。
- **不接管第三方插件的显示层**。镜像行上报了 `$oc_title` / `$oc_project` / `$oc_state`
  token 也设了 pane label，但 `herdr-sidebar` 的 `hs_title` 优先级更高，改它要你自己动手。
- v2 下 `retry` 探测每个活跃 session 多一次 HTTP 请求，行多时可以在 `.env` 里
  关掉 `RETRY_DETECTION`。
