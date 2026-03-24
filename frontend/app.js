// ── app.js — extra-hands UI controller ────────────────────────────────────────
import {
  getState, setState,
  loadState, savePrefs, saveApiKey, saveTavilyKey, saveJinaKey,
  createThread, loadThread, updateActiveThread,
  appendMessage, flushActiveThread,
  addTrustedFolder,
} from "./state.js";
import { orchestrateMessage } from "./search.js";
import { normPath as _normPath, boxPath as _boxPath, applyEdit as _applyEdit } from "./utils.js";
import * as smd from "https://cdn.jsdelivr.net/npm/streaming-markdown/smd.min.js";

// ── Tauri IPC stubs ────────────────────────────────────────────────────────────
const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

async function listDir(path)            { return invoke("list_dir",   { path }); }
async function readFile(path)           { return invoke("read_file",  { path }); }
async function writeFile(path, content) { return invoke("write_file", { path, content }); }
async function pickFolder()             { return invoke("pick_folder"); }
async function openPath(path)           { return invoke("open_path",  { path }); }

// Open files/URLs when clicking any [data-open-path] element
document.addEventListener("click", e => {
  const el = e.target.closest("[data-open-path]");
  if (!el || el.closest(".fa-pending")) return;
  e.stopPropagation();
  openPath(el.dataset.openPath);
});

const normPath = _normPath;

// ── Title generation ────────────────────────────────────────────────────────────
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function generateTitle(task, apiKey, model) {
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/hr23232323/extra-hands",
        "X-Title": "extra-hands",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Reply with a 2-5 word title for this task. Only the title, no punctuation, no explanation." },
          { role: "user", content: task },
        ],
        max_tokens: 20,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

const boxPath = _boxPath;

function _parentDir(path) {
  const norm = normPath(path);
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : norm;
}

// ── Permission prompt ──────────────────────────────────────────────────────────
let _permResolve = null;

function showPermissionPrompt(toolName, path) {
  return new Promise(resolve => {
    _permResolve = resolve;
    $("perm-tool").textContent = toolName;
    $("perm-path").textContent = path;
    $("permission-prompt").style.display = "flex";
    requestAnimationFrame(() => { $("agent-feed").scrollTop = $("agent-feed").scrollHeight; });
  });
}

function resolvePermission(decision) {
  $("permission-prompt").style.display = "none";
  _permResolve?.(decision);
  _permResolve = null;
}

async function checkPermission(toolName, path) {
  const { workspace, trustedFolders } = getState();
  const norm = normPath(path);
  if (workspace && norm.startsWith(workspace)) return "allow";
  if (trustedFolders.some(f => norm.startsWith(f))) return "allow";
  return showPermissionPrompt(toolName, path);
}

// ── Chat UI helpers ────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _renderMarkdown(container, text) {
  const parser = smd.parser(smd.default_renderer(container));
  smd.parser_write(parser, text);
  smd.parser_end(parser);
}

const OPENABLE_TOOLS = new Set(["list_dir", "read_file", "write_file", "edit_file", "fetch_url"]);

function _buildStepHtml(toolName, toolArg) {
  const argHtml = toolArg
    ? ` <em ${OPENABLE_TOOLS.has(toolName) ? `data-open-path="${escapeHtml(toolArg)}"` : ""}>${escapeHtml(toolArg)}</em>`
    : "";
  return `<span class="thinking-step-arrow">↳</span><span class="thinking-step-text">${escapeHtml(toolName)}${argHtml}</span>`;
}

function _attachToolsReplay(header, tools) {
  if (!tools.length) return;
  const btn = document.createElement("button");
  btn.className = "msg-agent-toggle";
  btn.innerHTML = `tools <span class="agent-toggle-arrow">▸</span>`;
  const replay = document.createElement("div");
  replay.className = "thinking-replay";
  for (const t of tools) {
    const step = document.createElement("div");
    step.className = "thinking-step";
    step.innerHTML = _buildStepHtml(t.toolName, t.toolArg);
    replay.appendChild(step);
  }
  btn.addEventListener("click", () => {
    const open = replay.classList.toggle("open");
    btn.classList.toggle("open", open);
  });
  header.appendChild(btn);
  header.appendChild(replay);
}

