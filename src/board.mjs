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
import { CodexClient, CodexError, normalizeThread, parseSourceKinds } from "./codex.mjs";

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
  // MIRROR_LABEL 现在只用来命名「兜底」工作区：目录在 Herdr 里找不到对应工作区时用它。
  mirrorLabel: store.asString(raw, "MIRROR_LABEL", "Sessions"),
  // 每个目录在自己的工作区里独占一个同名标签页放镜像 pane。
  mirrorTabLabel: store.asString(raw, "MIRROR_TAB_LABEL", "oc-sessions"),
  autoStart: store.asBool(raw, "AUTO_START", false),
  installAgentView: store.asBool(raw, "INSTALL_AGENT_VIEW", false),
  agentViewScope: store.asEnum(raw, "AGENT_VIEW_SCOPE", ["mirror", "sort-only"], "mirror"),
  pollIntervalMs: store.asInt(raw, "POLL_INTERVAL_MS", 5_000, 1_000, 600_000),
  idleGraceMs: store.asInt(raw, "IDLE_GRACE_MS", 15_000, 0, 3_600_000),
  // 已废弃：RESUME_MODE=opencode 会在 herdr 重启时于镜像 pane 里拉起 opencode TUI，
  // 官方集成随即覆盖掉我们这一行（不是新增重复行），镜像功能对该目录静默失效。
  // 只读不认，写了就在启动时明确告知已忽略。
  legacyResumeMode: str(raw?.RESUME_MODE || "").trim(),
  paneRatio: store.asFloat(raw, "MIRROR_PANE_RATIO", 0.5, 0.02, 0.98),
  paneDirection: store.asEnum(raw, "MIRROR_PANE_DIRECTION", ["down", "right"], "down"),
  rebalanceIntervalMs: store.asInt(raw, "REBALANCE_INTERVAL_MS", 30_000, 5_000, 600_000),
  // 焦点落到镜像 pane 时，转到同目录真正的前台 agent（见 SPEC 7.3）
  focusRedirect: store.asBool(raw, "FOCUS_REDIRECT", true),
  focusRedirectCooldownMs: store.asInt(raw, "FOCUS_REDIRECT_COOLDOWN_MS", 2_500, 0, 60_000),
  // 内联模式：完全不建镜像 pane，把并行 session 信息挂到该目录官方 agent 行的
  // token 上（见 SPEC 8）。false = 回到「每个 session 一个镜像行」的旧模型，
  // 那个模式会在每个涉及的工作区建一个 oc-sessions 标签页。
  mirrorInline: store.asBool(raw, "MIRROR_INLINE", true),
  // oc_par token 的值上限。实测 Herdr 对单个 token 值硬截断在 80 字符，
  // 插件自己先算好并用「+N」收尾，避免被拦腰截断在半句话上。
  parallelTokenMax: store.asInt(raw, "PARALLEL_TOKEN_MAX", 78, 8, 80),
  // session 行树状前缀里的「父级竖线」。默认空 —— 用户反馈这条竖线是多余的。
  // Herdr 会 trim 前导空白，所以想改成空格缩进是做不到的（传 "  └─ x" 存下来
  // 是 "└─ x"）。要加回来就设成 "│" 或别的非空白字符。
  parallelTrunk: store.asString(raw, "PARALLEL_TRUNK", ""),
  // 没有并行 session 时，官方 session 自己那一行还要不要写。
  // 默认要 —— 模板里已经没有 terminal_title_stripped 了，不写就等于官方标题消失。
  inlineAlwaysList: store.asBool(raw, "INLINE_ALWAYS_LIST", true),
  sessionLimit: store.asInt(raw, "SESSION_LIST_LIMIT", 200, 10, 2_000),
  sessionPages: store.asInt(raw, "SESSION_PAGE_LIMIT", 8, 1, 50),
  retryDetection: store.asBool(raw, "RETRY_DETECTION", true),
  retryCheckLimit: store.asInt(raw, "RETRY_CHECK_LIMIT", 8, 0, 64),
  autoAuth: store.asBool(raw, "AUTO_AUTH_SERVICE_JSON", true),
  backoffMaxMs: store.asInt(raw, "DISCOVERY_BACKOFF_MAX_MS", 60_000, 5_000, 600_000),

  // --- codex（第 11 节）-------------------------------------------------
  // codex 那边只要一个总开关。默认开：没有 codex 官方 agent 行时这一整条路径
  // 只会打一条 debug 日志然后安静下来，不连也不会刷屏。
  codexEnabled: store.asBool(raw, "CODEX_ENABLED", true),
  // 留空 = 走 ~/.codex/app-server-control/app-server-control.sock。调试时守护
  // 进程可能起在别处（`codex app-server daemon version` 会报真实路径），指过来最省事。
  codexSocket: store.asString(raw, "CODEX_SOCKET", ""),
  // clientInfo 会拼进 app-server 自己的 user-agent 串里（实测形如
  // `codex-tui/0.160.0 … herdr/0.9.3 (herdr-session-mirror; 1)`），
  // 出问题时 codex 那边能一眼看出这条连接是谁。
  codexClientName: store.asString(raw, "CODEX_CLIENT_NAME", "herdr-session-mirror"),
  // 默认取「人开的」四种来源，**靠排除 subAgent\* 实现「子 agent 不单列」**。
  // 不能只填 `cli`：实测本机那两条 thread 的 kind 是 `vscode`，
  // `sourceKinds:["cli"]` 直接返回 0 条（会话凭空消失）。
  codexSourceKinds: parseSourceKinds(store.asString(raw, "CODEX_SOURCE_KINDS", "")),
  // thread/list 一页拉多少。会话多的机器上活跃 thread 可能不在第一页，
  // 所以还会带着 `thread/loaded/list` 的 id 当提前停止翻页的信号。
  codexSessionLimit: store.asInt(raw, "CODEX_SESSION_LIMIT", 100, 10, 1_000),
  // 守护进程在**同一个 app-server 上**（用户自己在跑 codex），连接不该长时间挂着
  // 不放，否则 codex 重启时要等我们的 socket 断开才起得来。
  codexTimeoutMs: store.asInt(raw, "CODEX_TIMEOUT_MS", 8_000, 500, 60_000),
  logLevel: store.asEnum(raw, "LOG_LEVEL", ["debug", "info", "warn", "error", "silent"], "info"),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(PLUGIN_ROOT, ".state");
const LOCK_FILE = path.join(STATE_DIR, "board.lock");
const SYNC_FLAG = path.join(STATE_DIR, "sync.request");
const REAP_FLAG = path.join(STATE_DIR, "reap.request");
const MIRROR_PREFIX = "oc_";

/** 镜像 pane 名上限。侧边栏一行放不下更多，留点余量给状态符号。 */
const MIRROR_LABEL_MAX = 40;

/**
 * pane 名里显示的 agent 名。
 *
 * 刻意用 `MIRROR_DISPLAY_LABEL`（`opencode`）而不是上报用的 `AGENT_LABEL`
 * （`opencode-mirror`）：pane 边框标签和 pane 名是要给人看的，长的内部名只会
 * 挤掉标题。上报名唯一是为了拿到独立的行模板，显示名要好看。
 */
const MIRROR_AGENT_LABEL = herdr.MIRROR_DISPLAY_LABEL;

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
   * codex app-server 的连接状态。独立于 opencode 那套：两个守护进程互不相干，
   * 退避也各算各的（codex 挂了不该让 opencode 的发现一起退避）。
   */
  codex: {
    client: null,
    /** 距离下次允许再连的时间戳 */
    nextAttemptAt: 0,
    backoffMs: 1_000,
    consecutiveFailures: 0,
    lastError: "",
    /** 「采到会话但没有对应官方行」的前置条件提示是否已经 info 说过一次。 */
    missingRowsHinted: "",
  },
  timers: [],
  /** 一轮重算里已经重平衡过没有。回收一批行时不必每个都重算一次布局。 */
  balancedThisPass: false,
  /** 上次常规重平衡的时间戳，用来节流 `maybeRebalanceAll`。 */
  lastRebalanceAt: 0,
  /** 内联模式：上一次 attach 的 seq，仅用于日志排查。 */
  lastAttachSeq: 0,
  /** `pane.focused` 订阅句柄。 */
  focusSub: null,
  /** 镜像 pane id -> 上次重定向的时刻，用来防抖。 */
  focusCooldown: new Map(),
  /** 重定向进行中。防止 agent focus 触发的回焦事件再次进入处理。 */
  focusRedirecting: false,
  /** pane 全量列表的索引（目录 → workspace 解析、认领标签页、孤儿回收都要用），带 TTL 缓存。 */
  paneIndex: null,
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

  // 内联模式：把旧「建 pane 模式」留下的镜像 pane / oc-sessions 标签页清掉。
  // 放在 validateTrackedPanes 之后 —— 先确认映射有效，再按内联逻辑收摊。
  if (config.mirrorInline) await migrateToInline();

  if (config.legacyResumeMode && config.legacyResumeMode !== "mirror") {
    log(
      "warn",
      `已忽略 RESUME_MODE=${config.legacyResumeMode}：那个值会在 Herdr 重启时于镜像 pane 里` +
        `拉起 opencode，官方集成随即覆盖掉这一行（不是新增重复行），镜像功能会静默失效。` +
        `恢复命令恒为常驻进程。想在某个镜像位置直接对话，手动敲 opencode --session <id> 即可。`,
    );
  }

  installSignalHandlers();
  await reconcile("启动"); // 先把 client 建起来，reconcile 内部会顺带开 SSE

  startFocusRedirect();

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
      stopFocusRedirect();
      closeCodexClient();
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
// codex app-server 采集
// ---------------------------------------------------------------------------

/**
 * `thread/loaded/list` 给出的「在内存里加载着」但 `thread/list` 一次都没出现的
 * thread，最多补查多少条。
 *
 * 实测本机守护进程里 loaded 有 3 个 id，`thread/list` 只给出 1 个（另外两个是
 * 刚建、还没有任何消息的 thread，`preview` 是空串）。这类 thread **确实在跑**，
 * 只是列表接口不吐它们，所以必须按 id 补查一次 `thread/read` 才能拿到 cwd。
 *
 * 补查是**按需**的：数量通常只有个位数，且只在「loaded 集合没被列表覆盖」时才发。
 * 设上限是为了防「loaded 列表很长」时把守护进程问烦。
 */
const CODEX_READ_BACKFILL_MAX = 8;

/**
 * 拿到一个可用的 CodexClient，失败时按退避静默重试。
 *
 * 和 {@link getClient} 同构，但**故意独立**：codex 的守护进程由 codex 自己管生命周期，
 * 它没起来 / 正在重启都不代表 opencode 那边出了任何问题，两边的退避不该联动。
 *
 * @returns {Promise<CodexClient|null>}
 */
async function getCodexClient() {
  if (!config.codexEnabled) return null;
  const now = Date.now();

  // 已连上的直接复用。真的断了会在 fetchCodexSessions 的 catch 里被丢弃。
  if (runtime.codex.client) return runtime.codex.client;
  if (now < runtime.codex.nextAttemptAt) return null;

  const client = new CodexClient({
    socketPath: config.codexSocket || undefined,
    clientName: config.codexClientName,
    timeoutMs: config.codexTimeoutMs,
  });

  try {
    const info = await client.connect();
    runtime.codex.client = client;
    runtime.codex.consecutiveFailures = 0;
    runtime.codex.backoffMs = 1_000;
    runtime.codex.nextAttemptAt = 0;
    runtime.codex.lastError = "";
    const ver = info?.appServerVersion || info?.userAgent || "?";
    log("info", `已连接 codex app-server @ ${client.socketPath}（${String(ver).slice(0, 80)}）`);
    return client;
  } catch (err) {
    // connect() 失败时 client 可能已经持有半开的 socket，必须关掉，
    // 否则它会一直挂着直到进程退出。
    try {
      client.close();
    } catch {
      /* ignore */
    }
    failCodex(err?.message || String(err));
    return null;
  }
}

function failCodex(reason) {
  const d = runtime.codex;
  d.client = null;
  d.consecutiveFailures += 1;
  if (d.consecutiveFailures === 1 || d.consecutiveFailures % 5 === 0) {
    // 跟 opencode 侧一样：第一次和每五次失败才说一句，避免每 5 秒刷一行
    log("debug", `codex 采集不可用（${reason}），${Math.round(d.backoffMs / 1000)}s 后重试`);
  }
  d.lastError = reason;
  d.backoffMs = Math.min(config.backoffMaxMs, Math.round(d.backoffMs * 2));
  d.nextAttemptAt = Date.now() + d.backoffMs;
}

