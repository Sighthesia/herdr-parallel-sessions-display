# herdr 插件：opencode 运行中 session 镜像

## 1. 目标

在一个目录里打开的 OpenCode（同一个 server 实例）内运行了多个 session，其中只有「当前 pane 的 TUI 选中的那个 session 及其子 session」会出现在 herdr 的 Agents 视图里；同一 server 内其它正在运行的 session 完全不可见。

本插件让**所有运行中的根 session**在 herdr Agents 视图里各占一行，带准确的 `working` / `blocked` 状态和可读标题。

**已确认的产品决策**

| 决策点 | 结论 |
| --- | --- |
| 镜像行能力 | **只看不聊**。镜像 pane 内不运行 opencode，不接受输入。 |
| session 范围 | **根 session**。子 agent 由官方集成汇总进父行，不单列。 |
| 停下来的 session | **保留**（内联模式）。跑完留在列表里显示 `○`，用户切到前台查看后才清除，见 12.9 |

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
   - **仅非内联模式**。内联模式没有镜像 pane，而且停下来的 session 要留着让用户知道它跑完了（12.9）。
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
| `IDLE_GRACE_MS` | `15000` | 状态变化的防抖时间。非内联模式：非活跃后回收镜像行的宽限期。内联模式：被官方集成连续认作前台 session 多久算「用户已查看」 |
| `IDLE_KEEP` | `3` | 内联模式：每个目录最多留几条「已完成、尚未查看过」的 session（见 12.9） |
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
  codex.mjs              # Codex app-server 客户端（WebSocket over unix socket + JSON-RPC，见第 12 节）
  claude.mjs             # Claude Code 会话发现（spawn `claude agents --json` + 纯字段映射，见第 13 节）
  state.mjs              # HERDR_PLUGIN_STATE_DIR 下的映射持久化
config/.env.example
README.md            # 英文，主展示
README.zh-CN.md      # 中文，与英文同步维护
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
---

## 11. 内联模式（当前默认，`MIRROR_INLINE=true`）

第 4~10 节描述的是「每个 session 一个镜像 pane」的原始模型。它能跑，但**代价太大**：每个涉及的目录多一个标签页、每个 session 一个真实终端 pane。实测发现有个更好的支点，于是默认切到内联模式。

### 11.1 支点：`--applies-to-source`

`pane.report_metadata` 有个 `--applies-to-source`：用它可以往**别的 source 上报的 agent 行**上附加自己的 token，而**不接管那一行**。

实测（herdr 0.9.3 + 官方 opencode 集成 v13）：

- `agent` 字段和 `agent_session.source` 都不受影响
- 官方集成随后重报（`working` → `idle`）后，token 照样存活
- 挂上 token 的行**依然是官方行**：点击跳官方 pane，`agent` 名仍是 `opencode`

于是并行 session 的信息**不需要自己的 pane**，挂在官方行上即可。直接消灭了镜像标签页和镜像 pane 整套机制。

### 11.2 渲染：ASCII 树状图

侧边栏模板（`~/.config/herdr/config.toml` 的 `[ui.sidebar.agents]`）：

```toml
rows = [
  ["workspace"],
  ["state_icon", "agent"],
  ["$oc_sess1"], ["$oc_sess2"], ["$oc_sess3"],
  ["$oc_sess4"], ["$oc_sess5"], ["$oc_sess6"],
]
```

效果：

```
[1] afloat
◐ opencode
│▸ ● 排查 Shell 重载启动初始化卡顿      ← 官方 TUI 当前选中的（根）
├─ ● 排查Shell启动时壁纸揭露过渡卡顿      ← 切走但还在跑的（分支）
└─ ○ Tray hover二级菜单点击收起无退场效果…
```

连接符由 `PARALLEL_CONNECTOR` 决定：`bar`（默认）/ `tree` / `none`。

`bar` 下官方行是**根**（`│▸ `），其余行是它的**分支**（`├─ `，最后一条 `└─ `），
两种前缀都在标记前占满 3 格，于是**标记和标题在所有行上
落在同一列**。补出来的空格是**中间**的空格（不是前导），所以不受 Herdr trim
前导空白的影响。

### 11.3 Herdr 侧边栏的硬限制（全部实测，决定了上面这个模板长这样）

