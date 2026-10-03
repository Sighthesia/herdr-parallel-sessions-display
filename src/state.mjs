// state.mjs —— 配置加载 + HERDR_PLUGIN_STATE_DIR 下的映射持久化。
//
// 说明：SPEC 第 8 节把交付物限定为 5 个 src 文件，配置解析没有单独的文件，
// 所以 .env 解析器与配置默认值都放在这里（配置与状态都是「本地持久化」范畴）。

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 配置默认值。文件值 < 真实环境变量 < 这些默认值。 */
export const CONFIG_DEFAULTS = Object.freeze({
  // --- SPEC 第 7 节 ---
  OPENCODE_SERVER_URL: "",
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "",
  MIRROR_LABEL: "Sessions",
  AUTO_START: "true",
  INSTALL_AGENT_VIEW: "false",
  POLL_INTERVAL_MS: "5000",
  IDLE_GRACE_MS: "15000",
  // 每个目录最多留几条「已完成、还没在前台查看过」的 session（内联模式）。
  // 0 = 不留，停下来 15 秒后照旧消失。
  IDLE_KEEP: "3",
  // 一个 agent 行最多显示几个 session。留空 = 自动读侧边栏模板
  // `ui.sidebar.agents.rows` 里引了几个 `$oc_sess*`，所以往模板里加一行就多一行，
  // 不用改这里。上限 14：herdr 的 16 行上限算的是**整个 rows 数组**，模板里已经
  // 占了 2 行给 workspace / agent 行。
  SESSION_ROWS: "",
  // --- SPEC 第 7 节之外、为可运行性补的项（README 有完整表格）---
  AGENT_VIEW_SCOPE: "mirror", // mirror | sort-only
  MIRROR_TAB_LABEL: "oc-sessions",
  // 已废弃：写什么都会被忽略，只用来在启动日志里提示。恢复命令恒为常驻进程。
  RESUME_MODE: "",
  MIRROR_PANE_RATIO: "0.5",
  MIRROR_PANE_DIRECTION: "down",
  // 常规重平衡巡检间隔。建行/回收时是即时的，这里只负责把别人改乱的布局纠回来。
  REBALANCE_INTERVAL_MS: "30000",
  // 焦点落到镜像 pane 时转到同目录真正的前台 agent（只在 MIRROR_INLINE=false 时生效）。
  FOCUS_REDIRECT: "true",
  // 同一个镜像行的重定向冷却，防抖。
  FOCUS_REDIRECT_COOLDOWN_MS: "2500",
  SESSION_LIST_LIMIT: "200",
  SESSION_PAGE_LIMIT: "8",
  RETRY_DETECTION: "true",
  RETRY_CHECK_LIMIT: "8",
  AUTO_AUTH_SERVICE_JSON: "true",
  DISCOVERY_BACKOFF_MAX_MS: "60000",
  LOG_LEVEL: "info",
  // --- 内联模式（SPEC 第 11 节）---
  // **这一段的每个键都必须列在这里。** KNOWN_KEYS 是从 CONFIG_DEFAULTS 派生的，
  // 不在这里的键会被 loadConfig 静默丢弃 —— .env 里写了、README 里也承诺了，
  // 但永远读不到，表现就是「改了配置没反应」，而且没有任何提示。踩过：
  // MIRROR_INLINE / INLINE_ALWAYS_LIST / PARALLEL_TOKEN_MAX / PARALLEL_TRUNK /
  // REBALANCE_INTERVAL_MS / FOCUS_REDIRECT / FOCUS_REDIRECT_COOLDOWN_MS
  // 这 7 个键就是这样白写了很久（board.mjs 读它们，KNOWN_KEYS 里却没有）。
  MIRROR_INLINE: "true",
  // 没有并行 session 时，官方 session 自己那一行还要不要写（默认要）。
  INLINE_ALWAYS_LIST: "true",
  // 单个 token 值的上限。Herdr 侧硬截断在 80 字符，插件先自己截好。
  PARALLEL_TOKEN_MAX: "78",
  // 会话行的连接符：bar=│▸ ● 标题（默认，整列对齐）/ tree=├─ ▸ 标题 / none=▸ 标题
  PARALLEL_CONNECTOR: "bar",
  // 「正在跑」标记的帧序列。**单字符 = 静态**（默认 ●）。
  // 想开点阵转轮：两项都要改 —— PARALLEL_BUSY_FRAMES 填多字符（Herdr 自己的
  // ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏）+ PARALLEL_BUSY_ANIMATE=true。只填序列不开动画仍是静帧，
  // 免得填了序列就意外把 12% 的 CPU 花出去。
  PARALLEL_BUSY_FRAMES: "●",
  // 每帧毫秒；10 帧 × 150ms ≈ 1.5s 一轮。转轮期间实测约 12% 单核。
  PARALLEL_BUSY_FRAME_MS: "150",
  PARALLEL_BUSY_ANIMATE: "false",
  // tree 模式下叠加在连接符之前的父级竖线，默认空。
  PARALLEL_TRUNK: "",
  // --- codex（SPEC 第 11 节）---
  CODEX_ENABLED: "true",
  CODEX_SOCKET: "",
  CODEX_CLIENT_NAME: "herdr-parallel-sessions-display",
  // 空 = 用 codex.mjs 里的默认集合（cli,exec,appServer,vscode，靠排除 subAgent* 实现
  // 「子 agent 不单列」）。不要只填 cli：实测 kind 是 vscode 的 thread 会被过滤掉。
  CODEX_SOURCE_KINDS: "",
  CODEX_SESSION_LIMIT: "100",
  CODEX_TIMEOUT_MS: "8000",
  // 官方行没有 agent_session 时，由插件以 herdr:codex 的身份补报一次（读的是
  // codex 自己的 app-server，写的是真实 thread id）。设成 false 回到纯被动。
  CODEX_ADOPT_SESSION: "true",
  // --- Claude Code（SPEC 第 13 节）---
  // 同样每个键都必须列在这里，否则被 loadConfig 静默丢弃（见上面的历史事故）。
  CLAUDE_ENABLED: "true",
  // 空 = 用 PATH 上的 claude。本机实测 Claude Code 装在 /opt/claude-code/bin/claude，
  // **未必在 GUI 起的 Herdr 进程的 PATH 里** —— 终端里 `claude` 能跑、看板面板里 spawn
  // 不到就是这个形态。指绝对路径最省事。
  CLAUDE_BIN: "",
  // 单次 `claude agents --json` 的超时。本机实测正常调用约 260ms，8s 是留给机器慢的情况。
  CLAUDE_TIMEOUT_MS: "8000",
  // claude 侧的**独立**节奏，默认 10000：主轮询 5000ms，而每次 spawn 约 260ms，
  // 按 5 秒追平主循环就是白花约 5% 单核（实测忙标记转轮开/关差 8%，这个量级不能忽略）。
  // 想追平设 5000。
  CLAUDE_POLL_MS: "10000",
  // 最多认多少个会话（按 startedAt 新的优先）。防御性上限：正常机器上活跃会话只有个位数，
  // 这个数主要是防「有人在同一台机器上跑一堆自动化 job」把侧边栏和 IO 一起冲垮。
  CLAUDE_SESSION_LIMIT: "50",
  // 官方行没有 agent_session 时，由插件以 herdr:claude 的身份补报一次（写的是
  // `claude agents --json` 里的真实 sessionId）。设成 false 回到纯被动。
  CLAUDE_ADOPT_SESSION: "true",
  // 标题是默认显示名（`herdr-fe` 这类没信息量的）时，要不要读 transcript 的首条用户
  // 消息来兜底。只读文件头部前 64KB，且按 sessionId 记忆化，所以代价很小；关掉的唯一
  // 场景是 Claude Code 装在网络盘上、每次 stat 都很贵。
  CLAUDE_READ_TITLES: "true",
});

