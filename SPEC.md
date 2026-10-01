# herdr 插件：opencode 运行中 session 镜像

## 1. 目标

在一个目录里打开的 OpenCode（同一个 server 实例）内运行了多个 session，其中只有「当前 pane 的 TUI 选中的那个 session 及其子 session」会出现在 herdr 的 Agents 视图里；同一 server 内其它正在运行的 session 完全不可见。

本插件让**所有运行中的根 session**在 herdr Agents 视图里各占一行，带准确的 `working` / `blocked` 状态和可读标题。

**已确认的产品决策**

| 决策点 | 结论 |
| --- | --- |
| 镜像行能力 | **只看不聊**。镜像 pane 内不运行 opencode，不接受输入。 |
| session 范围 | **仅运行中的根 session**。子 agent 由官方集成汇总进父行，不单列。 |

---

## 2. 关键约束（决定架构的硬事实）

1. **Agents 视图的每一行必须绑定一个真实 pane。** Herdr 没有「无终端的 agent」实体：所有上报接口 `pane.report_agent` / `pane.report_agent_session` 都强制要求 `pane_id`，也不存在 `agent.create`。
2. **插件不能向 Agents 视图新增原生行。** 插件 v1 明确排除非终端原生 UI 与运行时 action 注册。唯一的视图干预入口 `agent.view.set` 只能对**已有 agent 记录**做过滤与排序。
3. **官方 opencode 集成只上报选中 session。** V1 追踪「pane 选中的 session 及其后代」，V2 追踪「pane 的选中根 session」。
4. **同一 pane 的状态归属是独占的。** 自定义上报用独立 `source`；Herdr 自带集成用 `herdr:` 前缀。镜像必须使用自己的 pane，不能占用用户真实 TUI 所在的 pane。

> 推论：想让 session 出现在 Agents 视图里，就必须为它分配一个 pane。这是整个方案的支点。

---

## 3. 方案概述

为「未被任何 pane 打开」的运行中根 session 分配一个**专用镜像 pane**，不查看时无感。镜像 pane 内**不运行 opencode**（避免官方集成在该 pane 二次上报造成重复行），由插件通过 Herdr 官方开放接口替它上报状态与元数据。

状态来源是 OpenCode server 自身的运行态，而非屏幕识别——这比官方集成读屏幕更准。

### 3.1 镜像 pane 落在哪里：**每个目录一个专属标签页，放在该目录自己的工作区里**

目标形态（用户侧边栏）：

```
[1] afloat
  ├ opencode  Tray hover二级菜单点击收起…      ← 官方行（TUI 当前选中的）
  └ opencode  实现 Hover 菜单式…               ← 镜像行（同目录另一个在跑的）
[2] ReimuMoePCB_DAPLink
  └ opencode  使用 DAPLink 识别 H750          ← 官方行
[5] Muthesia
  ├ opencode  MIDI绘制乐理辅助功能             ← 官方行
  └ opencode  …                               ← 镜像行
```

**为什么必须这么排**：Agents 侧边栏的分组 token **只有 `workspace`**（`ui.sidebar.agents.rows` 默认 `["state_icon","machine","workspace","tab"]`，无「按目录分组」选项）。行的分组完全由它所在 pane 的 `workspace_id` 决定，所以镜像 pane 必须落在「用户为这个目录开的工作区」里，那一行才会归到对应的 `[n] <项目名>` 分组下。全部堆进一个 `Sessions` 分组就达不到目的。

**为什么用标签页而不是直接往用户的工作标签页里插 pane**：镜像独占一个标签页（固定名 `oc-sessions`，Herdr 自动加 `[N] ` 前缀），用户的多 pane 布局不会被挤压、不会抖。实测在 `w18` 建镜像标签页 `w18:tE` 后，用户原有的 `w18:t1 [1] lazer` 与 `w18:t7 [2] fish` 两个标签页的 pane 数完全不变。

**一个目录都匹配不上工作区时**（例如 session 在 `/tmp/...` 下而用户没开过这个目录），才退回 central `Sessions` 工作区，并在日志里明说「该目录无对应工作区，已归入 Sessions」。此时该工作区被 Herdr 自动回收（空工作区不留），下次需要时再建。

---

## 4. 数据来源

