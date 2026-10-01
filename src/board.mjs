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
  paneRatio: store.asFloat(raw, "MIRROR_PANE_RATIO", 0.5, 0.02, 0.98),
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

/** 镜像 pane 名上限。侧边栏一行放不下更多，留点余量给状态符号和项目名。 */
const MIRROR_LABEL_MAX = 40;

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
  timers: [],
  /** 一轮重算里已经重平衡过没有。回收一批行时不必每个都重算一次布局。 */
  balancedThisPass: false,
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

  // 1) 按当前 config 校准已安装的投影。
  //    这一段必须所有模式共用：投影是进程外的全局副作用，只在 startup 里处理的话，
  //    用户把 INSTALL_AGENT_VIEW 关掉后就没有任何进程会去清它了（它会一直赖在 server 里）。
  runtime.state = state;
  await reconcileAgentView(state, { reason: "startup", force: true });

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

  // action 也走一遍投影校准：这是用户手动触发时最可靠的「投影残留」自救入口。
  runtime.state = await store.readState(STATE_DIR);
  primeSeq(runtime.state.lastSeq);
  await reconcileAgentView(runtime.state, { reason: `action:${action}` });

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
  await reconcileAgentView(runtime.state, { reason: "once" });
  await reconcile("once");
  persistState();
  runtime.sse?.stop?.();
  // 一次性模式不常驻：跑完就断开 SSE 并封住后续重算。
  // 只 stop SSE 是不够的 —— session 一忙 SSE 就会持续触发 scheduleReconcile，
  // 进程会一直重算下去、永远不退出（自检模式必须是「跑一轮就退出」）。
  runtime.shuttingDown = true;
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
  await reconcileAgentView(runtime.state, { reason: "pane 启动", force: true });

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
  runtime.balancedThisPass = false;

  // 权限等待 = SSE 跟踪的 ∪ 轮询到的（轮询能覆盖 SSE 刚断的那段）
  const pending = new Map(runtime.pendingPermissions);
  for (const row of polledPermissions) pending.set(row.sessionID, row);
  runtime.pendingPermissions = pending;

  const infoById = new Map();
  for (const s of roots) infoById.set(s.id, s);

  // 已经被其它来源（官方集成）上报的 session 必须让出去，否则会出现重复行。
  // 这次 agent list 顺带给末尾的投影校准用。
  const agents = await herdr.agentList();
  const claimed = await herdr.claimedSessionIds(agents);

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
      // 不因为空间不足而放弃建行：切完立刻重平衡，实在还是 0 行也照样把行建出来。
      const created = await createMirrorPane(info);
      if (!created) {
        // 只有 herdr 自己报错（pane_split_failed 等）才算失败，下一轮无条件重试。
        log("warn", `镜像行 ${shortId(info.id)} 建不出来，下一轮重试`);
        continue;
      }
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

  // --- 5. 按「镜像行确实存在」校准投影 ---------------------------------------
  // 这一步是防「no matching agents」事故的最后一道闸：镜像行归零时必须把
  // 带筛选的投影降级成只排序，否则用户的官方行会被我们的筛选全部隐藏。
  if (config.installAgentView || runtime.state.agentView) {
    await reconcileAgentView(runtime.state, { reason: `重算(${reason})` });
  }

  log(
    "debug",
    `重算(${reason}): 根 ${roots.length} / 活跃 ${activeStates.size} / 待权限 ${pending.size} / ` +
      `让出 ${claimed.size} / 镜像行 ${Object.keys(runtime.state.panes).length} / ` +
      `herdr 镜像行 ${herdr.countMirrorRows(agents)} / SSE ${runtime.sseUp ? "up" : "down"}`,
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
 * 给一个 session 建镜像 pane：split → **重平衡** → 校验可见行 → 启动驻留进程。
 *
 * 关键设计（替代旧的「锚点越来越小 + 高度守卫」）：
 * `pane split` 之后立刻把整棵镜像子树的比例重算一遍，让所有镜像 pane 均分空间。
 * 旧策略是反复用小 ratio 拆同一个锚点，锚点自己被逐次压缩，预算很快耗尽 ——
 * 那不是 herdr 的限制，是切分策略错了。实测 44 行 area 下平衡 8 叶完全放得下。
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
    // 必须显式传：pane split 起的 shell 只继承 herdr server 的环境，
    // 拿不到本插件进程的 HERDR_PLUGIN_STATE_DIR。少了它，镜像 pane 里的驻留进程
    // 会退回去读 PLUGIN_ROOT/.state（空的），于是永远显示 "starting"。
    HERDR_PLUGIN_STATE_DIR: STATE_DIR,
    HERDR_PLUGIN_ROOT: PLUGIN_ROOT,
  };

  let pane = null;
  try {
    pane = await herdr.paneSplit({
      paneId: anchorPane,
      direction: config.paneDirection,
      ratio: config.paneRatio,
      cwd,
      env,
    });
  } catch (err) {
    log("warn", `pane split 失败（${shortId(info.id)}）：${err?.message || err}`);
    return null;
  }
  const paneId = str(pane?.pane_id);
  if (!paneId) {
    log("warn", `pane split 没返回 pane_id（${shortId(info.id)}）`);
    return null;
  }

  // 先重平衡再启驻留：新 pane 拿到 0 行时 shell 照样跑得起来，但没必要让它从 0 行开始。
  await rebalanceMirrorTree(`新建 ${shortId(info.id)}`, [paneId]);
  await ensurePaneVisible(paneId, `新建 ${shortId(info.id)}`);

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

