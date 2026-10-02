// codex.mjs —— Codex app-server 客户端。
//
// Codex 没有 opencode 那种 HTTP 面，它把运行态放在一个**共享 app-server 守护进程**
// 后面，走 JSON-RPC 2.0。本机实测：`codex app-server daemon version` 报
//
//   {"status":"running","backend":"pid",
//    "socketPath":"~/.codex/app-server-control/app-server-control.sock",
//    "managedCodexVersion":"0.160.0"}
//
// 守护进程命令行是 `codex app-server --listen unix:// --managed-daemon`，那个
// socketPath 是指向 /tmp/codex-daemon-<uid>/<hash> 的符号链接，**直接用符号链接
// 路径即可**，不必自己去找真实路径。
//
// ## 为什么用共享守护进程，而不是自己 spawn 一个 app-server
//
// app-server 是有状态的多用户进程：`thread/loaded/list` 反映的是「**那个**实例
// 内存里加载着的 session」。自己起一个实例的话它对用户的会话一无所知（要落盘、
// 要重新索引、状态会滞后），拿到的列表和用户真正在跑的东西对不上。共享守护进程
// 是 codex 自己管的生命周期（`--managed-daemon`），我们只当客户端，连不上就退避。
//
// ## 传输层：WebSocket over unix socket（实测踩过的坑都在下面标注）
//
// 这个 socket 上跑的**不是**裸 JSON 行 —— 裸发一串 JSON 会被直接断开。它是标准
// WebSocket 握手 + 二进制帧。Node 内置的 `WebSocket` 不支持 unix socket
// （`new WebSocket("ws://…")` 只能走 TCP），所以握手和帧编解码都自己写，只用
// 内置的 `node:http` / `node:crypto`。
//
// 坑 1：`http.request({socketPath, ...})` 之后**必须调 `req.end()`**，否则请求根本没
//        发出去，`upgrade` 事件永远不会来。
// 坑 2：客户端发往服务端的帧**必须掩码**，且掩码从「帧头长度 + 4」开始异或。
//        帧头最少 2 字节，所以 2 字节头时负载从第 6 字节开始 —— 我第一次按固定
//        偏移 4 写，服务端一直不回包（它把长度字节当负载解了），排查了很久。
// 坑 3：JSON-RPC 必须先 `initialize` 握手，否则任何请求都回
//        `{"code":-32600,"message":"Not initialized"}`。
//
// ## 为什么不读 ~/.codex/state_5.sqlite
//
// sqlite 是 tempting 的：字段全、不用管协议。但实测直接读 `threads` 表得到 **0 行**
// —— 数据还在 `state_5.sqlite-wal` 里，不做 checkpoint 读不到；就算做了还得拷一份
// WAL 出来（不能直接读正在写的库），每 5 秒一次轮询代价太大。而且 status 之类易变
// 字段在内存侧比落盘侧新。走 app-server 是「问正在运行的那个进程」，语义上更准。

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 8_000;
const UPGRADE_TIMEOUT_MS = 6_000;

/** 控制帧。客户端只主动发 ping（为了测活），其余一律回同样的码。 */
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class CodexError extends Error {
  constructor(message, { method = "", code = null } = {}) {
    super(message);
    this.name = "CodexError";
    this.method = method;
    /** JSON-RPC 错误码；传输层故障时为 null。 */
    this.code = code;
  }
}

/**
 * 守护进程 socket 路径。
 *
 * `CODEX_SOCKET` 优先 —— 调试时守护进程可能起在临时路径上，而且 `codex app-server
 * daemon version` 已经把真实路径报出来了，用户可以直接指过来。默认走官方固定路径。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function defaultSocketPath(env = process.env) {
  const explicit = String(env?.CODEX_SOCKET || "").trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

// ---------------------------------------------------------------------------
// WebSocket 帧
// ---------------------------------------------------------------------------

/**
 * 编一个**带掩码**的文本帧。
 *
 * 掩码是 RFC 6455 对「客户端 → 服务端」的硬性要求（服务端不发是因为它不验证）。
 * 掩码偏移必须跟着帧头长度走：头 2 字节时负载从第 6 字节开始、头 4 字节时第 8 字节。
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(String(text ?? ""), "utf8");
  const mask = crypto.randomBytes(4);

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | OP_TEXT; // FIN + text

  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * 增量帧解码器。喂 Buffer 进去，吐出**完整的文本消息**。
 *
 * 必须处理三类非文本帧，否则连接会在几十秒后被服务端悄悄掐掉：
 *   - ping（0x9）→ 要回 pong（0xa）
 *   - close（0x8）→ 往外抛，让调用方知道连接没了
 *   - 分片（FIN=0）→ 拼起来再吐，JSON-RPC 的大响应会被分片
 *
 * 服务端发来的帧不掩码，但解码器保留掩码处理（万一对端真掩码了也不至于解析错）。
 */