| 限制 | 实测结果 | 对设计的影响 |
| --- | --- | --- |
| 自定义 token 会被 trim 前导空白 | 传 `"  └─ x"` 存下来是 `"└─ x"` | 空格缩进存不住；Unicode 空白（U+00A0、U+2000–200A、U+3000）同样被 trim，只能自己把连接线写进值里 |
| token 值里的换行会被去掉 | 传 `"a\nb\nc"` 存下来是 `"abc"` | 一个 token 只能渲染一行 → N 个 session 必须 N 个 token、N 个 row |
| 单个 token 值硬截断 80 字符 | 请求 82 字符存下来是 80 | 插件自己先截到 78 并用「+N」收尾 |
| 空槽位不渲染成空白行 | `$oc_sess4..6` 无值时那三行不出现 | 槽位可以放心加 |
| `ui.sidebar.agents.rows` 最多 16 行 | — | 现在用 2 + 6 = 8 行 |
| 合法内置 token 只有 8 个 | `workspace` `machine` `tab` `agent` `state_icon` `terminal_title` `terminal_title_stripped` `pane` | 带 `$` 的是自定义 token，herdr 不校验存在性 |
| 每 agent 条目各渲染一遍，无分组头去重 | 两个 agent 同工作区时 `[1] afloat` 会重复 | 分组只能靠 workspace 行，**做不到「每个工作区一个头」** |
| `rules` 只能匹配该 token 自己的值 | 不能按行条件化样式 | — |

### 11.4 为什么官方 session 也由插件生成

一开始官方那行用内置 `terminal_title_stripped`，只有并行 session 用插件 token。实测渲染出来是：

```
[1] afloat
◐ opencode
  OC | 实现 Hover 菜单式 Mod 键 Window Hint    ← 内置行：缩进 2 格、无连接线
│ └─ ● 排查 Shell 重载启动…                     ← 插件行：顶格、带连接线
```

插件行反而比它 supposed 的父节点**更靠左**，读不出层级。官方那行拿不到连接线，是因为 `terminal_title_stripped` 是内置 token、内容不可改（`rules` 只能改样式）。

改成官方 session 也由插件写进 `$oc_sess1`，所有 session 行同一格式，官方那个用 `▸` 点出。官方 session 的标题直接取官方行的 `terminal_title_stripped`，**不额外查 opencode**（实测那个字段就是该 session 的标题）。另外用 `stripAgentPrefix` 砍掉开头的 agent 标识前缀（`OC | ` 这类）——树状图里每行都是 opencode，重复它既占宽度又没有信息量。

### 11.5 挂载点解析

内联模式要挂的是**官方 agent 行本身**，所以目录 → 工作区的解析规则和建 pane 模式不同：

- 建 pane 模式挑「该目录里 pane 最多的工作区」（要的是一个放镜像 pane 的容器）
- 内联模式必须用官方行的 `foreground_cwd` **精确匹配**

实测踩到的坑：`Software/herdr` 这个目录在 w19 里有 **7 个** pane 的 cwd（用户跑了一堆 herdr-sidebar 实例），在 w1J 里只有 4 个。按数量会选 w19 —— 信息就挂到不相干的分组下面了。

### 11.6 无状态清理

清理逻辑**以 `agent.list` 的实际值为准**，不依赖进程内记账。踩过的坑：原本遍历 `runtime.attachedParallel`，而那个 Map 随进程生死；board 重启后它空了，于是上一轮挂在别人工作区上的过期 token 再也没人清，一直挂在侧边栏上（实测 session 都跑完了，`oc_par` 还显示着旧的标题）。

### 11.7 内联模式的功能损失

session 在用户没开 TUI 的目录（典型是 `/tmp` 下的临时工程）时，这个工作区里没有可挂载的官方行，那条信息**直接不显示**并记日志。想让这类 session 也可见，把 `MIRROR_INLINE` 设成 false 回到建 pane 模型。

---

## 12. 多 agent 支持

第 4~11 节都只讲 opencode。挂载机制（`--applies-to-source`）和渲染（`$oc_sess*`）**本来就是 agent 无关的**，只有「去哪儿找正在跑的 session」这一层每个 agent 各写一个探测器。

### 12.1 分层

```
publishInlineSessions(providers)          ← agent 无关：分组、挑挂载点、写/清 token
  ├─ fetchCodexSessions()  → codex.mjs   ← codex 专用
  ├─ fetchClaudeSessions() → claude.mjs  ← Claude Code 专用
  └─ (opencode 侧)        → opencode.mjs
```

`publishInlineSessions` 接受一组 `{ agent, wanted, statesById, failed }`，**把官方 agent 行按 `a.agent` 分桶**，每个 provider 只碰自己桶里的行。