// ---------------------------------------------------------------------------
// 平衡 BSP 树：让所有镜像 pane 均分空间
// ---------------------------------------------------------------------------

/** 收集一棵子树里的所有叶子 pane id。 */
function collectLeafPanes(node, acc = []) {
  if (!node) return acc;
  if (node.type === "pane") {
    const id = str(node.pane_id);
    if (id) acc.push(id);
    return acc;
  }
  collectLeafPanes(node.first, acc);
  collectLeafPanes(node.second, acc);
  return acc;
}

/** 比例已经到位就不重复下发 —— reconcile 每 5 秒跑一次，不能每轮都打十几次 socket。 */
const RATIO_EPSILON = 1e-4;

/**
 * 算出需要调整哪些 split 节点。
 *
 * 规则只有一条：**ratio = first 子树的叶子数 / 该节点子树的总叶子数**。
 * 这样每个叶子恰好拿到 1/N，对任意二叉树形状都成立 —— 不管镜像是怎么被
 * 拆出来的一棵「锚点脊柱」，还是用户在面板里手动拖成了别的形状。
 *
 * 只处理「子树里全是我们的 pane」的节点：侧边栏之类的外来 pane 不参与，
 * 它们的祖先 split 保持不动，免得把用户的侧边栏挤扁。
 *
 * @returns {Array<{path:boolean[],ratio:number}>}
 */
export function balanceSplitPlans(root, ownPaneIds) {
  const own = ownPaneIds instanceof Set ? ownPaneIds : new Set(ownPaneIds || []);
  const plans = [];

  (function walk(node, path) {
    if (!node || node.type !== "split") return;
    const leaves = collectLeafPanes(node);
    if (leaves.length >= 2 && leaves.every((id) => own.has(id))) {
      const firstLeaves = collectLeafPanes(node.first).length;
      const ratio = firstLeaves / leaves.length;
      const current = Number(node.ratio);
      if (!Number.isFinite(current) || Math.abs(current - ratio) > RATIO_EPSILON) {
        plans.push({ path, ratio });
      }
    }
    walk(node.first, path.concat(false));
    walk(node.second, path.concat(true));
  })(root, []);

  return plans;
}

/** 我们自己占着的 pane：锚点 + state 里全部镜像 pane + 带 oc_mirror token 的残留。 */
async function ourPaneIds(extra = []) {
  const out = new Set();
  const anchor = str(runtime.state.anchor?.paneId);
  if (anchor) out.add(anchor);
  for (const rec of Object.values(runtime.state.panes)) {
    if (rec && str(rec.paneId)) out.add(str(rec.paneId));
  }
  for (const id of extra) if (id) out.add(id);

  // state.json 丢了 / 崩过几轮时，靠 token 把还活着的镜像 pane 认回来，
  // 否则它们会被当成「外来 pane」，整棵镜像子树就永远不会被重平衡。
  const wsId = str(runtime.state.anchor?.workspaceId);
  if (wsId) {
    for (const pane of await herdr.paneList(wsId)) {
      const id = str(pane?.pane_id);
      if (id && pane?.tokens?.[herdr.MIRROR_TOKEN] === "1") out.add(id);
    }
  }
  return out;
}