/**
 * 采一轮 codex 的运行中 thread。
 *
 * ## 「运行中」怎么判定
 *
 * codex 没有 opencode 那种 `/session/status`；能区分「正在跑」和「历史遗留」的是
 * `status.type`：`active` / `idle` / `systemError` / `notLoaded`。实测同一台机器上
 * `thread/list` 返回的两条里，一条 `active`、一条 `notLoaded` —— `notLoaded` 就是
 * 「没加载进 app-server 内存的历史对话」，不显示。
 *
 * `thread/loaded/list` 是第二条独立证据（它返回**字符串数组**，不是对象数组）。
 * 两条证据怎么用：
 *   - `loaded` 里有 → 一定显示，哪怕 `thread/list` 说它 `notLoaded`（双保险，
 *     防状态字段和服务端内存不一致）。
 *   - `loaded` 里没有且 `notLoaded` → 不显示。
 *   - `loaded` 里有但 `thread/list` 压根没列（实测就有这种，见
 *     {@link CODEX_READ_BACKFILL_MAX}）→ 按 id 补查 `thread/read` 拿 cwd。
 *
 * 子 agent 靠 `sourceKinds` 排除（默认集不含任何 `subAgent*`），和 opencode 侧
 * 「子 agent 不单列」的产品决策一致。
 *
 * @returns {Promise<{ok:true, wanted:{id:string,title:string,directory:string}[], statesById:Map<string,string>}
 *                 | {ok:false, reason:string}>}
 */
async function fetchCodexSessions() {
  // 主动关掉和「连不上」是两回事，必须分开标记。
  //
  // `disabled` 表示用户**主动**关了 codex 支持 —— 这时候该把之前挂上去的 token
  // 撤掉，否则侧边栏上会一直留着关之前那一版会话列表。踩过的坑：最初这里直接
  // 返回 `ok:false`，和「守护进程连不上」共用同一条路，而下游把 `ok:false`
  // 一律当成「本轮失败，既不写也不清」，于是 `CODEX_ENABLED=false` 之后残留
  // 永远留在官方行上（实测 codex 集成装好后那一行一直显示关之前的 6 条会话）。
  if (!config.codexEnabled) return { ok: false, disabled: true, reason: "CODEX_ENABLED=false" };

  const client = await getCodexClient();
  if (!client) return { ok: false, reason: runtime.codex.lastError || "codex 退避中" };

  try {
    const loaded = await client.loadedThreadIds();
    const loadedSet = new Set(loaded);

    const { threads } = await client.listThreads({
      limit: config.codexSessionLimit,
      sourceKinds: config.codexSourceKinds,
      // loaded 里的 id 全都命中就可以停止翻页 —— 会话多的机器上活跃 thread
      // 未必在第一页。
      wantIds: loaded,
    });

    const wanted = [];
    const statesById = new Map();
    const seen = new Set();

    const take = (raw) => {
      const t = normalizeThread(raw);
      // ephemeral 的 thread 直接跳过（normalizeThread 返回 null）—— 每建一次
      // app-server 连接守护进程就造一个，不挡掉的话侧边栏会堆出一串「(无标题)」
      if (!t || !t.id || seen.has(t.id)) return;
      const inMemory = loadedSet.has(t.id);
      // 两个证据都说「不在内存里」→ 历史遗留，不显示
      if (!inMemory && t.state === null) return;
      // 只有一条证据说「在内存里」时以它为准（双保险的另一半）
      seen.add(t.id);
      wanted.push({ id: t.id, title: t.title, directory: t.directory });
      statesById.set(t.id, t.state || "idle");
    };

    for (const raw of threads) take(raw);

    // loaded 里那些列表压根没给的：补查一次 cwd，否则挂不到任何工作区上。
    let backfilled = 0;
    for (const id of loaded) {
      if (seen.has(id) || backfilled >= CODEX_READ_BACKFILL_MAX) continue;
      backfilled += 1;
      try {
        const raw = await client.readThread(id);
        if (raw) take(raw);
      } catch (err) {
        log("debug", `codex 补查 ${shortId(id)} 失败：${err?.message || err}`);
      }
    }

    if (backfilled > 0) {
      log("debug", `codex: loaded 里 ${backfilled} 条不在 thread/list 中，已按 id 补查`);
    }
    log(
      "debug",
      `codex: loaded ${loaded.length} / 列出 ${threads.length} / 采纳 ${wanted.length}` +
        `（sourceKinds=${config.codexSourceKinds.join(",")}）`,
    );
    return { ok: true, wanted, statesById };
  } catch (err) {
    failCodex(err?.message || String(err));
    if (err instanceof CodexError) log("debug", `codex 请求失败：${err.message}`);
    return { ok: false, reason: err?.message || String(err) };
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
  // 1a. 孤儿：state.json 丢过 / 崩过几轮时残留的镜像行。先扫一遍，避免它们
  //     一直挂在侧边栏上，也避免它们被当成「这个目录还有镜像」而让标签页关不掉。
  {
    const index = await paneIndex();
    await sweepOrphanPanes("重算");
    await sweepTakenOverPanes(index, "重算");
    pruneDeadCentral(index);
  }

  // 1b. 正常回收：不再活跃且过了宽限期的行 → release + 关 pane（标签页空了会整页关掉）
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

  // 本轮开始时活着的 pane，用来发现「记着的 pane 已经被外部关掉」。
  // 边建边补，所以同一轮里先建出来的 pane 不会把自己当成失效。
  const alive = new Set(((await paneIndex({ force: true })).panes || []).map((p) => str(p?.pane_id)));

  // 内联模式：session id -> 展示用状态，交给 publishInlineParallel 拼 token
  const parallelStates = new Map();

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

    // 自愈：记着的 pane 可能已经不在了（用户手动关、herdr 回收空工作区、
    // sidebar 插件重排标签页）。复用死 pane 的话这一行就永久消失 —— 上报会一直
    // 报 pane_not_found，而 rec.paneId 非空又让建行逻辑以为「已经有 pane 了」。
    if (rec.paneId && !alive.has(rec.paneId)) {
      log("info", `镜像行 ${shortId(info.id)} 的 pane ${rec.paneId} 已消失，重建`);
      rec.paneId = "";
      rec.fingerprint = "";
      rec.lastState = "";
    }

    if (!rec.paneId && !config.mirrorInline) {
      // 不因为空间不足而放弃建行：切完立刻重平衡，实在还是 0 行也照样把行建出来。
      const created = await createMirrorPane(info);
      if (!created) {
        // 只有 herdr 自己报错（pane_split_failed 等）才算失败，下一轮无条件重试。
        log("warn", `镜像行 ${shortId(info.id)} 建不出来，下一轮重试`);
        continue;
      }
      rec.paneId = created;
      alive.add(created);
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

    // 内联模式不需要自己的 agent 行，只把状态记进 rec 供 token 拼接用
    if (!config.mirrorInline) await reportMirror(info.id, rec);
    parallelStates.set(info.id, state);
  }

  // --- 3b. 内联模式：各 agent 的 session 列表挂到各自的官方 agent 行 ----------
  // 完全不建 pane，也就不需要镜像标签页、不需要镜像行、不会被官方集成接管。
  //
  // codex 的采集**放在这个判断之内**：非内联模式下 session 信息挂在镜像 pane 上，
  // 根本不经过 publishInlineSessions，没必要为此去连 codex 的守护进程。
  if (config.mirrorInline) {
    const codex = await fetchCodexSessions();
    const attached = await publishInlineSessions([
      { agent: "opencode", wanted, statesById: parallelStates },
      {
        agent: "codex",
        wanted: codex.ok ? codex.wanted : [],
        statesById: codex.ok ? codex.statesById : new Map(),
        failed: !codex.ok,
        // 主动关掉（CODEX_ENABLED=false）和采集失败要分开：前者要清残留，后者要保留。
        disabled: Boolean(codex.disabled),
        failedReason: codex.ok ? "" : codex.reason,
      },
    ]);
    runtime.lastAttachSeq = nextSeq();
    log("debug", `内联挂载本轮动了 ${attached} 行`);
  }

  // --- 4. 写镜像 pane 的显示状态 ------------------------------------------
  await publishMirrorSnapshots();

  // --- 4b. 常规重平衡（节流） ----------------------------------------------
  // 建行/回收时已经重平衡过，但布局会被别人改：sidebar 插件会往每个标签页注入
  // 自己的 Sidebar pane 并且重排整页，用户也可能手动拖。不定期纠正的话，镜像
  // pane 会被挤到只剩零星几行（实测 Sidebar 42 行 vs 每个 session pane 9 行）。
  await maybeRebalanceAll();

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
      `镜像标签页 ${Object.keys(runtime.state.mirrors || {}).length} / ` +
      `herdr 镜像行 ${herdr.countMirrorRows(agents)} / SSE ${runtime.sseUp ? "up" : "down"}`,
  );
}

/**
 * 定期把所有镜像标签页重平衡一遍。
 *
 * 节流到 `rebalanceIntervalMs`（默认 30s）一次：`balanceSplitPlans` 内部有
 * `RATIO_EPSILON` 判断，比例已经对得上时不会下发任何 `set_split_ratio`，所以
 * 稳态下这里只有 `layout.export` + `pane list` 两次读，没有写。
 *
 * 有行被建/被回收的那一轮由 `runtime.balancedThisPass` 单独管，那边是即时的，
 * 不受这里的节流影响。
 */
async function maybeRebalanceAll() {
  // 内联模式不建镜像 pane，也就没有镜像标签页要平衡
  if (config.mirrorInline) return;
  const now = Date.now();
  if (now - runtime.lastRebalanceAt < config.rebalanceIntervalMs) return;
  runtime.lastRebalanceAt = now;

  const entries = [...Object.values(runtime.state.mirrors || {})];
  const central = runtime.state.central;
  if (central?.tabId) entries.push({ ...central, fallback: true });

  for (const entry of entries) {
    if (runtime.shuttingDown) return;
    try {
      await rebalanceMirrorTab(entry, "常规巡检");
    } catch (err) {
      log("debug", `常规重平衡失败（${str(entry?.tabId) || "?"}）：${err?.message || err}`);
    }
  }
}

/**
 * Herdr 报的「这个 pane 不存在」。
 *
 * pane 可能在我们背后消失：用户手动关掉、herdr 回收空工作区、sidebar 插件重排
 * 标签页时关掉自己不再需要的 pane。碰到这种错误必须当成「目标已达成」，
 * 不能当成失败 —— 否则映射会永远卡在一个死 pane 上（实测每轮重试关闭、
 * 侧边栏里那一行再也回不来）。
 */
function isPaneNotFound(error) {
  const code = error?.error?.code ?? error?.code;
  const msg = String(error?.error?.message ?? error?.message ?? "");
  return code === "pane_not_found" || /pane .* not found/i.test(msg);
}

/**
 * 焦点落到镜像 pane 上 → 转到该目录真正的前台 agent。
 *
 * ## 为什么需要它
 *
 * Herdr 的侧边栏行点击行为**没有任何 per-row 开关**（SPEC 7.3 有完整核查记录）：
 * `agent.view.set` 只有 filter/sort/label，`AgentInfo` 里唯一相关的
 * `interactive_ready` 在 0.9.3 根本不返回，config 也没有相关项，插件 v1 更是
 * 明确排除非终端 UI。所以「让镜像行不可点击」在 Herdr 上做不到。
 *
 * 退而求其次的做法是让跳转**落到有用的地方**：镜像行是只读的（里面不跑
 * opencode），点进去只能看一张说明卡；用户的真实意图通常是「我要去这个目录
 * 干活」，那就该落在那个目录真正在对话的 TUI 上。
 *
 * ## 为什么不选别的做法
 *
 * 「把焦点转走」比「每次重建后按官方行排序 / 让只读卡片做得更醒目」都更贴近
 * 用户动作：用户点的那一行消失在意料之外，落点却在意料之中。同一个 workspace
 * 内部切换，用户几乎察觉不到中间过程。
 *
 * ## 副作用（必须让用户知道）
 *
 * 「焦点落在镜像 pane」不只由点侧边栏行产生。按 `prefix+alt+N` 切工作区时 Herdr
 * 会恢复该工作区上次聚焦的 pane —— 如果那正好是镜像 pane，同样会被弹走。
 * 多数情况下这是合心意的（用户去这个工作区就是为了干活），但如果你就是想去
 * `oc-sessions` 标签页看看，会被弹回来，需要点一次官方行。
 * `FOCUS_REDIRECT=false` 可以完全关掉这个行为。
 *
 * @param {{paneId:string,workspaceId:string}} info `pane.focused` 事件
 */
