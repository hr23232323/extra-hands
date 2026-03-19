// ── app.js — extra-hands UI controller ────────────────────────────────────────
import {
  getState, setState,
  loadState, savePrefs, saveApiKey,
  createThread, loadThread, updateActiveThread,
  appendMessage, flushActiveThread,
  addTrustedFolder,
} from "./state.js";
import { orchestrateMessage } from "./search.js";
import * as smd from "https://cdn.jsdelivr.net/npm/streaming-markdown/smd.min.js";

// ── Tauri IPC stubs ────────────────────────────────────────────────────────────
const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

async function listDir(path)            { return invoke("list_dir",   { path }); }
async function readFile(path)           { return invoke("read_file",  { path }); }
async function writeFile(path, content) { return invoke("write_file", { path, content }); }
async function pickFolder()             { return invoke("pick_folder"); }

const normPath = p => p.replace(/\\/g, "/");

// Box any path (relative, absolute, or already workspace-prefixed) into the
// workspace root. Neutralizes path traversal (../../etc/passwd → workspace/etc/passwd).
function boxPath(workspace, rawPath) {
  if (!workspace) return normPath(rawPath);
  let rel = normPath(rawPath);
  // Strip workspace prefix or any leading slash so we always treat as relative
  if (rel.startsWith(workspace + "/")) rel = rel.slice(workspace.length + 1);
  else if (rel.startsWith("/"))        rel = rel.slice(1);
  // Resolve . and .. segments
  const parts = [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return `${workspace}/${parts.join("/")}`;
}

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

function _buildStepHtml(toolName, toolArg) {
  return `<span class="thinking-step-arrow">↳</span><span class="thinking-step-text">${escapeHtml(toolName)}${toolArg ? ` <em>${escapeHtml(toolArg)}</em>` : ""}</span>`;
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
  const { apiKey } = getState();
  if (apiKey) $("api-key-input").value = apiKey;
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

  $("thread-task-title").textContent = activeThread.title;
  _setStatusBadge(activeThread.status);

  const feed = $("agent-feed");
  feed.innerHTML = "";
  $("agent-result").style.display = "none";

  // User task bubble
  feed.appendChild(_makeChatMsg("user", activeThread.title));

  // Group tool calls before each text message into a collapsible tools block
  let pendingTools = [];
  for (const msg of activeThread.messages) {
    if (msg.type === "tool") {
      pendingTools.push(msg);
    } else if (msg.type === "text") {
      feed.appendChild(_makeChatMsg("assistant", msg.content, pendingTools));
      pendingTools = [];
    }
  }

  feed.scrollTop = feed.scrollHeight;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
let _liveThinkingEl = null;
let _liveTools = [];
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
      description: "Write or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
];

async function executeTool(toolName, argsStr) {
  let args;
  try { args = JSON.parse(argsStr); } catch { return "Error: could not parse tool args."; }

  const { workspace } = getState();
  if (!workspace) return "Error: no workspace selected.";
  const path = boxPath(workspace, args.path ?? "");

  const decision = await checkPermission(toolName, path);

  if (decision === "deny") return "Error: access denied by user.";

  if (decision === "always") {
    addTrustedFolder(toolName === "list_dir" ? normPath(path) : _parentDir(path));
  }

  const { activeThread } = getState();
  if (activeThread) {
    await appendMessage({ type: "tool", toolName, toolArg: path });
    if (_liveThinkingEl) {
      addThinkingStep(_liveThinkingEl, toolName, path);
      _liveTools.push({ toolName, toolArg: path });
      $("agent-feed").scrollTop = $("agent-feed").scrollHeight;
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
    return "Error: unknown tool.";
  } catch (err) {
    return `Error: ${err.message ?? err}`;
  }
}

function _setThreadComposeEnabled(enabled) {
  $("thread-input").disabled = !enabled;
  $("thread-send-btn").disabled = !enabled || !$("thread-input").value.trim();
}

function _buildMessages(thread) {
  const messages = [{ role: "user", content: thread.title }];
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

  const systemPrompt = `You are extra-hands, an autonomous file-based task agent running inside the user's workspace.
Use relative paths for all file operations (e.g. "report.txt", "subdir/data.csv"). The system will resolve them to the correct location automatically.
You can call list_dir, read_file, and write_file to complete the task.
Work autonomously. When done, summarize what you did and what files were created or modified.`;

  const messages = _buildMessages(activeThread);

  // Streaming state — persists across turns, reset only after a tool call
  let contentEl = null, mdParser = null, observer = null;
  let lastResult = null, scrollPending = false;

  function onDelta(delta) {
    if (viewThread.style.display === "none") return;
    if (!contentEl) {
      // First text — collapse thinking, start assistant bubble
      _liveThinkingEl = null;
      collapseThinking(thinkingEl, () => {});
      const msgEl = _makeChatMsg("assistant", "", _liveTools);
      feed.appendChild(msgEl);
      contentEl = msgEl.querySelector(".bubble-content");
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
    contentEl = null;
    _liveTools = [];
  }

  try {
    for (let turn = 0; turn < 8; turn++) {
      const result = await orchestrateMessage({
        apiKey, model, messages, systemPrompt,
        tools: FILE_TOOLS,
        onDelta,
      });

      if (result.toolCall) {
        // Reset streaming state so next turn's text starts a fresh bubble
        resetStreamState();

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
        break;
      }
    }

    await updateActiveThread({ status: "done", result: lastResult });
  } catch (err) {
    console.error("[extra-hands] agent error:", err);
    _liveThinkingEl = null;
    if (thinkingEl.parentNode) { thinkingEl.style.transition = "none"; thinkingEl.remove(); }
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

  $("pick-folder-btn").addEventListener("click", handlePickFolder);
  $("task-input").addEventListener("input", updateRunButton);

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