const KNOWN_KEYS = new Set(Object.keys(CONFIG_DEFAULTS));
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 极简 .env 解析器。纯函数，便于离线验证。
 *
 * - 忽略空行、`#` 开头的整行注释。
 * - 支持行首可选的 `export ` 前缀。
 * - `KEY=VALUE`，按第一个 `=` 切分。
 * - 值可带单/双引号；双引号内支持 \n \t \r \" \\ 转义。
 * - 未加引号时，把「空白 + #」到行尾当作行尾注释（所以带 # 的密码请加引号）。
 * - 非法 key 直接忽略，不抛错。
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text) {
  const out = Object.create(null);
  if (typeof text !== "string" || text.length === 0) return out;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      value = unquote(value, quote);
      if (quote === '"') {
        value = value.replace(/\\(["\\nrt])/g, (_m, c) =>
          c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
        );
      }
    } else {
      // 未加引号：空白 + # 之后视为注释
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }

    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * 剥掉引号。闭合引号的位置必须跳过转义序列，
 * 否则 `"say \"hi\""` 会在第一个 \" 的引号处就误判为结束。
 */
function unquote(value, quote) {
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      out += ch + value[i + 1];
      i += 1;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return out; // 没有闭合引号：按原样返回内容
}

/** opencode `--service` 模式把 Basic Auth 密码写在这里。 */
export function serviceJsonPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "service.json");
}