> **协议双轨**：OpenCode v1 与 v2 的 HTTP 接口路径、参数、事件名完全不同，且 v2 对未知路径会返回 SPA 的 HTML fallback（HTTP 200）。客户端必须**先探测协议版本再发业务请求**，并把非 JSON 响应判定为「路径不对」而非「接口可用」。
> 已在本机 `opencode 2.0.21` 上验证 v2 路径；v1 路径按官方 v1 文档适配，无真机可测。

| 用途 | v1 | v2 |
| --- | --- | --- |
| 健康/版本探测 | `GET /global/health` → `{healthy, version}` | `GET /api/info` → `{version, pid, urls}` |
| 活跃状态 | `GET /session/status` | `GET /api/session/active` |
| 根会话筛选 | `?roots=true` | `?parentID=null` |
| 会话目录字段 | `directory` | `location.directory` |
| SSE 事件名 | `event:` 字段 | `data:` 内 JSON 的 `type` 字段，另有 `: heartbeat` |
| 待处理权限 | 仅能靠 SSE | `GET /api/permission/request`（靠 `x-opencode-directory` 头分目录） |

### 4.1 状态与权限

- v1 `SessionStatus` 仅有 `idle` / `retry` / `busy` 三种（见 `packages/schema/src/session-status-event.ts`），且 idle 的 session 会从服务端内存 Map 中删除。
- v2 `/api/session/active` **只有 `running`**，没有 retry 信号。重试需额外探测 `GET /api/session/{id}/message?limit=1&order=desc` 的末尾消息，代价是每个活跃 session 多一次 HTTP 请求，由 `RETRY_DETECTION` 开关控制。
- 权限等待在两版都不在活跃状态里。v2 有独立的 pending 接口可轮询，v1 只能靠 SSE。**必须同时走 SSE 与轮询兜底**，否则「卡在审批上」这一最有价值的信号会丢。

### 4.2 会话目录

- 根会话列表分页拉取，按需翻页；候选集合命中后提前停止，避免每轮全量拉取。
- 候选 session 若不在根列表中，按 id 查 `parentID` 确认——这是「仅根 session」决策的落地点，子 agent 由此被排除。
- 目录 → 项目名映射用于展示。

### 4.3 Server 发现

`opencode serve --discoverable` 尚未发布，插件不依赖它。采用三级策略：

1. 插件配置里的显式 URL（`OPENCODE_SERVER_URL`，最高优先级）
2. 自动探测：`ss -ltnp` / `lsof` 找出进程名含 `opencode` 的监听端口，逐个探测校验
3. mDNS（若用户以 `--mdns` 启动）

探测到 401 时自动读取 `~/.config/opencode/service.json` 取密码重试，可由 `AUTO_AUTH_SERVICE_JSON=false` 关闭。

### 4.4 去重

`herdr agent list --json` 中每个 agent 暴露只读 `agent_session: { source, agent, kind, value }`。收集所有活跃 agent 的 `agent_session.value`（即 session id），从候选集合中剔除，避免与用户真实 TUI 那一行重复。

**实测补充（herdr 0.9.3）**：这个字段只在 herdr 存下原生 session 引用时才出现，而官方集成（`herdr:opencode`）会存、**第三方 source 不会** —— 实测 `plugin:` / `user:` / `custom:` source 无论带不带 `resume_argv`、带不带 `agent_session_id`、seq 多大，`agent.list` / `pane.list` 里的 `agent_session` 一律被省略。因此去重必须有第二条回退路径：读自己上报的 `oc_session` token。

同时必须能区分「自己的镜像行」和「别人上报的行」，否则下一轮会把自己刚建好的行当成已有人上报而全部丢掉。判定顺序：`tokens.oc_mirror == "1"` → `agent_session.source === plugin:<id>`。

---

## 5. 状态映射

| OpenCode | Herdr | 说明 |
| --- | --- | --- |
| `busy` / `running` | `working` | 正在执行 |
| `retry` | `blocked` | 通常是报错需要用户处理，`message` 写入 `--message`。**v2 无此信号**，需 `RETRY_DETECTION` 额外探测 |
| 存在未回复的权限请求 | `blocked` | v2 走 `GET /api/permission/request` 轮询，v1 只能靠 SSE |
| 以上都不满足 | `idle` | 出现即代表已停止运行 |

