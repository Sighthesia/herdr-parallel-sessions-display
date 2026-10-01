// board.mjs —— 常驻管理器。
//
// 为什么管理器必须以「插件面板」的形式存在：
// SPEC 6.1 + 官方文档都写明 [[startup]] 是一次性初始化钩子，不是受监管的守护进程，
// 所以常驻逻辑放在 [[panes]] id = "board" 的面板进程里。
//
// 四种运行模式：
//   --mode startup   一次性：重放 agent 视图投影、（可选）拉起面板，然后退出
//   --mode pane      常驻管理器：发现 server → SSE + 轮询 → 增删镜像 pane → 上报
//   --mode action    由 [[actions]] 触发，通过 STATE_DIR 里的请求文件与常驻进程通信
//   --mode once      自检 / 调试用：跑一轮重算就退出

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import * as herdr from "./herdr.mjs";
import * as store from "./state.mjs";
import {
  OpenCodeClient,
  OpenCodeError,
  classifyState,
  discoverCandidateUrls,
  normalizeBaseUrl,
} from "./opencode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT || path.resolve(HERE, "..");
const MIRROR_SCRIPT = path.join(HERE, "mirror.mjs");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const loaded = store.loadConfig(process.env);
const raw = loaded.values;
const config = {
  serverUrl: store.asString(raw, "OPENCODE_SERVER_URL", ""),
  username: store.asString(raw, "OPENCODE_SERVER_USERNAME", "opencode"),
  password: store.asString(raw, "OPENCODE_SERVER_PASSWORD", ""),
  mirrorLabel: store.asString(raw, "MIRROR_LABEL", "Sessions"),
  autoStart: store.asBool(raw, "AUTO_START", false),
  installAgentView: store.asBool(raw, "INSTALL_AGENT_VIEW", false),
  agentViewScope: store.asEnum(raw, "AGENT_VIEW_SCOPE", ["mirror", "sort-only"], "mirror"),
  pollIntervalMs: store.asInt(raw, "POLL_INTERVAL_MS", 5_000, 1_000, 600_000),
  idleGraceMs: store.asInt(raw, "IDLE_GRACE_MS", 15_000, 0, 3_600_000),
  resumeMode: store.asEnum(raw, "RESUME_MODE", ["opencode", "mirror"], "opencode"),
  paneRatio: store.asFloat(raw, "MIRROR_PANE_RATIO", 0.25, 0.02, 0.9),
  minPaneRows: store.asInt(raw, "MIN_PANE_ROWS", 3, 1, 40),
  paneDirection: store.asEnum(raw, "MIRROR_PANE_DIRECTION", ["down", "right"], "down"),
  sessionLimit: store.asInt(raw, "SESSION_LIST_LIMIT", 200, 10, 2_000),
  sessionPages: store.asInt(raw, "SESSION_PAGE_LIMIT", 8, 1, 50),
  retryDetection: store.asBool(raw, "RETRY_DETECTION", true),
  retryCheckLimit: store.asInt(raw, "RETRY_CHECK_LIMIT", 8, 0, 64),
  autoAuth: store.asBool(raw, "AUTO_AUTH_SERVICE_JSON", true),
  backoffMaxMs: store.asInt(raw, "DISCOVERY_BACKOFF_MAX_MS", 60_000, 5_000, 600_000),
  logLevel: store.asEnum(raw, "LOG_LEVEL", ["debug", "info", "warn", "error", "silent"], "info"),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(PLUGIN_ROOT, ".state");
const LOCK_FILE = path.join(STATE_DIR, "board.lock");
const SYNC_FLAG = path.join(STATE_DIR, "sync.request");
const REAP_FLAG = path.join(STATE_DIR, "reap.request");
const MIRROR_PREFIX = "oc_";

/** 镜像空间不足时的退避时长。 */
const SPACE_BACKOFF_MS = 60_000;

function log(level, ...args) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = `[herdr-oc-mirror] ${new Date().toISOString().slice(11, 19)} ${level.toUpperCase()} ${args
    .map((a) => (typeof a === "string" ? a : safeJson(a)))
    .join(" ")}\n`;
  try {
    process.stderr.write(line);
  } catch {
    /* stderr 断了也不能影响主流程 */
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// seq：跨进程重启单调递增
// ---------------------------------------------------------------------------

let seqCounter = 0;

function primeSeq(persisted) {
  seqCounter = Math.max(seqCounter || 0, Number.isFinite(persisted) ? persisted : 0, Date.now());
}

function nextSeq() {
  // 同一毫秒内多次上报也必须严格递增，否则 Herdr 会拒收
  seqCounter = Math.max(seqCounter + 1, Date.now());
  return seqCounter;
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

const runtime = {
  state: null,
  client: null,
  clientBaseUrl: null,
  /** SSE 跟踪到的待回复权限：sessionID -> {action, at} */
  pendingPermissions: new Map(),
  sseUp: false,
  discovery: {
    /** 距离下次允许再试的时间戳，退避用 */
    nextAttemptAt: 0,
    backoffMs: 1_000,
    consecutiveFailures: 0,
    lastError: null,
  },
  inFlight: false,
  queued: false,
  sse: null,
  /**
   * 「镜像空间不足」的退避表。窗口太矮或镜像行太多时 pane split 会失败，
   * 记一笔就能避免每轮都对着同一个矮窗口反复 split 刷警告。
   * key = sessionID，值 = 退避到什么时候。
   */
  spaceBlocked: new Map(),
  timers: [],
  shuttingDown: false,
};

// ---------------------------------------------------------------------------
// 模式分发
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const MODE = flagValue("--mode") || "pane";
const ACTION = flagValue("--action");

async function main() {
  switch (MODE) {
    case "startup":
      return modeStartup();
    case "pane":
      return modePane();
    case "action":
      return modeAction(ACTION);
    case "once":
      return modeOnce();
    default:
      log("error", `未知模式: ${MODE}`);
      process.exitCode = 2;
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// startup：一次性
// ---------------------------------------------------------------------------

async function modeStartup() {
  if (!process.env.HERDR_PLUGIN_ID) {
    // 不在 Herdr 里被调用时安静退出，不要污染用户终端
    return;
  }

  const state = await store.readState(STATE_DIR);
  primeSeq(state.lastSeq);

  log("info", `startup 钩子（配置目录 ${loaded.configDir || "无"}）`);

  // 1) 重放 agent 视图投影 —— 官方文档推荐的「state dir 存声明式视图 + startup 重放」
  if (config.installAgentView) {
    runtime.state = state;
    await applyAgentView(state, { reason: "startup" });
  } else if (state.agentView) {
    // 用户刚把开关关掉：把之前装上的投影清掉
    runtime.state = state;
    await clearAgentView(state, "startup: INSTALL_AGENT_VIEW 已关闭");
    state.agentView = null;
    persistState();
  }

  // 2) 可选拉起常驻管理器
  if (config.autoStart) {
    await ensureBoardRunning();
  } else {
    log("info", "AUTO_START=false，不自动拉起管理器（用 prefix+shift+o 或插件 action 打开）");
  }

  // startup 钩子必须自己退出
  return undefined;
}

async function ensureBoardRunning() {
  if (await boardIsRunning()) {
    log("info", "管理器已在运行");
    return true;
  }
  const res = await herdr.pluginPaneOpen({
    plugin: herdr.pluginId(),
    entrypoint: "board",
    placement: "tab",
  });
  if (res.ok) {
    log("info", "已拉起管理器面板");
    return true;
  }
  log("warn", `拉起管理器失败: ${res.error}`);
  return false;
}

async function boardIsRunning() {
  const pid = await store.readPidFile(LOCK_FILE);
  return pid !== null && store.pidAlive(pid);
}

// ---------------------------------------------------------------------------
// action：由 [[actions]] 触发
// ---------------------------------------------------------------------------

async function modeAction(action) {
  if (!process.env.HERDR_PLUGIN_ID) return;

  if (action === "board") {
    const res = await herdr.pluginPaneOpen({
      plugin: herdr.pluginId(),
      entrypoint: "board",
      placement: "tab",
    });
    if (!res.ok) {
      log("warn", `打开看板失败: ${res.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === "sync" || action === "reap") {
    // 请求文件：常驻进程每轮都会检查
    const flag = action === "sync" ? SYNC_FLAG : REAP_FLAG;
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(flag, `${Date.now()}\n`, "utf8");
    } catch (err) {
      log("warn", `写入请求文件失败: ${err?.message}`);
      process.exitCode = 1;
      return;
    }
    if (!(await boardIsRunning())) {
      log("info", "管理器没在跑，先把它拉起来");
      await ensureBoardRunning();
    }
    return;
  }

  log("error", `未知 action: ${action}`);
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// once：自检
// ---------------------------------------------------------------------------

async function modeOnce() {
  // 自检模式：不抢常驻锁，免得调试时被正在运行的管理器挡掉
  runtime.state = await store.readState(STATE_DIR);
  primeSeq(runtime.state.lastSeq);
  await reconcile("once");
  persistState();
  runtime.sse?.stop?.();
  // 一次性模式不常驻：跑完就断开 SSE，否则 fetch 的连接会吊住进程
  runtime.client = null;
  return undefined;
}

// ---------------------------------------------------------------------------
// pane：常驻管理器
// ---------------------------------------------------------------------------

async function modePane() {
  if (!process.env.HERDR_PLUGIN_ID) return;

  if (!(await acquireBoardLock())) {
    log("info", "已有一个管理器在运行，这个面板退出");
    return;
  }

  runtime.state = await store.readState(STATE_DIR);
  primeSeq(runtime.state.lastSeq);

  // 接管历史映射：上次残留的 pane 可能已经没了，逐个验证
  await validateTrackedPanes();

  installSignalHandlers();
  await reconcile("启动"); // 先把 client 建起来，reconcile 内部会顺带开 SSE

  runtime.timers.push(
    setInterval(() => {
      void drainRequestFlags();
      void reconcile("轮询");
    }, config.pollIntervalMs),
  );

  // Herdr 重启后 startup 钩子已经重放过视图，这里兜底再确认一次
  if (config.installAgentView) {
    await applyAgentView(runtime.state, { reason: "pane 启动" });
  }

  log("info", `管理器已启动（pane=${process.env.HERDR_PANE_ID || "?"}，轮询 ${config.pollIntervalMs}ms）`);
  return undefined;
}

async function acquireBoardLock() {
  const existing = await store.readPidFile(LOCK_FILE);
  if (existing !== null && existing !== process.pid && store.pidAlive(existing)) return false;
  await store.writePidFile(LOCK_FILE);
  return true;
}

async function releaseBoardLock() {
  const pid = await store.readPidFile(LOCK_FILE);
  if (pid === process.pid) await store.removeFile(LOCK_FILE);
}

function installSignalHandlers() {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      if (runtime.shuttingDown) return;
      runtime.shuttingDown = true;
      log("info", `收到 ${signal}，退出管理器（镜像行保留，下次启动会恢复）`);
      for (const timer of runtime.timers) clearInterval(timer);
      void (async () => {
        persistState();
        await releaseBoardLock();
        process.exit(0);
      })();
    });
  }
}

/** 请求文件里只存时间戳，用来判断「有没有待处理的 action」。 */
async function readFlag(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function drainRequestFlags() {
  if (await readFlag(SYNC_FLAG)) {
    await store.removeFile(SYNC_FLAG);
    log("info", "收到 sync action，立即重算");
    await reconcile("sync-action");
  }
  if (await readFlag(REAP_FLAG)) {
    await store.removeFile(REAP_FLAG);
    log("info", "收到 reap action，回收所有镜像行");
    await reapAll("action");
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * 保证恰好有一条 SSE 连接指向当前 client。
 *
 * subscribe() 内部的循环自己负责重连，所以这里只在 client 换了对象时才重开，
 * 否则每轮轮询都会新开一条连接泄漏出去。
 */
async function ensureEventStream(client) {
  if (runtime.sse && runtime.sse.client === client) return;
  if (runtime.sse) {
    try {
      runtime.sse.stop();
    } catch {
      /* ignore */
    }
  }

  let handle;
  try {
    handle = await client.subscribe({
      onOpen: () => {
        runtime.sseUp = true;
        log("info", `SSE 已连接（opencode ${client.version || "?"}，协议 ${client.flavor}）`);
        scheduleReconcile("sse-open");
      },
      onClose: (err) => {
        if (runtime.sseUp) log("warn", `SSE 断开，退化为轮询：${err?.message || "unknown"}`);
        runtime.sseUp = false;
      },
      onEvent: onOpenCodeEvent,
    });
  } catch (err) {
    runtime.sseUp = false;
    log("warn", `SSE 订阅失败，退化为轮询：${err?.message || err}`);
    return;
  }
  runtime.sse = { client, stop: handle.stop };
}

/** SSE 事件 → 权限跟踪 + 去抖触发重算。事件名在 v1 是 event 名，在 v2 是 payload.type。 */
function onOpenCodeEvent(event) {
  const type = String(event?.type || "");
  const data = event?.data;

  if (type === "permission.asked") {
    const sessionID = data?.sessionID;
    if (typeof sessionID === "string" && sessionID.length > 0) {
      runtime.pendingPermissions.set(sessionID, {
        action: typeof data?.action === "string" ? data.action : "",
        at: Number.isFinite(data?.at) ? data.at : Date.now(),
      });
      log("debug", `权限等待: ${sessionID} ${data?.action || ""}`);
      scheduleReconcile("permission.asked");
    }
    return;
  }

  if (type === "permission.replied") {
    const sessionID = data?.sessionID;
    if (typeof sessionID === "string" && runtime.pendingPermissions.delete(sessionID)) {
      log("debug", `权限已回复: ${sessionID}`);
      scheduleReconcile("permission.replied");
    }
    return;
  }

  // v1 的状态事件也用一下，让 busy/idle 切换更跟手
  if (type === "session.status" || type === "session.idle" || type === "session.updated") {
    scheduleReconcile(type);
    return;
  }

  // 其余事件只用来感知「有动静」，不去抖到全量重算
  if (type.startsWith("session.") || type === "project.updated") {
    scheduleReconcile(type);
  }
}

let reconcileTimer = null;
function scheduleReconcile(reason) {
  if (reconcileTimer) return; // 去抖：2 秒内的事件合并成一次重算
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile(`event:${reason}`);
  }, 2_000);
}

// ---------------------------------------------------------------------------
// server 发现
// ---------------------------------------------------------------------------

/**
 * 拿到一个可用的 OpenCodeClient。失败时按退避静默重试，不刷错误日志（SPEC 9.7）。
 * @returns {Promise<OpenCodeClient|null>}
 */
async function getClient() {
  const now = Date.now();

  // 已经连上的 client 直接复用；真的连不上了会在 reconcile 的 catch 里被丢弃。
  if (runtime.client) {
    runtime.state.server.lastOkAt = now;
    return runtime.client;
  }

  if (now < runtime.discovery.nextAttemptAt) return null;

  // 显式 URL 优先
  const explicit = normalizeBaseUrl(config.serverUrl);
  const candidates = [];
  if (explicit) candidates.push(explicit);
  else {
    try {
      candidates.push(...(await discoverCandidateUrls()));
    } catch (err) {
      log("debug", `端口扫描失败：${err?.message || err}`);
    }
  }

  if (candidates.length === 0) {
    failDiscovery("没找到任何候选地址（opencode server 可能在跑但端口扫不到）");
    return null;
  }

  for (const baseUrl of candidates) {
    const client = new OpenCodeClient({
      baseUrl,
      username: config.username,
      password: config.password,
      passwordProvider: config.autoAuth ? readServicePassword : null,
    });
    try {
      const probe = await client.probe();
      if (!probe.ok) {
        // 401 是配置问题，值得说一次；其它就是「这个端口不是 opencode」
        if (String(probe.reason || "").startsWith("unauthorized")) {
          log("warn", `${baseUrl} 需要认证：设置 OPENCODE_SERVER_PASSWORD，或开 AUTO_AUTH_SERVICE_JSON`);
        }
        log("debug", `跳过 ${baseUrl}: ${probe.reason}`);
        continue;
      }
      if (explicit && runtime.clientBaseUrl && runtime.clientBaseUrl !== baseUrl) {
        log("info", `server 切换: ${runtime.clientBaseUrl} -> ${baseUrl}`);
      }
      runtime.client = client;
      runtime.clientBaseUrl = baseUrl;
      runtime.discovery.consecutiveFailures = 0;
      runtime.discovery.backoffMs = 1_000;
      runtime.discovery.nextAttemptAt = 0;
      runtime.state.server = {
        baseUrl,
        flavor: probe.flavor,
        version: probe.version || "",
        lastOkAt: now,
      };
      log("info", `已连接 opencode ${probe.version || "?"} @ ${baseUrl}（协议 ${probe.flavor}）`);
      // 换了 server 就把旧的权限缓存丢掉
      runtime.pendingPermissions.clear();
      // SSE 指向新 client（内部自带重连，所以只在 client 换对象时才重开）
      await ensureEventStream(client);
      return client;
    } catch (err) {
      log("debug", `探测 ${baseUrl} 抛异常: ${err?.message || err}`);
    }
  }

  failDiscovery("所有候选地址都不可达");
  return null;
}

function failDiscovery(reason) {
  const d = runtime.discovery;
  d.consecutiveFailures += 1;
  if (d.consecutiveFailures === 1 || d.consecutiveFailures % 5 === 0) {
    // 只在第一次和每五次失败时说一句，避免刷屏
    log("warn", `${reason}，${Math.round(d.backoffMs / 1000)}s 后重试`);
  }
  d.lastError = reason;
  d.backoffMs = Math.min(config.backoffMaxMs, Math.round(d.backoffMs * 2));
  d.nextAttemptAt = Date.now() + d.backoffMs;
}

async function readServicePassword() {
  try {
    const text = await fs.readFile(store.serviceJsonPath(process.env), "utf8");
    const password = JSON.parse(text)?.password;
    return typeof password === "string" && password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 重算主流程
// ---------------------------------------------------------------------------

async function reconcile(reason) {
  if (runtime.shuttingDown) return;
  if (runtime.inFlight) {
    runtime.queued = true;
    return;
  }
  runtime.inFlight = true;

  try {
    const client = await getClient();
    if (!client) return; // 不可达：静默等退避

    // 先拿活跃集合 —— 它决定我们关心哪些 session，也就决定了要查哪些目录。
    // 顺序反过来会变成「每 5 秒拉几百条会话 + 扫几十个目录」，完全没必要。
    const activeStates = await client.activeStates();

    // 第一页通常就覆盖了全部活跃 session；不够再按 wantIds 续翻。
    let roots = await client.listRootSessions({ limit: config.sessionLimit, maxPages: 1 });
    const known = new Set(roots.map((r) => r.id));
    const missing = [...activeStates.keys()].filter((id) => !known.has(id));
    if (missing.length > 0) {
      roots = await client.listRootSessions({
        limit: config.sessionLimit,
        maxPages: config.sessionPages,
        wantIds: missing,
      });
    }

    // 权限轮询只查「活跃 session 的目录 ∪ 已跟踪行的目录」，
    // 而不是全部根会话的目录（后者在这台机器上有 40 个，串行查要几十秒）。
    const byId = new Map(roots.map((r) => [r.id, r]));
    const directories = new Set();
    for (const id of activeStates.keys()) {
      const dir = byId.get(id)?.directory;
      if (dir) directories.add(dir);
    }
    for (const rec of Object.values(runtime.state.panes)) {
      if (rec.directory) directories.add(rec.directory);
    }

    const polledPermissions = await client.pendingPermissions([...directories]);

    await applySessionState({ client, roots, activeStates, polledPermissions, reason });
  } catch (err) {
    if (isTransportError(err)) {
      // server 掉了/换端口了：丢掉 client，让下一轮重新走发现流程
      log("warn", `opencode 连接中断，${Math.round(runtime.discovery.backoffMs / 1000)}s 后重新发现: ${err?.message || err}`);
      dropClient();
    } else if (err instanceof OpenCodeError) {
      log("debug", `opencode 请求失败: ${err.message}`);
    } else {
      log("warn", `重算出错: ${err?.message || err}`);
      if (err?.stack && config.logLevel === "debug") log("debug", err.stack);
    }
  } finally {
    runtime.inFlight = false;
    persistState();
    if (runtime.queued && !runtime.shuttingDown) {
      runtime.queued = false;
      setTimeout(() => void reconcile("queued"), 300);
    }
  }
}

/**
 * 把 opencode 的运行态映射到 Herdr 镜像行。
 *
 * 流程：
 *   1. 回收：不再活跃且过了宽限期的行 → release-agent + 关 pane
 *   2. 建行：活跃（busy / 权限等待）的根 session，减去已被别人上报的 → 建/复用一个镜像 pane
 *   3. 上报：状态或元数据变了才调 herdr，避免噪音
 */
async function applySessionState({ client, roots, activeStates, polledPermissions, reason }) {
  const now = Date.now();

  // 权限等待 = SSE 跟踪的 ∪ 轮询到的（轮询能覆盖 SSE 刚断的那段）
  const pending = new Map(runtime.pendingPermissions);
  for (const row of polledPermissions) pending.set(row.sessionID, row);
  runtime.pendingPermissions = pending;

  const infoById = new Map();
  for (const s of roots) infoById.set(s.id, s);

  // 已经被其它来源（官方集成）上报的 session 必须让出去，否则会出现重复行
  const claimed = await herdr.claimedSessionIds();

  // --- 1. 回收 -----------------------------------------------------------
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    const active = activeStates.has(sessionID) || pending.has(sessionID);
    if (active) {
      rec.idleSince = 0;
      continue;
    }
    if (!rec.idleSince) rec.idleSince = now;
    const graceLeft = config.idleGraceMs - (now - rec.idleSince);
    if (graceLeft <= 0) {
      await teardownMirror(sessionID, rec, "停止运行且已过宽限期");
    }
  }

  // --- 2. 决定要保留哪些行 ------------------------------------------------
  /** @type {Array<{id:string,title:string,directory:string,projectID:string}>} */
  const wanted = [];

  // 2a. 当前活跃的根 session
  //
  // 注意「不在根会话列表里」的 session 不能直接建行：它可能是个子 agent。
  // SPEC 1 明确「子 agent 不单列」，所以要按 id 查一次 parentID 确认。
  for (const [sessionID, activeType] of activeStates) {
    if (claimed.has(sessionID)) continue;

    const info = infoById.get(sessionID);
    if (info) {
      wanted.push(info);
      continue;
    }

    const probed = await client.getSession(sessionID);
    if (!probed) {
      // 连单条都查不到（可能刚被删）：不建行，等下一轮
      log("debug", `活跃 session ${shortId(sessionID)} 查不到明细，本轮跳过`);
      continue;
    }
    if (probed.parentID) {
      log("debug", `${shortId(sessionID)} 是 ${shortId(probed.parentID)} 的子 agent，不单列`);
      continue;
    }
    wanted.push(probed);
  }

  // 2b. 正在等权限的 session —— 哪怕它已经不在 active 里也必须保留 blocked 行
  for (const sessionID of pending.keys()) {
    if (claimed.has(sessionID)) continue;
    if (wanted.some((w) => w.id === sessionID)) continue;
    const info = infoById.get(sessionID);
    if (info) {
      wanted.push(info);
      continue;
    }
    const probed = await client.getSession(sessionID);
    if (probed && !probed.parentID) wanted.push(probed);
  }

  // 2c. 还在宽限期内、暂时空闲的行：保持 idle 显示
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    if (wanted.some((w) => w.id === sessionID)) continue;
    if (!rec.idleSince) continue; // 没有 idleSince 说明它还活跃（上面已处理）
    wanted.push({
      id: sessionID,
      title: rec.title,
      directory: rec.directory,
      projectID: "",
    });
  }

  // --- 3. 逐个确保 pane 存在并上报 ---------------------------------------
  // retry 探测只对「活跃且没被权限挡住」的 session 做，且数量封顶
  const retryBudget = config.retryDetection ? config.retryCheckLimit : 0;
  let retryUsed = 0;

  for (const info of wanted) {
    if (runtime.shuttingDown) return;
    if (!store.isValidSessionId(info.id)) {
      log("debug", `跳过非法 session id: ${String(info.id).slice(0, 40)}`);
      continue;
    }

    const pendingPerm = pending.get(info.id) || null;
    const activeType = activeStates.get(info.id) || null;

    let retry = null;
    if (!pendingPerm && activeType === "retry") {
      retry = { attempt: 0, message: "重试中" };
    } else if (!pendingPerm && activeType === "busy" && retryUsed < retryBudget) {
      retryUsed += 1;
      retry = await client.retryInfo(info.id);
    }

    const { state, message } = classifyState({ pending: pendingPerm, retry, active: activeType });

    let rec = runtime.state.panes[info.id];
    if (!rec) {
      rec = {
        paneId: "",
        title: "",
        directory: "",
        state: "",
        stateMessage: "",
        idleSince: 0,
        reportedAt: 0,
        fingerprint: "",
        lastState: "",
        lastStateMessage: "",
        lastResume: "",
      };
      runtime.state.panes[info.id] = rec;
    }

    if (!rec.paneId) {
      // 空间不足导致的跳过是有原因的，退避期内不要再试，避免每轮刷警告
      const blockedUntil = runtime.spaceBlocked.get(info.id) || 0;
      if (blockedUntil > now) continue;

      const created = await createMirrorPane(info);
      if (!created) {
        runtime.spaceBlocked.set(info.id, Date.now() + SPACE_BACKOFF_MS);
        continue;
      }
      runtime.spaceBlocked.delete(info.id);
      rec.paneId = created;
      log("info", `新建镜像行 ${shortId(info.id)} → ${created} 「${info.title || "(无标题)"}」`);
    }

    rec.title = info.title || rec.title || "";
    rec.directory = info.directory || rec.directory || "";
    rec.state = state;
    rec.stateMessage = message;

    if (state === "idle") {
      if (!rec.idleSince) rec.idleSince = now;
    } else {
      rec.idleSince = 0;
    }

    await reportMirror(info.id, rec);
  }

  // --- 4. 写镜像 pane 的显示状态 ------------------------------------------
  await publishMirrorSnapshots();

  log(
    "debug",
    `重算(${reason}): 根 ${roots.length} / 活跃 ${activeStates.size} / 待权限 ${pending.size} / ` +
      `让出 ${claimed.size} / 镜像行 ${Object.keys(runtime.state.panes).length} / SSE ${runtime.sseUp ? "up" : "down"}`,
  );
}

function hasRow(sessionID) {
  return Object.prototype.hasOwnProperty.call(runtime.state.panes, sessionID);
}

/** 是不是「连接层」错误 —— 只有这类才值得丢掉 client 重新发现。 */
function isTransportError(err) {
  if (err instanceof OpenCodeError) {
    if (err.status === 0) return true;
    return err.status === 502 || err.status === 503 || err.status === 504;
  }
  const name = err?.name || "";
  const code = err?.code || err?.cause?.code || "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
  );
}

function dropClient() {
  if (runtime.sse) {
    try {
      runtime.sse.stop();
    } catch {
      /* ignore */
    }
    runtime.sse = null;
  }
  runtime.client = null;
  runtime.sseUp = false;
  failDiscovery("opencode 连接中断");
}

function shortId(id) {
  return String(id).slice(0, 12);
}

/** 状态落盘。seq 一起存，保证下次启动 seq 不回退 —— Herdr 会拒收非递增的 seq。 */
function persistState() {
  if (runtime.state) runtime.state.lastSeq = seqCounter;
  void store.writeState(STATE_DIR, runtime.state).catch(() => {});
}

// ---------------------------------------------------------------------------
// 镜像 pane 生命周期
// ---------------------------------------------------------------------------

/** 找到或重建承载所有镜像 pane 的工作区 + 锚点 pane。 */
async function ensureAnchor() {
  const anchor = runtime.state.anchor;

  // 已记录的锚点还有效就直接用
  if (anchor.paneId) {
    const pane = await herdr.paneGet(anchor.paneId);
    if (pane) return anchor.paneId;
    log("debug", `锚点 pane ${anchor.paneId} 已失效，重新找`);
    anchor.paneId = null;
    anchor.tabId = null;
    anchor.workspaceId = null;
  }

  // 按 label 找回上次建的工作区
  if (anchor.workspaceId) {
    const workspaces = await herdr.workspaceList();
    const found = workspaces.find((w) => sameLabel(w.label, anchor.label));
    if (found) {
      const pane = await firstPane(found.workspace_id);
      if (pane) {
        anchor.workspaceId = found.workspace_id;
        anchor.paneId = pane;
        log("info", `复用已有镜像工作区 ${found.workspace_id}「${found.label}」`);
        return pane;
      }
    }
    log("info", `镜像工作区 ${anchor.workspaceId} 已不存在，重新创建`);
  }

  // state.json 丢失/损坏，或历史上崩过几次没清干净时，Herdr 里会留下一堆
  // 我们不认识的镜像 pane（甚至多个同名工作区）。认领其中一个当锚点，
  // 把其余所有「不在 state 映射里」的 pane 当孤儿回收，
  // 否则 Agents 视图会一直挂着上一轮的行。
  const known = new Set(Object.values(runtime.state.panes).map((r) => r.paneId).filter(Boolean));
  let adopted = 0;
  let orphanCount = 0;

  for (const ws of await herdr.workspaceList()) {
    if (!sameLabel(ws.label, config.mirrorLabel)) continue;

    for (const pane of await herdr.paneList(ws.workspace_id)) {
      const paneId = str(pane.pane_id);
      if (!paneId || known.has(paneId)) continue;

      if (!anchor.paneId) {
        // 第一个可用 pane 当锚点
        anchor.workspaceId = ws.workspace_id;
        anchor.paneId = paneId;
        anchor.label = config.mirrorLabel;
        adopted += 1;
        continue;
      }

      // 其余一律当孤儿：先 release 再关，保证 Agents 视图里不残行
      await herdr.releaseAgent({ paneId, seq: nextSeq() });
      const closed = await herdr.paneClose(paneId);
      if (closed.ok) orphanCount += 1;
      log(closed.ok ? "info" : "warn", `回收孤儿镜像 pane ${paneId}${closed.ok ? "" : `: ${closed.error}`}`);
    }
  }

  if (adopted > 0) log("info", `认领镜像工作区 ${anchor.workspaceId}，锚点 ${anchor.paneId}`);
  if (orphanCount > 0) log("info", `共回收 ${orphanCount} 个孤儿镜像 pane`);
  if (anchor.paneId) return anchor.paneId;

  const created = await herdr.workspaceCreate({
    label: config.mirrorLabel,
    cwd: runtime.state.panes && firstDirectory(runtime.state) ? firstDirectory(runtime.state) : undefined,
  });
  const workspaceId = str(created?.workspace?.workspace_id);
  const paneId = str(created?.root_pane?.pane_id);
  if (!paneId) {
    throw new Error(`workspace create 没返回 root_pane（herdr 输出异常）`);
  }

  anchor.workspaceId = workspaceId || null;
  anchor.tabId = str(created?.tab?.tab_id) || null;
  anchor.paneId = paneId;
  anchor.label = config.mirrorLabel;
  log("info", `已创建镜像工作区 ${workspaceId || "?"}「${config.mirrorLabel}」，锚点 ${paneId}`);
  return paneId;
}

function firstDirectory(state) {
  for (const rec of Object.values(state.panes || {})) {
    if (rec && rec.directory) return rec.directory;
  }
  return "";
}

/** 找一个工作区里可以拿来 split 的 pane。 */
async function firstPane(workspaceId) {
  const panes = await herdr.paneList(workspaceId);
  if (panes.length > 0) return str(panes[0].pane_id);
  return null;
}

/** herdr 会给 workspace label 加 `[n] ` 前缀，比对时要剥掉。 */
function sameLabel(a, b) {
  const norm = (v) => String(v || "").replace(/^\[\d+\]\s*/, "").trim();
  return Boolean(a) && norm(a) === norm(b);
}

/**
 * 给一个 session 建镜像 pane：split → 等 shell 就绪 → 启动驻留进程。
 *
 * session id / 标题 / 目录全部通过 `pane split --env` 传，不进 shell 文本，
 * 所以不存在把用户数据拼进命令行的注入面。
 */
async function createMirrorPane(info) {
  let anchorPane;
  try {
    anchorPane = await ensureAnchor();
  } catch (err) {
    log("warn", `准备镜像工作区失败：${err?.message || err}`);
    return null;
  }
  if (!anchorPane) return null;

  const cwd = info.directory || undefined;
  const env = {
    OC_MIRROR_SESSION_ID: info.id,
    OC_MIRROR_TITLE: store.truncate(store.sanitizeText(info.title || "", 60), 60),
    OC_MIRROR_DIRECTORY: store.truncate(info.directory || "", 200),
  };

  // 高度守卫：split 是按比例瓜分锚点的高度，行数不够时新 pane 会拿到 0 行，
  // Herdr 直接返回 pane_split_failed。先确认锚点还有富余。
  const anchorRows = await herdr.paneViewportRows(anchorPane);
  if (anchorRows !== null && anchorRows < config.minPaneRows * 2) {
    log(
      "warn",
      `锚点 ${anchorPane} 只剩 ${anchorRows} 行，放不下新的镜像 pane（每行至少要 ${config.minPaneRows} 行）。` +
        `请手动打开 Sessions 工作区把窗口拉高，或调小 MIRROR_PANE_RATIO。`,
    );
    return null;
  }

  const paneId = await splitMirrorPane(anchorPane, cwd, env);
  if (!paneId) return null;

  await startMirrorResident(paneId);
  return paneId;
}

const SHELL_NAMES = new Set([
  "fish",
  "bash",
  "zsh",
  "sh",
  "dash",
  "nu",
  "elvish",
  "xonsh",
  "powershell",
  "pwsh",
  "cmd",
  "login",
]);

/**
 * 在 pane 里启动驻留进程。
 *
 * pane run 是「把文本打进 shell」，刚 split 出来的 shell 可能还没到提示符，
 * 所以先轮询 pane process-info 等前台进程变成 shell 再下发。
 * 万一还是重复执行，mirror.mjs 自己的单实例锁会让后到的那个直接退出。
 */
async function startMirrorResident(paneId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const names = await herdr.paneForegroundNames(paneId);
    if (names && names.length > 0 && names.some((n) => SHELL_NAMES.has(n))) break;
    await sleep(300);
  }

  const command = `${shellQuote(process.execPath)} ${shellQuote(MIRROR_SCRIPT)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await herdr.paneRun(paneId, command);
    if (res.ok) return true;
    log("debug", `pane run 第 ${attempt + 1} 次失败: ${res.error}`);
    await sleep(500);
  }
  log("warn", `无法在 ${paneId} 启动镜像驻留进程`);
  return false;
}

/**
 * 从锚点切出一个镜像 pane。
 *
 * 失败时换个更小的比例重试：镜像行多了以后锚点会越来越小，固定比例迟早会
 * 切不动（Herdr 返回 pane_split_failed）。逐级退让比直接放弃好。
 *
 * @returns {Promise<string|null>} pane id
 */
async function splitMirrorPane(anchorPane, cwd, env) {
  const ratios = [config.paneRatio, config.paneRatio * 0.5, 0.12, 0.05];
  const tried = [];

  for (let i = 0; i < ratios.length; i += 1) {
    const ratio = ratios[i];
    let pane = null;
    try {
      pane = await herdr.paneSplit({ paneId: anchorPane, direction: config.paneDirection, ratio, cwd, env });
    } catch (err) {
      tried.push(`${ratio.toFixed(2)}:${err?.message || err}`);
      log("debug", `pane split(ratio=${ratio}) 失败: ${err?.message || err}`);
      continue;
    }
    const paneId = str(pane?.pane_id);
    if (paneId) {
      if (i > 0) log("info", `锚点空间不足，改用 ratio=${ratio} 切出镜像 pane ${paneId}`);
      return paneId;
    }
    tried.push(`${ratio.toFixed(2)}:无 pane_id`);
  }

  // 只说一次具体失败原因，别刷屏
  log("warn", `无法从锚点 ${anchorPane} 切出镜像 pane，已退避 ${SPACE_BACKOFF_MS / 1000}s。`);
  log("debug", `  尝试记录: ${tried.join(" | ")}`);
  log(
    "warn",
    `  通常是 Sessions 工作区窗口太矮或镜像行太多。` +
      `请把该工作区的窗口拉高，或调小 .env 里的 MIRROR_PANE_RATIO。`,
  );
  return null;
}

/** 单引号包裹；内部单引号用 '\\'' 闭合转义。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 关掉镜像 pane：先 release 再 close，行才消失得干净。
 *
 * close 失败时保留映射，下一轮再试 —— 直接删掉会留下一个我们再也管不到的
 * 残行（herdr 里 agent 还在，pane 也还在）。
 */
async function teardownMirror(sessionID, rec, reason) {
  if (!rec.paneId) {
    delete runtime.state.panes[sessionID];
    return;
  }

  const released = await herdr.releaseAgent({ paneId: rec.paneId, seq: nextSeq() });
  if (!released.ok) log("debug", `release-agent 失败: ${released.error}`);

  const closed = await herdr.paneClose(rec.paneId);
  if (!closed.ok) {
    log("warn", `关闭镜像 pane ${rec.paneId} 失败，保留映射下轮重试: ${closed.error}`);
    return;
  }

  delete runtime.state.panes[sessionID];
  await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
  log("info", `回收镜像行 ${shortId(sessionID)}（${reason}）`);
}

/** 全部回收（reap action 用）。 */
async function reapAll(reason) {
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    await teardownMirror(sessionID, rec, reason);
  }
  // 映射之外的孤儿快照也一起清掉（比如上一轮崩溃或手工删过 state.json）
  let orphans = 0;
  try {
    for (const name of await fs.readdir(STATE_DIR)) {
      if (!name.startsWith("mirror-") || !name.endsWith(".json")) continue;
      await store.removeFile(path.join(STATE_DIR, name));
      orphans += 1;
    }
  } catch {
    /* state 目录还不存在，无所谓 */
  }
  if (orphans > 0) log("info", `清理了 ${orphans} 个残留的镜像显示快照`);
  if (config.installAgentView) await clearAgentView(runtime.state, reason);
  persistState();
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------

/** 只有状态/标题/目录真的变了才调 herdr，免得把日志刷爆。 */
function fingerprintOf(rec) {
  return [rec.state, rec.stateMessage, rec.title, rec.directory].join("|");
}

/**
 * Herdr 会把 resume 命令重新执行，规则（官方 add-herdr-support 文档）：
 * 第一个词必须是 PATH 上的纯命令名，不能是路径；<=64 个参数；参数里不能有控制字符。
 * 所以这里只能用 "node" / "opencode"，不能用 process.execPath。
 */
function resumeArgvFor(sessionID) {
  if (config.resumeMode === "mirror") {
    // 不恢复 opencode，只恢复驻留进程 —— 严格遵守「镜像 pane 不运行 opencode」
    return ["node", MIRROR_SCRIPT];
  }
  // SPEC 6.2：恢复命令用 `opencode --session <id>`。
  // 副作用是 herdr 重启后这个 pane 会真的跑起 opencode；此时官方集成会在同一个 pane 上报，
  // 我们下一轮去重就会看到该 session 已被占用，主动让出这一行 —— 所以不会重复。
  return ["opencode", "--session", sessionID];
}

async function reportMirror(sessionID, rec) {
  const fingerprint = fingerprintOf(rec);
  const paneId = rec.paneId;
  if (!paneId) {
    log("warn", `镜像行 ${shortId(sessionID)} 没有 pane，跳过上报`);
    return;
  }

  const firstReport = rec.reportedAt === 0 || rec.fingerprint === "";
  const stateChanged = firstReport || rec.state !== rec.lastState || rec.stateMessage !== rec.lastStateMessage;

  // 第一次上报必须带 resume argv —— Herdr 要求先持有 pane 才接受恢复命令，
  // 否则返回 resume_not_accepted。
  if (firstReport || rec.lastResume !== config.resumeMode) {
    const res = await herdr.reportAgent({
      paneId,
      state: rec.state,
      seq: nextSeq(),
      sessionId: sessionID,
      message: rec.stateMessage,
      resumeArgv: resumeArgvFor(sessionID),
    });
    if (!res.ok) {
      log("warn", `report-agent 失败（${shortId(sessionID)}）: ${res.error}`);
      return;
    }
    rec.lastResume = config.resumeMode;
    await writeMirrorMetadata(paneId, sessionID, rec);
    rec.reportedAt = Date.now();
    rec.lastState = rec.state;
    rec.lastStateMessage = rec.stateMessage;
    rec.fingerprint = fingerprint;
    log("info", `上报 ${shortId(sessionID)} → ${rec.state}${rec.stateMessage ? `（${rec.stateMessage}）` : ""}`);
    return;
  }

  if (stateChanged) {
    const res = await herdr.reportAgent({
      paneId,
      state: rec.state,
      seq: nextSeq(),
      sessionId: sessionID,
      message: rec.stateMessage,
    });
    if (!res.ok) {
      log("warn", `report-agent 失败（${shortId(sessionID)}）: ${res.error}`);
      return;
    }
    log("info", `上报 ${shortId(sessionID)} → ${rec.state}${rec.stateMessage ? `（${rec.stateMessage}）` : ""}`);
  }

  if (fingerprint !== rec.fingerprint) {
    // token / 标题变了（含会话切换后目录变了）
    await writeMirrorMetadata(paneId, sessionID, rec);
  }

  rec.reportedAt = Date.now();
  rec.lastState = rec.state;
  rec.lastStateMessage = rec.stateMessage;
  rec.fingerprint = fingerprint;
}

/**
 * 只影响展示的元数据。
 *
 * token 名固定为 oc_mirror / oc_session / oc_title / oc_project，
 * 供 agent.view 投影筛选；值自己先截到 80 字符（Herdr 也会截，但超长标题会先挤爆整行）。
 */
async function writeMirrorMetadata(paneId, sessionID, rec) {
  const title = store.truncate(store.sanitizeText(rec.title || shortId(sessionID), 80));
  const project = store.truncate(
    store.sanitizeText(basename(rec.directory) || (rec.directory ? "" : "unknown")),
    80,
  );

  const res = await herdr.reportMetadata({
    paneId,
    seq: nextSeq(),
    title,
    tokens: {
      [`${MIRROR_PREFIX}mirror`]: "1",
      [`${MIRROR_PREFIX}session`]: store.truncate(sessionID, 80),
      [`${MIRROR_PREFIX}title`]: title,
      [`${MIRROR_PREFIX}project`]: project,
    },
  });
  if (!res.ok) log("debug", `report-metadata 失败: ${res.error}`);
}

/** 把当前状态写到 STATE_DIR，供镜像 pane 里的驻留进程显示。 */
async function publishMirrorSnapshots() {
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    const file = path.join(STATE_DIR, `mirror-${sessionID}.json`);
    try {
      await fs.writeFile(
        file,
        `${JSON.stringify({
          sessionID,
          state: rec.state || "starting",
          title: rec.title || "",
          directory: rec.directory || "",
          message: rec.stateMessage || "",
          paneId: rec.paneId || "",
          updatedAt: Date.now(),
        })}\n`,
        "utf8",
      );
    } catch {
      /* 显示快照丢了不影响上报 */
    }
  }
}

/** 启动时核对上次残留的映射，pane 没了就清掉。 */
async function validateTrackedPanes() {
  let dropped = 0;
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    if (!rec.paneId) {
      delete runtime.state.panes[sessionID];
      await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
      dropped += 1;
      continue;
    }
    const pane = await herdr.paneGet(rec.paneId);
    if (!pane) {
      log("info", `上次的镜像 pane ${rec.paneId} 已不存在，丢弃该行（session 仍在跑会重新建）`);
      delete runtime.state.panes[sessionID];
      await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
      dropped += 1;
    }
  }
  if (dropped > 0) log("info", `清理了 ${dropped} 条失效映射`);
  if (runtime.state.anchor.paneId) {
    const pane = await herdr.paneGet(runtime.state.anchor.paneId);
    if (!pane) {
      runtime.state.anchor = { workspaceId: null, tabId: null, paneId: null, label: null };
    }
  }
}

// ---------------------------------------------------------------------------
// agent.view 投影（全局副作用，必须显式开启）
// ---------------------------------------------------------------------------

/**
 * 构造投影参数。
 *
 * scope=mirror（默认，SPEC 6.3）：只显示本插件的镜像行。
 * scope=sort-only：不过滤，只接管排序（保留其它 agent）。
 *
 * 注意这个投影是全局的，会影响整个 Agents 侧边栏，所以默认不安装。
 */
export function buildAgentView() {
  const params = {
    source: herdr.ownSource(),
    label: "opencode-sessions",
    sort: [
      { field: "attention", order: "desc" },
      { field: "state_change_seq", order: "desc" },
    ],
  };
  if (config.agentViewScope === "mirror") {
    params.filter = { op: "eq", field: { token: `${MIRROR_PREFIX}mirror` }, value: "1" };
  }
  return params;
}

async function applyAgentView(state, { reason } = {}) {
  const params = buildAgentView();
  try {
    const result = await herdr.agentViewSet(params);
    log("info", `已安装 Agents 视图投影（scope=${config.agentViewScope}，原因 ${reason || "?"}）`);
    if (state) {
      state.agentView = { params, installedAt: Date.now() };
      persistState();
    }
    return result;
  } catch (err) {
    log("warn", `安装 Agents 视图投影失败: ${err?.message || err}`);
    return null;
  }
}

/** 只在「确实是我们装的」情况下才清，避免误删别人的视图。 */
async function clearAgentView(state, reason) {
  try {
    await herdr.agentViewClear(herdr.ownSource());
    log("info", `已清除 Agents 视图投影（${reason}）`);
    if (state) {
      state.agentView = null;
      persistState();
    }
    return true;
  } catch (err) {
    log("warn", `清除 Agents 视图投影失败: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === "string" ? v : "";
}

function basename(dir) {
  if (!dir) return "";
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------

process.on("unhandledRejection", (err) => {
  log("warn", `未处理的 Promise 拒绝: ${err?.message || err}`);
});
process.on("uncaughtException", (err) => {
  log("error", `未捕获异常，退出以免留下坏状态: ${err?.message || err}`);
  void (async () => {
    await store.writeState(STATE_DIR, runtime.state).catch(() => {});
    await releaseBoardLock().catch(() => {});
    process.exit(1);
  })();
});

main().catch((err) => {
  log("error", `启动失败: ${err?.message || err}`);
  if (config.logLevel === "debug" && err?.stack) log("debug", err.stack);
  process.exitCode = 1;
});