/**
 * 重平衡镜像布局。
 *
 * 用 `layout.set_split_ratio` 而不是 `layout.apply` —— 官方文档明说 apply
 * 会重建 tab、不保留 live PTY / scrollback / 进程，把已有镜像 pane 全杀掉重启。
 *
 * @returns {Promise<number>} 实际调整的节点数
 */
async function rebalanceMirrorTree(reason, extraPaneIds = []) {
  const anchorPane = str(runtime.state.anchor?.paneId);
  if (!anchorPane) return 0;

  const pane = await herdr.paneGet(anchorPane);
  const tabId = str(pane?.tab_id) || str(runtime.state.anchor?.tabId);
  if (!tabId) return 0;

  let layout = null;
  try {
    layout = await herdr.layoutExport(tabId);
  } catch (err) {
    log("debug", `layout.export 失败（${reason}）：${err?.message || err}`);
    return 0;
  }
  if (!layout?.root) return 0;

  const plans = balanceSplitPlans(layout.root, await ourPaneIds(extraPaneIds));
  if (plans.length === 0) return 0;

  let applied = 0;
  for (const plan of plans) {
    const res = await herdr.layoutSetSplitRatio({ tabId, path: plan.path, ratio: plan.ratio });
    if (res.ok) applied += 1;
    else log("debug", `set_split_ratio([${plan.path}]) 失败：${res.error}`);
  }
  if (applied > 0) log("debug", `重平衡镜像布局 ${applied} 个节点（${reason}）`);
  return applied;
}

/**
 * 零高度陷阱防御。
 *
 * herdr 对过小的 split **不报错**，会静默返回 `viewport_rows: 0` 的不可见 pane
 * （实测连切 40 次全部返回成功，第 3 个之后全是 0 行）。所以「不报错」≠「建好了」。
 *
 * 这里读回真实行数，为 0 就再重平衡一次；仍然为 0 只记一条日志 ——
 * **绝不因为 0 行就放弃这一行**，记下来下一轮继续。
 *
 * @returns {Promise<number|null>} 实际行数；herdr 没给就返回 null
 */