async function handlePaneFocused(info) {
  if (!config.focusRedirect || runtime.shuttingDown) return;
  // agent focus 自身也会触发 pane.focused，挡掉重入
  if (runtime.focusRedirecting) return;

  const paneId = str(info?.paneId);
  const workspaceId = str(info?.workspaceId);
  if (!paneId) return;

  const index = await paneIndex();
  const pane = (index.panes || []).find((p) => str(p?.pane_id) === paneId);
  // 焦点落在镜像 pane 上 —— 这才是我们要拦的情况
  if (!pane || !herdr.isMirrorPane(pane)) return;

  const now = Date.now();
  const last = Number(runtime.focusCooldown.get(paneId) || 0);
  if (now - last < config.focusRedirectCooldownMs) return;
  runtime.focusCooldown.set(paneId, now);

  // 同目录有没有真正的前台 agent？没有就保持原样，让用户看到只读卡片 ——
  // 弹到一个不对的 pane 比不弹更糟。
  // 落点优先挑**用户自己标签页**里的 agent：官方 opencode 有可能就开在
  // oc-sessions 里（镜像 pane 被接管后的遗留），跳过去等于没离开镜像标签页。
  const avoidTabIds = new Set(
    Object.values(runtime.state.mirrors || {})
      .map((m) => str(m?.tabId))
      .filter(Boolean),
  );
  if (str(runtime.state.central?.tabId)) avoidTabIds.add(str(runtime.state.central.tabId));

  const target = await herdr.findForegroundAgentPane(workspaceId, paneId, { avoidTabIds });
  if (!target) {
    log("debug", `镜像行 ${paneId} 获得焦点，但工作区 ${workspaceId} 没有前台 agent，保持原样`);
    return;
  }

  runtime.focusRedirecting = true;
  try {
    const res = await herdr.agentFocus(target);
    if (res?.ok === false) log("debug", `focus 重定向 ${paneId} → ${target} 失败：${res.error || ""}`);
    else log("info", `镜像行 ${paneId} 获得焦点 → 转到前台 agent ${target}`);
  } catch (err) {
    log("debug", `focus 重定向异常：${err?.message || err}`);
  } finally {
    // 留一点窗口把回焦事件挡掉，再放行下一次
    setTimeout(() => {
      runtime.focusRedirecting = false;
    }, 400).unref?.();
  }
}

/** 启动焦点重定向订阅。只在常驻模式、且不是内联模式时才有意义。 */
function startFocusRedirect() {
  // 内联模式没有镜像 pane，「焦点落到镜像行」这个事件根本不会发生，
  // 订阅它只是白占一条 socket 连接。而且点击需求已经天然满足了 ——
  // 侧边栏里只有官方行，点它本来就跳官方 pane。
  if (config.mirrorInline) return;
  if (!config.focusRedirect || runtime.focusSub) return;
  runtime.focusSub = herdr.subscribePaneFocused({
    onFocus: (info) => {
      void handlePaneFocused(info).catch((err) => log("debug", `focus 重定向出错: ${err?.message || err}`));
    },
    onError: (err) => log("debug", `pane.focused 订阅异常: ${err?.message || err}`),
  });
  log("info", "已订阅 pane.focused（镜像行获得焦点时转到同目录前台 agent）");
}

function stopFocusRedirect() {
  runtime.focusSub?.stop();
  runtime.focusSub = null;
  runtime.focusCooldown.clear();
}

/**
 * 内联模式：把「这个目录还有哪些 session 在跑」挂到该目录**官方 agent 行**上。
 *
 * ## 为什么不建 pane
 *
 * Herdr 的 agent 行必须绑定真实 pane，这是硬约束。但 `pane.report_metadata` 有个
 * `--applies-to-source`：**能往别的 source 上报的 agent 行附加自己的 token，
 * 而不接管那一行**。实测官方集成随后重报（working → idle）token 照样存活，
 * `agent` 字段和 `agent_session.source` 都不受影响。
 *
 * 于是并行 session 的信息不需要自己的 pane —— 挂在官方行上就行，侧边栏模板引用
 * `$oc_sess*` 即可。顺带白送一件事：点击那行本来就跳官方 pane，所以
 * 「点镜像信息只跳到真正的前台 agent」不再需要 FOCUS_REDIRECT。
 *
 * ## 多 agent：一个 workspace 里的 session 列表（SPEC 第 11 节）
 *
 * 一个 provider = 一个 agent（`opencode` / `codex`）+ 它自己那批 session。
 *
 * **每个 provider 只能碰自己 `agent` 名下的官方行。** 挂载点解析也必须限定在
 * provider 自己的行里（`resolveInlineHostWorkspace` 传的 `officialRowsForThisAgentOnly`）：
 * 目录是跨 agent 共用的，同一个目录下 opencode 行和 codex 行的 `foreground_cwd`
 * 可能完全一样。全局解析会把 codex 的 session 挂到 opencode 行上 —— 侧边栏里
 * codex 的会话出现在 opencode 分组下面。这是本函数最容易犯的错。
 *
 * ## 官方 session 优先用 id 精确匹配
 *
 * `agent_session.value` 就是官方集成上报的 session id。拿它和 thread/session 的
 * id 一比就知道「这一行对应哪个会话」，标题直接用**会话自己的名字**而不是终端标题
 * —— codex 的终端标题未必有信息量（实测两个 thread 的终端标题都是同一个）。
 *
 * 匹配不上才退回「按 `foreground_cwd` 分组 + 取 `terminal_title_stripped`」那条老路。
 * 两条都得留：opencode 侧的会话在进 `wanted` 之前就被 `claimed` 剔掉了
 * （用户 TUI 选中的那个），所以它**只能**靠终端标题那一路补回来。
 *
 * ## 采集失败时既不写也不清
 *
 * provider 的 `failed` 为 true（守护进程临时掉了、正在退避）时，这个 agent 的行
 * **一个字都不动**。反过来写的话就是「守护进程抖一下 → 侧边栏上的 session 行全部
 * 空掉 → 下一轮又全回来」地闪。
 *
 * ## 过期 token 的清理以 agent list 的实际值为准
 *
 * 刻意**不**依赖进程内记账（曾经踩过：board 重启后 `runtime.attachedParallel`
 * 是空的，于是过期 token 永远清不掉）。每轮直接读 `agent.tokens` 里哪些槽位还有值，
 * 本轮不需要就显式置空 —— board 重启后的第一轮就能把上次的残留收干净。
 *
 * ## 值格式与硬限制
 *
 * Herdr 对单个 token 值**硬截断在 80 字符**（实测请求 82 字符存下来是 80），
 * 而且换行会被去掉 —— 所以一行只能放一个 session，多个必须各占一个 token /
 * 一个 row。侧边栏本身也不宽，实际能看到的更少。
 *
 * **官方 session 也由这里写进 `$oc_sess*`**，不是用内置
 * `terminal_title_stripped`。原因见 {@link formatParallelSlots}：内置那行拿不到
 * 树形连接线、和插件行缩进不一致，两种格式混在一起读不出层级。
 *
 * ## 没有官方 agent 的目录
 *
 * session 在用户没开 TUI 的目录下（典型是 `/tmp` 下的临时工程）时，这个工作区
 * 里没有可挂载的官方行，那条信息就无处可放 —— 内联模式下**直接不显示**并记日志。
 * 想让这类 session 也可见，把 `MIRROR_INLINE` 设成 false 回到建 pane 的旧模型。
 *
 * @param {Array<{agent:string, wanted:{id:string,title:string,directory:string}[], statesById:Map<string,string>, failed?:boolean, failedReason?:string}>} providers
 * @returns {Promise<number>} 实际写入/清除的行数
 */