export class FrameDecoder {
  /** @param {{onPing?:(payload:Buffer)=>void}} [options] */
  constructor(options = {}) {
    this.onPing = options.onPing || null;
    this.buffer = Buffer.alloc(0);
    /** @type {{opcode:number, chunks:Buffer[]}|null} 分片累积 */
    this.fragment = null;
    this.closed = false;
  }

  /** @param {Buffer} chunk @returns {string[]} 这次解出的完整文本消息 */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const out = [];
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;
      const message = this.#handle(frame);
      if (message !== null) out.push(message);
    }
    return out;
  }

  #readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      // 单条 JSON-RPC 响应不可能有 2^53 字节；再大就是协议坏了，不要硬撑
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CodexError("帧长度异常");
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  /** @returns {string|null} 完整文本消息（控制帧返回 null） */
  #handle(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OP_CLOSE) {
      this.closed = true;
      throw new CodexError("服务端关闭了 WebSocket");
    }
    if (opcode === OP_PING) {
      this.onPing?.(payload);
      return null;
    }
    if (opcode === OP_PONG) return null;

    if (opcode === OP_CONTINUATION) {
      if (!this.fragment) return null;
      this.fragment.chunks.push(payload);
    } else if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (fin) return payload.toString("utf8");
      this.fragment = { opcode, chunks: [payload] };
      return null;
    } else {
      return null;
    }

    if (!fin) return null;
    const merged = Buffer.concat(this.fragment.chunks);
    this.fragment = null;
    return merged.toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class CodexClient {
  /**
   * @param {{socketPath?:string, clientName?:string, clientVersion?:string, timeoutMs?:number}} options
   */
  constructor(options = {}) {
    this.socketPath = options.socketPath || defaultSocketPath();
    this.clientName = options.clientName || "herdr-session-mirror";
    this.clientVersion = options.clientVersion || "1";
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    this.socket = null;
    this.decoder = null;
    this.connected = false;
    this.serverInfo = null;
    /** @type {Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:any}>} */
    this.pending = new Map();
    this.nextId = 1;
  }

  /**
   * 升级到 WebSocket 并完成 `initialize` 握手。
   *
   * 失败时必须把 socket 干净地关掉 —— 半开的 socket 会让下一次 connect() 拿到
   * 一个永远不回的连接，而 board 是每轮轮询都会重试的。
   */
  async connect() {
    const socket = await this.#upgrade();
    this.socket = socket;
    this.decoder = new FrameDecoder({ onPing: (payload) => this.#sendRaw(opcodeFrame(OP_PONG, payload)) });

    socket.on("data", (chunk) => {
      let messages = [];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        this.#failAll(err);
        this.#destroy();
        return;
      }
      for (const text of messages) this.#dispatch(text);
    });
    socket.on("error", (err) => this.#failAll(new CodexError(`codex 连接出错: ${err?.message || err}`)));
    socket.on("close", () => {
      if (!this.connected && !this.socket) return;
      this.#failAll(new CodexError("codex 连接已关闭"));
    });
    socket.on("end", () => this.#failAll(new CodexError("codex 连接结束")));

    this.connected = true;
    const info = await this.call("initialize", {
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    this.serverInfo = info && typeof info === "object" ? info : null;
    return info;
  }

  /** @returns {Promise<import("node:net").Socket>} */
  #upgrade() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, socket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(socket);
      };

      // 握手必须自己拼：内置 WebSocket 只支持 TCP，不支持 unix socket。
      // `path` 用 "/" 就够（实测 /ws、/control 同样返回 101）。
      const req = http.request({
        socketPath: this.socketPath,
        path: "/",
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      });
      const timer = setTimeout(() => {
        req.destroy();
        finish(new CodexError(`升级超时（${Math.round(UPGRADE_TIMEOUT_MS / 1000)}s）: ${this.socketPath}`));
      }, UPGRADE_TIMEOUT_MS);
      timer.unref?.();

      req.on("upgrade", (_res, socket) => finish(null, socket));
      req.on("response", (res) => {
        res.resume();
        finish(new CodexError(`未升级为 WebSocket: HTTP ${res.statusCode}`));
      });
      req.on("error", (err) => finish(new CodexError(`连不上 codex 守护进程: ${err?.message || err}`)));

      // 漏掉这行请求根本不会发出，upgrade 事件永远不来（踩过）。
      req.end();
    });
  }

  /**
   * 发一个 JSON-RPC 请求，等它的响应。
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<any>}
   */
  call(method, params = {}, { timeoutMs } = {}) {
    if (!this.socket || !this.connected) {
      return Promise.reject(new CodexError("codex 未连接", { method }));
    }
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`codex 请求超时: ${method}`, { method }));
      }, timeoutMs || this.timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, method });
      this.#sendRaw(encodeTextFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  /**
   * thread 列表，按游标翻页。
   *
   * 参数直接透传给服务端：`cwd`（字符串或数组，**服务端自己按目录过滤** —— 实测
   * 传不存在的目录返回 0 条）、`sourceKinds`、`archived`、`searchTerm`、`sortKey`、
   * `sortDirection`、`limit`。返回 `{data: Thread[], nextCursor}`。
   *
   * `wantIds` 是提前停止翻页的信号：会话多的机器上活跃 thread 可能不在第一页，
   * 而 `thread/loaded/list` 给出的就是「**真的在跑**」的那批 id，全都命中就可以停了
   * —— 和 opencode 侧 `listRootSessions({wantIds})` 同一思路。
   *
   * @param {{limit?:number, maxPages?:number, wantIds?:string[], sourceKinds?:string[], cwd?:string|string[], archived?:boolean, sortKey?:string, sortDirection?:string}} options
   * @returns {Promise<{threads:object[], nextCursor:string|null}>}
   */
  async listThreads(options = {}) {
    const { limit = 100, maxPages = 4, wantIds, sourceKinds, cwd, archived, sortKey, sortDirection } = options;
    const want = Array.isArray(wantIds) ? new Set(wantIds.filter(Boolean)) : null;

    const base = {};
    if (Array.isArray(sourceKinds) && sourceKinds.length > 0) base.sourceKinds = sourceKinds;
    if (Array.isArray(cwd) && cwd.length > 0) base.cwd = cwd;
    else if (cwd) base.cwd = String(cwd);
    if (archived !== undefined) base.archived = archived === true;
    if (sortKey) base.sortKey = sortKey;
    if (sortDirection) base.sortDirection = sortDirection;

    const out = [];
    const seen = new Set();
    let cursor = null;

    for (let page = 0; page < Math.max(1, maxPages); page += 1) {
      const params = { ...base, limit };
      if (cursor) params.cursor = cursor;
      const res = await this.call("thread/list", params);

      const rows = Array.isArray(res?.data) ? res.data : [];
      let added = 0;
      for (const row of rows) {
        const id = String(row?.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(row);
        added += 1;
      }
      // 真的在跑的那批都找到了就不用继续翻
      if (want && [...want].every((id) => seen.has(id))) return { threads: out, nextCursor: null };
      cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
      if (!cursor || (rows.length === 0 && added === 0)) break;
    }
    return { threads: out, nextCursor: cursor };
  }

  /**
   * 按 id 取单个 thread 的完整信息。返回 `{thread: Thread}`（外层有包装，别写
   * `res.cwd`，那是 undefined）。`thread/read` 对已加载但不在 `thread/list` 里的
   * thread 同样有效 —— 这条路是下面「双保险」的最后一块拼图。
   */
  async readThread(threadId) {
    const res = await this.call("thread/read", { threadId: String(threadId || ""), includeTurns: false });
    const t = res?.thread && typeof res.thread === "object" ? res.thread : res;
    return t && typeof t === "object" ? t : null;
  }

  /**
   * 当前在 app-server 内存里加载着的 thread id。
   *
   * **返回的是字符串数组**（不是对象数组）—— 这个形状很容易想当然地写成
   * `res.map(t => t.id)`，结果是全 `undefined`。
   */
  async loadedThreadIds() {
    const res = await this.call("thread/loaded/list", {});
    if (Array.isArray(res)) return res.filter((id) => typeof id === "string" && id.length > 0);
    if (Array.isArray(res?.data)) {
      return res.data
        .map((t) => (typeof t === "string" ? t : t?.id))
        .filter((id) => typeof id === "string" && id.length > 0);
    }
    return [];
  }

  /** 断开并让所有在途请求失败。幂等。 */
  close() {
    this.connected = false;
    this.#destroy();
  }

  #destroy() {
    this.#failAll(new CodexError("codex 连接已关闭"));
    const socket = this.socket;
    this.socket = null;
    this.decoder = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  #sendRaw(buffer) {
    if (!this.socket) return;
    try {
      this.socket.write(buffer);
    } catch {
      /* 连接已经烂了，close/error 事件会接手 */
    }
  }

  #dispatch(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // 认不出来的通知（比如心跳）直接跳过
    }
    // 通知没有 id，我们没订阅任何通知，忽略即可（实现靠轮询，见 SPEC 11）。
    const id = msg?.id;
    if (id === undefined || id === null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new CodexError(`codex 返回错误: ${msg.error.message || "unknown"}`, { method: entry.method, code: msg.error.code ?? null }));
      return;
    }
    entry.resolve(msg.result ?? null);
  }

  /** 断线时**必须**让所有在途请求失败，否则调用方会永远挂着（板子就不会继续轮询了）。 */
  #failAll(err) {
    if (this.pending.size === 0) return;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}

