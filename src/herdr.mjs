// herdr.mjs —— Herdr 调用封装。
//
// 原则（https://herdr.dev/docs/plugins/）：
//   1. 优先 `HERDR_BIN_PATH` + CLI —— 跨 Unix socket / Windows 命名管道可移植。
//   2. 只有 CLI 没封装的能力（agent.view.set / agent.view.clear）才写裸 socket 客户端。
//   3. 任何调用都不许抛到调用方：失败返回结构化结果，由上层记录并忽略。

import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_CLI_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 8_000;

export function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function socketPath() {
  return process.env.HERDR_SOCKET_PATH || null;
}

export function pluginId() {
  return process.env.HERDR_PLUGIN_ID || "herdr-parallel-sessions-display";
}

/** 我们自己的 source。Herdr 规范要求 plugin 用 `plugin:<HERDR_PLUGIN_ID>`。 */
export function ownSource() {
  return `plugin:${pluginId()}`;
}

/**
 * Herdr **内置集成**的 source id，规律是 `herdr:<规范 agent 名>`。
 *
 * 从 herdr 0.9.3 二进制里核过：内置集成的 hook 脚本里写死的是
 * `source = "herdr:opencode"` / `"herdr:claude"` / `"herdr:codex"` 这类值。
 * 官方集成正常上报时，`agent_session.source` 就是这个字符串。
 */
export function builtinSource(agent) {
  return `herdr:${agent}`;
}

/**
 * 以某个内置集成的身份补报一次 agent session 身份。
 *
 * ## 什么时候需要
 *
 * `pane.report_metadata` 的 `--applies-to-source` 要求**目标 source 已经在那个
 * pane 上有记录**，否则 token 挂上去立刻消失（实测：官方行没有 agent_session 时，
 * 猜一个 `herdr:codex` 去 `--applies-to-source`，写完再查 tokens 是 null）。
 *
 * codex 这边会真的缺：Codex 0.160 的 `SessionStart` hook **在 TUI 启动时不触发**
 * （二进制里是 `run_pending_session_start_hook`，挂起到会话真正开始干活才跑），
 * 于是官方行一直空着 `agent_session`，内联模式就无处可挂 —— 而这个插件的价值
 * 恰恰是「显示正在跑的会话」。
 *
 * ## 为什么这不算抢官方集成的归属
 *
 * 写进去的 `agent_session_id` 是从 **codex 自己的 app-server** 读出来的真实
 * thread id，不是我们编的。官方 hook 将来真跑起来时写的是同一个值，两边一致。
 * 反过来，不补报就等于「因为官方还没上报，所以什么都不显示」，那是更糟的结果。
 *
 * 所以这是一个**可以关掉**的行为：`CODEX_ADOPT_SESSION=false` 即回到纯被动。
 *
 * @param {{paneId:string, agent:string, sessionId:string, seq:number}} input
 */
export async function reportBuiltinAgentSession({ paneId, agent, sessionId, seq }) {
  const args = [
    "pane",
    "report-agent-session",
    paneId,
    "--source",
    builtinSource(agent),
    "--agent",
    agent,
    "--agent-session-id",
    String(sessionId),
    "--seq",
    String(seq),
  ];
  return cli(args);
}

let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return `${pluginId()}:${Date.now()}:${requestCounter}`;
}

/**
 * 同步解析可能很大的 stdout/stderr，同时保证事件循环不被卡死。
 * 用异步 spawn 而不是 execFileSync，因为 board 进程里还挂着 SSE 长连接。
 */