function _makeChatMsg(role, text, tools = []) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "assistant") {
    const header = document.createElement("div");
    header.className = "msg-header";
    _attachToolsReplay(header, tools);
    body.appendChild(header);
  }
  const contentEl = document.createElement("div");
  contentEl.className = "bubble-content";
  if (text) {
    if (role === "user") contentEl.textContent = text;
    else _renderMarkdown(contentEl, text);
  }
  body.appendChild(contentEl);
  msg.appendChild(body);
  return msg;
}

function createThinkingIndicator() {
  const el = document.createElement("div");
  el.className = "thinking";
  el.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-label">working</span>
      <div class="thinking-dots"><span></span><span></span><span></span></div>
    </div>
    <div class="thinking-log"></div>
  `;
  return el;
}

function addThinkingStep(thinkingEl, toolName, toolArg) {
  const log = thinkingEl.querySelector(".thinking-log");
  if (!log) return;
  const step = document.createElement("div");
  step.className = "thinking-step";
  step.innerHTML = _buildStepHtml(toolName, toolArg);
  log.appendChild(step);
}

function collapseThinking(thinkingEl, onDone) {
  const h = thinkingEl.getBoundingClientRect().height;
  thinkingEl.style.height = h + "px";
  thinkingEl.style.overflow = "hidden";
  thinkingEl.style.transition = "height 0.28s ease, opacity 0.2s ease, margin-bottom 0.28s ease";
  requestAnimationFrame(() => {
    thinkingEl.style.height = "0";
    thinkingEl.style.opacity = "0";
    thinkingEl.style.marginBottom = "0";
  });
  let done = false;
  const cleanup = () => { if (done) return; done = true; thinkingEl.remove(); onDone(); };
  const timer = setTimeout(cleanup, 400);
  thinkingEl.addEventListener("transitionend", function h(e) {
    if (e.propertyName === "height") { clearTimeout(timer); thinkingEl.removeEventListener("transitionend", h); cleanup(); }
  });
}

// ── Models ─────────────────────────────────────────────────────────────────────
const MODELS = [
  "qwen/qwen3-32b:nitro",
  "google/gemini-2.5-pro",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-4o",
];

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const viewHome   = $("view-home");
const viewThread = $("view-thread");

// ── View routing ───────────────────────────────────────────────────────────────
function showHome() {
  viewHome.style.display   = "flex";
  viewThread.style.display = "none";
  setState({ activeThread: null });
  $("history-btn").classList.remove("active");
  viewHome.classList.remove("entering");
  viewHome.getAnimations({ subtree: true }).forEach(a => a.cancel());
  viewHome.classList.add("entering");
}

function showThread() {
  viewHome.style.display   = "none";
  viewThread.style.display = "flex";
  renderThreadView();
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  $("theme-icon-moon").style.display = isDark ? "none" : "";
  $("theme-icon-sun").style.display  = isDark ? "" : "none";
}

async function toggleTheme() {
  const { theme } = getState();
  const next = theme === "dark" ? "light" : "dark";
  setState({ theme: next });
  applyTheme(next);
  await savePrefs();
}

// ── Settings panel ─────────────────────────────────────────────────────────────
function showSettings() {
  $("settings-bar").classList.add("open");
  $("settings-btn").classList.add("active");
  const { apiKey, tavilyKey, jinaKey } = getState();
  if (apiKey)    $("api-key-input").value    = apiKey;
  if (tavilyKey) $("tavily-key-input").value = tavilyKey;
  if (jinaKey)   $("jina-key-input").value   = jinaKey;
}

function hideSettings() {
  $("settings-bar").classList.remove("open");
  $("settings-btn").classList.remove("active");
}

function toggleSettings() {
  $("settings-bar").classList.contains("open") ? hideSettings() : showSettings();
}

// ── History panel ──────────────────────────────────────────────────────────────
function openHistory() {
  $("history-panel").classList.add("open");
  $("history-backdrop").classList.add("open");
  $("history-btn").classList.add("active");
  $("history-panel").setAttribute("aria-hidden", "false");
  renderHistoryList($("history-search").value);
  $("history-search").focus();
}

function closeHistory() {
  $("history-panel").classList.remove("open");
  $("history-backdrop").classList.remove("open");
  $("history-btn").classList.remove("active");
  $("history-panel").setAttribute("aria-hidden", "true");
}

function toggleHistory() {
  $("history-panel").classList.contains("open") ? closeHistory() : openHistory();
}

function renderHistoryList(query = "") {
  const { threadIndex, activeThread } = getState();
  const list  = $("history-list");
  const empty = $("history-empty");
  const q = query.trim().toLowerCase();

  const filtered = q
    ? threadIndex.filter(t => t.title.toLowerCase().includes(q))
    : threadIndex;

  if (!filtered.length) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  list.innerHTML = "";

  for (const meta of filtered) {
    const item = document.createElement("div");
    item.className = "history-item" + (activeThread?.id === meta.id ? " active" : "");
    item.dataset.id = meta.id;

    const dot = document.createElement("span");
    dot.className = `history-item-status ${meta.status}`;

    const date = document.createElement("span");
    date.textContent = _formatDate(meta.createdAt);

    const metaRow = document.createElement("div");
    metaRow.className = "history-item-meta";
    metaRow.appendChild(dot);
    metaRow.appendChild(date);

    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = meta.title;

    item.appendChild(title);
    item.appendChild(metaRow);
    item.addEventListener("click", () => openExistingThread(meta.id));
    list.appendChild(item);
  }
}

async function openExistingThread(id) {
  closeHistory();
  const thread = await loadThread(id);
  if (thread) showThread();
}

function _formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ── Workspace ──────────────────────────────────────────────────────────────────
function renderWorkspace() {
  const { workspace } = getState();
  const pathEl = $("workspace-path");
  if (workspace) {
    const parts = workspace.split("/").filter(Boolean);
    const short = parts.length > 2 ? "…/" + parts.slice(-2).join("/") : workspace;
    pathEl.textContent = short;
    pathEl.title = workspace;
    pathEl.classList.add("has-path");
  } else {
    pathEl.textContent = "no folder selected";
    pathEl.title = "";
    pathEl.classList.remove("has-path");
  }
  updateRunButton();
}

async function handlePickFolder() {
  const path = await pickFolder();
  if (path) {
    setState({ workspace: normPath(path) });
    await savePrefs();
    renderWorkspace();
  }
}

// ── Compose ────────────────────────────────────────────────────────────────────
function updateRunButton() {
  const { workspace } = getState();
  const text = $("task-input").value.trim();
  const btn  = $("run-btn");
  const hint = $("compose-hint");
  if (!workspace) {
    hint.textContent = "select a workspace folder first";
    btn.disabled = true;
  } else if (!text) {
    hint.textContent = "";
    btn.disabled = true;
  } else {
    hint.textContent = "";
    btn.disabled = false;
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}

// ── Thread view ────────────────────────────────────────────────────────────────
function _setStatusBadge(status) {
  const badge = $("thread-status-badge");
  badge.className = `status-badge ${status}`;
  badge.textContent = status === "idle" ? "" : status;
}

function renderThreadView() {
  const { activeThread } = getState();
  if (!activeThread) { showHome(); return; }

  $("thread-task-title").value = activeThread.title;
  _setStatusBadge(activeThread.status);

  const feed = $("agent-feed");
  feed.innerHTML = "";
  $("agent-result").style.display = "none";

  // User task bubble
  feed.appendChild(_makeChatMsg("user", activeThread.title));

  // Replay messages: write/edit get inline pills, all tools accumulate into dropdown
  let pendingTools = [];
  for (const msg of activeThread.messages) {
    if (msg.type === "tool") {
      pendingTools.push(msg);
      if (PILL_TOOLS.has(msg.toolName)) {
        const op = _ALL_OPS[msg.toolName];
        if (op) feed.appendChild(_makeFileActionCard(op, msg.toolArg ?? ""));
      }
    } else if (msg.type === "text") {
      feed.appendChild(_makeChatMsg("assistant", msg.content, pendingTools));
      pendingTools = [];
    }
  }

  feed.scrollTop = feed.scrollHeight;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
// ── Web tool implementations ────────────────────────────────────────────────────

async function tavilySearch(query, key) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: 6, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results.map(r => ({ title: r.title, url: r.url, snippet: r.content, score: r.score }));
}

async function jinaFetch(url, key) {
  const headers = { "Accept": "text/plain", "X-Return-Format": "markdown" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  if (!res.ok) throw new Error(`Jina ${res.status}`);
  // Truncate very large pages to avoid blowing the context window
  const text = await res.text();
  return text.length > 12000 ? text.slice(0, 12000) + "\n\n[truncated]" : text;
}

// ── Tool definitions ────────────────────────────────────────────────────────────

let _liveThinkingEl    = null;
let _liveTools         = [];
let _pendingFileCard   = null;
let _agentStopRequested = false;
const FILE_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and subdirectories in a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file with the given content. Use for new files. For editing existing files, prefer edit_file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: `Make a targeted edit to an existing file by replacing a specific string.

Rules you MUST follow:
1. Always call read_file first. Copy old_string EXACTLY from the output, preserving indentation and whitespace.
2. old_string must uniquely identify the location. If the text appears multiple times, add more surrounding lines until it is unique.
3. To rename a variable or string everywhere in a file, set replace_all=true.
4. If you get "not found", re-read the file — the content may have changed since you last read it.

Errors you may receive and how to fix them:
- "old_string not found": re-read the file and copy old_string exactly.
- "Found N matches": add more surrounding context lines to old_string.
- "File modified since last read": call read_file again before editing.`,
      parameters: {
        type: "object",
        properties: {
          path:        { type: "string",  description: "Path to the file" },
          old_string:  { type: "string",  description: "The exact text to find and replace" },
          new_string:  { type: "string",  description: "The replacement text" },
          replace_all: { type: "boolean", description: "If true, replace every occurrence instead of just the first. Use for rename-style changes." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

const WEB_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Returns ranked URLs with snippets. Call this multiple times with different queries to research a topic thoroughly.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its full content as markdown. Use after web_search to read the complete content of promising URLs.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The full URL to fetch" } },
        required: ["url"],
      },
    },
  },
];

const _FA_ICONS = {
  write:  `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10.5V12h1.5l5-5L7 5.5l-5 5zM11.5 3.5a1.1 1.1 0 0 0-1.5-1.5L8.5 3.5 10 5l1.5-1.5z"/></svg>`,
  edit:   `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2l3 3-7 7H2V9l7-7z"/><line x1="7" y1="4" x2="10" y2="7"/></svg>`,
  read:   `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h10v10H2z"/><line x1="4.5" y1="5" x2="9.5" y2="5"/><line x1="4.5" y1="7.5" x2="9.5" y2="7.5"/><line x1="4.5" y1="10" x2="7" y2="10"/></svg>`,
  search: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4"/><line x1="9.5" y1="9.5" x2="12" y2="12"/></svg>`,
  fetch:  `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 7a6 6 0 1 0 12 0A6 6 0 0 0 1 7z"/><path d="M7 1c-1.5 2-2 3.5-2 6s.5 4 2 6M7 1c1.5 2 2 3.5 2 6s-.5 4-2 6M1 7h12"/></svg>`,
};
const _ALL_OPS = {
  read_file: "read", write_file: "write", edit_file: "edit",
  web_search: "search", fetch_url: "fetch",
};