优先级：权限等待 > retry > busy。

「仅根 session」的判定：候选活跃 session 若不在根列表中，按 id 查 `parentID` 确认；非空则排除。这条同时决定了列表拉取无法总是提前停止翻页。

---

## 6. 组件与生命周期

### 6.1 常驻管理器

插件 v1 的 `[[startup]]` 钩子是**一次性初始化，不是受监管的守护进程**，因此不能在钩子里后台常驻。管理器以**插件面板**形式常驻：

- 插件声明 `[[panes]] id = "board"`，作为管理/看板面板
- 管理器负责：发现 server → 订阅事件 + 轮询兜底 → 维护 `sessionID ↔ paneID` 映射 → 增删镜像 pane
- `[[startup]]` 钩子负责在 Herdr 恢复会话后读取 `HERDR_PLUGIN_STATE_DIR` 里的映射并重建上报（与官方文档推荐的「保存声明式视图 + startup 重放」一致）
- 面板可由用户手动打开；自动拉起为可配置开关

### 6.2 镜像 pane 与锚点模型

**锚点模型（`state.mirrors`，按目录索引）**：

```js
state.mirrors = {
  "<绝对目录>": { workspaceId, tabId, anchorPaneId, fallback: false },
  ...
};
state.central = { workspaceId, tabId, anchorPaneId, label };  // 兜底工作区
```

`ensureMirrorTab(directory)` = 「拿到或创建这个目录的镜像标签页」。每个镜像标签页内部再用 6.4 的平衡 BSP 树摆该目录的多个镜像 pane——**这段逻辑复用，不因分目录而重写**。

`fallback: true` 的目录只存标记，真实 id 在 `state.central` 里（多个目录共用同一个兜底工作区与标签页）。

### 6.2.1 目录 → workspace 的解析（精确匹配，绝不用 basename 猜）

session 自带 `directory`。要找到对应的 herdr workspace，用 `herdr pane list` 的 `cwd` / `foreground_cwd` 反查，**三级判定**：

| 级 | 判据 | 说明 |
| --- | --- | --- |
| 1 | `pane.cwd === directory` | 用户就是在这个目录里开的 opencode，绝大多数命中这一级 |
| 2 | `pane.foreground_cwd === directory` | pane 的实际前台进程在这个目录里 |
| 3 | 该目录在某个 pane 目录**之下**（取最深的那个） | 用户在项目子目录里开了 session，而那个子目录自己没有 pane |

同级命中多个工作区时，选「**在这个目录里 pane 最多**」的那个，再比 pane 总数，最后按 id 保证结果稳定可复现。

> **为什么不用 pane 总数当主判据**：实测 `.../Software/herdr` 同时命中 `w1C [4] AI8051U_AM32_ESC`（该工作区里只有 1 个 pane 在这个目录，是个 sidebar）和 `w1J [7] herdr`（4 个 pane 都在这个目录，用户真在这儿干活）。按总数挑会选错分组，按匹配数挑才对——「这个目录里 pane 多」才说明用户真的在这干活。

**绝不拿 label 做匹配**：`herdr-sidebar` 会把用户的工作区 label 改写成 `[1] afloat` 这种带编号的形式，label 只是显示。label 只用于「找回 central 兜底工作区」这一处（且会剥掉 `[N] ` 前缀）。

一个 workspace 都匹配不上 → 退回 central `Sessions` 工作区，日志写明「该目录无对应工作区，已归入 Sessions」。

### 6.2.2 认领（state.json 丢失 / 崩溃残留之后）

`state.json` 丢了但镜像标签页还在时，需要重新认领，避免建出重复标签页：

1. **优先「里面有我们跟踪的镜像 pane」** ——最可靠，完全不看 label。
2. 其次按 label 认（归一化时剥掉 `[N] ` 前缀、只取 `›` 之前的部分，因为 sidebar 插件会把标签页改写成 `[3] oc-sessions › …`）。

**挑锚点 pane 不能拿「列表第一个」**：pane 列表顺序不保证是布局顺序，而 sidebar 插件会给每个标签页注入一个 `label: "Sidebar"` 的 pane。抢它当锚点会让之后 split 出来的镜像 pane 跑到侧边栏那一列下面（实测如此）。优先级：① 自己留的锚点 shell（无 label、无别人的 agent 行）→ ② 跟踪中的镜像 pane → ③ 列表第一个。