function spawnCapture(argv, { timeoutMs, input }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String(err?.message || err), spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n[herdr-mirror] timeout after ${timeoutMs}ms: ${argv.join(" ")}`,
        timedOut: true,
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 100_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err?.message || err), spawnError: true });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, timedOut: false });
    });

    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

/**
 * 调 Herdr CLI。永不抛错。
 * @returns {Promise<{ok:boolean,code:number|null,stdout:string,stderr:string,json:any,timedOut?:boolean,error?:string}>}
 */
export async function cli(args, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = {}) {
  const result = await spawnCapture([herdrBin(), ...args], { timeoutMs });
  const out = {
    ...result,
    json: null,
    error: result.ok ? null : firstLine(result.stderr) || `exit ${result.code}`,
  };
  if (result.stdout && result.stdout.trim().length > 0) {
    try {
      out.json = JSON.parse(result.stdout);
    } catch {
      // 非 JSON 输出不算致命，只是拿不到结构化结果
      out.json = null;
    }
  }
  return out;
}

function firstLine(text) {
  const line = String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return line ? line.slice(0, 400) : "";
}

/** 从 CLI 响应里挖 result 字段，缺字段时返回 null。 */
function resultOf(res) {
  if (!res || !res.json || typeof res.json !== "object") return null;
  const r = res.json.result;
  return r && typeof r === "object" ? r : null;
}

// ---------------------------------------------------------------------------
// 裸 socket 客户端（只用于 CLI 没有封装的方法）
// ---------------------------------------------------------------------------

function socketEndpoint() {
  const p = socketPath();
  if (!p) return null;
  // 参考官方集成 ~/.config/opencode/plugins/herdr-agent-state.js 的做法
  return process.platform === "win32" ? `\\\\.\\pipe\\${p}` : p;
}

/**
 * newline-delimited JSON 请求/响应。
 * @returns {Promise<any>} 成功时 resolve result，失败 reject（调用方自己 catch）。
 */
export function socketCall(method, params = {}, { timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS } = {}) {
  const endpoint = socketEndpoint();
  if (!endpoint) return Promise.reject(new Error("HERDR_SOCKET_PATH 未设置"));

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const socket = net.createConnection(endpoint, () => {
      socket.write(`${JSON.stringify({ id: nextRequestId(), method, params })}\n`);
    });

    // 用普通定时器而不是 socket.setTimeout：连不上的连接也必须能超时返回，
    // 否则后面的上报会被队列堵死（与官方集成同样的考虑）。
    const timer = setTimeout(() => finish(new Error(`socket 超时: ${method}`)), timeoutMs);
    timer.unref?.();

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buffer.slice(0, nl));
      } catch {
        finish(new Error(`socket 返回非 JSON: ${method}`));
        return;
      }
      if (msg && msg.error) {
        finish(new Error(`${msg.error.code || "error"}: ${msg.error.message || ""}`));
        return;
      }
      finish(null, msg?.result ?? {});
    });

    socket.on("error", (err) => finish(err));
    socket.on("end", () => finish(new Error(`socket 提前关闭: ${method}`)));
    socket.on("close", () => finish(new Error(`socket 关闭且无响应: ${method}`)));
  });
}

// ---------------------------------------------------------------------------
// 事件订阅（长连接）
// ---------------------------------------------------------------------------

/**
 * 订阅 `pane.focused`，用于「焦点落到镜像 pane 就转到该目录真正的前台 agent」。
 *
 * CLI 没有事件订阅的封装，`events.subscribe` 只能走裸 socket，所以这里维持一条
 * 长连接。断了自动退避重连 —— Herdr 重启、socket 被清理、插件热重载都会断，
 * 一次性调用撑不住。
 *
 * @param {{onFocus:(info:{paneId:string,workspaceId:string})=>void, onError?:(err:Error)=>void}} handlers
 * @returns {{stop:()=>void}} stop 幂等
 */
export function subscribePaneFocused({ onFocus, onError } = {}) {
  const endpoint = socketEndpoint();
  let socket = null;
  let stopped = false;
  let retryMs = 1_000;
  let reconnectTimer = null;
  let buffer = "";

  function scheduleReconnect() {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      retryMs = Math.min(retryMs * 2, 30_000);
      open();
    }, retryMs);
    reconnectTimer.unref?.();
  }

  function open() {
    if (stopped) return;
    if (!endpoint) {
      onError?.(new Error("HERDR_SOCKET_PATH 未设置，无法订阅 pane.focused"));
      return;
    }
    buffer = "";
    const subId = nextRequestId();
    socket = net.createConnection(endpoint, () => {
      retryMs = 1_000; // 连上就重置退避
      socket.write(
        `${JSON.stringify({
          id: subId,
          method: "events.subscribe",
          params: { subscriptions: [{ type: "pane.focused" }] },
        })}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // 事件流是 newline-delimited；一次 data 可能带来多条，也可能半条
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 心跳之类，认不出来就跳过
        }
        // 订阅应答：带 id 的是我们那条请求的回应。方法名或参数写错时服务端会
        // 在这里回错误 —— 必须报出来，否则会安静地什么都不推。
        if (msg && msg.id === subId) {
          if (msg.error) onError?.(new Error(`events.subscribe 失败: ${msg.error.code || ""} ${msg.error.message || ""}`));
          continue;
        }
        if (msg?.event !== "pane.focused") continue;
        const paneId = String(msg?.data?.pane_id || "");
        if (!paneId) continue;
        try {
          onFocus?.({ paneId, workspaceId: String(msg?.data?.workspace_id || "") });
        } catch (err) {
          onError?.(err);
        }
      }
    });

    socket.on("error", (err) => {
      onError?.(err);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      scheduleReconnect();
    });
    socket.on("close", () => scheduleReconnect());
    socket.on("end", () => scheduleReconnect());
  }

  open();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 只读查询
// ---------------------------------------------------------------------------

/** @returns {Promise<object[]>} workspaces；失败返回 [] */
export async function workspaceList() {
  const res = await cli(["workspace", "list"]);
  const r = resultOf(res);
  return Array.isArray(r?.workspaces) ? r.workspaces : [];
}

export async function tabList(workspaceId) {
  const args = ["tab", "list"];
  if (workspaceId) args.push("--workspace", workspaceId);
  const res = await cli(args);
  const r = resultOf(res);
  return Array.isArray(r?.tabs) ? r.tabs : [];
}

/**
 * 在指定工作区里开一个新标签页。
 *
 * **这是让镜像行按目录分组的关键**（SPEC 6.6）：Agents 侧边栏的分组 token 只有
 * `workspace`，没有「按目录分组」这个选项，所以镜像 pane 必须落在「用户为这个目录
 * 开的工作区」里，那一行才会归到那个分组下。镜像独占一个标签页，绝不往用户正在用的
 * 工作标签页里插 pane，多 pane 布局因此不会被挤压。
 *
 * 返回 `{root_pane, tab, type:"tab_created"}`。
 */
export async function tabCreate({ workspaceId, cwd, label, env }) {
  const args = ["tab", "create", "--no-focus"];
  if (workspaceId) args.push("--workspace", workspaceId);
  if (label) args.push("--label", label);
  if (cwd) args.push("--cwd", cwd);
  for (const [k, v] of Object.entries(env || {})) args.push("--env", `${k}=${v}`);
  const res = await cli(args);
  const r = resultOf(res);
  return r && typeof r === "object" ? r : null;
}