/**
 * 读取配置。优先级：真实环境变量 > ${HERDR_PLUGIN_CONFIG_DIR}/.env > 默认值。
 * 只有 KNOWN_KEYS 里的键会从环境变量取，避免 HERDR_* 之类撞名。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{values:Record<string,string>, filePath:string|null, fileKeys:string[], unknownFileKeys:string[], configDir:string|null}}
 */
export function loadConfig(env = process.env) {
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR || null;
  const filePath = configDir ? path.join(configDir, ".env") : null;

  let fileValues = Object.create(null);
  if (filePath) {
    try {
      fileValues = parseEnv(readFileSync(filePath, "utf8"));
    } catch {
      fileValues = Object.create(null);
    }
  }

  const values = Object.create(null);
  for (const key of KNOWN_KEYS) values[key] = CONFIG_DEFAULTS[key];

  const fileKeys = Object.keys(fileValues);
  for (const key of fileKeys) {
    if (KNOWN_KEYS.has(key)) values[key] = fileValues[key];
  }

  for (const key of KNOWN_KEYS) {
    const fromEnv = env[key];
    if (typeof fromEnv === "string" && fromEnv.length > 0) values[key] = fromEnv;
  }

  return {
    values,
    filePath,
    fileKeys,
    unknownFileKeys: fileKeys.filter((k) => !KNOWN_KEYS.has(k)),
    configDir,
  };
}

const TRUTHY = new Set(["1", "true", "yes", "on", "y"]);
const FALSY = new Set(["0", "false", "no", "off", "n"]);

/** @param {Record<string,string>} values */
export function asBool(values, key, fallback = false) {
  const raw = String(values[key] ?? "").trim().toLowerCase();
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return fallback;
}