这里最容易踩的坑：**挂载点解析必须限定在该 provider 自己的行里**。一个 workspace 里 opencode 行和 codex 行的目录可能一样，用全局集合解析挂载点必然串味 —— codex 的 session 会挂到 opencode 行上，显示在错误的分组下。清理循环同理。

### 12.2 codex 的数据源：app-server over WebSocket

**不用 sqlite。** 实测 `~/.codex/state_5.sqlite` 的 `threads` 表直接读得到 **0 行**（数据在 `-wal` 里），而 app-server 直接返回真实数据。走网络同时省掉了「复制 `db`+`-wal`、不能复制 `-shm`」这一套处理。

Codex 0.160 的协议：

| 项 | 值 |
| --- | --- |
| 传输 | JSON-RPC 2.0 over **WebSocket**（unix socket 或 TCP 都行） |
| 握手 | 必须先 `initialize`，否则任何请求返回 `{"code":-32600,"message":"Not initialized"}` |
| 列会话 | `thread/list`，支持 `cwd`（字符串或数组，**服务端直接按目录过滤**）、`sourceKinds`、`archived`、`searchTerm`、游标翻页 |
| 谁在跑 | `thread/loaded/list`，返回**字符串数组**（thread id），语义是「在内存里加载着的」 |
| 状态推送 | 通知 `thread/status/changed`（本插件 5 秒轮询，用不上，保持实现简单） |

### 12.3 传输层：共享守护进程 vs 自起实例

`codex app-server --listen` 支持 `stdio://`（默认）、`unix://`、`unix://PATH`、`ws://IP:PORT`、`off`。两条路都实测过：

| | 共享守护进程 | 自起实例 |
| --- | --- | --- |
| 连法 | `http.request({socketPath})` + 手动 WS 握手 | `spawn` + Node 内置 `WebSocket` |
| 拿得到 thread 列表 | 能 | 能 |
| **拿得到实时状态** | **能**（`status.type` 有 `active`/`idle`） | **不能**，全 `notLoaded` |
| 前置 | 守护进程要在跑 | 无 |

选**共享守护进程**。理由：这个插件的全部价值就是「区分正在跑的 session」，而状态是进程内运行时状态，别处看不到。守护进程本来就常驻，我们只是多一个客户端连接，不增加任何常驻成本。

守护进程 socket 路径：`~/.codex/app-server-control/app-server-control.sock`（符号链接指向 `/tmp/codex-daemon-1000/<hash>`）。可用 `codex app-server daemon version` 查（输出是 JSON，含 `status` 和 `socketPath`）。

### 12.4 帧层：为什么手写 WebSocket

Node 内置 `WebSocket` **不支持 unix socket**，所以帧编解码要自己写。两个实测踩到的坑：

- **客户端发往服务端的帧必须掩码**，掩码密钥 4 字节，**掩码从「帧头长度 + 4」开始异或**。帧头 2 字节时负载从第 6 字节开始 —— 写成固定偏移 4，服务端会一直不回包（表现为所有请求超时）。
- `http.request` 走 `upgrade` 握手**必须调 `req.end()`**，否则请求根本不发出去，`upgrade` 事件永远不来。

服务端发来的帧不掩码。解码要处理 ping（回 pong）和 close。

### 12.5 状态映射

| codex `status.type` | 插件状态 | 侧边栏标记 |
| --- | --- | --- |
| `active` | `working` | `●` |
| `idle` | `idle` | `○` |
| `systemError` | `blocked` | `▲` |
| `notLoaded` | `null` | **不显示**（历史遗留，不在内存里） |

「正在跑」用**两条证据**判定，避免单边误判：`thread/loaded/list` 的 id 集合，以及 `status.type !== "notLoaded"`。两个证据都说不在内存里才丢弃。`loaded` 里有但 `thread/list` 没给的，按 id 补查 `thread/read`（上限 8 条）。

### 12.6 子 agent 不单列

`sourceKinds` 枚举共 10 种：`cli` `vscode` `exec` `appServer` `subAgent` `subAgentReview` `subAgentCompact` `subAgentThreadSpawn` `subAgentOther` `unknown`。

默认取 `["cli","exec","appServer","vscode"]`，即**用排除法**滤掉 `subAgent*`。

**坑**：不要只填 `["cli"]`。实测那两条 thread 的 kind 是 `vscode`，只填 `cli` 会返回 0 条 —— 整份列表凭空消失，而且不报错。

### 12.7 前置条件