async function publishInlineSessions(providers) {
  const agents = await herdr.agentList();

  // 官方行：不是我们上报的、且带 agent_session 的
  const official = agents.filter(
    (a) => !herdr.isMirrorRow(a) && a.agent && typeof a.agent_session?.source === "string",
  );

  const tokens = herdr.SESSION_TOKENS;
  // 历史版本用过的 token 名，早已不在模板里，顺手清掉免得白占 metadata 配额：
  //   oc_par    = 单行版（多个 session 用 · 挤在一行）
  //   oc_par1..4 = 多行版但只放并行 session，官方那行还是内置 terminal_title
  const legacyTokens = [herdr.PARALLEL_TOKEN, "oc_par1", "oc_par2", "oc_par3", "oc_par4"];

  // 官方行按 agent 名分桶。跨 agent 分组是**绝对不能**的：一个 workspace 里
  // opencode 行和 codex 行的目录可能一样，用全局集合解析挂载点必然串味。
  const rowsByAgent = new Map();
  for (const a of official) {
    const key = str(a.agent);
    if (!key) continue;
    if (!rowsByAgent.has(key)) rowsByAgent.set(key, []);
    rowsByAgent.get(key).push(a);
  }

  // 只有确实要解析目录时才拉 pane 列表；index 跨 provider 共用一次就够了。
  const index = await paneIndex({ force: true });

  let attached = 0;
  let cleared = 0;
  /** 本轮有意处理过（含「有意保留」）的 pane，兜底清扫时跳过。 */
  const handled = new Set();

  for (const provider of providers || []) {
    const agentName = str(provider?.agent);
    const rows = rowsByAgent.get(agentName) || [];
    const wanted = Array.isArray(provider?.wanted) ? provider.wanted : [];

    if (rows.length === 0) {
      if (wanted.length > 0) noteMissingRows(agentName, wanted.length);
      continue;
    }

    if (provider.failed && !provider.disabled) {
      // 既不写也不清：守护进程抖一下不该让侧边栏上的 session 行全空掉再全回来。
      //
      // `disabled` 不走这条路 —— 那是用户主动关的，要的是**撤掉**之前挂上去的
      // token（`wanted` 传空数组即可，下面照常走写/清循环，`desired` 里不会有
      // 这一行，于是所有槽位被判定为过期而清空）。
      log(
        "debug",
        `${agentName} 采集本轮失败（${provider.failedReason || "未知"}），` +
          `保持 ${rows.length} 行现有 token 不动`,
      );
      // 标记成「本轮有意保留」，别被后面的兜底清扫当成孤儿清掉。
      for (const a of rows) handled.add(str(a.pane_id));
      continue;
    }
    if (provider.disabled) {
      closeCodexClient();
      log("debug", `${agentName} 支持已被 ${provider.failedReason || "关闭"}，撤掉 ${rows.length} 行上的旧 token`);
    }

    // --- 官方 session：id 精确匹配 --------------------------------------
    // 匹配上的从并行集合里拿走 —— 它已经是「官方那一行」，再列一次就是重复。
    const officialSlots = new Map(); // paneId -> {title, state}
    const parallel = [];
    for (const info of wanted) {
      const row = rows.find((a) => str(a.agent_session?.value) === str(info.id));
      if (row) {
        // 标题用会话自己的名字，比终端标题可靠（codex 的终端标题没信息量）
        officialSlots.set(str(row.pane_id), { title: info.title, state: str(row.agent_status) });
        continue;
      }
      parallel.push(info);
    }

    // --- 并行 session 按工作区分组 ----------------------------------------
    const byWorkspace = new Map();
    const orphans = [];
    for (const info of parallel) {
      const hit = resolveInlineHostWorkspace(info.directory, index, rows);
      if (!hit?.workspaceId) {
        orphans.push(info);
        continue;
      }
      if (!byWorkspace.has(hit.workspaceId)) byWorkspace.set(hit.workspaceId, []);
      byWorkspace.get(hit.workspaceId).push(info);
    }
    for (const o of orphans) {
      log(
        "info",
        `[${agentName}] ${shortId(o.id)}「${(o.title || "").slice(0, 24)}」所在目录没有对应的 Herdr 工作区` +
          `（或那个工作区里没有 ${agentName} 的 agent 行），内联模式下无处显示。` +
          `把 MIRROR_INLINE 设成 false 可回到建 pane 模式。`,
      );
    }

    /** 工作区里挑一个官方行作为挂载点：优先正在忙的，其次当前聚焦的。 */
    const pickHost = (workspaceId) => {
      const candidates = rows.filter((a) => str(a.workspace_id) === str(workspaceId));
      if (candidates.length === 0) return null;
      const rank = (a) => {
        if (a.agent_status === "working") return 0;
        if (a.agent_status === "blocked") return 1;
        if (a.focused) return 2;
        if (a.agent_status === "idle") return 3;
        if (a.agent_status === "done") return 4;
        return 5;
      };
      candidates.sort((a, b) => rank(a) - rank(b) || str(a.pane_id).localeCompare(str(b.pane_id)));
      return candidates[0];
    };

    const desired = new Map();
    // **遍历这个 agent 所有有官方行的工作区**，而不是只遍历有并行 session 的那些。
    // 模板里已经没有 terminal_title_stripped 了，官方 session 的标题现在也靠
    // $oc_sess1 —— 只遍历 byWorkspace 的话，「没有并行 session」的工作区会一个
    // token 都不写，那一行就彻底空了（实测官方标题直接消失）。
    //
    // `provider.disabled` 时**一个工作区都不遍历**，`desired` 保持为空 → 下面
    // 的写/清循环会把这些行上的槽位全判为过期并清掉，那一行退回成 Herdr 原生
    // 的样子（只剩内置 token 渲染的内容）。不能只让 `wanted` 为空：默认的
    // `INLINE_ALWAYS_LIST=true` 仍会把官方 session 那一行写上去，那就还是我们
    // 的内容、不是原生的。
    for (const workspaceId of provider.disabled ? [] : new Set(rows.map((a) => str(a.workspace_id)))) {
      const host = pickHost(workspaceId);
      if (!host) continue;
      const paneId = str(host.pane_id);
      const infos = byWorkspace.get(workspaceId) || [];
      const matched = officialSlots.get(paneId);
      if (infos.length === 0 && !matched && !config.inlineAlwaysList) continue;

      const states = provider.statesById instanceof Map ? provider.statesById : new Map();
      // **官方 session 排第一**：它是用户 TUI 里正在用的那个，用 ▸ 点出来，
      // 下面的并行 session 是「切走但还在跑」的。
      const list = matched
        ? [{ title: matched.title, state: matched.state, official: true }]
        : [
            {
              // 退回终端标题（id 没匹配上时的老路，opencode 侧走的就是这条）
              title: stripAgentPrefix(host.terminal_title_stripped || host.title || host.pane_id),
              state: host.agent_status,
              official: true,
            },
          ];
      for (const i of infos) {
        list.push({ title: i.title, state: states.get(i.id) || "", official: false });
      }
      desired.set(paneId, { agent: host, slots: formatParallelSlots(list) });
    }

    // --- 写 / 清 ----------------------------------------------------------
    for (const agent of rows) {
      const paneId = str(agent.pane_id);
      handled.add(paneId);
      const want = desired.get(paneId);
      const actualTokens = agent.tokens || {};
      // 本轮该有值的槽位 + 本轮该为空但实际有值的槽位
      const stale = tokens.filter((t) => actualTokens[t] != null);
      const legacy = legacyTokens.filter((t) => actualTokens[t] != null);

      if (!want) {
        if (stale.length === 0 && legacy.length === 0) continue;
        const res = await herdr.attachMetadata({
          paneId,
          targetSource: agent.agent_session.source,
          clear: [...stale, ...legacy],
          seq: nextSeq(),
        });
        if (res.ok) {
          cleared += 1;
          log("debug", `清除 ${paneId} 上过期的 ${stale.join(",")}`);
        } else {
          log("warn", `清除 ${paneId} 的 ${stale.join(",")} 失败：${res.error}`);
        }
        continue;
      }

      // 只写「值不同」的槽位；用不到的槽位显式置空（attachMetadata 用空串覆盖）
      const payload = {};
      const toClear = [...legacy];
      for (let i = 0; i < tokens.length; i += 1) {
        const name = tokens[i];
        const next = want.slots[i] ?? "";
        const cur = actualTokens[name];
        if (next) {
          if (cur !== next) payload[name] = next;
        } else if (cur != null) {
          toClear.push(name);
        }
      }
      if (Object.keys(payload).length === 0 && toClear.length === 0) continue;

      const res = await herdr.attachMetadata({
        paneId,
        targetSource: want.agent.agent_session.source,
        tokens: payload,
        clear: toClear,
        seq: nextSeq(),
      });
      if (res.ok) {
        attached += 1;
        log(
          "debug",
          `并行信息已挂到 ${paneId}：${want.slots.filter(Boolean).join(" / ")}` +
            (toClear.length ? `（清掉 ${toClear.join(",")}）` : ""),
        );
      } else {
        log("warn", `并行信息挂载失败（${paneId}）：${res.error}`);
      }
    }
  }

  // --- 兜底清扫：带着我们的 token、却没被本轮处理过的行 --------------------
  //
  // 有些行现在进不了 `official`，于是永远轮不到上面的清理，token 就一直挂在
  // 侧边栏上。实测踩到过：herdr 的 codex 集成只在 `SessionStart` 时上报
  // `agent_session`，会话结束后该字段消失 → 那一行不再满足「官方行」判定
  // （`agent_session?.source` 得是字符串）→ `CODEX_ENABLED=false` 之后
  // 关之前的 6 条会话一直留在界面上，谁也清不掉。
  //
  // 所以这里不按「是不是官方行」判断，只按「有没有我们的 token 且本轮没碰过」。
  // 不带 `--applies-to-source` 调用：实测那只会清 token，不会把这一行的 agent
  // 归属抢走（`agent` 仍是 codex），因为接管靠的是 `report-agent` 不是
  // `report-metadata`。
  for (const agent of agents) {
    const paneId = str(agent?.pane_id);
    if (!paneId || handled.has(paneId)) continue;
    const actual = agent.tokens || {};
    const stale = tokens.filter((t) => actual[t] != null);
    const legacy = legacyTokens.filter((t) => actual[t] != null);
    if (stale.length === 0 && legacy.length === 0) continue;
    const res = await herdr.attachMetadata({ paneId, clear: [...stale, ...legacy], seq: nextSeq() });
    if (res.ok) {
      cleared += 1;
      log(
        "info",
        `清扫 ${paneId}（agent=${agent.agent || "?"}）：它已不再上报 agent_session，` +
          `之前挂的 ${[...stale, ...legacy].join(",")} 已撤掉`,
      );
    } else {
      log("warn", `清扫 ${paneId} 的 ${[...stale, ...legacy].join(",")} 失败：${res.error}`);
    }
  }

  if (official.length === 0) {
    log("debug", "内联模式：当前没有官方 agent 行，无处挂载 session 列表");
  }
  return attached + cleared;
}

/**
 * 「采集到会话了，但 Herdr 里一个对应 agent 的官方行都没有」时的提示。
 *
 * 这就是「装了 herdr 的 codex 集成之前，codex session 一行都不显示」的成因：
 * 内联模式的信息必须挂在官方 agent 行上，而官方行由 `herdr integration install
 * <agent>` 建立的 hook 上报。所以第一轮用 info 说清楚前置条件（每轮都 info 会刷屏），
 * 之后降级成 debug。
 */
function noteMissingRows(agentName, count) {
  const hinted = runtime.codex.missingRowsHinted;
  const msg =
    `${agentName} 采集到 ${count} 个会话，但 Herdr 里没有 agent === "${agentName}" 的官方行，` +
    `无处挂载（内联模式只往官方行上挂 token）。` +
    `需要先装对应的官方集成：herdr integration install ${agentName}。`;
  if (hinted === undefined || agentName !== hinted) {
    log("info", msg);
    runtime.codex.missingRowsHinted = agentName;
    return;
  }
  log("debug", msg);
}

/**
 * 内联模式专用的「目录 → 工作区」解析：**返回该挂哪个官方 agent 行所在的工作区**。
 *
 * 和 {@link resolveWorkspaceForDirectory} 的根本区别：那条规则挑「该目录里 pane
 * 最多的工作区」，因为它要的是一个**放镜像 pane 的容器**；而内联模式要挂的是
 * **官方 agent 行本身**，必须是那个真的在跑这个目录 session 的 agent。
 *
 * 实测踩到的坑：`Software/herdr` 这个目录在 w19 里有 **7 个** pane 的 cwd（用户在
 * ReimuMoePCB_DAPLink 工作区里跑了一堆 herdr-sidebar 实例），在 w1J 里只有 4 个。
 * 「pane 最多优先」会选 w19 —— 但 w19 的 agent 跑的是 ReimuMoePCB_DAPLink 的
 * session，信息挂过去就显示在不相干的分组下面了。
 *
 * @param {string} directory
 * @param {object} index paneIndex
 * @param {object[]} official 官方 agent 行
 * @returns {{workspaceId:string, tier:string, paneHits:number}|null}
 */