标签页真不在了（记录指向已消失的 pane）→ 删掉该目录的记录，下一轮重新解析目录、重建标签页。

每个镜像 pane 运行一个极轻的驻留进程（Node 定时器保活即可，不依赖外部命令），插件以自己的 `source` 为它上报。上报**刻意拆成两步**：

1. `pane report-agent --state ... --agent-session-id <id>` —— 只带状态与 session id，**不带** resume argv
2. `pane report-agent-session --agent-session-id <id> -- <恢复命令>` —— 单独附上恢复命令

原因是官方文档写明 `invalid_resume_argv` 时「the report is not applied」：合成一步上报时，一个不合法的恢复命令会把 `agent_session_id` 一起丢掉，session id 白报。拆开后第 2 步失败只影响「Herdr 重启后怎么恢复」，不影响这一行本身。两步都记日志。

恢复命令为 `opencode --session <id>`（`RESUME_MODE=mirror` 时改为只恢复驻留进程），保证 Herdr 重启后仍能恢复该行。session 停止运行 → `pane release-agent` + 关闭该镜像 pane + 重平衡剩余布局，行随之消失。

> **`pane split` 的 socket 参数是 `target_pane_id`**（没有 `pane_id`；传错会被静默忽略并拆当前焦点 pane）。CLI 侧用位置参数 `herdr pane split <pane_id>`，等价于 `target_pane_id`。

同时上报两层展示信息：

- `pane report_metadata`：`title` + `oc_mirror` / `oc_session` / `oc_title` / `oc_project` / `oc_state` token
- `pane rename`：`状态符号 + 项目 + 标题`（≤40 字）。Agents 侧边栏一行的默认文本来自终端标题（OSC），镜像 pane 里跑的是 node 进程，不改名就会显示成 `'/usr/bin/node' '/ho…`

`--seq` 必须跨进程重启单调递增，使用时间戳。

### 6.3 视图投影

`agent.view.set` 安装一个声明式投影，把镜像行按「需要关注优先 + 最近状态变更」排序，筛选条件走插件上报的 `oc_mirror` token。

**注意**：该投影是全局的，会影响整个 Agents 侧边栏的所有 agent。因此必须可开关，默认不安装。

另有一个副作用需要正视：按 `oc_mirror` token 筛选会**把官方集成的行全部隐藏掉**。因此提供 `AGENT_VIEW_SCOPE` 开关：

- `mirror`（默认，符合原始 SPEC）——只显示镜像行
- `sort-only`——不筛选，只安装排序，保留官方集成的行

#### 6.3.1 安全底线：绝不只靠筛选隐藏官方行

上面那条副作用是可以造成真实事故的：`mirror` 投影是全局筛选，一旦装上而镜像行为 0，用户原本那 8 行官方 opencode agent 会被**全部**筛掉，侧边栏变成 `no matching agents` —— 插件把用户自己的视图清空了。

两条硬性规则：

1. **装投影前先数镜像行数。** 为 0 时绝不允许安装带筛选的 `mirror` 投影，自动退回 `sort-only`（只接管排序）。收敛成一个函数 `shouldFilterMirror()`。镜像行从 0 变正、或从正变 0，投影都会跟着自动升降级。
2. **投影必须有人清。** `INSTALL_AGENT_VIEW=false` 但 `state.agentView` 存在时，清掉投影并把 `state.agentView` 置 null。这段「按当前 config 校准已安装投影」的逻辑是**所有模式共用**的（`startup` / `pane` / `action` / `once` 都跑一次），幂等、不刷错误日志。只有 startup 处理是不够的：用户把开关关掉后没有任何进程会再去校准，投影会一直赖在运行中的 Herdr server 里。

### 6.4 布局：平衡 BSP 树（按标签页，不是全局）

新增镜像 pane 后**重平衡这个镜像标签页里的镜像子树**，让该目录的所有镜像 pane 均分空间，而不是让锚点越来越小。不同目录的镜像在不同标签页/工作区，互不影响。