`herdr integration status` 显示 **`codex: not installed`** —— herdr 的 codex 集成靠 hook 上报（注入 `~/.codex/herdr-agent-state.sh`），没装的话 `herdr agent list` 里一个 `agent === "codex"` 的行都没有。

内联模式只往官方行上挂 token，所以**没装集成时 codex 的 session 一行都不显示**。插件会在采集到会话但找不到对应官方行时打一条 info 级日志说明这件事（只说一次，之后降级 debug）。

### 12.8 补报会话身份（`CODEX_ADOPT_SESSION`）

内联模式挂 token 用 `pane.report_metadata --applies-to-source`，而它要求**目标 source
已经在该 pane 上有记录**。没有记录时写完立刻消失 —— 实测猜一个 `herdr:codex` 去挂，
写完再查 `tokens` 就是 null。

codex 恰好会缺：Codex 0.160 的 `SessionStart` hook **在 TUI 启动时不触发**（二进制里是
`run_pending_session_start_hook`，挂起到会话真正开始干活才跑）。这里要说明验证过程中踩
到的坑：**第一轮测试是无效的** —— 当时改了 hook 命令去做记录壳，但 `trusted_hash` 是按
命令内容算的，改命令等于把信任作废，codex 就会跳过它。第二轮用 `bypass_hook_trust`
排除这个干扰因素后重测，结论才站得住。

于是官方行一直空着 `agent_session`，内联模式无处可挂。插件的做法是：从 **codex 自己的
app-server** 读出该目录的真实 thread id，以 `herdr:codex` 的身份补报一次 `agent_session`。

为什么这不算抢官方集成的归属：写进去的 `agent_session_id` 是真值，不是我们编的；官方
hook 将来真跑起来时写的是同一个值。而不补报的后果是「因为官方还没上报，所以什么都不
显示」，那是更糟的结果。仍然保留了关闭开关（`CODEX_ADOPT_SESSION=false`）回到纯被动。

挑选规则：用官方行的 `foreground_cwd` 精确匹配会话的 `cwd`；同目录有多个时，已补报过
的仍然有效就继续用它 → 否则优先 `working` → 再否则取 `updatedAt` 最大的。

补报之后 `agent_session.value` 与 app-server 的 `thread.id` 完全对上，于是 12 节点里
「用会话自己的标题而不是终端标题」那条精确匹配路径顺带生效。

**A/B 实测**：同一个工作区开两个 codex pane，一个开着补报、一个关着。开着的那行
`agent_session` 有值且挂上了树，关着的没有——确认是插件补的，不是官方 hook。

### 12.9 运行中标记：实心圆（点阵转轮保留但默认不启用）

`working` 的标记默认是**实心圆 `●`，静止**；点阵转轮实现保留但不启用。

想开：两项都要设，只设序列仍是静帧（免得填了序列就意外花 CPU）——
`PARALLEL_BUSY_FRAMES=⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` + `PARALLEL_BUSY_ANIMATE=true`，可选
`PARALLEL_BUSY_FRAME_MS` 调帧率。

为什么默认关：实测**转轮 12% 单核 vs 关闭 4%**，多花 8% 换来的观感提升有限 —— 同一行的
`state_icon` 本来就在用 Herdr 自己的点阵转轮转着，**转起来的是那一行，不是我们这个标记**。

为什么默认不用点阵：opencode v2 的运行指示器（`session-progress-indicator-v2.tsx`）是
5×5 共 25 个点的 SVG，改 opacity 播对角波纹，1200ms 一轮。侧边栏复现不了原样（token 静态
文本、换行被去掉、值硬截断 80 字符、Herdr 不播动画），二维点阵画不进一行。

实现要点（保留这套代码的理由）：

- **动画必须自己播**：Herdr 只为它自己的 `state_icon` 播动画，自定义 token 拿不到。
- **单开 ticker，不把主重算循环跑快**：主 `reconcile` 一轮要拉 opencode 活跃集合、扫会话、
  扫 pane、查权限，为 150ms 的动画跑它会拖垮两边。ticker 只在内存里换字 —— 主循环渲染时把
  忙标记写成占位符 `\uE000` 并缓存这些行，ticker 到点换成下一帧写回去，不做任何查询；没有
  忙标记就停掉定时器，空闲期零开销。用私用区字符当占位符是为了避免会话标题里恰好出现同一
  个字符时被误替换。
- **写入走 socket**（`attachMetadataFast` → `pane.report_metadata`）而非 CLI：原实现每次
  都 spawn 一个 `herdr` 进程（一次约 5ms），150ms 一帧 × N 个忙行就是每秒几十次 spawn。