export function resolveInlineHostWorkspace(directory, index, official) {
  const dir = normalizeDir(directory);
  if (!dir) return null;

  // ── tier 1（精确，优先）──────────────────────────────────────────────
  // 官方 agent 行的 `foreground_cwd` 就是它自己那个 session 的工作目录 ——
  // 那个 pane 里跑着 opencode TUI，前台进程的 cwd 不可能是别的工程。
  // 实测每一行都对得上：w1J:p1 → herdr、w19:p1 → ReimuMoePCB_DAPLink。
  //
  // 这一条无歧义，所以永远优先；有多个匹配就挑状态最忙的那个。
  const exact = official.filter(
    (a) => normalizeDir(a?.foreground_cwd) === dir || normalizeDir(a?.cwd) === dir,
  );
  if (exact.length > 0) {
    const rank = (a) =>
      a.agent_status === "working" ? 0 : a.agent_status === "blocked" ? 1 : a.focused ? 2 : a.agent_status === "idle" ? 3 : a.agent_status === "done" ? 4 : 5;
    exact.sort((a, b) => rank(a) - rank(b) || str(a.pane_id).localeCompare(str(b.pane_id)));
    return { workspaceId: str(exact[0].workspace_id), tier: "foreground-cwd", paneHits: 0 };
  }

  // ── tier 2（退化）────────────────────────────────────────────────────
  // session 在子目录里、而官方 TUI 的 cwd 是它的某个祖先时才走到这里。
  // 必须叠加「有官方 agent 行」这个条件：只按 pane 数量选会挑到
  // 「恰好在那个目录下开了很多别的 pane、但没有 opencode」的工作区。
  const hosts = new Set(official.map((a) => str(a.workspace_id)));
  const byCount = new Map();
  for (const field of ["cwd", "foreground_cwd"]) {
    for (const pane of index.panes || []) {
      const pdir = normalizeDir(pane?.[field]);
      if (!pdir || (pdir !== dir && !pdir.startsWith(`${dir}/`))) continue;
      const ws = str(pane?.workspace_id);
      if (!ws || !hosts.has(ws)) continue;
      byCount.set(ws, (byCount.get(ws) || 0) + 1);
    }
  }
  const ranked = [...byCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return null;
  return { workspaceId: ranked[0][0], tier: "ancestor-cwd", paneHits: ranked[0][1] };
}

/**
 * 把一个工作区下的**全部** session（官方那个 + 所有并行的）拆成「每个一行」，
 * 每行带 ASCII 树形符号。
 *
 * ## 为什么连官方 session 也由插件生成
 *
 * 一开始只让插件管并行的 session，官方那行用内置 `terminal_title_stripped`。
 * 结果视觉上散架 —— 实测渲染：
 *
 * ```
 * [1] afloat
 * ◐ opencode
 *   OC | 实现 Hover 菜单式 Mod 键 Window Hint     ← 内置行，缩进 2 格、无连接线
 * └─ ● 排查 Shell 重载启动…                      ← 插件行，顶格
 * ```
 *
 * `│ └─` 反而比它 supposed 的父节点更靠左，完全读不出层级：官方行拿不到连接线
 * （`terminal_title_stripped` 是内置 token，内容不可改，`rules` 只能改样式），
 * 而插件行又没法缩进（下面说）。
 *
 * 所以官方 session 也由插件写进 `$oc_sess*`，**所有 session 行同一格式**：
 *
 * ```
 * [1] afloat
 * ◐ opencode
 * ├─ ○ 实现 Hover 菜单式 Mod 键 Window Hint     ← 官方 TUI 当前选中的
 * ├─ ● 排查 Shell 重载启动初始化卡顿              ← 并行
 * └─ ● Tray hover二级菜单点击收起…                ← 并行
 * ```
 *
 * 模板里相应去掉 `terminal_title_stripped`，只留 `$oc_sess*`。
 *
 * ## 前缀为什么只能画在 token 值里
 *
 * Herdr 只给**它自己认识的结构行**（`workspace` / `agent`）加缩进，
 * `$oc_sess*` 这种自定义 token 会被渲染成顶格。而且 **它会 trim 前导空白**
 * （实测传 `"  └─ ● 标题"` 存下来是 `"└─ ● 标题"`），所以空格缩进根本存不住
 * —— Unicode 空白字符（U+00A0、U+2000–200A、U+3000 等）也都在 Rust `trim()`
 * 的范围内，同样保不住。
 *
 * 所以连接线只能自己写进值里。以前默认带一条 `│` 竖线当父级连接线，用户反馈
 * 多余，改成默认不带（`PARALLEL_TRUNK=""`，想加回来设成 `"│"` 即可）。
 *
 * 目标效果：
 *
 * ```
 * [1] afloat
 * ◐ opencode
 * ├─ ▸ ● 实现 Hover 菜单式…           ← 官方 TUI 当前选中的
 * ├─ ● 排查 Shell 重载启动…            ← 并行
 * └─ ● Tray hover二级菜单…              ← 并行
 * ```
 *
 * ## 不能塞进一个 token
 *
 * token 值里的换行会被去掉（实测 `"a\nb\nc"` 存下来是 `"abc"`），所以一行只能
 * 显示一个 session，多个必须各占一个 token / 一个 row。
 *
 * ## 槽位不够时
 *
 * 超出 `herdr.SESSION_TOKENS` 长度时把多出来的折成最后一行末尾的「+N」——
 * 让人知道「还有几个」比静默丢掉强。**已实测空槽位不会渲染成空白行**，所以
 * 槽位可以放心多加。
 *
 * @param {Array<{title:string, official?:boolean}>} sessions 官方 session 排第一
 */
export function formatParallelSlots(sessions) {
  const slots = herdr.SESSION_TOKENS;
  const limit = config.parallelTokenMax;
  const trunk = config.parallelTrunk;

  const marked = (sessions || []).map((s) => {
    const st = s.state || "";
    const mark =
      st === "working" ? "●" : st === "blocked" ? "▲" : st === "idle" ? "○" : st === "retry" ? "↻" : "·";
    return { mark, title: store.truncate(store.sanitizeText(s.title || "(无标题)", 60), 60), official: s.official };
  });
  if (marked.length === 0) return slots.map(() => "");

  const out = slots.map(() => "");
  const shown = Math.min(marked.length, slots.length);

  for (let i = 0; i < shown; i += 1) {
    const lastLine = i === shown - 1 && marked.length <= slots.length;
    // 官方 session 是「当前 TUI 里正在用的那个」，用 ▸ 点出它，比状态图标更好认
    const head = marked[i].official ? `▸ ${marked[i].mark}` : marked[i].mark;
    // trunk 为空时不要留下那个空格（Herdr 反正会 trim，但代码里就别制造）
    const stem = trunk ? `${trunk} ` : "";
    out[i] = `${stem}${lastLine ? "└─" : "├─"} ${head} ${marked[i].title}`;
  }

  // 溢出：把多出来的折进最后一行末尾的「+N」
  const rest = marked.length - (shown - 1);
  if (rest > 1) {
    const tail = ` +${rest - 1}`;
    const last = out[shown - 1];
    out[shown - 1] = last.length + tail.length <= limit ? last + tail : last.slice(0, Math.max(0, limit - tail.length)) + tail;
  }
  return out;
}

/**
 * 去掉终端标题开头的 agent 标识前缀（`OC | `、`✻ │ ` 之类）。
 *
 * 官方 opencode TUI 会把窗口标题设成 `<标识> | <会话标题>`（用户那边是 `OC | `）。
 * 在树状图里每一行都是 opencode，重复这个前缀既占宽度又没有信息量，所以砍掉。
 * 只砍「短标识 + 竖线」这种明确的形状，不确定的原样保留。
 */
export function stripAgentPrefix(title) {
  const s = String(title || "").trim();
  const m = s.match(/^(\S{1,4})\s*[|｜]\s*/);
  if (!m) return s || "(无标题)";
  const rest = s.slice(m[0].length);
  // 砍完几乎不剩东西就别砍了（那大概是标题本身就是这么写的）
  return rest.length >= 3 ? rest : s;
}

/**
 * 从「建 pane 模式」切到「内联模式」时清理旧残留。
 *
 * 旧模式留下的镜像 pane / `oc-sessions` 标签页 / state 里的 mirrors+central 记录，
 * 在内联模式下没有任何代码会去动它们 —— 会一直留在用户工作区里占地方。启动时
 * 主动扫一遍清掉，让切换是一次干净的迁移而不是半吊子状态。
 *
 * 反向（内联 → 建 pane）不需要专门处理：下一轮 reconcile 会正常建行。
 */
async function migrateToInline() {
  if (!config.mirrorInline) return 0;

  let cleaned = 0;
  const index = await paneIndex({ force: true });
  const tracked = trackedMirrorPaneIds();

  // 1) 镜像 pane
  for (const pane of index.panes || []) {
    const id = str(pane?.pane_id);
    if (!id || !herdr.isMirrorPane(pane)) continue;
    if (!tracked.has(id)) continue;
    const closed = await herdr.paneClose(id);
    if (closed.ok) {
      cleaned += 1;
      log("info", `内联模式：清掉旧模式遗留的镜像 pane ${id}`);
    } else if (!isPaneNotFound(closed.error)) {
      log("warn", `内联模式：清镜像 pane ${id} 失败：${closed.error}`);
    }
  }

  // 2) 镜像标签页与工作区
  for (const entry of Object.values(runtime.state.mirrors || {})) {
    const tabId = str(entry?.tabId);
    if (!tabId) continue;
    const res = await herdr.tabClose(tabId);
    if (res?.ok) {
      cleaned += 1;
      log("info", `内联模式：关掉旧模式遗留的镜像标签页 ${tabId}`);
    }
  }
  if (str(runtime.state.central?.tabId)) {
    const res = await herdr.tabClose(str(runtime.state.central.tabId));
    if (res?.ok) cleaned += 1;
  }
  const centralWs = str(runtime.state.central?.workspaceId);
  if (centralWs) {
    await herdr.workspaceClose(centralWs);
  }

  if (Object.keys(runtime.state.mirrors || {}).length > 0) {
    log("info", "内联模式：已清空 state 里的镜像标签页记录");
    runtime.state.mirrors = {};
  }
  if (str(runtime.state.central?.workspaceId) || str(runtime.state.central?.tabId)) {
    runtime.state.central = store.emptyCentral();
  }
  // 旧记录里的 paneId 一律作废：内联模式下 rec.paneId 恒为空
  for (const rec of Object.values(runtime.state.panes)) rec.paneId = "";

  if (cleaned > 0) {
    invalidatePaneIndex();
    log("info", `内联模式：迁移清理了 ${cleaned} 项旧残留`);
  }
  return cleaned;
}

/** 是不是「连接层」错误 —— 只有这类才值得丢掉 client 重新发现。 */function isTransportError(err) {
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
  // codex 是另一条独立连接，一起收掉：留在那儿会让 board 进程永远不退出，
  // 也可能在 codex 重启时占着那个 socket。
  closeCodexClient();
  failDiscovery("opencode 连接中断");
}

/**
 * 关掉 codex 的 app-server 连接。
 *
 * 必须在退出路径上调用：那是用户自己启动的 app-server，我们的 socket 挂着不放手，
 * 它重启时要多等一次 socket 超时。
 */
function closeCodexClient() {
  const client = runtime.codex.client;
  runtime.codex.client = null;
  if (!client) return;
  try {
    client.close();
  } catch {
    /* ignore */
  }
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

// ---------------------------------------------------------------------------
// 目录 → (workspace_id, tab_id)：镜像标签页模型
//
// **为什么必须按目录解析工作区**：Agents 侧边栏的分组 token 只有 `workspace`
// （`ui.sidebar.agents.rows` 默认是 `["state_icon","machine","workspace","tab"]`），
// 没有任何「按目录分组」的选项。所以镜像行必须落在「用户为这个目录开的那个工作区」
// 里，那一行才会归到对应的 `[n] <项目名>` 分组下。
//
// 模型：
//   state.mirrors[<绝对目录>] = { workspaceId, tabId, anchorPaneId, fallback }
//   state.central              = { workspaceId, tabId, anchorPaneId, label }
//
// 每个目录在自己的工作区里**独占一个标签页**（固定名 `oc-sessions`）放它的镜像 pane。
// 独占标签页的意义：绝不往用户正在用的工作标签页里插 pane，多 pane 布局不会被挤压。
// 标签页内部再用平衡 BSP 树摆该目录的多个镜像 pane。
// 一个目录都匹配不上工作区时，才退回 central 那个 `Sessions` 工作区。
// ---------------------------------------------------------------------------

/** 目录归一：file:// URL → 路径、砍掉结尾斜杠、空白。空/非法一律返回 ""。 */
export function normalizeDir(value) {
  let dir = typeof value === "string" ? value.trim() : "";
  if (!dir) return "";
  if (dir.startsWith("file://")) {
    try {
      dir = fileURLToPath(dir);
    } catch {
      return "";
    }
  }
  dir = dir.replace(/[\\/]+$/, "");
  return dir || "/";
}

/** `base` 是否是 `dir` 的真祖先目录（按路径分段比，避免 /a/bc 命中 /a/b）。 */
function isAncestorDir(base, dir) {
  if (!base || !dir || base === dir) return false;
  return dir.startsWith(base.endsWith("/") ? base : `${base}/`);
}

// --- pane 全量索引 ---------------------------------------------------------

/**
 * pane 列表索引，带 TTL 缓存。
 *
 * 三件事都要用：① 目录 → workspace 解析；② 认领「上次留下的镜像标签页」；
 * ③ 孤儿回收。都不是每轮都必要的事，所以缓存 15 秒，别每 5 秒拉一次全量。
 */
const PANE_INDEX_TTL_MS = 15_000;

async function paneIndex({ force = false } = {}) {
  const cached = runtime.paneIndex;
  if (!force && cached && Date.now() - cached.at < PANE_INDEX_TTL_MS) return cached;

  const panes = await herdr.paneList();
  const workspaces = await herdr.workspaceList();
  const paneCount = new Map();
  const tabPanes = new Map();

  for (const pane of panes) {
    const wsId = str(pane?.workspace_id);
    paneCount.set(wsId, (paneCount.get(wsId) || 0) + 1);
    const tabId = str(pane?.tab_id);
    if (!tabId) continue;
    if (!tabPanes.has(tabId)) tabPanes.set(tabId, []);
    tabPanes.get(tabId).push(pane);
  }
  // workspace list 自带的 pane_count 可以补上 pane list 漏掉的部分
  for (const ws of workspaces) {
    const id = str(ws?.workspace_id);
    if (!id) continue;
    paneCount.set(id, Math.max(paneCount.get(id) || 0, Number(ws.pane_count) || 0));
  }

  runtime.paneIndex = { at: Date.now(), panes, paneCount, tabPanes };
  return runtime.paneIndex;
}

function invalidatePaneIndex() {
  if (runtime.paneIndex) runtime.paneIndex.at = 0;
}

// --- 目录 → workspace ------------------------------------------------------

/**
 * 目录 → workspace_id。
 *
 * **绝不拿 basename 猜**：同一个项目名可以出现在任意路径下，猜错就会把镜像行
 * 归到别人的分组里。三级判定，命中哪一级都会写进日志：
 *
 *   1. `cwd` 严格等于该目录 —— 用户就是在这个目录里开的 opencode，绝大多数命中这一级。
 *   2. `foreground_cwd` 严格等于该目录 —— pane 的实际前台进程在这个目录里。
 *   3. 该目录在某个 pane 目录的**之下**（取最深的那个）—— 用户在项目子目录里
 *      开了 session、而那个子目录自己没有 pane 时的兜底。
 *
 * 同一级命中多个工作区时，挑「在这个目录里 pane 最多的那个」（见 {@link pickWorkspace}）。
 *
 * @returns {{workspaceId:string, tier:string}|null}
 */
export function resolveWorkspaceForDirectory(directory, index) {
  const dir = normalizeDir(directory);
  if (!dir) return null;

  for (const field of ["cwd", "foreground_cwd"]) {
    const byWorkspace = new Map();
    for (const pane of index.panes) {
      if (normalizeDir(pane?.[field]) !== dir) continue;
      const id = str(pane?.workspace_id);
      byWorkspace.set(id, (byWorkspace.get(id) || 0) + 1);
    }
    if (byWorkspace.size > 0) return { workspaceId: pickWorkspace(index, byWorkspace), tier: field };
  }

  // tier 3：先取「最深的那个 pane 目录」，再在同深度里挑工作区
  let deepestDepth = 0;
  const byWorkspace = new Map();
  for (const pane of index.panes) {
    for (const field of ["cwd", "foreground_cwd"]) {
      const base = normalizeDir(pane?.[field]);
      if (!isAncestorDir(base, dir)) continue;
      const depth = base.split("/").length;
      if (depth > deepestDepth) {
        deepestDepth = depth;
        byWorkspace.clear();
      }
      if (depth !== deepestDepth) continue;
      const id = str(pane?.workspace_id);
      byWorkspace.set(id, (byWorkspace.get(id) || 0) + 1);
    }
  }
  if (deepestDepth > 0) return { workspaceId: pickWorkspace(index, byWorkspace), tier: "祖先目录" };

  return null;
}

/**
 * 多个候选工作区里挑一个。
 *
 * **首选「在这个目录里 pane 最多的那个工作区」**，而不是「pane 总数最多的」。
 * 实测差别很要命：`herdr` 这个目录同时命中 `[4] AI8051U_AM32_ESC`（只有 1 个 pane 在
 * 这个目录，是个 sidebar）和 `[7] herdr`（4 个 pane 都在这个目录，用户真在这儿干活）。
 * 按总数挑会选错分组，按匹配数挑才对 —— 「这个目录里 pane 多」才说明用户真的在这干活。
 * 匹配数一样再比 pane 总数，最后按 id 保证结果稳定可复现。
 */
function pickWorkspace(index, matchCountByWorkspace) {
  let bestId = "";
  let bestMatch = -1;
  let bestTotal = -1;
  for (const [id, matches] of matchCountByWorkspace) {
    if (!id) continue;
    const total = index.paneCount.get(id) || 0;
    const better =
      matches > bestMatch ||
      (matches === bestMatch && total > bestTotal) ||
      (matches === bestMatch && total === bestTotal && id < bestId);
    if (!better) continue;
    bestId = id;
    bestMatch = matches;
    bestTotal = total;
  }
  return bestId || null;
}

// --- 镜像标签页 ------------------------------------------------------------

/**
 * 拿到（或创建）这个目录的镜像标签页。
 *
 * @param {string} directory session 的工作目录；空则直接用 central
 * @returns {Promise<{workspaceId:string,tabId:string,anchorPaneId:string,fallback:boolean}|null>}
 */
async function ensureMirrorTab(directory) {
  const dir = normalizeDir(directory);
  const existing = dir ? runtime.state.mirrors[dir] : null;

  // 1) 已有条目：确认标签页和锚点还在
  if (existing) {
    if (existing.fallback) {
      const central = await ensureCentral(dir);
      if (central) return central;
    } else {
      if (await mirrorEntryAlive(existing)) return existing;
      log("info", `${dir} 的镜像标签页 ${existing.tabId || "?"} 已消失，重新创建`);
      delete runtime.state.mirrors[dir];
    }
  }

  // 2) 目录 → workspace。force 刷新：新建标签页会改 pane 列表，缓存不能信。
  const index = await paneIndex({ force: true });
  const hit = dir ? resolveWorkspaceForDirectory(dir, index) : null;

  if (hit?.workspaceId) {
    const adopted = await adoptMirrorTab(index, hit.workspaceId);
    if (adopted) {
      runtime.state.mirrors[dir] = adopted;
      log(
        "info",
        `${dir} → 工作区 ${hit.workspaceId}（${hit.tier} 命中），复用镜像标签页 ${adopted.tabId || "?"}`,
      );
      return adopted;
    }
    const created = await createMirrorTab(hit.workspaceId, dir);
    if (created) {
      runtime.state.mirrors[dir] = created;
      log(
        "info",
        `${dir} → 工作区 ${hit.workspaceId}（${hit.tier} 命中），新建镜像标签页 ${created.tabId}`,
      );
      return created;
    }
    log("warn", `${dir} 已命中工作区 ${hit.workspaceId}，但镜像标签页建不出来，改归入 central`);
  } else if (dir) {
    // 用户没在这个目录开过 Herdr 工作区（比如 session 在 /tmp 下）——只有这一种情况
    // 才退回 central，日志里说清楚，避免用户以为「分组怎么跑到 Sessions 去了」。
    log("info", `${dir} 没有对应的工作区，已归入 ${config.mirrorLabel} 兜底工作区`);
  }

  // 3) 兜底
  // 这里存的是一条**「本目录走 central」的备忘**，不是镜像标签页本身：字段全空，
  // 真正的 tab/锚点在 state.central 里。留它是为了下一轮直接在 1) 命中 fallback
  // 分支直接跳到 ensureCentral，省掉一次全量工作区解析。代价是用户之后为这个目录
  // 开了工作区也不会改判 —— 那时它仍然只是归到 Sessions 分组，行照样在，不影响正确性。
  if (dir) runtime.state.mirrors[dir] = { ...store.emptyMirrorEntry(), fallback: true };
  return await ensureCentral(dir);
}

async function mirrorEntryAlive(entry) {
  const anchorPane = str(entry?.anchorPaneId);
  if (!anchorPane) return false;
  const pane = await herdr.paneGet(anchorPane);
  if (!pane) return false;
  return str(pane.tab_id) === str(entry.tabId);
}

/**
 * 认领这个工作区里已经存在的镜像标签页。
 *
 * 优先「里面还有我们跟踪的镜像 pane」——最可靠，而且完全不看 label；
 * 其次才按 label 认（state.json 丢了、标签页还在的情况）。用户的工作区标签
 * 会被 sidebar 插件改写成 `[3] oc-sessions › xxx`，所以比对前要先归一化。
 */
async function adoptMirrorTab(index, workspaceId) {
  const tracked = trackedMirrorPaneIds();
  const candidates = [];

  for (const tab of await herdr.tabList(workspaceId)) {
    const tabId = str(tab?.tab_id);
    if (!tabId) continue;
    const panes = index.tabPanes.get(tabId) || [];
    const trackedHere = panes.filter((p) => tracked.has(str(p?.pane_id)));
    const labelHit = sameTabLabel(tab?.label, config.mirrorTabLabel);
    if (trackedHere.length === 0 && !labelHit) continue;
    // 分数：2 = 里面有我们跟踪的镜像 pane（一定是我们自己的标签页）
    //      1 = 只有 label 对得上（可能是上一轮留下的空标签页）
    candidates.push({ tabId, panes, trackedHere, score: trackedHere.length > 0 ? 2 : 1 });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.tabId.localeCompare(b.tabId));
  const chosen = candidates[0];

  return {
    workspaceId,
    tabId: chosen.tabId,
    anchorPaneId: pickAdoptionAnchor(chosen.panes, chosen.trackedHere),
    fallback: false,
  };
}

/**
 * 认领标签页时挑锚点 pane。
 *
 * **不能随便拿「第一个 pane」** —— pane 列表的顺序不保证是布局顺序，而 sidebar 插件
 * 会给自己的每个标签页注入一个 `label: "Sidebar"` 的 pane。抢它当锚点的话，
 * 之后 split 出来的镜像 pane 会跑到侧边栏那一列下面去（实测 w1J:t4 就是这样：
 * 镜像 pane 被塞到了 Sidebar 底下，锚点却占着整列）。
 *
 * 优先级：① 自己留的锚点 shell（没 label、没有别人的 agent 行）；
 * ② 跟踪中的镜像 pane；③ 实在挑不出来就用列表第一个。
 */
function pickAdoptionAnchor(panes, trackedHere = []) {
  const list = Array.isArray(panes) ? panes : [];
  const plain = list.filter((p) => !p?.label && !isForeignAgentPane(p) && !herdr.isMirrorPane(p));
  const tracked = list.filter((p) => trackedHere.includes(p));
  return str((plain[0] || tracked[0] || list[0])?.pane_id);
}

/** 在目标工作区里开一个专属镜像标签页。 */
async function createMirrorTab(workspaceId, directory) {
  const created = await herdr.tabCreate({
    workspaceId,
    label: config.mirrorTabLabel,
    cwd: directory || undefined,
  });
  const tabId = str(created?.tab?.tab_id);
  const paneId = str(created?.root_pane?.pane_id);
  if (!tabId || !paneId) {
    log("warn", `工作区 ${workspaceId} 里 tab create 没返回 tab/root_pane`);
    return null;
  }
  invalidatePaneIndex();
  return { workspaceId, tabId, anchorPaneId: paneId, fallback: false };
}

/**
 * 兜底的 central 工作区（`MIRROR_LABEL`，默认 `Sessions`）。
 * 只有「有目录匹配不上工作区」时才会被建起来，所以它平时根本不存在。
 */
async function ensureCentral(directory) {
  const central = runtime.state.central;

  if (central.workspaceId && (await mirrorEntryAlive(central))) {
    return { ...central, fallback: true };
  }

  // 1) 记录里的工作区还在（标签页被回收了 / 是上一轮留下的）→ 就在它里面建一个镜像标签页
  // 2) 按 label 找回上次的 central 工作区（Herdr 可能给 workspace label 加 `[n] ` 前缀）
  //    两条路都失败才新建工作区，不然连着回收几次就会冒出一堆同名的 `Sessions`。
  const workspaces = await herdr.workspaceList();
  const known = workspaces.filter((w) => str(w?.workspace_id) === str(central.workspaceId));
  const byLabel = workspaces.filter((w) => sameLabel(w.label, central.label || config.mirrorLabel));
  const reusable = [...known, ...byLabel.filter((w) => !known.includes(w))];

  for (const ws of reusable) {
    const wsId = str(ws.workspace_id);
    if (!wsId) continue;
    const index = await paneIndex({ force: true });
    const adopted = await adoptMirrorTab(index, wsId);
    const entry = adopted || (await createMirrorTab(wsId, directory));
    if (!entry) continue;

    runtime.state.central = {
      workspaceId: entry.workspaceId,
      tabId: entry.tabId,
      anchorPaneId: entry.anchorPaneId,
      label: config.mirrorLabel,
    };
    log(
      "info",
      `复用 ${config.mirrorLabel} 工作区 ${wsId}，` +
        `${adopted ? "认领" : "新建"}镜像标签页 ${entry.tabId}`,
    );
    return { ...runtime.state.central, fallback: true };
  }

  if (central.workspaceId) {
    log("info", `${config.mirrorLabel} 兜底工作区 ${central.workspaceId} 已失效，重新创建`);
  }

  const created = await herdr.workspaceCreate({
    label: config.mirrorLabel,
    cwd: directory || undefined,
  });
  const paneId = str(created?.root_pane?.pane_id);
  if (!paneId) throw new Error("workspace create 没返回 root_pane（herdr 输出异常）");

  const tabId = str(created?.tab?.tab_id);
  // workspace create 自带的标签页就是我们的镜像标签页，统一改个名字方便认领
  if (tabId) await herdr.tabRename(tabId, config.mirrorTabLabel);

  runtime.state.central = {
    workspaceId: str(created?.workspace?.workspace_id),
    tabId,
    anchorPaneId: paneId,
    label: config.mirrorLabel,
  };
  invalidatePaneIndex();
  log(
    "info",
    `已创建 ${config.mirrorLabel} 兜底工作区 ${runtime.state.central.workspaceId || "?"}` +
      `，镜像标签页 ${tabId || "?"}，锚点 ${paneId}`,
  );
  return { ...runtime.state.central, fallback: true };
}

/** 找 state.mirrors 里记着这个标签页的目录（central 另有 state.central）。 */
function findMirrorEntryByTab(tabId) {
  for (const [dir, entry] of Object.entries(runtime.state.mirrors || {})) {
    if (entry && str(entry.tabId) === str(tabId) && tabId) return { dir, entry };
  }
  return null;
}

/** 我们跟踪着的全部镜像 pane id（不含锚点 shell）。 */
function trackedMirrorPaneIds() {
  const out = new Set();
  for (const rec of Object.values(runtime.state.panes || {})) {
    if (rec && str(rec.paneId)) out.add(str(rec.paneId));
  }
  return out;
}

/**
 * sidebar 插件往每个标签页注入的 pane 的 label。
 *
 * 纯镜像标签页里它是唯一的「外来」pane，且不报任何 agent 行，所以判定
 * 「这个标签页归我们管」时可以把它算进平衡池。
 */
const SIDEBAR_PANE_LABEL = "Sidebar";

/**
 * 这个 pane 上有没有**别的来源**（官方集成、user、custom…）上报的 agent 行。
 *
 * 两条硬安全阀都用它：① 镜像标签页里有别人的 agent 行就不许关；
 * ② 重平衡时不许把别人的 pane 当成自己的（否则会去动 sidebar 那一列的比例）。
 */
function isForeignAgentPane(pane) {
  const source = pane?.agent_session?.source;
  return typeof source === "string" && source.length > 0 && source !== herdr.ownSource();
}

/**
 * 这个标签页里已经没有镜像 pane 了 → 连标签页一起收掉。
 *
 * 回收完最后一个镜像 pane 之后标签页只剩一个锚点 shell，不关掉就会留下一个空标签。
 * 硬安全阀：标签页里还有**别的 source 上报的 agent 行**时绝不关 —— 那种情况下
 * 它已经不是「纯镜像标签页」了，可能是用户自己用上了这个标签页。
 * sidebar 插件注入的 Sidebar pane 没有 agent 行，不会触发这个保护。
 */
async function maybeCloseMirrorTab(home, reason) {
  const tabId = str(home?.tabId);
  const workspaceId = str(home?.workspaceId);
  if (!tabId) return false;

  const tracked = trackedMirrorPaneIds();
  const inTab = (await herdr.paneList(workspaceId)).filter((p) => str(p?.tab_id) === tabId);
  const live = inTab.filter(
    (p) => tracked.has(str(p?.pane_id)) || herdr.isMirrorPane(p),
  );
  if (live.length > 0) return false;

  const foreign = inTab.filter((p) => isForeignAgentPane(p));
  if (foreign.length > 0) {
    log("warn", `标签页 ${tabId} 里还有 ${foreign.length} 个非镜像 agent 行，保留标签页不关`);
    return false;
  }

  const closed = await herdr.tabClose(tabId);
  if (!closed.ok) {
    log("warn", `关闭镜像标签页 ${tabId} 失败，保留映射下轮重试: ${closed.error}`);
    return false;
  }

  // central 的记录里 tabId 是空的（fallback 目录只存标记，真实 id 在 state.central），
  // 所以 central 那条路径要把所有 fallback 目录的记录一起清掉。
  const wasCentral = str(runtime.state.central.tabId) === tabId;
  if (wasCentral) {
    for (const [dir, entry] of Object.entries(runtime.state.mirrors || {})) {
      if (entry?.fallback) delete runtime.state.mirrors[dir];
    }
  } else {
    const found = findMirrorEntryByTab(tabId);
    if (found) delete runtime.state.mirrors[found.dir];
  }
  invalidatePaneIndex();
  log("info", `镜像标签页 ${tabId} 已无镜像 pane，整页关闭（${reason}）`);

  // 注意顺序：先判要不要关 central 工作区，再由它自己决定怎么清记录
  if (wasCentral) await maybeCloseCentral(reason);
  return true;
}

/**
 * 没有任何目录再用 central 兜底工作区 → 关掉它。
 *
 * 关不掉（比如里面还有别人的 agent 行）就只忘掉这个标签页，工作区留着下次复用 ——
 * 反正 ensureCentral 会在同一个工作区里重新开镜像标签页，不会多出同名工作区。
 */
async function maybeCloseCentral(reason) {
  const central = runtime.state.central;
  if (!central.workspaceId) return false;
  const inUse = Object.values(runtime.state.mirrors || {}).some((m) => m && m.fallback);
  if (inUse) return false;

  if (await closeCentralWorkspace(reason)) {
    runtime.state.central = store.emptyCentral();
    return true;
  }
  runtime.state.central = { ...central, tabId: "", anchorPaneId: "" };
  return false;
}

/** 关掉 central 兜底工作区。里面还有别人的 agent 行时不关。 */
async function closeCentralWorkspace(reason) {
  const central = runtime.state.central;
  const workspaceId = str(central?.workspaceId);
  if (!workspaceId) return true;

  if (central.tabId) await herdr.tabClose(central.tabId);

  const panes = await herdr.paneList(workspaceId);
  const foreign = panes.filter((p) => isForeignAgentPane(p));
  if (foreign.length > 0) {
    log("warn", `${config.mirrorLabel} 兜底工作区 ${workspaceId} 里还有 ${foreign.length} 个非镜像 agent，保留`);
    return false;
  }

  const closed = await herdr.workspaceClose(workspaceId);
  if (closed.ok) {
    log("info", `${config.mirrorLabel} 兜底工作区 ${workspaceId} 已无目录使用，关闭（${reason}）`);
  } else if (/not_found/.test(String(closed.error || ""))) {
    // 标签页关掉之后 herdr 会自己把空工作区收走 —— 这正是我们想要的，记一条 info 就行
    log("info", `${config.mirrorLabel} 兜底工作区 ${workspaceId} 已被 herdr 自动回收`);
  } else {
    log("warn", `关闭 ${config.mirrorLabel} 兜底工作区失败: ${closed.error}`);
  }
  invalidatePaneIndex();
  return Boolean(closed.ok) || /not_found/.test(String(closed.error || ""));
}

/** herdr 会给 workspace label 加 `[n] ` 前缀，比对时要剥掉。 */
function sameLabel(a, b) {
  const norm = (v) => String(v || "").replace(/^\[\d+\]\s*/, "").trim();
  return Boolean(a) && norm(a) === norm(b);
}

/**
 * 标签页 label 的归一化比对。
 * sidebar 插件会把标签页改写成 `[3] oc-sessions` 甚至 `[3] oc-sessions › xxx`，
 * 所以先剥编号前缀、再只取 `›` 之前的部分。
 */
function sameTabLabel(a, b) {
  const norm = (v) =>
    String(v || "")
      .replace(/^\[\d+\]\s*/, "")
      .split(/\s*›\s*/)[0]
      .trim();
  return Boolean(a) && norm(a) === norm(b);
}

/**
 * 造孤儿回收：把「带 oc_mirror token、但不在我们映射里」的 pane 全部 release + 关掉。
 *
 * state.json 丢失或崩过几轮时，Herdr 里会留下一堆上一轮的行，而且没有任何映射能认领
 * 它们。靠 token 认最可靠 —— 标签页名可能被用户改，pane id 一定认不错。
 */
async function sweepOrphanPanes(reason, { force = false } = {}) {
  const index = await paneIndex({ force });
  const tracked = trackedMirrorPaneIds();
  let closedCount = 0;

  for (const pane of index.panes) {
    const paneId = str(pane?.pane_id);
    if (!paneId || tracked.has(paneId) || !herdr.isMirrorPane(pane)) continue;

    await herdr.releaseAgent({ paneId, seq: nextSeq() });
    const closed = await herdr.paneClose(paneId);
    if (closed.ok) {
      closedCount += 1;
      log("info", `回收孤儿镜像 pane ${paneId}（${reason}）`);
    } else {
      log("warn", `回收孤儿镜像 pane ${paneId} 失败: ${closed.error}`);
    }
  }

  if (closedCount > 0) invalidatePaneIndex();
  return closedCount;
}

/**
 * 清掉「映射还在、但这一行已经被别的来源接管」的镜像行。
 *
 * 接管就是 `oc_mirror` token 消失：有人在镜像 pane 里手动敲了
 * `opencode --session <id>`，或者（旧的 `RESUME_MODE=opencode`）Herdr 重启时
 * 自动重放了恢复命令。官方集成随后在同一个 pane 上报官方行，我们的标记被覆盖。
 *
 * 只看「pane 还在不在」是发现不了的 —— pane 好好地在那儿，于是这一行静默消失。
 *
 * 接管后官方集成已经报了该 session id，所以删掉映射就等于**让出**：正常的
 * claimed 去重逻辑会接手。等这个 session 不再被任何 TUI 选中，它自然重新变成
 * 镜像行。这也正是「同一 session 只出现一行」这条规则在起作用。
 *
 * 复用本轮已经取到的 pane 索引，不额外发请求。
 */
async function sweepTakenOverPanes(index, reason) {
  const tracked = trackedMirrorPaneIds();
  if (tracked.size === 0) return 0;

  const live = new Map();
  for (const pane of index.panes || []) {
    const id = str(pane?.pane_id);
    if (id) live.set(id, pane);
  }

  let dropped = 0;
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    const paneId = str(rec?.paneId);
    if (!paneId || !tracked.has(paneId)) continue;
    const pane = live.get(paneId);
    if (pane && herdr.isMirrorPane(pane)) continue;
    if (!pane) continue; // pane 真没了，交给 validateTrackedPanes / 建行自愈

    log("info", `镜像行 ${shortId(sessionID)} 的 pane ${paneId} 已被其它来源接管，让出（${reason}）`);
    // 刻意**不**调 releaseAgent、也**不**关 pane：这一行现在归官方集成所有，
    // 里面很可能有一个用户正在用的 opencode TUI。我们对它已经没有任何权利，
    // 碰它就是破坏用户的工作。放弃映射就够了。
    delete runtime.state.panes[sessionID];
    await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
    dropped += 1;
  }
  if (dropped > 0) invalidatePaneIndex();
  return dropped;
}

/**
 * 清掉「central 兜底工作区已经没了」的记录。
 *
 * 需要这一步是因为 herdr 会**自动回收空工作区**：标签页关掉之后工作区自己就没了，
 * 而我们的记录里还留着那个 workspace_id。不清掉的话，下次走 fallback 会先拿着一个
 * 已消失的 id 去认领，白跑一趟（在 ensureCentral 里虽然会兜住，但记录本身是错的）。
 */
function pruneDeadCentral(index) {
  const central = runtime.state.central;
  if (!central.workspaceId || central.tabId) return;
  const inUse = Object.values(runtime.state.mirrors || {}).some((m) => m && m.fallback);
  if (inUse) return;
  const alive = index.panes.some((p) => str(p?.workspace_id) === str(central.workspaceId));
  if (!alive) {
    log("info", `${config.mirrorLabel} 兜底工作区 ${central.workspaceId} 已不存在，清掉记录`);
    runtime.state.central = store.emptyCentral();
  }
}

/**
 * 给一个 session 建镜像 pane：确认/新建它的镜像标签页 → split → **重平衡** → 校验可见行 → 启驻留。
 *
 * 关键设计（替代旧的「锚点越来越小 + 高度守卫」）：
 * `pane split` 之后立刻把**这个标签页**里镜像子树的比例重算一遍，让所有镜像 pane
 * 均分空间。旧策略是反复用小 ratio 拆同一个锚点，锚点自己被逐次压缩，预算很快耗尽 ——
 * 那不是 herdr 的限制，是切分策略错了。实测 44 行 area 下平衡 8 叶完全放得下。
 *
 * session id / 标题 / 目录全部通过 `pane split --env` 传，不进 shell 文本，
 * 所以不存在把用户数据拼进命令行的注入面。
 */
async function createMirrorPane(info) {
  let entry;
  try {
    entry = await ensureMirrorTab(info.directory);
  } catch (err) {
    log("warn", `准备镜像标签页失败：${err?.message || err}`);
    return null;
  }
  if (!entry || !entry.anchorPaneId) return null;

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
      paneId: entry.anchorPaneId,
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
  await rebalanceMirrorTab(entry, `新建 ${shortId(info.id)}`, [paneId]);
  await ensurePaneVisible(entry, paneId, `新建 ${shortId(info.id)}`);

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

/**
 * 这个标签页里我们自己占着的 pane：锚点 + 跟踪中的镜像 pane + 带 oc_mirror token 的残留。
 *
 * 只统计这个标签页的 pane —— 每个目录有自己的标签页，别的目录的镜像不参与这里的平衡。
 * token 兜底是必需的：state.json 丢了 / 崩过几轮时，靠映射认不回来的镜像 pane
 * 会被当成「外来 pane」，整棵镜像子树就永远得不到平衡。
 */
async function ourPaneIdsInTab(entry, extra = []) {
  const out = new Set();
  for (const id of extra) if (id) out.add(id);

  const workspaceId = str(entry?.workspaceId);
  const tabId = str(entry?.tabId);
  if (!workspaceId || !tabId) {
    const anchor = str(entry?.anchorPaneId);
    if (anchor) out.add(anchor);
    return out;
  }

  const tracked = trackedMirrorPaneIds();
  const anchor = str(entry?.anchorPaneId);
  const panes = (await herdr.paneList(workspaceId)).filter((p) => str(p?.tab_id) === tabId);

  // 「纯镜像标签页」= 除了 sidebar 插件注入的 Sidebar pane 以外，没有任何别的
  // source 上报过 agent 行。这时整棵子树都归我们平衡。
  //
  // 必须这么判的原因：sidebar 插件会给**每个**标签页注入一个 Sidebar pane，而
  // `balanceSplitPlans` 只处理「子树里全是我们的 pane」的节点。之前 sidebar pane
  // 被当成外来 pane，根 split 就永远被跳过 —— 结果是我们自己建的 oc-sessions
  // 标签页从没被平衡过，sidebar 在里面白占一半空间（实测 42/78 行），而每个
  // session pane 只剩 9 行。
  const exclusive = panes.every((p) => !isForeignAgentPane(p) || p?.label === SIDEBAR_PANE_LABEL);

  for (const pane of panes) {
    const id = str(pane?.pane_id);
    if (!id) continue;
    // 非纯镜像标签页（认领路径万一抢到了用户的标签页）：别人的 agent 行一律不碰，
    // 不能因此去动用户侧边栏那一列的比例
    if (!exclusive && isForeignAgentPane(pane)) continue;
    if (id === anchor || tracked.has(id) || herdr.isMirrorPane(pane)) out.add(id);
  }
  return out;
}

/**
 * 重平衡**某个镜像标签页**里的镜像布局。
 *
 * 用 `layout.set_split_ratio` 而不是 `layout.apply` —— 官方文档明说 apply
 * 会重建 tab、不保留 live PTY / scrollback / 进程，把已有镜像 pane 全杀掉重启。
 *
 * @param {{workspaceId:string,tabId:string,anchorPaneId:string}} entry 这个目录的镜像标签页
 * @returns {Promise<number>} 实际调整的节点数
 */
async function rebalanceMirrorTab(entry, reason, extraPaneIds = []) {
  const tabId = str(entry?.tabId);
  const anchorPane = str(entry?.anchorPaneId);
  if (!tabId || !anchorPane) return 0;

  // 锚点已经不在了（用户把它关了）→ 这次没什么可平衡的，等下次重建标签页
  if (!(await herdr.paneGet(anchorPane))) return 0;

  let layout = null;
  try {
    layout = await herdr.layoutExport(tabId);
  } catch (err) {
    log("debug", `layout.export 失败（${reason}）：${err?.message || err}`);
    return 0;
  }
  if (!layout?.root) return 0;

  const plans = balanceSplitPlans(layout.root, await ourPaneIdsInTab(entry, extraPaneIds));
  if (plans.length === 0) return 0;

  let applied = 0;
  for (const plan of plans) {
    const res = await herdr.layoutSetSplitRatio({ tabId, path: plan.path, ratio: plan.ratio });
    if (res.ok) applied += 1;
    else log("debug", `set_split_ratio([${plan.path}]) 失败：${res.error}`);
  }
  if (applied > 0) log("debug", `重平衡镜像布局 ${tabId} ${applied} 个节点（${reason}）`);
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
async function ensurePaneVisible(entry, paneId, reason) {
  let rows = await herdr.paneViewportRows(paneId);
  if (rows === null || rows > 0) return rows;

  await rebalanceMirrorTab(entry, `${reason}: 首轮 0 行`, [paneId]);
  rows = await herdr.paneViewportRows(paneId);
  if (rows === null || rows > 0) return rows;

  log(
    "warn",
    `镜像 pane ${paneId} 重平衡后仍拿不到可视行（${rows}）。这一行照样保留，下一轮会再平衡一次。` +
      `若反复出现，多半是镜像标签页 ${str(entry?.tabId) || "?"} 被缩得太矮。`,
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

  // 关之前先记住它属于哪个工作区/标签页：这个标签页可能这一轮就被清空了，
  // 得连标签页一起回收，否则用户的工作区里会留一个只剩锚点 shell 的空标签。
  const pane = await herdr.paneGet(rec.paneId);
  const home = { workspaceId: str(pane?.workspace_id), tabId: str(pane?.tab_id) };

  const released = await herdr.releaseAgent({ paneId: rec.paneId, seq: nextSeq() });
  if (!released.ok) log("debug", `release-agent 失败: ${released.error}`);

  const closed = await herdr.paneClose(rec.paneId);
  if (!closed.ok) {
    // pane 已经不在了 = 目标已达成。当成失败保留映射的话，这一行就永久丢了：
    // 下一轮还是会去关同一个不存在的 pane，永远重建不回来（实测 session 还在跑，
    // 侧边栏却再没有它的行，每轮刷一条 warn）。
    if (isPaneNotFound(closed.error)) {
      log("info", `镜像 pane ${rec.paneId} 已被外部关闭，丢弃映射下轮重建（${reason}）`);
      delete runtime.state.panes[sessionID];
      await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
      return;
    }
    log("warn", `关闭镜像 pane ${rec.paneId} 失败，保留映射下轮重试: ${closed.error}`);
    return;
  }

  delete runtime.state.panes[sessionID];
  await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
  invalidatePaneIndex();

  // 少了一个叶子，剩下的 pane 要重新均分，不然锚点会把空出来的空间全吃掉。
  // 一轮里可能连续回收好几行，只重平衡一次就够。
  const entry = mirrorEntryForTab(home.tabId) || {
    workspaceId: home.workspaceId,
    tabId: home.tabId,
    anchorPaneId: "",
  };
  if (!runtime.balancedThisPass) {
    runtime.balancedThisPass = true;
    await rebalanceMirrorTab(entry, `回收 ${shortId(sessionID)}`);
  }

  // 标签页里已经没有镜像 pane 了 → 整页关掉（这个目录的镜像到此结束）
  await maybeCloseMirrorTab(home, `回收 ${shortId(sessionID)}`);
  log("info", `回收镜像行 ${shortId(sessionID)}（${reason}）`);
}

/** 按标签页找出它的镜像记录（fallback 目录走 state.central）。 */
function mirrorEntryForTab(tabId) {
  if (!tabId) return null;
  if (str(runtime.state.central.tabId) === str(tabId)) {
    return { ...runtime.state.central, fallback: true };
  }
  const found = findMirrorEntryByTab(tabId);
  return found ? found.entry : null;
}

/** 全部回收（reap action 用）。 */
async function reapAll(reason) {
  for (const [sessionID, rec] of Object.entries(runtime.state.panes)) {
    if (!rec.paneId) {
      delete runtime.state.panes[sessionID];
      continue;
    }
    await herdr.releaseAgent({ paneId: rec.paneId, seq: nextSeq() });
    const closed = await herdr.paneClose(rec.paneId);
    if (!closed.ok) log("warn", `关闭镜像 pane ${rec.paneId} 失败: ${closed.error}`);
    delete runtime.state.panes[sessionID];
    await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
  }
  invalidatePaneIndex();

  // 每个目录的镜像标签页整个关掉（fallback 目录共用 central 那一个）
  const tabIds = new Set();
  for (const entry of Object.values(runtime.state.mirrors || {})) {
    if (str(entry?.tabId)) tabIds.add(str(entry.tabId));
  }
  if (str(runtime.state.central.tabId)) tabIds.add(str(runtime.state.central.tabId));
  for (const tabId of tabIds) {
    const closed = await herdr.tabClose(tabId);
    if (!closed.ok) log("warn", `关闭镜像标签页 ${tabId} 失败: ${closed.error}`);
  }

  // 映射之外的残留镜像 pane 也要收（state.json 丢过、崩过几轮的情况）
  await sweepOrphanPanes(reason, { force: true });

  await closeCentralWorkspace(reason);
  runtime.state.mirrors = {};
  runtime.state.central = store.emptyCentral();
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
 * 所以这里只能用 "node"，不能用 process.execPath。
 *
 * **恢复命令恒为常驻进程，绝不恢复 opencode。**
 *
 * 曾经有个 `RESUME_MODE=opencode` 选项，恢复命令是 `opencode --session <id>`，
 * 理由是「重启后镜像行还能接着聊」。实测证明它会摧毁整个插件：
 * herdr 重启时它在镜像 pane 里拉起 opencode TUI，官方集成随即在**同一个 pane**
 * 上报官方 agent 行，把我们的 `oc_mirror` / `oc_session` token 直接覆盖掉 ——
 * 不是多出一行重复行，而是**这一行整个消失**。而状态文件里 `paneId` 还在，
 * 插件于是以为它活着，既不重建也不让出，镜像功能对该目录静默失效。
 *
 * 旧注释里写「下一轮去重会看到该 session 已被占用，主动让出这一行，所以不会
 * 重复」—— 这个推理是错的，它假设官方集成会**新增**一行，实际是**覆盖**同一行。
 *
 * 想在某个镜像位置直接和 session 对话，就手动敲 `opencode --session <id>`；
 * 那样它会变成一个官方行，插件下一轮就会自动让出，不会打架。
 */
function resumeArgvFor() {
  return ["node", MIRROR_SCRIPT];
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
  const identityStale = firstReport || rec.lastResume !== "mirror";

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
      rec.lastResume = "mirror";
      log("info", `上报[2/2] ${shortId(sessionID)} 恢复命令已挂上（常驻进程，不跑 opencode）`);
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
  // pane 的 label 会出现在侧边栏第 2 行（`state_icon` + `agent` 那一行）。
  // 只放 **agent 名 + 状态符号**，不要项目和标题 ——
  //   · 状态已经有 state_icon 在画了，重复一个 ● 只是噪音
  //   · 项目名已经在分组头（`[1] afloat`）里
  //   · 标题在下一行的 terminal_title_stripped 里
  return store.sanitizeText([mark, MIRROR_AGENT_LABEL].filter(Boolean).join(" "), MIRROR_LABEL_MAX);
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
  // 内联模式没有镜像 pane，也就没有 pane 里的驻留进程要喂快照。
  if (config.mirrorInline) return;
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

/**
 * 启动时核对上次残留的映射：pane / 镜像标签页没了就把记录清掉。
 *
 * 记录清掉不等于丢行 —— session 还在跑的话，下一轮会重新解析目录、重建标签页和 pane。
 */
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
      continue;
    }
    // 强制刷新展示层：label / token 的渲染规则可能随插件升级变了，而
    // fingerprint 只由「状态 + 标题 + 目录」构成，规则变化时它纹丝不动，
    // 于是新规则永远等不到触发条件（实测改完 mirrorLabel 重启 board 后
    // label 仍是旧的）。启动时无条件清一次，下一轮必定重写一遍。
    rec.fingerprint = "";
    rec.lastState = "";
    rec.reportedAt = 0;

    // pane 还在、但 `oc_mirror` 标记没了 → 这一行已经被**别的来源接管**。
    //
    // 真实事故：`RESUME_MODE=opencode` 让 Herdr 重启时在镜像 pane 里拉起 opencode
    // TUI，官方集成在同一个 pane 上报官方行，把我们的 token 覆盖掉了。只查
    // 「pane 还在不在」完全看不出这一点——pane 好好地在那儿，于是这一行静默消失，
    // 而状态文件里映射还在，插件既不重建也不让出。
    //
    // 接管之后官方集成已经报了该 session id，所以正确做法是**删掉映射让它让出**，
    // 由正常的 claimed 去重逻辑接手；等这个 session 不再被任何 TUI 选中，它会
    // 自然重新变成镜像行。
    if (!herdr.isMirrorPane(pane)) {
      log(
        "info",
        `镜像 pane ${rec.paneId} 已被其它来源接管（标记丢失），让出这一行` +
          `（session 仍在跑且未被选中时会重新建）`,
      );
      delete runtime.state.panes[sessionID];
      await store.removeFile(path.join(STATE_DIR, `mirror-${sessionID}.json`));
      dropped += 1;
    }
  }
  if (dropped > 0) log("info", `清理了 ${dropped} 条失效映射`);

  // 各目录的镜像标签页：锚点 pane 不在了就清掉该目录的记录（下次重建）
  let lostTabs = 0;
  for (const [dir, entry] of Object.entries(runtime.state.mirrors || {})) {
    if (entry?.fallback || !(await mirrorEntryAlive(entry))) {
      delete runtime.state.mirrors[dir];
      lostTabs += 1;
    }
  }
  if (lostTabs > 0) log("info", `清理了 ${lostTabs} 个已消失的镜像标签页记录`);

  if (runtime.state.central.workspaceId && !(await mirrorEntryAlive(runtime.state.central))) {
    log("info", `${config.mirrorLabel} 兜底工作区 ${runtime.state.central.workspaceId} 已失效`);
    runtime.state.central = store.emptyCentral();
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
  closeCodexClient();
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
