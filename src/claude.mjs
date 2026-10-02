// claude.mjs —— Claude Code 会话发现。
//
// ## 为什么只用 `claude agents --json`
//
// 官方文档明说这是「从 Claude Code 之外读会话状态的**受支持**方式」，同时点名
// `~/.claude/jobs/<id>/state.json` 和 `~/.claude/daemon/roster.json` 是**非稳定接口，
// 不要解析**。所以这里只有一条路：spawn 一次 `claude agents --json`，把 stdout 解析成
// 一个数组。本机实测单次约 260ms，stderr 干净，stdout 是纯 JSON 数组。
//
// 特别值一提：**不需要 supervisor 守护进程**。本机 `claude daemon status` 是
// `not running`，两个活着的交互式会话照样列得出来（实时进程组的 pid 来自
// `/proc`，不经过 daemon）。所以没有「拿不到 supervisor 就算失败」这回事。
//
// **不要加 `--all`**：默认语义已经是「every live session, plus background sessions
// that are still working or blocked even when their process has exited」，也就是我们要的
// 「正在跑」；加 `--all` 反而会把已完成的会话全列进来。
//
// ## 与 codex 侧的结构性差异（决定了 board 里的接法）
//
// codex 那边是 app-server 长连接，所以 board 里要有 client / 重连 / 断连接
// （`closeCodexClient`）。claude 这边**每次调用都是一个自洽的短命子进程**：没有
// 长连接要建、没有连接会断、也就没有「退出前必须断连接」这一步。代价换成了另一件事
// —— **spawn 出去的子进程必须每次都被等回来或杀掉**，否则 board 进程永远不退出
// （`AGENTS.md` 记过 codex 那条长连接导致自检永不退出，同款事故）。
//
// ## 标题：默认显示名毫无信息量
//
// 交互式会话在用户没 `/rename` 之前，`name` 是「默认显示名」`<cwd 的 basename>-<两字符>`
// （本机实测 `herdr-fe` / `herdr-99`）。文档还明说它**不是 resume handle**，只是用来在
// `claude agents` 列表里区分行。所以它得从 transcript 的首条用户消息兜底。
//
// 但文档同时警告 transcript 的行格式「internal to Claude Code and changes between
// versions, so scripts that parse these files directly can break on any release」——
// 于是下面 {@link readFirstUserMessage} 的解析**全宽容**：任何一行认不出来就跳过，
// 任何异常都退回占位符，绝不抛。

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sanitizeText } from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 8_000;
/** stdout 上限。列表正常只有几 KB；到这个量级基本是「claude 输出变了」，直接当失败。 */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** 只读 transcript 的头部。首条用户消息实测在文件开头 1KB 附近（前面是 mode / atis-latch / snapshot）。 */
const DEFAULT_TRANSCRIPT_HEAD_BYTES = 64 * 1024;
/** 标题记忆化的容量。超了按插入顺序淘汰最老的（Map 保持插入序）。 */
export const TITLE_CACHE_LIMIT = 200;
/** 标题长度上限，与 `formatParallelSlots` 的 60 对齐。 */
const TITLE_MAX = 60;
/** 无标题占位符，和 codex 侧（`normalizeThread`）保持一致。 */
export const NO_TITLE = "(无标题)";

export class ClaudeError extends Error {
  constructor(message, { missingBinary = false, timedOut = false } = {}) {
    super(message);
    this.name = "ClaudeError";
    /**
     * PATH 里没有 `claude`。上层要能把这个单独拎出来说 —— 「PATH 里没有 claude」和
     * 「采集失败」对用户的下一步动作完全不同（前者去装 / 改 `CLAUDE_BIN`）。
     */
    this.missingBinary = missingBinary;
    this.timedOut = timedOut;
  }
}

/**
 * 要 spawn 的可执行文件。
 *
 * `CLAUDE_BIN` 优先（本机实测装在 `/opt/claude-code/bin/claude`，未必在 GUI 起的
 * Herdr 进程的 PATH 里 —— 那是真实踩到的形态：终端里 `claude` 能跑，看板面板里 spawn
 * 不到）。留空则用 PATH 上的 `claude`。
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function claudeBin(env = process.env) {
  return String(env?.CLAUDE_BIN || "").trim() || "claude";
}

/**
 * Claude 的配置目录。`CLAUDE_CONFIG_DIR` 优先，否则 `~/.claude`。
 *
 * 刻意**不**支持 `CLAUDE_CODE_PROJECT_DIR_NAME`（transcript 目录名的覆盖变量）：
 * 官方文档没说它在任何对外接口上稳定，而我们只是拿它去猜一个文件路径，猜错了就退回
 * 占位符 —— 少支持一个能猜错的开关，比猜错之后排查半天划算。
 */