- **但瓶颈不在 spawn**：为此实测只省 2%（14% → 12%），真正省不掉的是 Herdr 每次 token 变化
  都要重绘侧边栏（4 个忙行 × 6.7 次/秒 ≈ 27 次/秒）。所以帧率必须可调，这是默认关它的
  根本原因。

### 12.10 每个工作区只挑一个挂载点，但每行都要显示自己

同工作区有多个同 agent 的官方行时，按「正在忙 → 正在聚焦 → 空闲」的顺序只挑**一个**
挂载点。所以同一工作区开三个 codex 窗口时，只有其中一行下面会出现完整的会话树。

**但没被挑中的那几行也必须显示自己的那一个 session**，不能留成空白行：模板里已经
没有 `terminal_title_stripped`，写/清循环对「本轮不需要」的行会清掉全部槽位，于
是那一行只剩状态图标和 agent 名。这个状态和「挂载失败」在 `agent list` 里长得一模一样
（`agent_session` 有值、`oc_sess*` 一个都没有），排查时极易误判，所以必须写。

与 opencode 侧行为一致。

### 12.11 配置键必须登记进 `CONFIG_DEFAULTS`

`loadConfig` 的 `KNOWN_KEYS` 是从 `CONFIG_DEFAULTS` 派生的，**不在名单里的键会被静默
丢弃** —— `.env` 里写了、README 里也承诺了，但 `board.mjs` 读到的一直是硬编码默认值，
且没有任何提示。实测踩过：`MIRROR_INLINE`、`INLINE_ALWAYS_LIST`、`PARALLEL_TOKEN_MAX`、
`PARALLEL_TRUNK`、`REBALANCE_INTERVAL_MS`、`FOCUS_REDIRECT`、
`FOCUS_REDIRECT_COOLDOWN_MS` 共 7 个键都属于这一类（`board.mjs` 读它们，`KNOWN_KEYS`
里却没有）。表现是「改了配置没反应」，排查时只会怀疑时序和缓存。

两条约束：① `board.mjs` 读的任何配置键都必须列进 `CONFIG_DEFAULTS`；② `.env` 里出现
陌生键时启动必须打一条 warn —— 对用户来说「拼错了」和「还不支持」的症状完全一样，
不能让他以为它生效了。

### 12.12 token 命名

沿用 `oc_sess1..oc_sess6`，**不因为支持多 agent 就改名**。token 挂在**具体某个 agent 行**上，不同 agent 的行本来就是不同的 pane，天然不冲突。改 token 名要动 `config.toml` 的 rows、README、SPEC，收益不抵风险。

### 12.14 停下来的 session 保留到「查看过」为止

**实测现象**：HardwareBridge 目录的侧边栏上，`无人机仿真测试工程与插件规划` 在两次快照
之间（12:09 → 12:20）凭空出现又消失。根因是 opencode 的 `/api/session/active`
**在会话停下的一刻就把条目移除**，而内联模式把它当成唯一的生死判据，宽限期一到就
回收该行。模板里已经没有内置标题行了，所以整条（含标题）一起消失 —— 用户看到的是
session 随机丢失，分不清「跑完了」和「被弄丢了」。

**产品决策**：跑完的 session 留在列表里显示 `○`，让用户知道哪个完成了；**用户把它切到
前台、结果看过了才清除**。

判据是 `claimed` —— 官方集成把这个 session 报成某个 pane 的当前 session，即用户真的
切过去了。**要求连续 claimed 满 `IDLE_GRACE_MS` 才认**：实测官方集成的 `agent_session`
会在两次轮询之间反复变（同一个 pane 上换过三次 session），照单全收会在用户切走的那
一瞬间把行误删，而用户根本没看过。

两条边界都不能省：

- **每目录上限 `IDLE_KEEP`（默认 3）**，按 `updatedAt` 倒序保留最近的。不设上限的话，
  一个开了好几天的目录会把 6 个槽位占满，真正在跑的那条被挤成「+N」。上限挤掉的**记录
  必须留在 `runtime.state.panes` 里**（只是本轮不列）—— 删掉的话下一轮它又冒出来，
  反复横跳。
- **闲置的子 agent 也要挡掉**。2a 只在筛选「活跃」集合时查 `parentID`，一旦 opencode 改了
  `parentID=null` 的过滤语义、或 state 是旧版本写的，子 agent 就会从「已完成」这条路径漏
  进来，违反 12.6 的产品决策。