/** 构一个不带 FIN 的控制帧（pong / close 用）。 */
function opcodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(2);
  head[0] = 0x80 | opcode;
  head[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) return Buffer.concat([head, Buffer.from([0, body.length]), body]);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------
// 纯函数：字段映射与状态映射
// ---------------------------------------------------------------------------

/**
 * codex `status.type` → Herdr 展示状态。
 *
 * | codex           | herdr    |
 * | ---             | ---      |
 * | `active`        | working  |
 * | `idle`          | idle     |
 * | `systemError`   | blocked  |
 * | `notLoaded`     | null     |
 *
 * `notLoaded` 映射成 `null` 而不是 `idle`，语义是「**这个 thread 不在 app-server 内存
 * 里**」—— 也就是历史遗留的对话。用户真正开着的会话才会被加载。返回 null 表示
 * 「不显示」，调用方据此过滤。
 *
 * 状态串必须和 `formatParallelSlots` 里的标记一致：working→● blocked→▲ idle→○ retry→↻。
 */
export function mapThreadStatus(statusType) {
  switch (String(statusType || "")) {
    case "active":
      return "working";
    case "idle":
      return "idle";
    case "systemError":
      return "blocked";
    case "notLoaded":
      return null;
    default:
      return null;
  }
}

/**
 * codex Thread → 插件内部统一的 `{id, title, directory, state}`。
 *
 * 标题优先 `name`（用户改过的 thread 名），退到 `preview`（首条用户消息，通常都有），
 * 再退到占位符。目录字段就是 `cwd`。
 *
 * ## `ephemeral` 的 thread 直接返回 null
 *
 * 实测：**每建立一次 app-server 连接，共享守护进程就会造一个 `ephemeral` thread。**
 * 它们不进 `thread/list`，但会被 `thread/loaded/list` 报上来，于是「按 id 补查
 * `thread/read`」那条路径会把它们全捞回来 —— 而它们 `name`/`preview` 都是空串，
 * 侧边栏上就堆出一串 `(无标题)`（实测一次连接就多一行，界面上出现 4 行噪音）。
 *
 * schema 里对 `ephemeral` 的说明是「should not be materialized on disk」，也就是
 * 「不是一次真正的会话」，本来就不该显示。所以在这里挡掉，别让调用方各写一遍。
 *
 * @returns {{id:string,title:string,directory:string,state:string|null}|null}
 */
export function normalizeThread(t) {
  if (t?.ephemeral === true) return null;
  const title = String(t?.name || t?.preview || "").trim() || "(无标题)";
  return {
    id: String(t?.id || ""),
    title,
    directory: String(t?.cwd || ""),
    state: mapThreadStatus(t?.status?.type),
  };
}

/**
 * `sourceKinds` 枚举 → 集合判断。
 *
 * 枚举实测值：cli / vscode / exec / appServer / subAgent / subAgentReview /
 * subAgentCompact / subAgentThreadSpawn / subAgentOther / unknown。
 *
 * **注意别只填 `cli`。** 实测本机那两条 thread 的 source kind 都不是 `cli`，
 * `sourceKinds:["cli"]` 返回 0 条 —— 直接把会话镜像成「全都看不见」。默认取
 * `cli,exec,appServer,vscode`，靠**排除** `subAgent*` 来实现「子 agent 不单列」。
 */
export const DEFAULT_SOURCE_KINDS = ["cli", "exec", "appServer", "vscode"];

/** 解析逗号分隔的 `CODEX_SOURCE_KINDS`。空串或全非法时退回默认集合。 */
export function parseSourceKinds(raw) {
  const list = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_SOURCE_KINDS];
}