/** 关掉整个标签页（连同里面的 pane）。收镜像标签页用。 */
export async function tabClose(tabId) {
  if (!tabId) return { ok: false, error: "tabClose 需要 tab id" };
  return cli(["tab", "close", tabId]);
}

/** 标签页改名。central 工作区创建后把它的首个标签页也统一成镜像标签名。 */
export async function tabRename(tabId, label) {
  if (!tabId || !label) return { ok: false, error: "tabRename 需要 tab id 和 label" };
  return cli(["tab", "rename", tabId, label]);
}

export async function paneList(workspaceId) {
  const args = ["pane", "list"];
  if (workspaceId) args.push("--workspace", workspaceId);
  const res = await cli(args);
  const r = resultOf(res);
  return Array.isArray(r?.panes) ? r.panes : [];
}

/** @returns {Promise<object|null>} PaneInfo；pane 不存在返回 null */
export async function paneGet(paneId) {
  const res = await cli(["pane", "get", paneId]);
  const r = resultOf(res);
  return r && typeof r.pane === "object" ? r.pane : null;
}

/**
 * pane 的可视行数。split 会按比例瓜分高度，行数不够时新 pane 会拿到 0 行，
 * Herdr 就会返回 pane_split_failed —— 所以建镜像行前必须先看这个。
 * @returns {Promise<number|null>} 拿不到时返回 null（表示未知，不阻断）
 */
export async function paneViewportRows(paneId) {
  const pane = await paneGet(paneId);
  const rows = pane?.scroll?.viewport_rows;
  return Number.isFinite(rows) ? rows : null;
}

/** pane 里的前台进程是否已经到了 shell（用来判断能不能安全地 pane run）。 */
export async function paneForegroundNames(paneId) {
  const res = await cli(["pane", "process-info", "--pane", paneId]);
  const r = resultOf(res);
  const list = r?.process_info?.foreground_processes;
  if (!Array.isArray(list)) return null;
  return list.map((p) => String(p?.name || "")).filter((n) => n.length > 0);
}

/**
 * pane 的完整进程信息（`foreground_process_group_id` + 每个前台进程的 pid/name/cwd）。
 *
 * ## 为什么需要它
 *
 * Claude Code 的会话能和 pane **精确**对上：herdr 报的
 * `foreground_process_group_id` 与 `claude agents --json` 那一条的 `pid` 逐字节相等
 * （本机实测 w1J:p12 → 2440557 → sessionId 333dcd0a…，w1J:p14 → 2441496 → 71ad425d…）。
 * codex 那边做不到这一点，只能靠目录 + 「谁在跑 / 最近动过」去猜（见 adoptCodexSessions），
 * 所以 claude 的补报能比 codex 准得多 —— 但前提是能读到 pid。
 *
 * `foreground_processes[]` 里的 pid 也一并返回：同一个进程组里可能有多个进程，
 * 命中任何一个都算对上（包装脚本 / `sh -c` 的情况下 pgid 与 pid 会不同）。
 *
 * 实测一次约 5ms。**永不抛错**：拿不到就返回 `{ok:false}`，上层降级到目录匹配。
 *
 * @returns {Promise<{ok:boolean, processInfo:object|null, error?:string}>}
 */
export async function paneProcessInfo(paneId) {
  if (!paneId) return { ok: false, processInfo: null, error: "paneProcessInfo 需要 pane id" };
  const res = await cli(["pane", "process-info", "--pane", paneId]);
  const info = resultOf(res)?.process_info;
  if (!info || typeof info !== "object") {
    return { ok: false, processInfo: null, error: res.error || res.stderr || "没有 process_info" };
  }
  return { ok: true, processInfo: info };
}

/** @returns {Promise<object[]>} agents；失败返回 [] */
export async function agentList() {
  const res = await cli(["agent", "list"]);
  const r = resultOf(res);
  return Array.isArray(r?.agents) ? r.agents : [];
}

/**
 * 本插件的镜像行标记 token。
 * agent.record 上带这个 token 的行就是我们自己的，不能当成「被别人占用的 session」。
 */
export const MIRROR_TOKEN = "oc_mirror";

/** 镜像行用来公开 session id 的 token，`agent_session` 缺失时的去重回退来源。 */
export const MIRROR_SESSION_TOKEN = "oc_session";

/**
 * 挂在**官方** agent 行上的 token，值是「这个目录还有哪些 session 在跑」。
 *
 * 内联模式（`MIRROR_INLINE=true`）专用：配合 `pane.report_metadata` 的
 * `--applies-to-source`，能把 token 附加到官方集成那一行而不接管它，于是
 * 并行 session 的信息不需要自己的 pane，也就不需要镜像标签页。
 *
 * 侧边栏模板里写 `["$oc_par"]` 即可。没有并行 session 的行没有这个 token，
 * 那一行渲染成空。
 */
export const PARALLEL_TOKEN = "oc_par";