判定逻辑是纯函数 `selectRetainedIdle`（board.mjs），不修改传入对象，可直接
`node -e` 断言。`acknowledgedAt` / `updatedAt` 必须在 `normalizeState` 的白名单里，
否则插件一重启就丢，「查看过才清除」每次重启都要重来一遍。

### 12.13 已知边界（codex）

- **`thread/read` 补查回来的 thread 可能没有标题**（`preview` 为空串，实测碰到过），只能显示 `(无标题)`。
- **codex 的官方行拿不到 id 精确匹配时**会退回按 `foreground_cwd` 解析（和 opencode 侧同一条路）。走补报（12.8）时 `agent_session.value` 与 thread id 天然相等，所以走的是精确匹配那条；只有官方 hook 自己上报、而我们没补报时才可能落到退回路径。
- **同工作区多个 codex 窗口时只有一个会显示会话树**（12.10），这是挂载点唯一决定的，不是 bug。
- **本机 codex 侧网络不通**（`moai.top` DNS 解析失败），所以 codex TUI 发消息会失败。但这不影响插件：会话数据全部来自本地 app-server，不联网。
- **codex 的终端标题未必有信息量**，所以 id 匹配成功时用 thread 自己的 `name`/`preview`，匹配不上才退回终端标题。

---

## 13. Claude Code 支持

第 12 节的多 agent 框架对 Claude Code 同样成立：**挂载机制和渲染一个字都没改**，只多了一个
provider（`fetchClaudeSessions()` → `claude.mjs`）。这一节只记 Claude 自己的数据源、字段映射、
匹配方式和成本 —— 结构上的异同才是读代码时真正要知道的。

### 13.1 发现方式：只有 `claude agents --json`

官方文档明说这是「**the supported way** to read session state from outside Claude Code」，
同时点名 `~/.claude/jobs/<id>/state.json` 与 `~/.claude/daemon/roster.json` 是
**非稳定接口、不要解析**。所以只用 CLI。

- **不需要 supervisor 守护进程。** 实测 `claude daemon status` 是 `not running` 时，两个活着的
  交互式会话照样列得出来（实时进程组信息走 `/proc`，不经过 daemon）。所以没有「拿不到
  supervisor 就算失败」这回事，也不要去管 `claude daemon`。
- **不要加 `--all`。** 默认语义已经是「every live session, plus background sessions that are
  still working or blocked even when their process has exited」，正好是我们要的「正在跑」；
  加 `--all` 反而把已完成的会话全列进来。
- 单次调用实测约 **260ms**（`time` 跑 5 次共 1.28s），stderr 干净，stdout 是纯 JSON 数组。

### 13.2 与 codex 侧的结构性差异

| | codex（第 12 节） | Claude Code |
| --- | --- | --- |
| 数据通道 | app-server 长连接（WebSocket over unix socket） | 每次一个短命 `spawn` |
| 连接生命周期 | connect / 重连 / 退出前 `closeCodexClient()` | 无连接可断 |
| 采集失败形态 | 「守护进程连不上」，退避重连 | 「这一轮没拿到结果」，退避后重来 |
| 状态粒度 | app-server 内存（实时） | 进程实时状态 |

差异直接决定了两件事：

1. **board 里没有 `runtime.claude.client`** —— 只有退避、节流、缓存。
2. **每一次 spawn 都必须自带超时并回收子进程**，否则 board 进程永远排不空事件循环，
   `--mode once` 挂着不退出（`AGENTS.md` 记过 codex 那条长连接的同款事故）。具体做法：
   超时后 SIGKILL **并 destroy 掉 stdio 流** —— 只杀进程不够，孙进程继承的管道端点会把
   本进程吊住（实测一个超时的 `sh` 包装脚本，+500ms 时仍有 4 个 PipeWrap 在活跃资源里）。

### 13.3 字段映射

实测输出（Claude Code 2.1.287）里每一项都可能缺，所以全部按可选处理：