// Only these tools get inline animated pills; all others appear in the tools ▸ dropdown
const PILL_TOOLS = new Set(["write_file", "edit_file"]);

function _makeFileActionCard(op, label) {
  const card = document.createElement("div");
  const isWeb = op === "search" || op === "fetch";
  card.className = `file-action-card ${isWeb ? "fa-web" : `fa-${op}`}`;
  const icon = _FA_ICONS[op] ?? "";
  const isPlaceholder = label === "…";
  card.innerHTML = `${icon}<span class="fa-op">${op}</span><span class="fa-name" title="${escapeHtml(label)}" ${isPlaceholder ? "" : `data-open-path="${escapeHtml(label)}"`}>${escapeHtml(label.split("/").pop() || label)}</span>`;
  return card;
}


function _logToolStep(toolName, toolArg) {
  const { activeThread } = getState();
  if (!activeThread) return;
  appendMessage({ type: "tool", toolName, toolArg });
  _liveTools.push({ toolName, toolArg });
  // Recreate thinking indicator if it was collapsed by a prior text chunk
  if (!_liveThinkingEl) {
    _liveThinkingEl = createThinkingIndicator();
    $("agent-feed").appendChild(_liveThinkingEl);
  }
  // Pill tools show their own animated pill; dropdown tools need a thinking step
  if (!PILL_TOOLS.has(toolName)) {
    addThinkingStep(_liveThinkingEl, toolName, toolArg);
  }
  $("agent-feed").scrollTop = $("agent-feed").scrollHeight;
}