/**
 * 每个 session 一个 token，各占侧边栏一行（`$oc_sess1` … `$oc_sess6`）。
 *
 * ## 为什么一行一个 token
 *
 * token 的值里**换行会被去掉**（实测 `"a\nb\nc"` 存下来是 `"abc"`），所以单个
 * token 无论塞什么都只能渲染成一行。想让 N 个 session 各占一行，只能用 N 个
 * token 分别放进 N 个 row。
 *
 * ## 为什么官方 session 也在里面
 *
 * 只让插件管并行 session、官方那行用内置 `terminal_title_stripped` 的话，两种
 * 格式混在一起读不出层级：内置行缩进 2 格且没有连接线，插件行顶格带 `│ └─`，
 * 反而比它 supposed 的父节点更靠左。所以官方 session 也由插件写进来，**所有
 * session 行同一格式**（官方那个用 `▸` 点出）。
 *
 * ## 槽位数量
 *
 * **已实测空的槽位不会渲染成空白行**，所以多写槽位零视觉成本；反过来，
 * **Herdr 也会老老实实存下模板里没引用的 token**（实测 `rows` 只有 6 行时
 * `oc_sess16` 照样存进去），只是永远不会被渲染 —— 也就是「多出来的 session 静默
 * 消失、连 `+N` 都不会有」。
 *
 * 所以槽位数必须等于模板能渲染的行数。插件不自己拍这个数，而是
 * {@link detectSidebarSessionRows} 直接去读 `~/.config/herdr/config.toml` 里
 * `ui.sidebar.agents.rows` 数出来：用户往模板里加一行 `$oc_sess7`，插件下一轮就
 * 多写一个槽位，**不需要改任何配置**。用户想手动收口才设 `SESSION_ROWS`。
 *
 * ## 这组 token 与 agent 无关
 *
 * `oc_sess1..6` **不绑定某个 agent**：它挂在哪个 agent 行上，就显示那个 agent 的
 * session 列表（`opencode` 行显示 opencode 的会话，`codex` 行显示 codex 的）。
 * 侧边栏模板对所有 agent 通用，rows 里写一次 `["$oc_sess1"]` 就够了。
 *
 * 也不会互相冲突：token 是挂在**具体某个 agent 行**上的，不同 agent 的行本来
 * 就是不同的 pane，Herdr 的 metadata 按 pane 存。这就是多 agent 支持不需要新
 * token 名、也不需要 `rows_by_agent` 的原因。
 *
 * 侧边栏模板里对应写：
 *   rows = [["workspace"], ["state_icon","agent"],
 *           ["$oc_sess1"], …, ["$oc_sessN"]]
 */

/**
 * session 槽位的上限。
 *
 * **不是 16。** 实测 `ui.sidebar.agents.rows` 的 16 行上限是**整个数组**的，而模板
 * 里已经占了 2 行给 `["workspace"]` 和 `["state_icon","agent"]` —— 写成 16 个
 * session 行就是 18 行，herdr 会**整份拒绝**：
 * `sidebar layouts may contain at most 16 rows ... keeping current ui settings`。
 *
 * 所以自动探测出来的数量总是安全的（它数的就是用户自己那份模板）；这个常量只用来
 * 给 `SESSION_ROWS` 封顶，14 + 2 行表头 = 16，正好卡在 herdr 的上限内。
 */
export const MAX_SESSION_SLOTS = 14;

/**
 * 前 `count` 个 session token 的名字。
 *
 * @param {number} count 1..{@link MAX_SESSION_SLOTS}
 * @returns {string[]}
 */
export function sessionTokens(count) {
  const n = Math.min(MAX_SESSION_SLOTS, Math.max(1, Math.trunc(Number(count) || 1)));
  return Array.from({ length: n }, (_, i) => `oc_sess${i + 1}`);
}

/**
 * 从 Herdr 的 `config.toml` 里数出侧边栏模板给 session 留了几行。
 *
 * ## 为什么必须去读文件
 *
 * 真正的上限在**用户的模板**里，不在插件里。实测 `herdr pane report-metadata`
 * 对模板没引用的 token 也照样存储成功（`rows` 只有 6 行时 `oc_sess16` 照样存进去），
 * 所以「写成功」不能用来探测可渲染行数 —— 只能直接读配置。
 *
 * ## 为什么值得读
 *
 * 反过来，「只写 6 个槽位、多的折成 `+N`」是**静默降级**：用户看不到自己少了什么，
 * 也不知道改哪里能看见。读模板之后，用户往 `rows` 里加一行 `$oc_sess7`，下一轮
 * 插件就多写一个槽位，什么都不用配。
 *
 * 解析只做「数一数 `$oc_sess*` 在 `ui.sidebar.agents.rows` 里出现了几次」，
 * 不做通用 TOML —— 官方没有 TOML 解析依赖，而这个需求只需要计数。
 *
 * @param {{env?:Record<string,string|undefined>, readFile?:(p:string)=>string}} [options]
 * @returns {{count:number, path:string, ok:boolean}}
 */
export function detectSidebarSessionRows(options = {}) {
  const env = options.env || process.env;
  const read = options.readFile || ((p) => readFileSync(p, "utf8"));
  // HERDR_SOCKET_PATH 由 Herdr 注入，其所在目录就是配置目录 —— 比猜 XDG 可靠。
  const socket = env.HERDR_SOCKET_PATH || "";
  const dir = env.HERDR_CONFIG_DIR || (socket ? path.dirname(socket) : "");
  const filePath = dir ? path.join(dir, "config.toml") : "";
  if (!filePath) return { count: 0, path: "", ok: false };
  let text = "";
  try {
    text = read(filePath);
  } catch {
    return { count: 0, path: filePath, ok: false };
  }
  return { count: countSessionRows(text), path: filePath, ok: true };
}

