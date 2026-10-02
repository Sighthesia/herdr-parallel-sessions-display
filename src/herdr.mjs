// herdr.mjs —— Herdr 调用封装。
//
// 原则（https://herdr.dev/docs/plugins/）：
//   1. 优先 `HERDR_BIN_PATH` + CLI —— 跨 Unix socket / Windows 命名管道可移植。
//   2. 只有 CLI 没封装的能力（agent.view.set / agent.view.clear）才写裸 socket 客户端。
//   3. 任何调用都不许抛到调用方：失败返回结构化结果，由上层记录并忽略。

import net from "node:net";
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
  return process.env.HERDR_PLUGIN_ID || "opencode.session-mirror";
}

/** 我们自己的 source。Herdr 规范要求 plugin 用 `plugin:<HERDR_PLUGIN_ID>`。 */
export function ownSource() {
  return `plugin:${pluginId()}`;
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
 * **已实测空的槽位不会渲染成空白行**，所以槽位可以放心加。`rows` 最多 16 行，
 * 现在用 2 + 6 = 8 行，余量充足。要增减就同时改这里和 config.toml 的 `rows`。
 *
 * 侧边栏模板里对应写：
 *   rows = [["workspace"], ["state_icon","agent"],
 *           ["$oc_sess1"], …, ["$oc_sess6"]]
 */
export const SESSION_TOKENS = ["oc_sess1", "oc_sess2", "oc_sess3", "oc_sess4", "oc_sess5", "oc_sess6"];

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

export async function pluginPaneOpen({ plugin, entrypoint, placement }) {
  const args = ["plugin", "pane", "open", "--plugin", plugin, "--entrypoint", entrypoint, "--no-focus"];
  if (placement) args.push("--placement", placement);
  return cli(args);
}

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