- 用 `layout.set_split_ratio`，**不用** `layout.apply`。官方文档明说 apply 会重建 tab、不保留 live PTY / scrollback / 进程，会把已有镜像 pane 全杀掉重启。
- 规则只有一条：**`ratio = first 子树的叶子数 / 该节点子树的总叶子数`**。每个叶子恰好拿到 1/N，对任意二叉树形状都成立。
- 比例已到位就不重复下发（reconcile 每 5 秒跑一次，不能每轮打十几次 socket）。
- **不因为空间不足拒绝建行。** 旧设计里「每行至少 N 行」的高度守卫和 ratio 逐级退让全部删除：反复用小 ratio 拆同一个锚点，锚点自己被逐次压缩、预算很快耗尽，那不是 herdr 的限制，是切分策略错了。实测 44 行 area 下平衡 8 叶完全放得下（`viewport_rows` 2/2/3/9/9/4/3，全 > 0）；超长会有滚动。

**外来 pane 的处理（两条规则，不是一视同仁）**：

- **别的来源（官方集成等）上报了 agent 行的 pane 一律不碰**——哪怕认领路径万一把它当成了锚点。认领路径可能误抢用户的标签页，这时候绝不能去动用户侧边栏那一列的比例。
- 但 sidebar 插件会给**每个**标签页注入一个 `label: "Sidebar"` 的 pane，它不报任何 agent 行。在**我们自己建的** `oc-sessions` 标签页里它就是纯废空间（里面全是常驻 shell，没有文件树也没有 git 变更可看），必须一起参与均分，否则根 split 永远被跳过、比例完全由 sidebar 插件摆布。
- 判据是「**纯镜像标签页**」：这个标签页里除 Sidebar pane 之外，没有任何别的 source 上报过 agent 行。是 → 整棵子树（含 Sidebar pane）都进平衡池；否 → 只平衡自己那部分。
- 实测：5 个 pane（4 镜像 + 1 Sidebar）时根 split 从 0.229 被纠正到 0.200，Sidebar 从 53.8% 降到 20%。

**常规巡检**：建行/回收时的重平衡是即时的，但布局会被别人改（sidebar 插件重排整页、用户手动拖分割条）。`REBALANCE_INTERVAL_MS`（默认 30s）触发一次全量巡检把比例纠回来。比例已正确时 `balanceSplitPlans` 返回空数组，不会下发任何写操作，所以稳定状态下只有 `layout.export` + `pane list` 两次读。

**零高度陷阱**：herdr 对过小的 split 不报错，会静默返回 `viewport_rows: 0` 的不可见 pane（实测连切 40 次全部返回成功，第 3 个之后全是 0 行）。所以「不报错」≠「建好了」。新建 pane 后读回 `scroll.viewport_rows`，为 0 立即重平衡再读一次；仍为 0 只记一条日志 —— **但绝不因此放弃这一行**，记下来下一轮重试。

> **`pane list` 的 `viewport_rows` 对非焦点工作区是陈旧值。** 实测 `layout.set_split_ratio` 返回 `ok: true`、`layout.export` 也确认 ratio 已经写成 0.200，但 `pane list` 仍报旧的 42/9/9/9/9。**判断布局是否真的生效要看 `layout.export`，不要信 `pane list` 的行数。** 副作用：`ensurePaneVisible` 的零高度检测在非焦点工作区上会读到陈旧的正数而跳过重平衡——这个缺口由上面的常规巡检兜住。

### 6.5 回收

三层回收，全部由同一条重算路径驱动：

1. **单个镜像行**：session 不再活跃且过了宽限期 → `release-agent` + 关 pane → 该标签页里的镜像 pane 重新均分。
2. **整个镜像标签页**：标签页里已经没有镜像 pane（跟踪中的、或带 `oc_mirror` token 的）→ `herdr tab close` 整页关掉，同时删掉该目录的记录。
   - **硬安全阀**：标签页里还有**别的 source 上报的 agent 行**时绝不关——那已经不是「纯镜像标签页」了。sidebar 插件注入的 Sidebar pane 没有 agent 行，不会触发这个保护。
3. **central 兜底工作区**：没有任何目录还在用 fallback → 关掉。里面还有别人的 agent 行则只关标签页、保留工作区（下次会在同一个工作区里重开镜像标签页，而不是新建一个同名工作区）。