async function ensurePaneVisible(paneId, reason) {
  let rows = await herdr.paneViewportRows(paneId);
  if (rows === null || rows > 0) return rows;

  await rebalanceMirrorTree(`${reason}: 首轮 0 行`, [paneId]);
  rows = await herdr.paneViewportRows(paneId);
  if (rows === null || rows > 0) return rows;

  log(
    "warn",
    `镜像 pane ${paneId} 重平衡后仍拿不到可视行（${rows}）。这一行照样保留，下一轮会再平衡一次。` +
      `若反复出现，多半是 ${config.mirrorLabel} 工作区所在标签页被缩得太矮。`,
  );
  return rows;
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
  // 少了一个叶子，剩下的 pane 要重新均分，不然锚点会把空出来的空间全吃掉。
  // 一轮里可能连续回收好几行，只重平衡一次就够。
  if (!runtime.balancedThisPass) {
    runtime.balancedThisPass = true;
    await rebalanceMirrorTree(`回收 ${shortId(sessionID)}`);
  }
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
  await rebalanceMirrorTree("reap");
  // reap 之后镜像行必然为 0，交给 reconcileAgentView 决定是降级成只排序还是直接清掉
  await reconcileAgentView(runtime.state, { reason, force: true });
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

/**
 * 上报一个镜像行。**刻意拆成两步。**
 *
 * 官方文档：`resume_argv` 非法时失败码是 `invalid_resume_argv`，而且
 * 「the report is not applied」—— 也就是说带一个坏 resume argv 会把
 * `agent_session_id` 一起丢掉，session id 白报。所以：
 *
 *   步骤 1 `pane report-agent`：只带状态 + `--agent-session-id`，**不带** resume argv。
 *          这一步失败就没有这一行。
 *   步骤 2 `pane report-agent-session`：单独附上 resume argv。
 *          这一步失败只丢「Herdr 重启后怎么恢复」，session id 不受影响。
 *
 * 两步都记日志，方便对着 herdr 侧边栏验证。
 */
async function reportMirror(sessionID, rec) {
  const fingerprint = fingerprintOf(rec);
  const paneId = rec.paneId;
  if (!paneId) {
    log("warn", `镜像行 ${shortId(sessionID)} 没有 pane，跳过上报`);
    return;
  }

  const firstReport = rec.reportedAt === 0 || rec.fingerprint === "";
  const stateChanged = firstReport || rec.state !== rec.lastState || rec.stateMessage !== rec.lastStateMessage;
  const identityStale = firstReport || rec.lastResume !== config.resumeMode;

  // --- 步骤 1：状态 + session 身份（不含 resume argv） ----------------------
  if (firstReport || stateChanged || identityStale) {
    const res = await herdr.reportAgent({
      paneId,
      state: rec.state,
      seq: nextSeq(),
      sessionId: sessionID,
      message: rec.stateMessage,
    });
    if (!res.ok) {
      log("warn", `上报[1/2] 失败（${shortId(sessionID)}）: ${res.error}`);
      return;
    }
    log(
      "info",
      `上报[1/2] ${shortId(sessionID)} → ${rec.state}${rec.stateMessage ? `（${rec.stateMessage}）` : ""}` +
        `${identityStale ? " +session id" : ""}`,
    );
  }

  // --- 步骤 2：恢复命令（失败只影响恢复能力） -------------------------------
  if (identityStale) {
    // herdr 要求先持有 pane 才接受恢复命令，步骤 1 已经保证了这一点
    const res = await herdr.reportAgentSession({
      paneId,
      seq: nextSeq(),
      sessionId: sessionID,
      resumeArgv: resumeArgvFor(sessionID),
    });
    if (res.ok) {
      rec.lastResume = config.resumeMode;
      log("info", `上报[2/2] ${shortId(sessionID)} 恢复命令已挂上（${config.resumeMode}）`);
    } else {
      log("warn", `上报[2/2] 失败（${shortId(sessionID)}），只影响 Herdr 重启后的恢复，不影响这一行: ${res.error}`);
    }
  }

  // --- 展示层：token / 标题 / pane 名 ---------------------------------------
  if (firstReport || fingerprint !== rec.fingerprint) {
    await writeMirrorPresentation(paneId, sessionID, rec);
  }

  rec.reportedAt = Date.now();
  rec.lastState = rec.state;
  rec.lastStateMessage = rec.stateMessage;
  rec.fingerprint = fingerprint;
}

/** 状态 → 一个能在 40 字内说清「谁、在哪、在干嘛」的 pane 名。 */
export function mirrorLabel(state, project, title) {
  const mark =
    state === "working" ? "●" : state === "blocked" ? "▲" : state === "idle" ? "○" : "·";
  return store.sanitizeText([mark, project, title].filter(Boolean).join(" "), MIRROR_LABEL_MAX);
}

/**
 * 只影响展示的元数据 + pane 名。
 *
 * 两件事分开的原因：
 *   - `pane.report_metadata` 的 `title` 与 token 走的是「展示层」通道，一定能落地，
 *     侧边栏行模板里可以用 `$oc_title` / `$oc_project` / `$oc_state` 渲染。
 *   - `pane.rename` 改的是 pane 自己的 label。Agents 侧边栏那一行的默认文本来自
 *     终端标题（OSC），镜像 pane 里跑的是 node 进程，不 rename 就会显示成
 *     `'/usr/bin/node' '/ho…` 这种东西。
 *
 * 用户自己的 herdr-sidebar 会用 `hs_title` 覆盖侧边栏文本，那个插件的配置我们不动，
 * README 里说明可以自行把 `$oc_title` 拼进行模板。
 *
 * token 名固定为 oc_mirror / oc_session / oc_title / oc_project / oc_state，
 * 值自己先截到 80 字符（Herdr 也会截，但超长标题会先挤爆整行）。
 */
async function writeMirrorPresentation(paneId, sessionID, rec) {
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
      [herdr.MIRROR_TOKEN]: "1",
      [herdr.MIRROR_SESSION_TOKEN]: store.truncate(sessionID, 80),
      [`${MIRROR_PREFIX}title`]: title,
      [`${MIRROR_PREFIX}project`]: project,
      [`${MIRROR_PREFIX}state`]: store.truncate(rec.state || "unknown", 32),
    },
  });
  if (!res.ok) log("debug", `report-metadata 失败: ${res.error}`);

  const label = mirrorLabel(rec.state, project, title);
  if (label) {
    const renamed = await herdr.paneRename(paneId, label);
    if (!renamed.ok) log("debug", `pane rename 失败（${paneId}）: ${renamed.error}`);
  }
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
//
// 安全底线（真实事故换来的）：**绝不只靠筛选隐藏官方行。**
// 投影的 filter 是全局的，一旦装了 `{oc_mirror == 1}` 而镜像行数为 0，
// 用户原本那 8 行官方 opencode agent 会全部被筛掉，侧边栏直接变成
// `no matching agents` —— 插件把用户的视图清空了。
// 所以装投影之前必须先数当前镜像行数，为 0 时退回 sort-only（只接管排序）。
// ---------------------------------------------------------------------------

