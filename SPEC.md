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

为「未被任何 pane 打开」的运行中根 session 分配一个**专用镜像 pane**，集中在 `Sessions` 工作区/标签页内，不查看时无感。镜像 pane 内**不运行 opencode**（避免官方集成在该 pane 二次上报造成重复行），由插件通过 Herdr 官方开放接口替它上报状态与元数据。

状态来源是 OpenCode server 自身的运行态，而非屏幕识别——这比官方集成读屏幕更准。

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

### 6.2 镜像 pane

统一放在专用工作区/标签页（默认标签名 `Sessions`），与管理面板同处一屏，不打开不占视野。

每个镜像 pane 运行一个极轻的驻留进程（Node 定时器保活即可，不依赖外部命令），插件以自己的 `source` 为它上报。上报**刻意拆成两步**：

1. `pane report-agent --state ... --agent-session-id <id>` —— 只带状态与 session id，**不带** resume argv
2. `pane report-agent-session --agent-session-id <id> -- <恢复命令>` —— 单独附上恢复命令

原因是官方文档写明 `invalid_resume_argv` 时「the report is not applied」：合成一步上报时，一个不合法的恢复命令会把 `agent_session_id` 一起丢掉，session id 白报。拆开后第 2 步失败只影响「Herdr 重启后怎么恢复」，不影响这一行本身。两步都记日志。

恢复命令为 `opencode --session <id>`（`RESUME_MODE=mirror` 时改为只恢复驻留进程），保证 Herdr 重启后仍能恢复该行。session 停止运行 → `pane release-agent` + 关闭该镜像 pane + 重平衡剩余布局，行随之消失。

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

### 6.4 布局：平衡 BSP 树

新增镜像 pane 后**重平衡整个镜像子树**，让所有镜像 pane 均分空间，而不是让锚点越来越小。

- 用 `layout.set_split_ratio`，**不用** `layout.apply`。官方文档明说 apply 会重建 tab、不保留 live PTY / scrollback / 进程，会把已有镜像 pane 全杀掉重启。
- 规则只有一条：**`ratio = first 子树的叶子数 / 该节点子树的总叶子数`**。每个叶子恰好拿到 1/N，对任意二叉树形状都成立。
- 只调整「子树里全是镜像 pane」的节点：侧边栏之类的外来 pane 不参与，它们的祖先 split 保持不动。
- 比例已到位就不重复下发（reconcile 每 5 秒跑一次，不能每轮打十几次 socket）。
- **不因为空间不足拒绝建行。** 旧设计里「每行至少 N 行」的高度守卫和 ratio 逐级退让全部删除：反复用小 ratio 拆同一个锚点，锚点自己被逐次压缩、预算很快耗尽，那不是 herdr 的限制，是切分策略错了。实测 44 行 area 下平衡 8 叶完全放得下（`viewport_rows` 2/2/3/9/9/4/3，全 > 0）；超长会有滚动。

**零高度陷阱**：herdr 对过小的 split 不报错，会静默返回 `viewport_rows: 0` 的不可见 pane（实测连切 40 次全部返回成功，第 3 个之后全是 0 行）。所以「不报错」≠「建好了」。新建 pane 后读回 `scroll.viewport_rows`，为 0 立即重平衡再读一次；仍为 0 只记一条日志 —— **但绝不因此放弃这一行**，记下来下一轮重试。

### 6.5 孤儿回收

`state.json` 丢失或多次崩溃后，Herdr 里会留下永久残行。需要按 label 认领镜像工作区，并回收所有不在映射里的 pane。重平衡时这些残行靠 `oc_mirror` token 认回来，否则整棵镜像子树会被当成「含外来 pane」而永远得不到平衡。

---

## 7. 插件配置

位于 `HERDR_PLUGIN_CONFIG_DIR/.env`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | 空 | 显式 server 地址，如 `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 空 | Basic Auth 密码 |
| `MIRROR_LABEL` | `Sessions` | 镜像所在工作区/标签名 |
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

---

## 10. 已知边界

- **一个运行中 session 一行 = 一个镜像 pane**，有终端资源成本，集中放置后不查看时无感，但不是零成本。行数很多时会需要滚动 —— 按产品决策这不构成拒绝建行的理由。
- **镜像行只读**。要交互需点进用户真实 TUI 手动切换 session。
- **状态准确性依赖 SSE 连接**。事件流断开会退化为轮询兜底，`blocked` 的权限判定精度下降；v1 无独立权限接口，断流期间该信号直接丢失。
- **v1 协议路径没有真机验证**（本机只有 v2）。v2 路径已在 `opencode 2.0.21` + Basic Auth 场景下端到端验证。
- **Windows 命名管道分支未验证**（无 Windows 环境），`agent.view.set` / `layout.set_split_ratio` 的裸 socket 客户端在 Windows 上留了 TODO。
- **不触碰官方集成文件**（`~/.config/opencode/plugins/herdr-agent-state.js` 等），避免与其抢同一 pane 的状态归属。
- **`agent.view.set` 与 `layout.set_split_ratio` 无 CLI 封装**，需自写裸 socket 客户端；`INSTALL_AGENT_VIEW` 默认关闭，未开启时不受此影响。
- **`agent_session` 落不了库**：herdr 0.9.3 只给官方集成存原生 session 引用，第三方 source 传了 `agent_session_id` 也会被省略（见 4.4）。去重因此走 `oc_session` token 回退；Herdr 重启后的原生 session 恢复在第三方 source 上不可用。
- **侧边栏行文本可能被用户自己的插件覆盖**：镜像行上报了 `oc_title` / `oc_project` / `oc_state` token，也用 `pane.rename` 设了可读 label，但 `herdr-sidebar` 的 `hs_title` token 优先级更高。插件不去改用户的 sidebar 配置，需要的话由用户自行把 `$oc_title` 拼进 sidebar 行模板。
- `RESUME_MODE=opencode` 的重启恢复未端到端验证（会真的拉起 opencode），`resume_argv` 的格式规则已按官方文档核对。
- 面板命令的输出不会进入 `herdr plugin log list`，排障需走 `herdr pane read`。