**孤儿回收**：`state.json` 丢失或多次崩溃后，Herdr 里会留下永久残行。每轮重算先扫一遍——凡是带 `oc_mirror` token 却不在我们映射里的 pane，一律 `release-agent` + 关闭。靠 token 认最可靠：标签页名可能被用户改，pane id 一定认不错。重平衡时这些残行同样靠 token 认回来，否则整棵镜像子树会被当成「含外来 pane」而永远得不到平衡。

**pane 凭空消失要能自愈**。镜像 pane 会在我们背后被关掉：用户手动关、Herdr 回收空工作区、sidebar 插件重排标签页时关掉自己不再需要的 pane。两条都要处理，缺一条这一行就永久消失：

- **建行路径**：每轮开始时取一次活着的 pane 集合，`rec.paneId` 非空但不在集合里 → 清空并重建。否则 `rec.paneId` 非空会让建行逻辑以为「已经有 pane 了」，而上报一直 `pane_not_found`。
- **回收路径**：`pane close` 报 `pane_not_found` = 目标已达成，**当成成功**处理并删掉映射。旧代码当成失败保留映射，于是每轮都去关同一个不存在的 pane、那一行再也回不来。

实测：手动 `herdr pane close w1B:p1V` 后，下一轮日志 `pane w1B:p1V 已消失，重建` → `新建镜像行 ses_f13b9bcc → w1B:p1X`，同一 session、同一工作区分组。

**已知的上游噪声**：客户端进程被强杀（`kill -9`、终端崩掉）后，opencode 服务端可能仍把该 session 留在 `/api/session/active` 里一两分钟。这期间镜像行会显示成「运行中」的幽灵行，服务端自己清掉 active 之后下一轮就会正常回收。属于等待窗口，不是永久错报。

另外要清掉「central 工作区已经不存在」的记录：Herdr 会**自动回收空工作区**（标签页关掉后工作区自己就没了），而记录里还留着那个 `workspace_id`，不清掉下次会拿着一个已消失的 id 去认领。

`reap` action 走同一条路径的全量版：逐个关 pane → 关所有镜像标签页 → 扫孤儿 → 关 central 工作区 → 清记录与残留快照。session 还在跑时下一轮会重新建回来。

---

## 7. 插件配置

位于 `HERDR_PLUGIN_CONFIG_DIR/.env`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | 空 | 显式 server 地址，如 `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 空 | Basic Auth 密码 |
| `MIRROR_LABEL` | `Sessions` | **兜底**工作区名，仅当某目录匹配不上任何工作区时才会建 |
| `MIRROR_TAB_LABEL` | `oc-sessions` | 每个目录在自己工作区里那个镜像标签页的名字（Herdr 会自动加 `[N] ` 前缀） |
| `AUTO_START` | `false` | Herdr 恢复后自动拉起管理器 |
| `INSTALL_AGENT_VIEW` | `false` | 是否安装全局 Agents 视图投影 |
| `POLL_INTERVAL_MS` | `5000` | 轮询兜底间隔 |
| `IDLE_GRACE_MS` | `15000` | 状态转为非活跃后保留行的宽限时间，避免抖动 |
| `AGENT_VIEW_SCOPE` | `mirror` | `mirror` 只显示镜像行；`sort-only` 只装排序、保留官方集成的行 |
| `RETRY_DETECTION` | `true` | v2 无 retry 信号，需每活跃 session 多一次 HTTP 请求；关掉可省开销但丢失 `blocked` 判定 |
| `AUTO_AUTH_SERVICE_JSON` | `true` | 探测到 401 时自动读 `~/.config/opencode/service.json` 取密码 |
| `RESUME_MODE` | `none` | `none` 只上报 session id；`opencode` 额外上报 `opencode --session <id>` 恢复命令 |

完整清单与注释见 `config/.env.example`，以该文件为准。

---

## 8. 交付物

```
herdr-plugin.toml        # 清单：actions / panes / startup / keys
src/
  board.mjs              # 管理器：发现 server、订阅 SSE、轮询兜底、增删镜像 pane
  mirror.mjs             # 镜像 pane 内的驻留进程
  herdr.mjs              # Herdr CLI / socket 调用封装
  opencode.mjs           # OpenCode server 客户端（health / session / status / SSE）
  state.mjs              # HERDR_PLUGIN_STATE_DIR 下的映射持久化