export function claudeConfigDir(env = process.env) {
  const explicit = String(env?.CLAUDE_CONFIG_DIR || "").trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".claude");
}

/**
 * 列一轮 Claude Code 的运行中会话。
 *
 * 用 `spawn` 而不是 `execFileSync`：board 进程里挂着 opencode 的 SSE 长连接，
 * 同步子进程会把整个管理器卡住。超时后 SIGKILL 并正常结束 Promise（不 reject 不 hang），
 * 让上层的退避逻辑照常工作。
 *
 * @param {{bin?:string, timeoutMs?:number, cwd?:string, env?:Record<string,string|undefined>}} [options]
 * @returns {Promise<object[]>} 原样条目数组；解析出来不是数组时抛 {@link ClaudeError}
 */
export function listClaudeSessions(options = {}) {
  const bin = String(options.bin || "claude");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ["agents", "--json"], {
        cwd: options.cwd || undefined,
        env: options.env || undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(spawnError(err, bin));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // **一定要把 stdio 流 destroy 掉，不能只杀进程。**
      //
      // 子进程自己 fork 出去的孙进程会继承它的 stdout/stderr 管道，于是即使子进程
      // 已经被 SIGKILL，我们这边的 Pipe 句柄仍然开着 —— 事件循环排不空，`--mode once`
      // 会挂着不退出（实测：一个超时后被杀死的 `sh` 包装脚本，+500ms 时还有 4 个
      // PipeWrap 在活跃资源里）。destroy 掉就丢掉我们这边的 fd，事件循环立刻排得空。
      // 正常结束那条路上流本来就已经关掉了，这里 destroy 是空操作。
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        try {
          stream?.destroy();
        } catch {
          /* ignore */
        }
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      // 先 SIGKILL 再 finish（finish 会 destroy 流）：两者都必须做，只做前者的话
      // 事件循环会被继承来的管道端点吊住。
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经死了 */
      }
      finish(new ClaudeError(`${bin} agents --json 超时（${timeoutMs}ms）`, { timedOut: true }));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => finish(spawnError(err, bin)));

    child.on("close", (code) => {
      if (code !== 0) {
        const detail = firstLine(stderr) || `exit ${code}`;
        finish(new ClaudeError(`${bin} agents --json 失败: ${detail}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        // 「输出不是 JSON」几乎一定是 claude 那边版本变了或者吐了横幅文案。
        // 按失败处理（上层会退避并打日志），不要把半个字符串当会话列表用。
        finish(new ClaudeError(`${bin} agents --json 的输出不是 JSON: ${err?.message || err}`));
        return;
      }
      if (!Array.isArray(parsed)) {
        finish(new ClaudeError(`${bin} agents --json 返回的不是数组（是 ${typeof parsed}）`));
        return;
      }
      finish(null, parsed);
    });
  });
}

/** spawn 本身的失败（ENOENT / EACCES…）。ENOENT 单独标记，见 {@link ClaudeError}。 */
function spawnError(err, bin) {
  // Node 的 ENOENT message 本身已经带 `spawn <bin> ENOENT` 了，别再拼一遍变成
  // 「spawn spawn …」—— 这种重复字样在日志里很扎眼。
  const message = String(err?.message || err);
  if (err?.code === "ENOENT") {
    return new ClaudeError(`PATH 里没有 ${bin}（${message}）`, { missingBinary: true });
  }
  return new ClaudeError(`${bin} 启动失败: ${message}`);
}

function firstLine(text) {
  const line = String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return line ? line.slice(0, 300) : "";
}

// ---------------------------------------------------------------------------
// 纯函数：字段映射与状态映射
// ---------------------------------------------------------------------------

/**
 * Claude 的运行态 → Herdr 展示状态。
 *
 * | claude                                | herdr    |
 * | ---                                   | ---      |
 * | `state:"working"`                     | working  |
 * | `state:"blocked"`                     | blocked  |
 * | `state:"done"`                        | idle     |
 * | `state:"failed"` / `"stopped"`        | **null** |
 * | `status:"busy"`                       | working  |
 * | `status:"waiting"`                    | blocked  |
 * | `status:"idle"`                       | idle     |
 * | 都没有                                | idle     |
 *
 * ## 「都没有」为什么当 idle 而不是 null
 *
 * **在列表里就意味着进程还活着**（只有 `--all` 才会带上已完成的，而默认调用不带）。
 * 所以宁可报 idle 也不要把它藏起来 —— 藏起来的代价（用户完全看不见这个会话）远大于
 * 多显示一个空转的会话。
 *
 * 注意这和 codex 侧的 `notLoaded → null` **语义不同，别照抄**：codex 的 null 是
 * 「这个 thread 不在 app-server 内存里」，也就是历史遗留；claude 这边没有这种概念。
 *
 * ## `done` 为什么是 idle 而不是 done
 *
 * `state:"done"` 是「这一回合跑完了，在等你下一句」，进程还活着（还能继续对话）。
 * 侧边栏的标记集合只有 working/blocked/idle/retry（见 `formatParallelSlots`），
 * 归到 idle 才有一个能认出来的标记（`○`）。
 *
 * `failed` / `stopped` 是真的结束了，归 null（不显示）。
 *
 * `status:"waiting"` 时条目上还有一个 `waitingFor`（`permission prompt` / `input
 * needed` / `sandbox request` / `worker request` / `dialog open`），语义就是「正卡在
 * 等你」，映射成 blocked。要显示得更细就得改侧边栏模板，本轮不做。
 *
 * @param {object} entry `claude agents --json` 的一条
 * @returns {"working"|"blocked"|"idle"|null}
 */
export function mapClaudeState(entry) {
  switch (String(entry?.state || "")) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "idle";
    case "failed":
    case "stopped":
      return null;
    default:
      break;
  }
  switch (String(entry?.status || "")) {
    case "busy":
      return "working";
    case "waiting":
      return "blocked";
    case "idle":
      return "idle";
    default:
      // 交互式会话只有 `status`、后台 worker 只有 `state`（见 SPEC 第 13 节的字段表），
      // 两个都没有时按「在列表里 = 进程还活着」处理成 idle。
      return "idle";
  }
}

/**
 * 一条 `claude agents --json` 条目 → 插件内部统一的会话对象。
 *
 * ## 为什么 `sessionId` 缺失一律丢弃
 *
 * 它是**唯一稳定身份**：去重靠它、transcript 路径靠它（`<sessionId>.jsonl`）、
 * 将来补报 `agent_session` 也靠它。没有它的条目既无法去重也无法 resume，留下来的
 * 唯一效果是侧边栏上多一行重名的东西。
 *
 * ## 字段一律按「可缺」处理
 *
 * 实测每一项都可能缺：`pid` 在后台 worker 刚起来时没有、`status` 同样可能没有、
 * `id` 只有 background 有、`state` 只有 background 有、`name` 是用户可能没改过的
 * 默认显示名。所以下面每个字段都单独兜底，不要指望某个字段一定在。
 *
 * @param {object} entry
 * @param {{name?:string}} [options] 覆盖标题（board 传已解析好的标题，避免二次读盘）
 * @returns {{id:string,title:string,directory:string,state:string|null,updatedAt:number,pid:number|null}|null}
 */
export function normalizeClaudeSession(entry, options = {}) {
  const id = String(entry?.sessionId || "").trim();
  if (!id) return null;

  const directory = String(entry?.cwd || "").trim();
  const name = String(options.name ?? entry?.name ?? "").trim();

  return {
    id,
    title: name || NO_TITLE,
    directory,
    state: mapClaudeState(entry),
    /**
     * `startedAt` 是 Unix **毫秒**（注意 codex 那边是秒）。同目录有多个会话时，
     * 降级匹配按它排「最近起的那个」。
     */
    updatedAt: Number.isFinite(entry?.startedAt) ? Number(entry.startedAt) : 0,
    /** 后台会话可能没有 pid —— 那是 pid 精确匹配降级到目录匹配的原因。 */
    pid: Number.isInteger(entry?.pid) && entry.pid > 0 ? entry.pid : null,
  };
}

/**
 * 这个 `name` 是不是「没被用户改过的默认显示名」。
 *
 * 默认名 = `<cwd 的 basename>-<两个字符>`（本机实测 `herdr-fe` / `herdr-99`）。
 * 官方文档说它**不是 resume handle**，只是用来在 `claude agents` 里区分行 —— 所以它
 * 出现在侧边栏上毫无信息量（同一个目录下两个会话都叫 `herdr-xx`），必须走 transcript 兜底。
 *
 * 判据刻意宽松（后缀 1~4 位字母数字、basename 允许被去标点或把标点换成短横后相等）：
 * 官方只说「形如」，没给规范。我们要判断的是「这个值有没有信息量」，而不是「它是不是逐
 * 字节等于某个公式」—— 比如目录叫 `my.project` 时默认名大概是 `my-project-xx`。
 *
 * 副作用（可接受）：用户真的把会话命名成 `herdr-fe`，我们也会去读 transcript ——
 * 拿到的第一条消息仍然是个合理的标题，不会显示错东西。
 *
 * @param {string} name
 * @param {string} cwd
 * @returns {boolean}
 */
export function isDefaultDisplayName(name, cwd) {
  const text = String(name || "").trim();
  if (!text) return false;
  const base = baseSlug(cwd);
  if (!base) return false;
  const m = text.match(/^(.+?)-[A-Za-z0-9]{1,4}$/);
  if (!m) return false;
  const stem = m[1];
  return (
    stem === base ||
    stem === base.replace(/[^A-Za-z0-9]/g, "") ||
    stem === base.replace(/[^A-Za-z0-9]/g, "-")
  );
}

/** cwd 的 basename（顺手砍掉结尾斜杠）。取不到就返回 ""。 */
function baseSlug(cwd) {
  const dir = String(cwd || "").trim().replace(/[\\/]+$/, "");
  if (!dir) return "";
  return path.basename(dir) || "";
}

/**
 * transcript 的目录名 = cwd 里**每个非字母数字字符换成 `-`**。
 *
 * 本机实测 `/home/alice/.local/share/oc-some-plugin` →
 * `-home-alice--local-share-oc-some-plugin`（`.` 和 `/` 都变 `-`，所以是连续两个 `-`）。
 *
 * 超过 200 字符时 Claude Code 会截断并加一个路径哈希 —— **不要去实现那个哈希**：
 * 官方没给算法，猜出来的路径只会读不到文件。这里老老实实生成短路径，长路径自然读不到，
 * 于是走占位符：那是一个可接受的降级，而实现一个猜出来的哈希会在某天悄悄读错文件。
 *
 * @param {string} cwd
 * @returns {string}
 */
export function encodeProjectDir(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

/** 一个会话的 transcript 路径。 */
export function transcriptPath(sessionId, cwd, configDir) {
  const dir = String(configDir || claudeConfigDir());
  return path.join(dir, "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * 从 transcript 里取**首条**用户消息，用作会话标题。
 *
 * ## 判据（全部宽容，任何一条不满足就继续往下找）
 *
 *   1. `type === "user"` 且 `message.role === "user"` 且 `isSidechain !== true`
 *      —— `isSidechain: true` 是子 agent 的对话，不该拿来当用户的会话标题
 *   2. `origin` 存在时要求 `origin.kind === "human"`；`origin` 整个缺失则放行
 *      （注入的 prompt / 工具结果都会带 origin，必须挡掉）
 *   3. 文本：content 是字符串就用它；是数组就只拼 `type === "text"` 的块
 *      （`tool_result` / `thinking` 这些块不是用户说的话）
 *   4. 空白压成单空格、trim、截到 60 字符
 *
 * ## 只读文件头部
 *
 * 只读前 64KB 而不是整个文件：实测首条用户消息在开头 1KB 附近（前面是 `mode` /
 * `permission-mode` / `atis-latch` / `file-history-snapshot` 这些），而整个 transcript
 * 实测 47KB 且会一直长下去。尾部读一遍纯属浪费。
 *
 * 官方明说这个格式是 internal 的、会随版本变，所以任何一行解析失败就跳过，
 * 找不到就返回 ""，**绝不抛**。
 *
 * @param {string} file transcript 路径
 * @param {{maxBytes?:number}} [options]
 * @returns {Promise<string>} 找不到返回 ""
 */
export async function readFirstUserMessage(file, { maxBytes = DEFAULT_TRANSCRIPT_HEAD_BYTES } = {}) {
  if (!file) return "";
  const size = Math.max(0, Number(maxBytes) || 0);
  let handle = null;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");

    for (const line of text.split("\n")) {
      const row = parseJsonLine(line);
      if (!row) continue;
      if (row.type !== "user") continue;
      if (row.isSidechain === true) continue;
      const message = row.message;
      if (!message || typeof message !== "object" || message.role !== "user") continue;
      const origin = row.origin;
      if (origin != null && origin.kind !== "human") continue;
      const human = userText(message);
      if (!human) continue;
      return sanitizeText(human, TITLE_MAX);
    }
    return "";
  } catch {
    // 文件不存在 / 权限不对 / 目录被删了 —— 一律退回占位符
    return "";
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
  }
}

function parseJsonLine(line) {
  const text = String(line || "").trim().replace(/^﻿/, "");
  if (!text || text[0] !== "{") return null;
  try {
    const row = JSON.parse(text);
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

function userText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join(" ");
}

/**
 * 解析一个会话该显示的标题。
 *
 * 顺序：用户改过的 `name` → transcript 首条用户消息 → `(无标题)`。
 *
 * 「默认名」有**两种**（都实测到过）：交互式会话的 `<basename>-<两字符>`，以及后台 job
 * 暂时拿不到标题时把自己的短 id 当名字。两种都要走 transcript 兜底。
 *
 * ## 记忆化
 *
 * `cache` 是 `sessionId -> 标题` 的 Map（由 board 的 `runtime.claude.titleCache` 持有），
 * 已经解析过的不再读盘 —— 每轮重读一个 47KB 的 transcript 纯属浪费，而 CLAUDE_POLL_MS
 * 下这一轮本来只需要 ~260ms 的 spawn。超过 {@link TITLE_CACHE_LIMIT} 按插入顺序淘汰最老的。
 *
 * **只缓存成功的解析**（认出来的那条消息），失败**不**缓存：TUI 刚起来时 transcript 可能
 * 还没写出第一条用户消息，把「没找到」缓存下来会让标题在用户真正发出第一句话之后仍然
 * 停在 `(无标题)`，而且要等 board 重启才恢复 —— 这种「缓存了一个瞬态结论」的坑比多读一次
 * 盘贵得多。
 *
 * @param {object} entry `claude agents --json` 的一条
 * @param {{configDir?:string, cache?:Map<string,string>, readTitles?:boolean}} [options]
 * @returns {Promise<string>}
 */
export async function resolveClaudeTitle(entry, options = {}) {
  const name = String(entry?.name || "").trim();
  const cwd = String(entry?.cwd || "");
  const id = String(entry?.sessionId || "").trim();
  const jobId = String(entry?.id || "").trim();
  const cache = options.cache instanceof Map ? options.cache : null;

  /**
   * `name` 等于自己的短 job id 是**另一种默认名**（本机 Claude Code 2.1.287 实测）：
   * 一个后台 job 还没拿到标题时，`name` 就是它自己的短 id（条目里 `id:"fca468d9"`、
   * `name:"fca468d9"`、`sessionId:"fca468d9-…"`，即短 id 是 sessionId 的前 8 位）。
   * 拿它当标题等于在侧边栏上显示一串随机十六进制，比 `(无标题)` 还糟，所以同样当默认名。
   *
   * SPEC 第 13 节只写了交互式会话的 `<basename>-<两字符>` 那一形式（{@link
   * isDefaultDisplayName} 管它）；这里是真机上补到的第二种，别在重构时丢掉。
   */
  const isJobIdName = Boolean(jobId) && name === jobId;
  const named = name && !isJobIdName && !isDefaultDisplayName(name, cwd);
  if (named) return name;
  if (!id) return NO_TITLE;

  if (cache?.has(id)) return cache.get(id);
  // readTitles=false 时不碰磁盘：省的是每轮最多 N 次文件打开，代价是默认显示名的
  // 会话全部显示成 (无标题)。留给「Claude Code 装在网络盘上 / 特别在意 IO」的场合。
  if (options.readTitles === false) return named ? name : NO_TITLE;

  const text = await readFirstUserMessage(transcriptPath(id, cwd, options.configDir));
  if (!text) return named ? name : NO_TITLE;
  if (cache) {
    cache.delete(id);
    cache.set(id, text);
    while (cache.size > TITLE_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  return text;
}