/**
 * 现在到底该不该带筛选。
 *
 * @param {object[]} agents 本轮拉到的 agent 列表（不传就现场拉一次）
 * @returns {boolean}
 */
export function shouldFilterMirror(agents) {
  // 配置只要不是 mirror，就永远不筛选。
  if (config.agentViewScope !== "mirror") return false;
  // 一个镜像行都没有时，带筛选 = 把用户的官方行全隐藏掉。绝对不装。
  return herdr.countMirrorRows(agents) > 0;
}

/**
 * 构造投影参数。
 *
 * @param {object[]} [agents] 用来判断「现在有没有镜像行」
 */
export function buildAgentView(agents) {
  const params = {
    source: herdr.ownSource(),
    label: "opencode-sessions",
    sort: [
      { field: "attention", order: "desc" },
      { field: "state_change_seq", order: "desc" },
    ],
  };
  if (shouldFilterMirror(agents)) {
    params.filter = { op: "eq", field: { token: herdr.MIRROR_TOKEN }, value: "1" };
  }
  return params;
}

function sameAgentViewParams(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 按「当前 config + 当前镜像行数」校准已安装的投影。**所有模式共用的唯一入口。**
 *
 * 规则（幂等，不刷错误日志）：
 *   - `INSTALL_AGENT_VIEW=false` 且 state 里记着自己装过 → 清掉并置空。
 *     这是「用户删了 .env 但没人去清」的自救路径。
 *   - 开关开着 → 算参数；参数没变就什么都不做，变了才重新下发。
 *     参数会随「镜像行有没有」自动在 `mirror`（带筛选）与 `sort-only` 之间切换。
 */
async function reconcileAgentView(state, { reason, force = false } = {}) {
  if (!state) return;

  if (!config.installAgentView) {
    if (!state.agentView) return; // 幂等：没装过就别碰
    await clearAgentView(state, `INSTALL_AGENT_VIEW 已关闭（${reason || "?"}）`);
    return;
  }

  const agents = await herdr.agentList();
  const params = buildAgentView(agents);
  const filtering = Boolean(params.filter);

  if (!force && state.agentView && sameAgentViewParams(state.agentView.params, params)) return;

  if (!filtering) {
    log("info", `当前没有镜像行，Agents 视图投影降级为只排序（不筛选），原因 ${reason || "?"}`);
  }
  await applyAgentView(state, { reason, params });
}

async function applyAgentView(state, { reason, params } = {}) {
  const effective = params || buildAgentView();
  try {
    await herdr.agentViewSet(effective);
    log(
      "info",
      `已安装 Agents 视图投影（${effective.filter ? "只显示镜像行" : "只排序，不筛选"}，原因 ${reason || "?"}）`,
    );
    if (state) {
      state.agentView = { params: effective, installedAt: Date.now() };
      persistState();
    }
    return true;
  } catch (err) {
    log("warn", `安装 Agents 视图投影失败: ${err?.message || err}`);
    return false;
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
