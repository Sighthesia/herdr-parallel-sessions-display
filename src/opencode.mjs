// opencode.mjs —— OpenCode server 客户端。
//
// 这台机器上跑的是 opencode v2（`opencode serve --service`），它的 HTTP 面和
// v1 差别很大，所以这里做了双协议适配：
//
//   v1:  GET /global/health  -> {healthy, version}
//        GET /session?roots=true&limit=n      -> Session[]
//        GET /session/status -> { [id]: {type:"idle"|"busy"|"retry"} }
//        GET /event          -> SSE，事件名在 `event:` 字段里
//
//   v2:  GET /api/info       -> {version, pid, urls}          （v2 没有 health 路由）
//        GET /api/session?parentID=null&limit=n&order=desc  -> {data:[], cursor:{}}
//        GET /api/session/active -> {data:{ [id]: {type:"running"}}}  （缺席即非活跃）
//        GET /api/permission/request  -> {data:[...]}，靠 x-opencode-directory 头分目录
//        GET /api/session/{id}/message?limit=1&order=desc -> 末尾消息里的 retry/error
//        GET /api/event -> SSE，事件名在 data JSON 的 `type` 字段里
//
// 实测确认的坑：
//   - v2 SSE 不发 `event:` 行，只有 `data:`，事件名在 payload 的 `type` 上；还会发 `: heartbeat` 注释。
//   - v2 会话目录在 `location.directory`，不是 `directory`。
//   - v2 根会话筛选是 `parentID=null`（字符串），不是 `roots=true`。
//   - v2 的 /session/active 全局跨目录，不需要 x-opencode-directory。
//   - v2 service 模式开了 Basic Auth，用户名默认 opencode。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 8_000;

/** token 值上限，与 Herdr 的 80 字符截断保持一致。 */
export const TOKEN_MAX = 80;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 去掉尾斜杠；允许用户直接写 `.../api`。 */
export function normalizeBaseUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  return url || null;
}

function base64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

/** 只有配了密码才发 Authorization。 */
export function authHeader({ username, password }) {
  if (!password) return null;
  return `Basic ${base64(`${username || "opencode"}:${password}`)}`;
}

export class OpenCodeError extends Error {
  constructor(message, { status = 0, body = "", url = "" } = {}) {
    super(message);
    this.name = "OpenCodeError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class OpenCodeClient {
  /**
   * @param {{baseUrl:string,username?:string,password?:string,timeoutMs?:number,
   *          fetchImpl?:typeof fetch, passwordProvider?:()=>Promise<string|null>}} options
   */
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.username = options.username || "opencode";
    this.password = options.password || "";
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.passwordProvider = options.passwordProvider || null;
    /** "v2" | "v1" | null —— probe() 之前是 null */
    this.flavor = null;
    this.version = null;
    /** 收到过 401 时才去读 service.json，避免不必要的磁盘访问。 */
    this.authRetryDone = false;
  }

  /** v2 的接口都在 /api 下；v1 在根。 */
  get prefix() {
    return this.flavor === "v1" ? "" : "/api";
  }