/** @param {Record<string,string>} values */
export function asInt(values, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(values[key] ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {Record<string,string>} values */
export function asFloat(values, key, fallback, min = 0, max = 1) {
  const n = Number.parseFloat(String(values[key] ?? "").trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {Record<string,string>} values */
export function asEnum(values, key, allowed, fallback) {
  const raw = String(values[key] ?? "").trim();
  return allowed.includes(raw) ? raw : fallback;
}

/** @param {Record<string,string>} values */
export function asString(values, key, fallback = "") {
  const raw = values[key];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

/** Herdr 会把 token 值截断到 80 字符，这里先自己截，避免超长标题把整行挤爆。 */
export function truncate(value, max = 80) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}

/** 去掉控制字符并压掉多余空白 —— 标题要同时进 shell 文本、env 和 Herdr token。 */
export function sanitizeText(value, max = 80) {
  const text = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, max);
}

/** session id 白名单：只允许 opencode 真实 id 的字符集，杜绝注入。 */
export function isValidSessionId(id) {
  return typeof id === "string" && /^ses[A-Za-z0-9_-]{4,120}$/.test(id);
}

// ---------------------------------------------------------------------------
// 状态持久化
// ---------------------------------------------------------------------------

export const STATE_VERSION = 2;

/**
 * 兜底用的 central 工作区（只有「某个目录在 Herdr 里找不到对应工作区」时才建）。
 * 除它之外，每个目录都在**自己的工作区**里拥有一个镜像标签页（SPEC 6.6）。
 */
export function emptyCentral() {
  return { workspaceId: "", tabId: "", anchorPaneId: "", label: "" };
}

/** 一个目录对应的镜像标签页记录。fallback=true 表示用的是 central 兜底工作区。 */
export function emptyMirrorEntry() {
  return { workspaceId: "", tabId: "", anchorPaneId: "", fallback: false };
}

/** @returns {object} 一个空的、字段齐全的状态对象 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: 0,
    lastSeq: 0,
    // 目录（绝对路径） → 该目录的镜像标签页
    mirrors: {},
    // 兜底工作区，MIRROR_LABEL 那个 Sessions 空间
    central: emptyCentral(),
    server: { baseUrl: "", flavor: "", version: "", lastOkAt: 0 },
    panes: {},
    // 工作区 id → 该工作区里被选为挂载点的 pane（内联模式）。
    // 持久化是为了**跨重启也稳定**：按状态重挑会让同一工作区里两个 opencode 窗口
    // 的会话树每隔几秒互换位置，看着像 bug。
    inlineHosts: {},
    agentView: null,
  };
}

/** 把读到的任意 JSON 收敛成字段齐全的状态对象（容错：缺字段不炸）。 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  if (Number.isFinite(raw.lastSeq)) base.lastSeq = raw.lastSeq;
  if (Number.isFinite(raw.updatedAt)) base.updatedAt = raw.updatedAt;

  // v1 只有单个全局 anchor（所有镜像都堆在一个 Sessions 工作区里）。
  // v2 起按目录索引，所以 anchor 直接丢弃：残留的镜像 pane 会被孤儿回收扫掉。
  if (raw.mirrors && typeof raw.mirrors === "object") {
    for (const [dir, entry] of Object.entries(raw.mirrors)) {
      if (!entry || typeof entry !== "object") continue;
      const key = str(dir);
      if (!key) continue;
      base.mirrors[key] = {
        workspaceId: str(entry.workspaceId),
        tabId: str(entry.tabId),
        anchorPaneId: str(entry.anchorPaneId),
        fallback: entry.fallback === true,
      };
    }
  }
  if (raw.central && typeof raw.central === "object") {
    base.central = {
      workspaceId: str(raw.central.workspaceId),
      tabId: str(raw.central.tabId),
      anchorPaneId: str(raw.central.anchorPaneId),
      label: str(raw.central.label),
    };
  }
  if (raw.server && typeof raw.server === "object") {
    base.server = {
      baseUrl: str(raw.server.baseUrl),
      flavor: str(raw.server.flavor),
      version: str(raw.server.version),
      lastOkAt: Number.isFinite(raw.server.lastOkAt) ? raw.server.lastOkAt : 0,
    };
  }
  if (raw.panes && typeof raw.panes === "object") {
    for (const [id, rec] of Object.entries(raw.panes)) {
      if (!rec || typeof rec !== "object") continue;
      base.panes[id] = {
        paneId: str(rec.paneId),
        title: str(rec.title),
        directory: str(rec.directory),
        state: str(rec.state),
        stateMessage: str(rec.stateMessage),
        idleSince: Number.isFinite(rec.idleSince) ? rec.idleSince : 0,
        // opencode 自己报的两个时间戳：`time.idle`（最后一次停下来干活）和
        // `time.viewed`（最后一次被用户打开）。`viewed > idle` 就是「跑完之后又被
        // 看过」，见 board.mjs 的 hasBeenViewedSinceIdle。必须在白名单里，否则插件
        // 一重启就丢，「看过才清除」每次重启都要重来一遍。
        idleAt: Number.isFinite(rec.idleAt) ? rec.idleAt : 0,
        viewedAt: Number.isFinite(rec.viewedAt) ? rec.viewedAt : 0,
        // 会话自己的 updatedAt。idle 排序和「超额丢弃谁」都要它。
        updatedAt: Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
        reportedAt: Number.isFinite(rec.reportedAt) ? rec.reportedAt : 0,
        fingerprint: str(rec.fingerprint),
        // 上一次真正上报出去的值，用来判断是否需要再调一次 herdr
        lastState: str(rec.lastState),
        lastStateMessage: str(rec.lastStateMessage),
        lastResume: str(rec.lastResume),
      };
    }
  }
  if (raw.inlineHosts && typeof raw.inlineHosts === "object") {
    for (const [workspaceId, paneId] of Object.entries(raw.inlineHosts)) {
      const ws = str(workspaceId);
      const pane = str(paneId);
      if (ws && pane) base.inlineHosts[ws] = pane;
    }
  }
  if (raw.agentView && typeof raw.agentView === "object") {
    base.agentView = raw.agentView;
  }
  return base;
}

function str(v) {
  return typeof v === "string" ? v : "";
}

/** 读状态。任何失败都返回空状态，绝不抛错。 */
export async function readState(stateDir) {
  if (!stateDir) return emptyState();
  try {
    const text = await fs.readFile(path.join(stateDir, "state.json"), "utf8");
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

/** 原子写状态（先写临时文件再 rename），避免半截文件。 */
export async function writeState(stateDir, state) {
  if (!stateDir) return;
  state.version = STATE_VERSION;
  state.updatedAt = Date.now();
  const target = path.join(stateDir, "state.json");
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 单实例锁：写入 pid，靠 kill(pid,0) 判活。 */
export async function readPidFile(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writePidFile(file) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${process.pid}\n`, "utf8");
  } catch {
    /* 单实例只是优化，失败不致命 */
  }
}

export async function removeFile(file) {
  try {
    await fs.rm(file, { force: true });
  } catch {
    /* ignore */
  }
}

/** pid 是否还活着（ESRCH 判定）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
