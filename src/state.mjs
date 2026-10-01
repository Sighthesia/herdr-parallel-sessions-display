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
  AUTO_START: "false",
  INSTALL_AGENT_VIEW: "false",
  POLL_INTERVAL_MS: "5000",
  IDLE_GRACE_MS: "15000",
  // --- SPEC 第 7 节之外、为可运行性补的项（README 有完整表格）---
  AGENT_VIEW_SCOPE: "mirror", // mirror | sort-only
  RESUME_MODE: "opencode", // opencode | mirror
  MIRROR_PANE_RATIO: "0.5",
  MIRROR_PANE_DIRECTION: "down",
  SESSION_LIST_LIMIT: "200",
  SESSION_PAGE_LIMIT: "8",
  RETRY_DETECTION: "true",
  RETRY_CHECK_LIMIT: "8",
  AUTO_AUTH_SERVICE_JSON: "true",
  DISCOVERY_BACKOFF_MAX_MS: "60000",
  LOG_LEVEL: "info",
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

export const STATE_VERSION = 1;

/** @returns {object} 一个空的、字段齐全的状态对象 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: 0,
    lastSeq: 0,
    anchor: { workspaceId: null, tabId: null, paneId: null, label: null },
    server: { baseUrl: null, flavor: null, version: null, lastOkAt: 0 },
    panes: {},
    agentView: null,
  };
}

/** 把读到的任意 JSON 收敛成字段齐全的状态对象（容错：缺字段不炸）。 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  if (Number.isFinite(raw.lastSeq)) base.lastSeq = raw.lastSeq;
  if (Number.isFinite(raw.updatedAt)) base.updatedAt = raw.updatedAt;
  if (raw.anchor && typeof raw.anchor === "object") {
    base.anchor = {
      workspaceId: str(raw.anchor.workspaceId),
      tabId: str(raw.anchor.tabId),
      paneId: str(raw.anchor.paneId),
      label: str(raw.anchor.label),
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
        reportedAt: Number.isFinite(rec.reportedAt) ? rec.reportedAt : 0,
        fingerprint: str(rec.fingerprint),
        // 上一次真正上报出去的值，用来判断是否需要再调一次 herdr
        lastState: str(rec.lastState),
        lastStateMessage: str(rec.lastStateMessage),
        lastResume: str(rec.lastResume),
      };
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
