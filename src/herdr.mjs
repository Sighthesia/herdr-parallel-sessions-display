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
 * 已被其它来源上报的原生 session id 集合 —— 用来避免和用户真实 TUI 那行重复。
 *
 * 关键：必须排除我们自己 source 的 agent，否则我们自己的镜像行会把自己挤掉。
 * `agent_session` 可能整个字段缺失（herdr 没存原生 session 引用），解析要容错。
 *
 * @param {object[]} [agents] 复用上次结果，省一次 CLI 调用
 * @returns {Promise<Set<string>>}
 */
export async function claimedSessionIds(agents) {
  const list = Array.isArray(agents) ? agents : await agentList();
  const mine = ownSource();
  const out = new Set();
  for (const agent of list) {
    const as = agent?.agent_session;
    if (!as || typeof as !== "object") continue;
    if (as.source === mine) continue; // 我们自己的镜像行
    const value = as.value;
    if (typeof value === "string" && value.length > 0) out.add(value);
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
 * 上报 agent 生命周期状态。resumeArgv 只在建立会话 / 换 session 时传，避免每次状态变化都重发。
 * @param {{paneId:string,state:string,seq:number,sessionId?:string,message?:string,resumeArgv?:string[]}} input
 */
export async function reportAgent({ paneId, state, seq, sessionId, message, resumeArgv }) {
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
  if (Array.isArray(resumeArgv) && resumeArgv.length > 0) {
    args.push("--");
    args.push(...resumeArgv);
  }
  return cli(args);
}

/** 只换 session 身份 + 恢复命令，不动状态。 */
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

/** 我们上报时用的 agent 标签。与官方集成同名，Agents 视图里看起来一致。 */
export const AGENT_LABEL = "opencode";

// ---------------------------------------------------------------------------
// agent.view —— 全局副作用，只有 socket API，必须显式开关
// ---------------------------------------------------------------------------

export function agentViewSet(params) {
  return socketCall("agent.view.set", params);
}

export function agentViewClear(source) {
  return socketCall("agent.view.clear", source ? { source } : {});
}