async function executeTool(toolName, argsStr) {
  let args;
  try { args = JSON.parse(argsStr); } catch { return "Error: could not parse tool args."; }

  // ── Web tools ──────────────────────────────────────────────────────────────
  if (toolName === "web_search") {
    const { tavilyKey } = getState();
    if (!tavilyKey) return "Error: Tavily API key not set. Add it in Settings to enable web search.";
    const query = args.query ?? "";
    _logToolStep("web_search", query);
    try {
      return JSON.stringify(await tavilySearch(query, tavilyKey));
    } catch (err) {
      return `Error: ${err.message ?? err}`;
    }
  }

  if (toolName === "fetch_url") {
    const { jinaKey } = getState();
    const url = args.url ?? "";
    _logToolStep("fetch_url", url);
    try {
      return await jinaFetch(url, jinaKey);
    } catch (err) {
      return `Error: ${err.message ?? err}`;
    }
  }

  // ── File tools ─────────────────────────────────────────────────────────────
  const { workspace } = getState();
  if (!workspace) return "Error: no workspace selected.";
  const path = boxPath(workspace, args.path ?? "");

  const decision = await checkPermission(toolName, path);
  if (decision === "deny") return "Error: access denied by user.";
  if (decision === "always") {
    addTrustedFolder(toolName === "list_dir" ? normPath(path) : _parentDir(path));
  }

  _logToolStep(toolName, path);

  // Only write_file and edit_file get inline pills; read_file/list_dir go to dropdown only
  if (PILL_TOOLS.has(toolName)) {
    const op   = _ALL_OPS[toolName];
    const name = path.split("/").pop() || path;
    if (_pendingFileCard) {
      const nameEl = _pendingFileCard.querySelector(".fa-name");
      if (nameEl) { nameEl.textContent = name; nameEl.title = path; nameEl.dataset.openPath = path; }
      _pendingFileCard.classList.remove("fa-pending");
      _pendingFileCard = null;
    } else {
      const feed = $("agent-feed");
      if (feed) { feed.appendChild(_makeFileActionCard(op, path)); feed.scrollTop = feed.scrollHeight; }
    }
  }

  try {
    if (toolName === "list_dir")   return JSON.stringify(await listDir(path));
    if (toolName === "read_file")  return await readFile(path);
    if (toolName === "write_file") {
      if (args.content === undefined) return "Error: write_file requires content.";
      await writeFile(path, args.content);
      return "ok";
    }
    if (toolName === "edit_file") {
      if (args.old_string === undefined || args.new_string === undefined)
        return "Error: edit_file requires old_string and new_string.";
      const current = await readFile(path);
      const { result, error } = _applyEdit(current, args.old_string, args.new_string, args.replace_all ?? false);
      if (error) return `Error: ${error}`;
      await writeFile(path, result);
      return "ok";
    }
    return "Error: unknown tool.";
  } catch (err) {
    return `Error: ${err.message ?? err}`;
  }
}