/**
 * 数 `config.toml` 里 `ui.sidebar.agents.rows` 引了多少个 `$oc_sess*`。
 *
 * 解析只做计数，不做通用 TOML —— 官方没有 TOML 解析依赖，而这个需求只需要一个数字。
 *
 * ## 两个实测出来的坑
 *
 * **一、16 行的上限算的是整个 `rows` 数组**，不是 session 行。模板里已经有
 * `["workspace"]` 和 `["state_icon","agent"]` 两行，所以 session 行最多 14 —— 写满
 * 16 会让 herdr **整份拒绝**这份配置（`sidebar layouts may contain at most 16 rows
 * ... keeping current ui settings`），症状是「改了配置没反应」，不是报错。
 *
 * **二、找外层数组的闭合括号要按嵌套深度走。** 找第一个 `]` 会命中 `rows = [` 自己，
 * 只找一层又会停在第一个元素 `["workspace"]` 的 `]` 上 —— 两种都让结果恒为 0。
 * 表头终止符同理必须要求**顶格**，用 `^\s*\[` 会在数组第一行就误判成新表头。
 *
 * @param {string} text 整个 config.toml
 * @returns {number}
 */
export function countSessionRows(text) {
  const src = String(text || "");
  const start = src.search(/^[ \t]*\[ui\.sidebar\.agents\][ \t]*(?:#.*)?$/m);
  if (start < 0) return 0;
  const rest = src.slice(src.indexOf("\n", start) + 1);
  // 下一张表的头。**必须顶格**（`^[`，不是 `^\s*\[`）—— rows 数组的元素是缩进过的
  // `  ["workspace"],`，用 `^\s*\[` 会在数组第一行就误判成表头，section 被截断成
  // 空串，count 永远是 0。
  const next = rest.search(/^[ \t]*\[(?:[A-Za-z_][\w.-]*|"[^"]*")\][ \t]*(?:#.*)?$/m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const rowsIdx = section.search(/^[ \t]*rows[ \t]*=/m);
  if (rowsIdx < 0) return 0;
  // 从 `rows = [` 的**开括号之后**开始，按嵌套深度找**外层**数组的闭合括号。
  // 两个坑都要躲：直接找第一个 `]` 会命中 `rows = [` 自己；只找一层又会停在第一个
  // 元素 `["workspace"]` 的 `]` 上，body 里一个 `$oc_sess` 都没有，count 永远是 0。
  const afterEq = section.indexOf("=", rowsIdx);
  const open = section.indexOf("[", afterEq + 1);
  if (open < 0) return 0;
  let depth = 1;
  let i = open + 1;
  for (; i < section.length && depth > 0; i += 1) {
    const ch = section[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  const body = section.slice(open + 1, depth === 0 ? i - 1 : section.length);
  const names = body.match(/\$oc_sess(\d+)/g) || [];
  if (names.length === 0) return 0;
  // 模板里可能跳号（写了 1..6 和 16），所以按最大序号算槽位数，**不能**按个数。
  let max = 0;
  for (const raw of names) {
    const n = Number(String(raw).replace("$oc_sess", ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return Math.min(MAX_SESSION_SLOTS, max);
}

/** 算一个 agent 是不是我们自己的镜像行。 */
export function isMirrorRow(agent) {
  const tokens = agent?.tokens;
  if (tokens && typeof tokens === "object" && tokens[MIRROR_TOKEN] === "1") return true;
  return agent?.agent_session?.source === ownSource();
}

/** 当前 Herdr 里活着的镜像行数量。 */
export function countMirrorRows(agents) {
  let n = 0;
  for (const agent of agents || []) if (isMirrorRow(agent)) n += 1;
  return n;
}

/**
 * 已被其它来源上报的原生 session id 集合 —— 用来避免和用户真实 TUI 那行重复。
 *
 * 两个来源：
 *   1. `agent_session.value`（官方集成 `herdr:opencode` 一定会写）
 *   2. `tokens.oc_session`（herdr 0.9.3 对第三方 source 不落 `agent_session`，
 *      实测带 `agent_session_id` 的 report 也照样省略该字段，所以必须留这条回退）
 *
 * `agent_session` 可能整个字段缺失（herdr 没存原生 session 引用），解析要容错。
 *
 * @param {object[]} [agents] 复用本轮已拉到的结果，省一次 CLI 调用
 * @returns {Promise<Set<string>>}
 */
export async function claimedSessionIds(agents) {
  const list = Array.isArray(agents) ? agents : await agentList();
  const mine = ownSource();
  const out = new Set();

  for (const agent of list) {
    // 1) 原生 session 引用：只要不是我们自己 source 上报的，一律让出去。
    //    这条优先级最高 —— 即便那个 pane 上同时挂着我们的 oc_mirror token
    //    （理论上不会发生），也不能因此对用户可见的行再造一个重复行。
    const session = agent?.agent_session;
    const native = session?.value;
    if (typeof native === "string" && native.length > 0 && session.source !== mine) {
      out.add(native);
      continue;
    }

    // 2) 回退：herdr 0.9.3 不给第三方 source 存原生引用，只能读我们自己上报的 token。
    //    自己的镜像行直接跳过，否则下一轮会把刚建好的行当成「已有人上报」而全丢掉。
    if (isMirrorRow(agent)) continue;
    const token = agent?.tokens?.[MIRROR_SESSION_TOKEN];
    if (typeof token === "string" && token.length > 0) out.add(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 变更操作
// ---------------------------------------------------------------------------

export async function workspaceCreate({ cwd, label }) {
  const args = ["workspace", "create", "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  if (label) args.push("--label", label);
  return resultOf(await cli(args));
}

/**
 * 关掉整个工作区。只有「我们自己建的 central 兜底工作区」才会走到这里，
 * 调用前必须确认里面没有别的 agent 行（board 里那层检查是硬性的）。
 */
export async function workspaceClose(workspaceId) {
  if (!workspaceId) return { ok: false, error: "workspaceClose 需要 workspace id" };
  return cli(["workspace", "close", workspaceId]);
}

/** 一个 pane 是不是我们自己的镜像 pane（靠上报的 oc_mirror token 认）。 */
export function isMirrorPane(pane) {
  return pane?.tokens?.[MIRROR_TOKEN] === "1";
}

export async function paneSplit({ paneId, direction = "down", ratio, cwd, env }) {
  const args = ["pane", "split"];
  if (paneId) args.push(paneId);
  args.push("--direction", direction, "--no-focus");
  if (typeof ratio === "number" && Number.isFinite(ratio)) args.push("--ratio", String(ratio));
  if (cwd) args.push("--cwd", cwd);
  for (const [k, v] of Object.entries(env || {})) args.push("--env", `${k}=${v}`);
  const res = await cli(args);
  const r = resultOf(res);
  if (!r?.pane || typeof r.pane !== "object") {
    // 把失败原因带出去，否则上层只能看到「没返回 pane_id」
    const err = new Error(res.error || "pane split 未返回 pane");
    err.splitArgs = args;
    throw err;
  }
  return r.pane;
}

/** 在 pane 里敲一条命令。命令是「打进 shell 的文本」，调用方负责引号。 */
export async function paneRun(paneId, command, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = {}) {
  return cli(["pane", "run", paneId, command], { timeoutMs });
}

export async function paneClose(paneId) {
  return cli(["pane", "close", paneId]);
}

/**
 * 给 pane 起一个可读名字。
 *
 * 背景：Agents 侧边栏那一行的默认文本来自终端标题（OSC 0/2），镜像 pane 里跑的是
 * node 进程，于是整行会显示成 `'/usr/bin/node' '/ho…` 这种没用的东西。
 * pane.rename 写的 label 是独立字段，不会和终端标题打架。
 */
export async function paneRename(paneId, label) {
  const text = String(label || "").trim();
  if (!paneId || !text) return { ok: false, error: "pane_rename 需要 pane id 和 label" };
  return cli(["pane", "rename", paneId, text]);
}

/**
 * 上报 agent 生命周期状态（第 1 步）。
 *
 * **刻意不接受 resume argv。** 官方文档：`resume_argv` 非法时失败码是
 * `invalid_resume_argv` 且「the report is not applied」—— 带一个坏恢复命令
 * 会把 `agent_session_id` 一起丢掉。恢复命令必须走 {@link reportAgentSession}。
 *
 * @param {{paneId:string,state:string,seq:number,sessionId?:string,message?:string}} input
 */
/**
 * 把展示用的 token 挂到**别的 source 上报的 agent 行**上。
 *
 * 这是「完全不创建镜像 pane」的支点。`pane.report_metadata` 有个
 * `--applies-to-source`：用它就能往官方集成（`herdr:opencode`）那一行上附加
 * 自己的 token，而**不接管那一行** —— 实测 `agent` 字段和 `agent_session.source`
 * 都不受影响，官方集成随后重报（working → idle）token 也照样存活。
 *
 * 于是「这个目录还有哪些 session 在跑」可以挂在该目录官方 agent 行的
 * `oc_par` token 上，侧边栏模板引用 `$oc_par` 就能显示。
 *
 * 而且顺带白送一件事：点击那行本来就跳到官方 pane，所以「点镜像信息只跳到
 * 真正的前台 agent」不再需要 FOCUS_REDIRECT —— 没有独立的镜像行了。
 *
 * @param {object} input
 * @param {string} input.paneId        官方 agent 所在 pane
 * @param {string} input.targetSource  目标 agent 的 source（`herdr:opencode`）
 * @param {Record<string,string>} [input.tokens] 要设置的 token
 * @param {string[]} [input.clear]      要清除的 token 名
 * @param {number} input.seq
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function attachMetadata({ paneId, targetSource, tokens = {}, clear = [], seq }) {
  const args = ["pane", "report-metadata", paneId, "--source", ownSource()];
  if (targetSource) args.push("--applies-to-source", targetSource);
  for (const [k, v] of Object.entries(tokens)) {
    args.push("--token", `${k}=${String(v ?? "")}`);
  }
  for (const k of clear) args.push("--clear-token", k);
  args.push("--seq", String(seq));
  const res = await cli(args);
  if (!res.ok) return { ok: false, error: res.error || res.stderr || "report-metadata 失败" };
  return { ok: true };
}

/**
 * {@link attachMetadata} 的 socket 版本，用于高频调用（忙标记转轮）。
 *
 * ## 为什么单独开一个
 *
 * `attachMetadata` 走 CLI，也就是每帧都 spawn 一个 `herdr` 进程。实测一次约 5ms，
 * 而转轮是 150ms 一帧、每个忙着的行都要写一次 —— 4 个忙行就是 ~27 次 spawn/秒，
 * 实测吃掉 9% 单核（关掉动画是 5%，开掉是 14%）。
 *
 * 同一个 `pane.report_metadata` 方法在 socket API 上也有（herdr 的
 * `PaneReportMetadataParams` 参数完全一致，含 `applies_to_source` / `tokens` /
 * `seq`），直接发就不必 spawn。socket 不可用时退回 CLI，保证行为一致。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function attachMetadataFast({ paneId, targetSource, tokens = {}, clear = [], seq }) {
  if (!socketEndpoint()) return attachMetadata({ paneId, targetSource, tokens, clear, seq });
  const params = { pane_id: paneId, source: ownSource(), seq };
  if (targetSource) params.applies_to_source = targetSource;
  if (Object.keys(tokens).length > 0) params.tokens = { ...tokens };
  // CLI 的 --clear-token 在 socket 侧就是把 token 设成 null（schema 里 value 允许 null）
  for (const k of clear) params.tokens = { ...(params.tokens || {}), [k]: null };
  try {
    await socketCall("pane.report_metadata", params);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function reportAgent({ paneId, state, seq, sessionId, message }) {
  const args = [
    "pane",
    "report-agent",
    paneId,
    "--source",
    ownSource(),
    "--agent",
    AGENT_LABEL,
    "--state",
    state,
    "--seq",
    String(seq),
  ];
  if (sessionId) args.push("--agent-session-id", sessionId);
  if (message) args.push("--message", truncateMessage(message));
  return cli(args);
}

/**
 * 附上 session 身份与恢复命令（第 2 步）。
 *
 * 带 `resumeArgv` 时 herdr 要求上报方先通过 {@link reportAgent} 持有这个 pane，
 * 否则返回 `resume_not_accepted`。
 */
export async function reportAgentSession({ paneId, seq, sessionId, resumeArgv }) {
  const args = [
    "pane",
    "report-agent-session",
    paneId,
    "--source",
    ownSource(),
    "--agent",
    AGENT_LABEL,
    "--seq",
    String(seq),
  ];
  if (sessionId) args.push("--agent-session-id", sessionId);
  if (Array.isArray(resumeArgv) && resumeArgv.length > 0) {
    args.push("--");
    args.push(...resumeArgv);
  }
  return cli(args);
}

export async function releaseAgent({ paneId, seq }) {
  return cli([
    "pane",
    "release-agent",
    paneId,
    "--source",
    ownSource(),
    "--agent",
    AGENT_LABEL,
    "--seq",
    String(seq),
  ]);
}

/**
 * 只影响展示的 pane 元数据：标题 + 供 agent.view 过滤的 token。
 */
export async function reportMetadata({ paneId, seq, title, tokens }) {
  const args = ["pane", "report-metadata", paneId, "--source", ownSource()];
  if (seq !== undefined && seq !== null) args.push("--seq", String(seq));
  if (title) args.push("--title", title);
  for (const [k, v] of Object.entries(tokens || {})) {
    if (v === undefined || v === null || v === "") continue;
    args.push("--token", `${k}=${v}`);
  }
  return cli(args);
}

// 注意：这里**没有** `pluginPaneOpen` 之类的「开面板」封装。
// 常驻管理器早先住在 `[[panes]]` 面板里，需要用它把自己拉起来；现在管理器脱离面板
// 运行（见 board.mjs 顶部关于「为什么不再住在面板里」的说明），已经没有任何地方需要
// 主动开面板，所以这个封装删掉了 —— 留着会让人以为还能靠开面板来恢复常驻进程，
// 而那条路现在恰恰是行不通的（面板拿不到管理器锁，会立刻退出）。

/** --message 最终会进 Herdr 的通知文案，留个上限避免异常长文本。 */
function truncateMessage(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/**
 * 我们上报镜像行时用的 agent 名。
 *
 * **故意不叫 `opencode`。**
 *
 * 原因：Herdr 的 `ui.sidebar.agents.rows` 模板是**每个 agent 条目各渲染一遍**，
 * 没有分组头去重机制（`ui.sidebar.spaces` 面板倒是有 `rows`，但它只接受
 * `workspace` / `state_icon` 两个 token，列不出该 space 下的 agent）。所以只要
 * 镜像行和官方行同名，同一个工作区里每多一个并行 session，`[1] afloat` 和
 * `opencode` 就会各重复一次。
 *
 * 用一个不同的名字，就能靠 `rows_by_agent` 给镜像行单独一套模板 —— 不含
 * `workspace`、不含 `agent`，只剩状态和标题，于是它读起来就是挂在官方 agent
 * 下的一条附加信息，而不是一个平级的工作区分组。
 *
 * 名字必须匹配 `^[a-z][a-z0-9_-]{0,31}$`（Herdr 的 `invalid_agent_name`）。
 * 想让自定义模板里不出现这个名字，就别在镜像行的 rows 里放 `agent` token。
 */
export const AGENT_LABEL = "opencode-mirror";

/**
 * 镜像行在**人类可见文本**里应该显示的名字。
 *
 * 上报名要唯一（为了区分模板），显示名要好看（pane 边框标签、pane 名都用它）。
 */
export const MIRROR_DISPLAY_LABEL = "opencode";

// ---------------------------------------------------------------------------
// agent 聚焦
// ---------------------------------------------------------------------------

/**
 * 聚焦一个 agent 行（会连带切到它所在的 workspace / tab）。
 *
 * 这是「点镜像行 → 落到同目录真正的前台 agent」的执行端：Herdr 侧边栏的点击
 * 行为我们改不了（见 SPEC 7.3），只能在焦点真的落到镜像 pane 上之后，由本插件
 * 把焦点转走。
 */
export function agentFocus(target) {
  return cli(["agent", "focus", String(target || "")]);
}

/**
 * 找一个工作区里「真正的前台 agent」——也就是 Herdr 自己侦测到、且**不是**我们
 * 上报的 agent 行。
 *
 * 这是镜像行点击重定向的落点。挑不出就返回 null（调用方保持原样，让用户看到
 * 只读卡片 —— 总比弹到一个不对的 pane 好）。
 *
 * ## 为什么有 avoidTabIds
 *
 * 官方 opencode 有可能**就开在 `oc-sessions` 标签页里**（那是镜像 pane 被官方
 * 集成接管后的遗留，实测出现过）。如果不做排除，点镜像行会跳到同一个镜像标签页
 * 里的另一个 pane —— 视觉上根本没离开 oc-sessions，用户的意图（去这个目录干活）
 * 没有被满足。所以给这些标签页里的候选加一份**重罚**，让用户自己标签页里的 agent
 * 优先；用户标签页里一个都没有时，重罚不影响「有总比没有强」。
 *
 * ## 排序规则
 *
 * 先看标签页（在用户标签页里 = 0 分，在 oc-sessions 里 = 10 分），再看状态：
 * 当前聚焦的优先，其次真正在忙的（working → blocked），再是 idle / done，
 * 最后按 pane_id 稳定排序兜底。只用稳定键排序，避免落点乱跳。
 *
 * @param {string} workspaceId
 * @param {string} excludePaneId 焦点当前所在的 pane（就是那个镜像 pane）
 * @param {{avoidTabIds?: Set<string>|string[]}} [options] 这些标签页里的候选降权
 * @returns {Promise<string|null>} 目标 pane_id
 */
export async function findForegroundAgentPane(workspaceId, excludePaneId = "", options = {}) {
  const ws = String(workspaceId || "");
  if (!ws) return null;

  const res = await cli(["agent", "list"]);
  const list = resultOf(res)?.agents;
  if (!Array.isArray(list)) return null;

  const avoid = new Set(Array.isArray(options.avoidTabIds) ? options.avoidTabIds : options.avoidTabIds || []);

  const usable = list.filter((a) => {
    if (String(a?.workspace_id || "") !== ws) return false;
    if (excludePaneId && String(a?.pane_id || "") === String(excludePaneId)) return false;
    if (!a?.agent) return false;
    if (isMirrorRow(a)) return false;
    // 别的 source 上报的才算「Herdr 侦测到的前台 agent」
    const src = a?.agent_session?.source;
    if (typeof src === "string" && src.length > 0 && src === ownSource()) return false;
    return true;
  });
  if (usable.length === 0) return null;

  const rank = (a) => {
    // 落在 oc-sessions 里的候选重罚：跳过去等于没离开镜像标签页
    const tabPenalty = avoid.size > 0 && avoid.has(String(a?.tab_id || "")) ? 10 : 0;
    if (a.focused) return tabPenalty;
    switch (a.agent_status) {
      case "working":
        return tabPenalty + 1;
      case "blocked":
        return tabPenalty + 2;
      case "idle":
        return tabPenalty + 3;
      case "done":
        return tabPenalty + 4;
      default:
        return tabPenalty + 5;
    }
  };
  usable.sort((a, b) => rank(a) - rank(b) || String(a.pane_id).localeCompare(String(b.pane_id)));
  return String(usable[0].pane_id);
}

// ---------------------------------------------------------------------------
// agent.view —— 全局副作用，只有 socket API，必须显式开关
// ---------------------------------------------------------------------------

export function agentViewSet(params) {
  return socketCall("agent.view.set", params);
}

export function agentViewClear(source) {
  return socketCall("agent.view.clear", source ? { source } : {});
}

// ---------------------------------------------------------------------------
// layout —— 只有 socket API
// ---------------------------------------------------------------------------

/**
 * 读出一个标签页的 BSP 布局树。
 *
 * 返回 `{workspace_id, tab_id, zoomed, focused_pane_id, root}`，
 * `root` 是 `LayoutNode`：pane 节点 `{type:"pane", pane_id, label, cwd, command}`，
 * split 节点 `{type:"split", direction, ratio, first, second}`。
 *
 * @returns {Promise<object|null>} layout 对象；拿不到返回 null
 */
export async function layoutExport(tabId) {
  const params = tabId ? { tab_id: tabId } : {};
  const r = await socketCall("layout.export", params);
  return r && typeof r === "object" && r.layout ? r.layout : null;
}

/**
 * 调整一个已有 split 节点的比例。
 *
 * `path` 是 BSP 树的索引路径：从标签页根开始，`false` 进 first、`true` 进 second，
 * 空数组 = 标签页根。`ratio` 是 **first 子树**占父区域的比例，
 * 与 `pane split --ratio` 同一语义。
 *
 * 官方文档明说 `layout.apply` 不保留 live PTY / scrollback / 进程，
 * 所以重平衡必须走这里，绝不能用 apply。
 *
 * @returns {Promise<{ok:boolean,error?:string}>} 永不抛错
 */
export async function layoutSetSplitRatio({ tabId, path, ratio }) {
  if (!Array.isArray(path) || !Number.isFinite(ratio)) {
    return { ok: false, error: "layoutSetSplitRatio 需要 path 数组与有限 ratio" };
  }
  try {
    await socketCall("layout.set_split_ratio", { tab_id: tabId, path, ratio });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