config/.env.example
README.md
```

语言：Node.js（`.mjs`），无第三方依赖，使用内置 `fetch` 与 `node:child_process`。

---

## 9. 验收标准

1. 单目录 opencode 内同时有 3 个根 session 在跑 → Agents 视图出现 3 行独立 agent，状态与 `/session/status` 一致。
2. 某个 session 进入权限等待 → 对应行变 `blocked`，herdr 触发通知。
3. 某个 session 完成 → 对应行与镜像 pane 自动消失，不留残行。
4. 用户真实 TUI 选中的 session **不出现重复行**。
5. 子 agent 不单列成行。
6. Herdr server 重启后，镜像行能按保存的映射恢复。
7. OpenCode server 不可达时，管理器不崩溃、不刷错误日志，退化为静默重试。
8. **同一工作区里跑着多个 session 时，镜像行的 `workspace_id` 等于该目录对应工作区的 id**（落在正确的 `[n] <项目名>` 分组下，而不是全堆在 `Sessions`）。
9. **镜像标签页的存在不改变用户原有标签页的 pane 数**（实测建镜像标签页前后，用户原有标签页的 `pane_count` 逐个不变）。
10. **目录下所有镜像 session 都结束后，该目录的镜像标签页被整页关闭**，工作区回到镜像前的样子；没有目录再用兜底时，`Sessions` 兜底工作区也被关掉。

---

## 10. 已知边界

- **一个运行中 session 一行 = 一个镜像 pane**，有终端资源成本。镜像集中在各目录自己的 `oc-sessions` 标签页里，不打开不占视野，但不是零成本。行数很多时会需要滚动 —— 按产品决策这不构成拒绝建行的理由。
- **每个目录会在它的工作区里多出一个标签页**。标签页名叫 `oc-sessions`（前缀由 Herdr 加），一眼能认出不是工作标签页，关闭它不影响镜像行之外的任何东西。
- **镜像标签页里会被 sidebar 插件注入一个 Sidebar pane**（它给每个标签页都注入）。这个 pane 不参与镜像的布局平衡，也没有任何 agent 行，所以不会挡住标签页回收。
- **镜像行只读**。要交互需点进用户真实 TUI 手动切换 session。
- **状态准确性依赖 SSE 连接**。事件流断开会退化为轮询兜底，`blocked` 的权限判定精度下降；v1 无独立权限接口，断流期间该信号直接丢失。
- **v1 协议路径没有真机验证**（本机只有 v2）。v2 路径已在 `opencode 2.0.21` + Basic Auth 场景下端到端验证。
- **Windows 命名管道分支未验证**（无 Windows 环境），`agent.view.set` / `layout.set_split_ratio` 的裸 socket 客户端在 Windows 上留了 TODO。
- **不触碰官方集成文件**（`~/.config/opencode/plugins/herdr-agent-state.js` 等），避免与其抢同一 pane 的状态归属。
- **`agent.view.set` 与 `layout.set_split_ratio` 无 CLI 封装**，需自写裸 socket 客户端；`INSTALL_AGENT_VIEW` 默认关闭，未开启时不受此影响。
- **`agent_session` 落不了库**：herdr 0.9.3 只给官方集成存原生 session 引用，第三方 source 传了 `agent_session_id` 也会被省略（见 4.4）。去重因此走 `oc_session` token 回退；Herdr 重启后的原生 session 恢复在第三方 source 上不可用。
- **侧边栏行文本可能被用户自己的插件覆盖**：镜像行上报了 `oc_title` / `oc_project` / `oc_state` token，也用 `pane.rename` 设了可读 label，但 `herdr-sidebar` 的 `hs_title` token 优先级更高。插件不去改用户的 sidebar 配置，需要的话由用户自行把 `$oc_title` 拼进 sidebar 行模板。
- `RESUME_MODE=opencode` 的重启恢复未端到端验证（会真的拉起 opencode），`resume_argv` 的格式规则已按官方文档核对。
- **central 兜底工作区按 label 找回**。理论上会认错用户自己取名 `Sessions` 的工作区 —— 但这只发生在「有目录匹配不上任何工作区」的兜底路径上，且里面有别人的 agent 行时不会关掉它。
- 面板命令的输出不会进入 `herdr plugin log list`，排障需走 `herdr pane read`。