  url(pathname, query) {
    let url = `${this.baseUrl}${this.prefix}${pathname}`;
    if (query && typeof query === "object") {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }

  /**
   * 单次 JSON 请求。401 会先用 passwordProvider 拿一次密码重试。
   * @returns {Promise<any>}
   */
  async json(pathname, { query, headers, directory, allow404 = false, timeoutMs } = {}) {
    const url = this.url(pathname, query);
    const requestHeaders = { accept: "application/json" };
    const auth = authHeader({ username: this.username, password: this.password });
    if (auth) requestHeaders.authorization = auth;
    // v2 用这个头把请求绑到某个目录（不带就是服务端默认目录）
    if (directory) requestHeaders["x-opencode-directory"] = directory;
    Object.assign(requestHeaders, headers || {});

    let res = await this.fetchImpl(url, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
    });

    if (res.status === 401 && !this.authRetryDone && this.passwordProvider) {
      const discovered = await this.passwordProvider();
      if (discovered && discovered !== this.password) {
        this.password = discovered;
        this.authRetryDone = true;
        return this.json(pathname, { query, headers, directory, allow404, timeoutMs });
      }
    }

    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const body = await safeText(res);
      throw new OpenCodeError(`HTTP ${res.status} ${pathname}`, { status: res.status, body, url });
    }
    const text = await res.text();
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // 服务端回了 HTML（SPA fallback）说明路径不对，不是 JSON 接口
      throw new OpenCodeError(`非 JSON 响应: ${pathname}`, { status: res.status, body: text.slice(0, 200), url });
    }
  }

  /**
   * 判定 baseUrl 是不是 opencode server，并确定协议版本。
   * @returns {Promise<{ok:boolean, flavor?:string, version?:string, reason?:string}>}
   */
  async probe() {
    if (!this.baseUrl) return { ok: false, reason: "no-base-url" };

    // 先试 v2：/api/info 返回 version 就认
    try {
      const info = await this.json("/info");
      if (info && typeof info === "object" && typeof info.version === "string") {
        this.flavor = "v2";
        this.version = info.version;
        return { ok: true, flavor: "v2", version: info.version };
      }
    } catch (err) {
      // v1 服务器会在这里 404 或者回 HTML，正常往下走
      if (err instanceof OpenCodeError && (err.status === 401 || err.status === 403)) {
        return { ok: false, reason: `unauthorized:${err.status}` };
      }
    }

    // 再试 v1：/global/health 返回 {healthy, version}
    const saved = this.flavor;
    this.flavor = "v1";
    try {
      const health = await this.json("/global/health");
      if (health && typeof health === "object") {
        const version = typeof health.version === "string" ? health.version : "";
        this.flavor = "v1";
        this.version = version;
        return { ok: true, flavor: "v1", version };
      }
    } catch (err) {
      this.flavor = saved;
      return { ok: false, reason: `probe-failed:${err?.status || err?.message || "unknown"}` };
    }
    this.flavor = saved;
    return { ok: false, reason: "not-opencode" };
  }

  /**
   * 所有运行中的根 session。
   *
   * v2 是分页的，默认按 updated 倒序，活跃 session 基本都在前几页。
   * 传 `wantIds` 时，一旦这些 id 全部命中就提前停止翻页 —— 否则每 5 秒轮询
   * 一次要拉几百条会话，纯属浪费。
   *
   * @param {{limit?:number, maxPages?:number, wantIds?:string[]}} options
   * @returns {Promise<Array<{id:string,title:string,directory:string,projectID:string,updatedAt:number,parentID:string}>>}
   */
  async listRootSessions({ limit = 200, maxPages = 8, wantIds } = {}) {
    if (this.flavor === "v1") {
      const payload = await this.json("/session", { query: { roots: "true", limit } });
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      return rows.filter((s) => !s?.parentID).map(normalizeSession);
    }

    const want = Array.isArray(wantIds) ? new Set(wantIds.filter(Boolean)) : null;
    const query = { parentID: "null", limit, order: "desc" };
    const out = [];
    const seen = new Set();
    let cursor = null;

    for (let page = 0; page < Math.max(1, maxPages); page += 1) {
      const payload = await this.json("/session", { query: { ...query, cursor } });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      let added = 0;
      for (const row of rows) {
        const s = normalizeSession(row);
        if (!s.id || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push(s);
        added += 1;
      }
      // 想要的都找到了就不用继续翻
      if (want && [...want].every((id) => seen.has(id))) break;
      cursor = typeof payload?.cursor?.next === "string" ? payload.cursor.next : null;
      if (!cursor || (rows.length === 0 && added === 0)) break;
    }
    return out;
  }

  /**
   * 活跃状态。返回 Map<sessionID, "busy" | "retry">；不在 map 里就是非活跃。
   * v1 的 idle 会被服务端从内存里删掉，所以 map 里只有非 idle 的。
   */
  async activeStates() {
    const out = new Map();
    if (this.flavor === "v1") {
      const payload = await this.json("/session/status");
      if (!payload || typeof payload !== "object") return out;
      for (const [id, status] of Object.entries(payload)) {
        const type = typeof status === "string" ? status : status?.type;
        if (type === "busy" || type === "retry" || type === "idle") out.set(id, type);
      }
      return out;
    }

    // v2
    const payload = await this.json("/session/active");
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!data || typeof data !== "object") return out;
    for (const [id, status] of Object.entries(data)) {
      const type = typeof status === "string" ? status : status?.type;
      // v2 只有 "running"；如果将来加了 retry 之类，这里直接认
      if (type === "retry") out.set(id, "retry");
      else if (type === "busy" || type === "running") out.set(id, "busy");
    }
    return out;
  }

  /**
   * 按 id 取单个 session 的完整信息（含 parentID）。
   *
   * 用途：候选集里出现「不在根会话列表中」的 session 时，必须查一下 parentID
   * 才能判断它是不是子 agent —— SPEC 1 的产品决策是「子 agent 不单列」。
   * 响应被包在 `{data: ...}` 里。
   *
   * @returns {Promise<null|{id:string,title:string,directory:string,parentID:string}>} 找不到返回 null
   */
  async getSession(sessionId) {
    if (!sessionId) return null;
    try {
      const payload = await this.json(`/session/${encodeURIComponent(sessionId)}`, {
        timeoutMs: 5_000,
        // 带错目录会 404，所以按 id 查时明确不带 x-opencode-directory
        directory: undefined,
      });
      const raw = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
      return normalizeSession(raw);
    } catch {
      return null;
    }
  }

  /**
   * 待回复的权限请求。权限等待是判定 blocked 最有价值的信号。
   *
   * v2：GET /api/permission/request 靠 x-opencode-directory 分目录，一次只能问一个目录，
   *      所以并发（但限流）地查多个目录再合并。目录数量由调用方收敛，
   *      通常只有活跃/已跟踪 session 涉及的那几个。
   * v1：没有已知的批量接口，返回 []，只能靠 SSE 跟踪（见 subscribe）。
   *
   * @param {string[]} directories
   * @returns {Promise<Array<{sessionID:string,action:string,at:number,id:string}>>}
   */
  async pendingPermissions(directories, { concurrency = 6 } = {}) {
    if (this.flavor === "v1") return [];
    const dirs = [...new Set((directories || []).filter(Boolean))].slice(0, 64);
    const out = [];
    const seen = new Set();

    const queue = dirs.slice();
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const dir = queue.shift();
        if (dir === undefined) return;
        let payload;
        try {
          payload = await this.json("/permission/request", { directory: dir, timeoutMs: 5_000 });
        } catch {
          continue; // 单个目录失败不影响其它目录
        }
        for (const row of Array.isArray(payload?.data) ? payload.data : []) {
          const sessionID = str(row?.sessionID);
          if (!sessionID || seen.has(sessionID)) continue;
          seen.add(sessionID);
          out.push({
            id: str(row?.id),
            sessionID,
            action: str(row?.action),
            at: Number.isFinite(row?.at) ? row.at : Date.now(),
          });
        }
      }
    });
    await Promise.all(workers);

    return out;
  }

  /**
   * 判定某 session 是否卡在「报错重试」上。
   *
   * v1：/session/status 直接给 retry，不用额外请求。
   * v2：/session/active 只有 running，重试信号在末尾 assistant 消息的 retry/error 字段里，
   *     所以这里取一条消息来判断（order=desc&limit=1，单次请求 ~100ms）。
   *
   * @returns {Promise<null|{attempt:number,message:string}>} null 表示没有重试
   */
  async retryInfo(sessionId) {
    if (this.flavor === "v1") return null;
    if (!sessionId) return null;
    let payload;
    try {
      payload = await this.json(`/session/${encodeURIComponent(sessionId)}/message`, {
        query: { limit: 1, order: "desc" },
      });
    } catch {
      return null;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const last = rows[0];
    if (!last || typeof last !== "object") return null;

    if (last.retry && typeof last.retry === "object") {
      return {
        attempt: Number.isFinite(last.retry.attempt) ? last.retry.attempt : 0,
        message: str(last.retry.error?.message) || "模型调用失败，正在重试",
      };
    }
    if (last.error && typeof last.error === "object") {
      return {
        attempt: 0,
        message: str(last.error.message) || "上次调用失败",
      };
    }
    return null;
  }

  /**
   * 订阅 SSE 事件流。
   *
   * @param {{onEvent:(ev:{type:string,data:any})=>void, onOpen?:()=>void, onClose?:(err?:Error)=>void,
   *          reconnect?:boolean}} handlers
   * @returns {Promise<{stop:()=>void}>}
   */
  async subscribe(handlers) {
    const url = this.url("/event");
    const headers = { accept: "text/event-stream" };
    const auth = authHeader({ username: this.username, password: this.password });
    if (auth) headers.authorization = auth;

    const controller = new AbortController();
    let stopped = false;
    let retryDelayMs = 1_000;

    const loop = async () => {
      while (!stopped) {
        try {
          const res = await this.fetchImpl(url, {
            headers,
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new OpenCodeError(`SSE HTTP ${res.status}`, { status: res.status });

          retryDelayMs = 1_000;
          handlers.onOpen?.();

          const decoder = new SseDecoder();
          const reader = res.body.getReader();
          const textDecoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = textDecoder.decode(value, { stream: true });
            for (const frame of decoder.push(text)) {
              const type = frame.event || frame.data?.type;
              if (!type) continue;
              handlers.onEvent({ type, data: frame.data?.data ?? frame.data });
            }
          }
          if (!stopped) handlers.onClose?.(new Error("SSE 断流"));
        } catch (err) {
          if (stopped || controller.signal.aborted) return;
          handlers.onClose?.(err);
        }
        if (stopped) return;
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(60_000, Math.round(retryDelayMs * 2));
      }
    };

    loop().catch(() => {});

    return {
      stop() {
        stopped = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === "string" ? v : "";
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/** 把 v1 / v2 的 Session.Info 收敛到同一个形状。 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") {
    return { id: "", title: "", directory: "", projectID: "", updatedAt: 0, idleAt: 0, viewedAt: 0, parentID: "" };
  }
  return {
    id: str(raw.id),
    // v1 有 title；v2 也有。缺失时留空，上层回退到 session id。
    title: str(raw.title),
    // v1: raw.directory；v2: raw.location.directory
    directory: str(raw.directory) || str(raw.location?.directory),
    projectID: str(raw.projectID),
    // v1: raw.time.updated；v2 同名
    updatedAt: num(raw.time?.updated) || num(raw.time?.created),
    // v2 的 `time.idle` / `time.viewed`。**这是「用户查看过没有」的唯一可靠信号**，
    // 见 {@link hasBeenViewedSinceIdle}。
    idleAt: num(raw.time?.idle) || 0,
    viewedAt: num(raw.time?.viewed) || 0,
    parentID: str(raw.parentID),
  };
}

/**
 * 状态映射。优先级：权限等待 > retry > busy > idle（SPEC 第 5 节）。
 *
 * @param {{pending?:{action?:string}|null, retry?:{message?:string,attempt?:number}|null,
 *          active?:string|null, idle?:boolean}} input
 * @returns {{state:"working"|"blocked"|"idle", message:string}}
 */
export function classifyState({ pending, retry, active } = {}) {
  if (pending) {
    const action = str(pending.action);
    return { state: "blocked", message: action ? `等待授权: ${action}` : "等待授权" };
  }
  if (retry) {
    const msg = sanitizeLine(retry.message) || "模型调用失败，正在重试";
    const attempt = Number.isFinite(retry.attempt) && retry.attempt > 0 ? `（第 ${retry.attempt} 次）` : "";
    return { state: "blocked", message: `${msg}${attempt}` };
  }
  if (active) return { state: "working", message: "" };
  return { state: "idle", message: "" };
}

function sanitizeLine(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// SSE 解码（纯函数，便于离线验证）
// ---------------------------------------------------------------------------

/**
 * 增量 SSE 解码器。
 *
 * 处理要点：
 *   - `\n\n` / `\r\n\r\n` 都算帧分隔
 *   - 同一帧里多行 `data:` 要用 `\n` 拼接（JSON 被拆行的情况）
 *   - `:` 开头的行是注释/心跳（v2 会发 `: heartbeat`），必须忽略
 *   - 事件名可能来自 `event:` 字段（v1），也可能只在 data JSON 的 `type` 里（v2）
 */
export class SseDecoder {
  constructor() {
    this.buffer = "";
    this.eventName = "";
  }

  /** @returns {Array<{event:string,data:any,id:string|null}>} */
  push(chunk) {
    this.buffer += String(chunk ?? "");
    const frames = [];

    // 归一化换行后再按空行切帧
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = this.#parseBlock(block);
      if (frame) frames.push(frame);
      sep = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  #parseBlock(block) {
    if (block.trim().length === 0) return null;

    const dataLines = [];
    let event = this.eventName || "";
    let id = null;

    for (const line of block.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue; // 注释 / 心跳
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") dataLines.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }

    // 帧边界（空行）重置 event 名
    this.eventName = "";

    if (dataLines.length === 0) return null;

    const raw = dataLines.join("\n");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 不是 JSON 的 data 当纯文本，交给上层决定要不要用
      parsed = { type: event || null, raw };
    }
    // 帧中间又出现空行是不合法的，这里不额外处理
    return { event, data: parsed, id };
  }
}

// ---------------------------------------------------------------------------
// server 发现
// ---------------------------------------------------------------------------

/** opencode 默认端口，先试省一轮扫描。 */
const WELL_KNOWN_PORTS = [4096];

/**
 * 从 `ss -ltnp` / `lsof` 里找出进程名含 opencode 的监听端口。
 * 返回形如 `http://127.0.0.1:49374` 的候选地址（已去重）。
 *
 * @param {{run?:(cmd:string,args:string[])=>Promise<{stdout:string}>,platform?:string}} [options]
 * @returns {Promise<string[]>}
 */
export async function discoverCandidateUrls(options = {}) {
  const platform = options.platform || process.platform;
  const run =
    options.run ||
    (async (cmd, args) => {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 4_000, maxBuffer: 4 << 20 });
      return { stdout };
    });

  const urls = new Set();
  for (const port of WELL_KNOWN_PORTS) urls.add(`http://127.0.0.1:${port}`);

  // Linux 优先 ss（更快且带进程名）
  if (platform === "linux") {
    try {
      const { stdout } = await run("ss", ["-ltnp"]);
      for (const url of parseSs(stdout)) urls.add(url);
    } catch {
      /* ss 不存在就走 lsof */
    }
  }

  try {
    const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    for (const url of parseLsof(stdout)) urls.add(url);
  } catch {
    /* 都没有就只剩显式 URL 和默认端口 */
  }

  return [...urls];
}

/**
 * 解析 `ss -ltnp` 输出，只留进程名含 opencode 的 LISTEN 行。
 * 列：State Recv-Q Send-Q Local Peer [Process]
 */
export function parseSs(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    const idx = line.indexOf("LISTEN");
    if (idx === -1) continue;

    const procMatch = /users:\(\("([^"]+)"/.exec(line);
    if (!procMatch || !/opencode/i.test(procMatch[1])) continue;

    const fields = line.trim().split(/\s+/);
    const stateIndex = fields.indexOf("LISTEN");
    const local = fields[stateIndex + 3];
    const port = portOf(local);
    if (port) out.push(`http://127.0.0.1:${port}`);
  }
  return out;
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN`。
 *
 * 真实输出的 NAME 列后面还跟着 ` (LISTEN)`，所以不能只看最后一个字段，
 * 必须从后往前找第一个「像地址」且带端口的字段。
 */
export function parseLsof(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    if (!/opencode/i.test(fields[0])) continue;
    // 表头行，以及被截断的全 0 连接行
    if (!/^\d+$/.test(fields[1])) continue;

    let port = null;
    for (let i = fields.length - 1; i >= 2; i -= 1) {
      const found = portOf(fields[i]);
      if (found) {
        port = found;
        break;
      }
    }
    if (port) out.push(`http://127.0.0.1:${port}`);
  }
  return out;
}

/** 从 `127.0.0.1:49374` / `*:5355` / `[::1]:5173` / `0.0.0.0:22` 里取端口。 */
export function portOf(address) {
  const m = /:(\d+)$/.exec(String(address || ""));
  if (!m) return null;
  const port = Number.parseInt(m[1], 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