function _setThreadComposeEnabled(enabled) {
  $("thread-input").disabled = !enabled;
  $("thread-send-btn").disabled = !enabled || !$("thread-input").value.trim();
  $("stop-btn").style.display = enabled ? "none" : "inline-flex";
}

function _buildMessages(thread) {
  const messages = [{ role: "user", content: thread.prompt ?? thread.title }];
  for (const msg of thread.messages) {
    if (msg.type === "text")       messages.push({ role: "assistant", content: msg.content });
    else if (msg.type === "user")  messages.push({ role: "user",      content: msg.content });
  }
  return messages;
}

async function runAgentLoop(isContinuation = false) {
  const { apiKey, model, workspace } = getState();
  let { activeThread } = getState();
  if (!activeThread) return;
  if (!apiKey) { showToast("Add your OpenRouter API key in settings."); return; }

  _setThreadComposeEnabled(false);
  await updateActiveThread({ status: "running" });
  activeThread = getState().activeThread;

  // Build the live chat feed
  const feed = $("agent-feed");
  if (!isContinuation) {
    feed.innerHTML = "";
    feed.appendChild(_makeChatMsg("user", activeThread.title));
  }

  const thinkingEl = createThinkingIndicator();
  feed.appendChild(thinkingEl);
  _liveThinkingEl = thinkingEl;
  _liveTools = [];
  feed.scrollTop = feed.scrollHeight;

  const { tavilyKey } = getState();
  const hasWeb = !!tavilyKey;
  const tools = hasWeb ? [...FILE_TOOLS, ...WEB_TOOLS] : FILE_TOOLS;

  const now = new Date();
  const dateTimeStr = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const systemPrompt = `Today is ${dateTimeStr}.

You are extra-hands, an autonomous agent working inside the user's local workspace.

## Before you start

First, assess whether the task has genuine ambiguity that would change what you do — scope unclear, multiple valid interpretations, or a risky/irreversible action involved. If yes, ask ONE focused question before touching any files. If no, proceed directly.

Do not ask about things you can figure out by exploring the workspace first. Do not ask multiple questions. One question, or none.

## Scratchpad

You have a working memory file at _scratch.md in the workspace root. Use it actively:
- At the start of every task, write your initial plan and what you know so far.
- After each significant discovery (files found, content read, decisions made), update it.
- When you need to recall what you've done so far, read it instead of scrolling back through the conversation.
- _scratch.md is yours to overwrite freely — it's not a deliverable.

## Approach

**Explore first.** Start every task with list_dir(".") to understand the workspace. List subdirectories that seem relevant. Build a mental map before reading or writing anything.

**Think before every tool call.** In one sentence, state what you're about to do and why before calling any tool. This keeps your reasoning visible and your actions deliberate.

**Plan before acting.** After exploring, think through the full task: which files need to be read, what will be created or changed, in what order. For multi-step tasks, state your plan briefly before starting.

**Read before you write.** Never call write_file or edit_file on a file you haven't read this session. The content may differ from what you expect. Prefer edit_file over write_file for existing files — it makes targeted changes rather than overwriting everything.

**Work incrementally.** Take small steps. After each tool call, check the result before continuing. Don't chain multiple writes without verifying the first succeeded.

**Never create duplicate files.** Modify files in place. Never create foo_backup.txt, foo_new.txt, foo_v2.txt, or similar unless the user explicitly asked for a copy.
${hasWeb ? `
## Web research

web_search returns snippets — treat them as leads, not conclusions. For any claim you'll write into a file, fetch_url the top 2–3 sources to read full content. Run at least 3 searches with different query angles before drawing conclusions. Never write an output file based on snippets alone.
` : ""}
## When things go wrong

Read the error carefully. Don't retry the identical call that just failed — change your approach. If a file you expected doesn't exist, re-explore. If you're blocked after two attempts at something, explain what you tried and stop rather than silently looping.

## Definition of done

You are done when the task is fully complete — not started, not half-done. Before finishing, re-read every file you modified to verify it looks correct.

End every completed task with:
**Done.** [1–2 sentences describing what was accomplished]
- Created: [files, or "none"]
- Modified: [files, or "none"]`;

  const messages = _buildMessages(activeThread);

  // Streaming state — persists across turns, reset only after a tool call
  let contentEl = null, mdParser = null, observer = null;
  let lastResult = null, scrollPending = false;

  function onToolName(name) {
    if (!PILL_TOOLS.has(name)) return;
    const op = _ALL_OPS[name];
    if (!op) return;
    const card = _makeFileActionCard(op, "…");
    card.classList.add("fa-pending");
    _pendingFileCard = card;
    const feed = $("agent-feed");
    if (feed) { feed.appendChild(card); feed.scrollTop = feed.scrollHeight; }
  }

  function onDelta(delta) {
    if (viewThread.style.display === "none") return;
    if (!contentEl) {
      // First text of this turn — collapse whatever thinking indicator is active
      // (may be the original thinkingEl or one recreated mid-loop by _logToolStep)
      const activeThinking = _liveThinkingEl;
      _liveThinkingEl = null;
      if (activeThinking) collapseThinking(activeThinking, () => {});
      const capturedTools = _liveTools;
      _liveTools = [];
      const msgEl = _makeChatMsg("assistant", "", capturedTools);
      feed.appendChild(msgEl);
      contentEl = msgEl.querySelector(".bubble-content");
      contentEl.classList.add("streaming");
      mdParser = smd.parser(smd.default_renderer(contentEl));
      observer = new MutationObserver(mutations => {
        for (const m of mutations)
          for (const node of m.addedNodes)
            if (node.nodeType === Node.ELEMENT_NODE) node.classList.add("chunk-in");
      });
      observer.observe(contentEl, { childList: true });
    }
    smd.parser_write(mdParser, delta);
    if (!scrollPending) {
      scrollPending = true;
      requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; scrollPending = false; });
    }
  }

  function resetStreamState() {
    if (observer) { observer.disconnect(); observer = null; }
    if (mdParser) { smd.parser_end(mdParser); mdParser = null; }
    if (contentEl) { contentEl.classList.remove("streaming"); contentEl = null; }
    // _liveTools intentionally NOT cleared here — tools accumulate across
    // tool-call turns and are captured when the next text bubble is created
  }

  const MAX_TURNS = 25;
  let ranToCompletion = false;
  let lastCallKey = null;

  function _showAgentError(msg) {
    const el = _makeChatMsg("assistant", "");
    el.querySelector(".bubble-content").innerHTML = `<span class="error-msg">${escapeHtml(msg)}</span>`;
    feed.appendChild(el);
  }

  try {
    _agentStopRequested = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (_agentStopRequested) {
        _agentStopRequested = false;
        _showAgentError("Stopped.");
        break;
      }

      const result = await orchestrateMessage({
        apiKey, model, messages, systemPrompt,
        tools,
        onDelta,
        onToolName,
      });

      if (result.toolCall) {
        resetStreamState();

        // Repeated-call detection — same tool + same args twice in a row = stuck
        const callKey = `${result.toolCall.name}\0${result.toolCall.args}`;
        if (callKey === lastCallKey) {
          _showAgentError(`Agent is repeating the same tool call (${result.toolCall.name}) — stopping to prevent a loop.`);
          break;
        }
        lastCallKey = callKey;

        messages.push({
          role: "assistant", content: result.fullText || null,
          tool_calls: [{ id: result.toolCall.id, type: "function",
            function: { name: result.toolCall.name, arguments: result.toolCall.args } }],
        });
        const toolResult = await executeTool(result.toolCall.name, result.toolCall.args);
        messages.push({ role: "tool", tool_call_id: result.toolCall.id, content: String(toolResult) });
      } else {
        if (result.fullText) {
          await appendMessage({ type: "text", content: result.fullText });
          messages.push({ role: "assistant", content: result.fullText });
          lastResult = result.fullText;
        }
        ranToCompletion = true;
        break;
      }
    }

    if (!ranToCompletion && !_agentStopRequested) {
      // Hit the turn cap without a final text response
      _showAgentError(`Reached the ${MAX_TURNS}-turn limit without completing. Try breaking the task into smaller steps.`);
      await updateActiveThread({ status: "error" });
    } else {
      await updateActiveThread({ status: "done", result: lastResult });
    }
  } catch (err) {
    console.error("[extra-hands] agent error:", err);
    const errThinking = _liveThinkingEl;
    _liveThinkingEl = null;
    if (errThinking?.parentNode) { errThinking.style.transition = "none"; errThinking.remove(); }
    else if (thinkingEl.parentNode) { thinkingEl.style.transition = "none"; thinkingEl.remove(); }
    const errEl = _makeChatMsg("assistant", "");
    errEl.querySelector(".bubble-content").innerHTML = `<span class="error-msg">${escapeHtml("Error: " + err.message)}</span>`;
    feed.appendChild(errEl);
    await updateActiveThread({ status: "error" });
    showToast(err.message);
  } finally {
    _liveThinkingEl = null;
    resetStreamState();
    await flushActiveThread();
    _setStatusBadge(getState().activeThread?.status ?? "");
    _setThreadComposeEnabled(true);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
async function init() {
  await loadState();
  const { theme, model } = getState();

  applyTheme(theme);

  const sel = $("model-select");
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  const match = Array.from(sel.options).find(o => o.value === model);
  if (match) sel.value = match.value;

  sel.addEventListener("change", () => {
    setState({ model: sel.value });
    savePrefs();
  });

  renderWorkspace();
  showHome();
}

// ── Wire events ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  $("theme-btn").addEventListener("click", toggleTheme);
  $("history-btn").addEventListener("click", toggleHistory);
  $("history-close-btn").addEventListener("click", closeHistory);
  $("history-backdrop").addEventListener("click", closeHistory);
  $("new-btn").addEventListener("click", () => { closeHistory(); showHome(); });
  $("settings-btn").addEventListener("click", toggleSettings);

  $("history-search").addEventListener("input", e => renderHistoryList(e.target.value));

  async function saveKeyAndHide() {
    const key = $("api-key-input").value.trim();
    if (key) { await saveApiKey(key); hideSettings(); }
  }
  $("save-key-btn").addEventListener("click", saveKeyAndHide);
  $("api-key-input").addEventListener("keydown", e => { if (e.key === "Enter") saveKeyAndHide(); });

  $("save-tavily-btn").addEventListener("click", async () => {
    const key = $("tavily-key-input").value.trim();
    if (key) { await saveTavilyKey(key); showToast("Tavily key saved — web search enabled"); }
  });
  $("tavily-key-input").addEventListener("keydown", async e => {
    if (e.key === "Enter") { const key = e.target.value.trim(); if (key) { await saveTavilyKey(key); showToast("Tavily key saved"); } }
  });

  $("save-jina-btn").addEventListener("click", async () => {
    const key = $("jina-key-input").value.trim();
    if (key) { await saveJinaKey(key); showToast("Jina key saved — fetch_url rate limit increased"); }
  });
  $("jina-key-input").addEventListener("keydown", async e => {
    if (e.key === "Enter") { const key = e.target.value.trim(); if (key) { await saveJinaKey(key); showToast("Jina key saved"); } }
  });

  $("pick-folder-btn").addEventListener("click", handlePickFolder);
  $("task-input").addEventListener("input", updateRunButton);
  $("task-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("run-btn").click(); }
  });

  const _arrowSvg = `<svg class="task-card-arrow" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10L10 2M10 2H5M10 2v5"/></svg>`;
  document.querySelectorAll(".task-card").forEach(card => {
    card.insertAdjacentHTML("beforeend", _arrowSvg);
    card.addEventListener("click", () => {
      $("task-input").value = card.dataset.task;
      $("task-input").focus();
      updateRunButton();
    });
  });

  $("run-btn").addEventListener("click", async () => {
    const title = $("task-input").value.trim();
    if (!title) return;
    await createThread(title);
    $("task-input").value = "";
    updateRunButton();
    showThread();

    // Generate a short display name in parallel — doesn't block the agent
    const { apiKey, model } = getState();
    generateTitle(title, apiKey, model).then(short => {
      if (!short) return;
      const { activeThread } = getState();
      if (!activeThread) return;
      updateActiveThread({ title: short });
      const el = $("thread-task-title");
      if (el && el !== document.activeElement) el.value = short;
    });

    await runAgentLoop();
  });

  $("thread-input").addEventListener("input", () => {
    $("thread-send-btn").disabled = !$("thread-input").value.trim();
  });
  $("thread-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("thread-send-btn").click(); }
  });
  $("thread-send-btn").addEventListener("click", async () => {
    const text = $("thread-input").value.trim();
    if (!text) return;
    $("thread-input").value = "";
    _setThreadComposeEnabled(false);
    await appendMessage({ type: "user", content: text });
    $("agent-feed").appendChild(_makeChatMsg("user", text));
    await runAgentLoop(true);
  });

  $("back-btn").addEventListener("click", showHome);
  $("stop-btn").addEventListener("click", () => { _agentStopRequested = true; });

  // Inline-editable thread title
  const titleEl = $("thread-task-title");
  titleEl.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); titleEl.blur(); }
    if (e.key === "Escape") { titleEl.blur(); }
  });
  titleEl.addEventListener("blur", () => {
    const newTitle = titleEl.value.trim();
    if (newTitle) updateActiveThread({ title: newTitle });
    else { const { activeThread } = getState(); if (activeThread) titleEl.value = activeThread.title; }
  });

  for (const [id, v] of [["perm-deny-btn","deny"],["perm-allow-btn","allow"],["perm-always-btn","always"]]) {
    $(id).addEventListener("click", () => resolvePermission(v));
  }

  // Close panels when clicking outside
  document.addEventListener("click", (e) => {
    const bar = $("settings-bar");
    if (bar.classList.contains("open") &&
        !bar.contains(e.target) &&
        !$("settings-btn").contains(e.target)) {
      hideSettings();
    }
  });

  init();
});