| 字段 | interactive | background | 用途 |
| --- | --- | --- | --- |
| `sessionId` | 有 | 有 | **唯一稳定身份**：去重、transcript 路径、补报都用它 |
| `cwd` | 有 | 有 | 目录匹配与挂载 |
| `kind` | `interactive` | `background` | 仅日志 |
| `startedAt` | 有 | 有 | Unix **毫秒**（codex 那边是秒）；降级匹配时排「最近起的」 |
| `pid` | 有 | **可能没有**（worker 刚起来时实测缺） | pid 精确匹配 |
| `status` | 有 | **可能没有** | `busy`/`waiting`/`idle` |
| `state` | **没有** | 有 | `working`/`blocked`/`done`/`failed`/`stopped` |
| `id` | **没有** | 有 | 短 id，`claude attach/stop/logs` 用 |
| `name` | 有 | 有 | 标题（常常是默认值，见 13.5） |
| `waitingFor` | 有状态时 | 有状态时 | `permission prompt` / `input needed` / … |

没有 `sessionId` 的条目直接丢弃：既无法去重也无法 resume。

### 13.4 状态映射

| claude | 插件状态 | 侧边栏标记 |
| --- | --- | --- |
| `state:"working"` / `status:"busy"` | working | `●` |
| `state:"blocked"` / `status:"waiting"` | blocked | `▲` |
| `state:"done"` / `status:"idle"` | idle | `○` |
| `state:"failed"` / `"stopped"` | `null` | **不显示**（回合已结束） |
| 都没有 | idle | `○` |

**「都没有」当 idle 的理由**：在列表里就意味着进程还活着（只有 `--all` 才带已完成的），
宁可报 idle 也不要把它藏起来。这与 codex 的 `notLoaded → null` 语义不同 —— 后者是
「不在 app-server 内存里」的历史遗留，claude 没有这个概念。

### 13.5 标题：默认显示名毫无信息量

交互式会话在用户 `/rename` 之前，`name` 是 `<cwd 的 basename>-<两个字符>`（本机实测
`herdr-fe` / `herdr-99`）；后台 job 暂时拿不到标题时，`name` 会是**自己的短 id**（实测
`id:"fca468d9"`、`name:"fca468d9"`、`sessionId:"fca468d9-…"`）。两种都当默认名处理。

兜底读 transcript 的首条用户消息，路径实测规则是
`<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl`，其中
`encoded-cwd` = 目录里每个非字母数字字符换成 `-`（`_` 也变 `-`）。超过 200 字符会截断
并加路径哈希 —— **不实现那个哈希**，官方没给算法，猜出来的路径只会读不到，于是退回
`(无标题)`：一个可接受的降级好过某天悄悄读错文件。

判据全宽容（`type==="user"` + `message.role==="user"` + `isSidechain!==true`，`origin`
存在时要求 `origin.kind==="human"`，数组 content 只取 `text` 块），**任何异常都退回占位符，
绝不抛** —— 官方明说 transcript 的行格式是 internal 的、随版本变。

**只读头部 64KB 且按 sessionId 记忆化**（上限 200 条）：整个 transcript 实测 47KB 且会一直
长下去，每轮重读纯属浪费。**只缓存成功的解析** —— 缓存「没找到」会让标题在用户发出第一句话
之后仍然停在 `(无标题)`，直到 board 重启。

### 13.6 匹配：pid 精确命中，比 codex 准

`herdr pane process-info --pane <id>` 的 `foreground_process_group_id` 与
`claude agents --json` 条目的 `pid` **逐字节相等**（本机实测 `w1J:p12` → 2440557 →
session `333dcd0a…`，`w1J:p14` → 2441496 → session `71ad425d…`）。`pane process-info`
实测 5ms/次，很便宜。

所以 claude 的补报（13.7）**不退化成 codex 那套「目录 + 排序去猜」**，只在下面这些情况才降级：

- 该会话没有 `pid`（后台 worker 刚起来时实测缺）；
- pane 里跑的根本不是 claude；
- **那个会话压根没出现在 `claude agents` 里** —— 实测踩到过：交互式 TUI 被 fork 成后台 job
  之后，交互式那个会话就从列表里消失了（进程还在、transcript 还在），此时 pane 的前台 pid
  对不上任何条目。

另外还有一条更直接的信号：后台 worker 的进程命令行里带 `--session-id <uuid>`（实测
`claude --session-id fca468d9-… --agent claude …`，herdr 原样返回 argv/cmdline），命中它
就不用对齐 pid。

### 13.7 补报会话身份（`CLAUDE_ADOPT_SESSION`）

`publishInlineSessions` 判定官方行的条件要求 `agent_session.source` 是字符串，而本机装好
Claude Code、官方集成未装时，`herdr agent list` 给的 claude 行**没有 `agent_session` 字段**
（实测字段只有 agent / agent_status / cwd / foreground_cwd / name / pane_id / tab_id /
terminal_id / terminal_title / workspace_id）—— 于是一条都进不了官方行集合，内联模式
无处可挂。

