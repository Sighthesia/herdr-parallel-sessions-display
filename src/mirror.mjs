// mirror.mjs —— 镜像 pane 里的驻留进程。
//
// 关键产品决策（SPEC 第 1、6.2 节）：镜像 pane「只看不聊」。
// 这里不启动 opencode、不接受输入，只保持前台进程存活，
// 让 Herdr 认为这个 pane 一直在，好让 board 通过 report-agent 给它持续上报状态。
//
// 启动方式由 board 用 `pane split --env` + `pane run` 完成，
// session id 等信息全部走环境变量，所以不需要在 shell 文本里拼接任何用户数据。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(PLUGIN_ROOT, ".state");

const SESSION_ID = process.env.OC_MIRROR_SESSION_ID || "";
const PANE_ID = process.env.HERDR_PANE_ID || "";
const TITLE = process.env.OC_MIRROR_TITLE || "";
const DIRECTORY = process.env.OC_MIRROR_DIRECTORY || "";

const ESC = String.fromCharCode(27);
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/**
 * OSC 2 —— 改终端标题。
 *
 * 为什么需要：Agents 侧边栏那一行的默认文本来自终端标题。镜像 pane 里跑的是 node
 * 进程，OSC 标题就落成 `'/usr/bin/node' '/home/…` 这种没用的东西，用户自己的
 * herdr-sidebar 还会用 `hs_title` 覆盖掉 pane 名。改自己的 OSC 标题是从源头修，
 * 不用去动别人的插件配置。
 */
const SET_TITLE = (text) => `${ESC}]2;${text}${ESC}\\`;

// 单实例：pane run 可能因为 shell 还没就绪而被重试多次，
// 重复启动时后到的那个直接退出，避免一个 pane 里跑两个驻留。
const LOCK_FILE = path.join(STATE_DIR, `mirror-${PANE_ID || "unknown"}.lock`);

// board 每轮重算都会写这个文件，驻留只读它来刷新显示。
const STATE_FILE = path.join(STATE_DIR, `mirror-${SESSION_ID || "unknown"}.json`);
const STATE_POLL_MS = 2_000;

const out = process.stdout;
let lastRender = "";

function readMirrorState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function paint() {
  const snapshot = readMirrorState();
  const title = (snapshot && snapshot.title) || TITLE || SESSION_ID || "(unknown session)";
  const state = (snapshot && snapshot.state) || "starting";
  const message = (snapshot && snapshot.message) || "";
  const dir = (snapshot && snapshot.directory) || DIRECTORY;

  const badge =
    state === "working"
      ? "● working"
      : state === "blocked"
        ? "▲ blocked"
        : state === "idle"
          ? "○ idle"
          : "· starting";

  const lines = [
    "  ┌─ opencode session 镜像 ───────────────────────────",
    `  │ 状态    ${badge}`,
    `  │ 标题    ${title}`,
    `  │ session ${SESSION_ID || "(unknown)"}`,
  ];
  if (dir) lines.push(`  │ 目录    ${dir}`);
  if (message) lines.push(`  │ 说明    ${message}`);
  lines.push("  │");
  lines.push("  │ 这一行只读：这里不运行 opencode，也不能对话。");
  lines.push("  │ 要交互请切回你真实的 opencode TUI pane。");
  lines.push("  └───────────────────────────────────────────────────");

  const body = `${lines.join("\n")}\n`;
  if (body === lastRender) return;
  lastRender = body;
  // OSC 标题 = **纯 session 标题**。
  //
  // 它会变成侧边栏的 `terminal_title_stripped`，所以格式必须和官方 opencode 行
  // 一致才好看。官方行是 `OC | <标题>`，前缀由 opencode TUI 自己设；我们这里
  // 只放标题，多余的状态符号和项目名不要 —— 项目名已经在分组头（`[1] afloat`）
  // 里了，状态在第 2 行的 state_icon 里，两处都重复就没意义了。
  // 控制字符已经由 board 在写快照前清过，这里只做长度兜底。
  const oscTitle = String(title).replace(/\s+/g, " ").trim();
  // 清屏 + 归位再整块重画。状态行很短，重画成本可以忽略，
  // 比用光标上移做原地更新可靠得多。
  out.write(SET_TITLE(oscTitle.slice(0, 120)) + CLEAR_SCREEN + body);
}

/** 目录的 basename，用来在标题里点出是哪个项目。 */
function basename(dir) {
  const parts = String(dir || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts[parts.length - 1] || "";
}

// --- 单实例锁 --------------------------------------------------------------

let lockHeld = false;

function acquireLock() {
  if (!PANE_ID) return true;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const existing = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
      try {
        process.kill(existing, 0); // 探活
        return false; // 还活着 → 已经有实例
      } catch (err) {
        if (err?.code === "EPERM") return false; // 活着但不属于我们
      }
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, "utf8");
    lockHeld = true;
    return true;
  } catch {
    return true; // 拿不到锁不算致命
  }
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    if (fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    /* ignore */
  }
}

// --- 保活 -----------------------------------------------------------------

if (!acquireLock()) {
  // 已经有驻留在跑，这个进程安静退掉
  process.exit(0);
}

paint();

const keepAlive = setInterval(paint, STATE_POLL_MS);
keepAlive.unref?.();

const shutdown = () => {
  clearInterval(keepAlive);
  releaseLock();
  process.exit(0);
};

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, shutdown);
}

process.on("exit", releaseLock);

// 吃掉 stdin：即使用户在这个 pane 里打字也不会有回显之外的任何行为
process.stdin?.resume?.();