herdr 的 claude 集成是 hook 驱动的（`~/.claude/hooks/herdr-agent-state.sh`，本机未装）。
所以插件以 `herdr:claude` 的身份补报一次 `agent_session`，写进去的 session id 是
`claude agents --json` 里的真值，将来官方 hook 真跑起来写的是同一个值。补报与挂载的顺序
不能颠倒 —— `--applies-to-source` 要求目标 source 在该 pane 上**已有记录**，所以必须先补报
再挂载，否则写完即消失（实测 `tokens` 变 null）。

实测确认：补报之后 `agent_session` 变成 `{agent:"claude", kind:"id", source:"herdr:claude",
value:"fca468d9-…"}`，`pane.report_metadata --applies-to-source herdr:claude` 也就能挂上
`$oc_sess*`。

### 13.8 踩坑：TUI 刚起来时列表是空的

本机实测两个 pane 卡在首次运行的 "Press Enter to continue…" 安全提示时，
`claude agents --json` 返回 `[]`；过掉信任对话和渲染器询问之后才列出。所以**「采不到会话」
不等于「采集坏了」**，不要因此报错或进退避。

### 13.9 成本：两条对策都要做

主轮询 `POLL_INTERVAL_MS` 默认 5000ms，每次 spawn 约 260ms —— 每 5 秒一次就是每 20 秒白花
260ms 常驻开销（约 5% 单核）。而这个项目对 CPU 很敏感（12.9：转轮开 12% vs 关 4%）。

1. `CLAUDE_POLL_MS` 独立节奏，默认 **10000**（想追平主循环设 5000，代价自己认）。
2. **零行门控**：Herdr 里一个 `agent === "claude"` 的行都没有时连 spawn 都跳过，直接
   `agent list()` 判（实测 4ms，而 `publishInlineSessions` 每轮本来就要拉一次）。用户没在
   Herdr 里跑 claude 时零成本。

另外两条实现细节也是为了省：

- **节流命中时返回上一次的好结果，不报失败。** 主循环 5 秒、claude 10 秒，每两轮必然命中一次
  节流；若命中时报 `failed`，`publishInlineSessions` 会走「既不写也不清」，表现就是「claude 的
  状态永远停在 10 秒前那一版而且被冻住」。
- **门控时不动节流时间戳**，否则用户新起的 claude 要再等一整个 `CLAUDE_POLL_MS` 才出现。

**这两条对策的实测收益**（同一台机器、同样两个 claude 会话在跑，读 `/proc/<pid>/stat` 的
utime+stime，各测 30 秒）：

| | 单核占用 |
| --- | --- |
| 改动前（只有 opencode + codex） | 3.9% |
| 改动后（加上 claude，默认 10s 节奏 + 零行门控） | **2.5%** |

反常但实测如此：新代码那一档更低。两份数据各有 10 余个会话在采集、机器负载也在动，30 秒
窗口的噪声足以盖过几百毫秒的 spawn 差值，所以**只能当量级参考，不能当精确基准**。真正的
结论是上面那两条机制本身：spawn 有独立节奏（不会变成每 5 秒一次），且一个 claude 行都没有时
连 spawn 都不做。要精确对比得停掉其它 agent、跑更长窗口。

### 13.10 已知边界（Claude Code）

- **补报可能挑错会话**：13.6 那三种降级情况下（同目录多个会话、其中一个没出现在列表里），
  目录匹配只能按「已绑定 → 正在跑 → 最近起」排序取一个。降级时日志里会写明
  「目录匹配（降级，pid 没对上）」，看到它就知道这一行是猜的。
- **补报出来的身份会一直留在 herdr 里**：插件不会主动撤销（撤销等于把官方集成也一起抹掉）。
  关掉支持请用 `CLAUDE_ENABLED=false`，它会撤掉 token，但补报过的 `agent_session` 保持原样
  —— 那本来就是真值。
- **`MIRROR_INLINE=false`（建 pane 模式）不支持 claude**：那条路径挂的是自己的镜像 pane，
  本来就不支持 codex，claude 与 codex 对齐即可。
- **旧看板进程不认识 claude 行，会把它当成孤儿清扫**：`--mode once` 与常驻管理器并存时，
  常驻进程（改动前启动的那一份）的兜底清扫会把 claude 行上的 `$oc_sess*` 清掉。改了代码要
  重启看板标签页才生效，这是既有机制（改完 `.env` 也一样），不是 claude 特有的问题。
