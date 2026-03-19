// ── app.js — extra-hands UI controller ────────────────────────────────────────
import {
  getState, setState,
  loadState, savePrefs, saveApiKey,
  createThread, loadThread, updateActiveThread,
  appendMessage, flushActiveThread,
} from "./state.js";
import { orchestrateMessage } from "./search.js";

// ── Tauri IPC stubs ────────────────────────────────────────────────────────────
const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

async function listDir(path)            { return invoke("list_dir",   { path })  ?? []; }
async function readFile(path)           { return invoke("read_file",  { path })  ?? ""; }
async function writeFile(path, content) { return invoke("write_file", { path, content }) ?? null; }
async function pickFolder()             { return invoke("pick_folder") ?? null; }

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
    const parts = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
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
    setState({ workspace: path });
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
function renderThreadView() {
  const { activeThread } = getState();
  if (!activeThread) { showHome(); return; }

  $("thread-task-title").textContent = activeThread.title;

  const badge = $("thread-status-badge");
  badge.className = `status-badge ${activeThread.status}`;
  badge.textContent = activeThread.status === "idle" ? "" : activeThread.status;

  const feed = $("agent-feed");
  feed.innerHTML = "";

  for (const msg of activeThread.messages) {
    if (msg.type === "tool") {
      feed.appendChild(_makeToolChip(msg));
    } else if (msg.type === "text") {
      const el = document.createElement("div");
      el.className = "feed-text";
      el.textContent = msg.content;
      feed.appendChild(el);
    }
  }

  if (activeThread.status === "running") {
    const last = feed.lastElementChild;
    if (last?.classList.contains("feed-text")) {
      const cursor = document.createElement("span");
      cursor.className = "cursor";
      last.appendChild(cursor);
    }
  }

  const resultBox = $("agent-result");
  if (activeThread.status === "done" && activeThread.result) {
    $("result-content").textContent = activeThread.result;
    resultBox.style.display = "block";
  } else {
    resultBox.style.display = "none";
  }
}

const _TOOL_ICONS = {
  read_file:  `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="10" height="13" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`,
  write_file: `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z"/><polyline points="10 2 10 6 14 6"/></svg>`,
  list_dir:   `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h4l2 2h8v8H1z"/></svg>`,
};

function _makeToolChip({ toolName, toolArg }) {
  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.innerHTML = (_TOOL_ICONS[toolName] ?? "") +
    `<span class="tool-name">${toolName}</span>` +
    (toolArg ? `<span class="tool-arg">${toolArg}</span>` : "");
  return chip;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
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

  const { activeThread } = getState();
  if (activeThread) {
    await appendMessage({ type: "tool", toolName, toolArg: args.path ?? "" });
    if (viewThread.style.display !== "none") renderThreadView();
  }

  if (toolName === "list_dir")   return JSON.stringify(await listDir(args.path));
  if (toolName === "read_file")  return await readFile(args.path);
  if (toolName === "write_file") { await writeFile(args.path, args.content); return "ok"; }
  return "Error: unknown tool.";
}

async function runAgentLoop() {
  const { apiKey, model, workspace, activeThread } = getState();
  if (!activeThread) return;
  if (!apiKey) { showToast("Add your OpenRouter API key in settings."); return; }

  await updateActiveThread({ status: "running" });
  if (viewThread.style.display !== "none") renderThreadView();

  const systemPrompt = `You are extra-hands, an autonomous file-based task agent.
The user has granted you access to their workspace at: ${workspace ?? "(none)"}
You can call list_dir, read_file, and write_file to complete the task.
Work autonomously. When done, summarize what you did and what files were created or modified.`;

  const messages = [{ role: "user", content: activeThread.title }];

  let streamEl     = null;
  let streamText   = null;
  let streamCursor = null;
  let fullText     = "";
  let lastResult   = null;

  function onDelta(delta) {
    fullText += delta;
    if (viewThread.style.display === "none") return;
    const feed = $("agent-feed");
    if (!streamEl) {
      streamEl = document.createElement("div");
      streamEl.className = "feed-text";
      streamText = document.createTextNode("");
      streamCursor = document.createElement("span");
      streamCursor.className = "cursor";
      streamEl.appendChild(streamText);
      streamEl.appendChild(streamCursor);
      feed.appendChild(streamEl);
    }
    streamText.textContent = fullText;
    feed.scrollTop = feed.scrollHeight;
  }

  try {
    for (let turn = 0; turn < 8; turn++) {
      fullText     = "";
      streamEl     = null;
      streamText   = null;
      streamCursor = null;

      const result = await orchestrateMessage({
        apiKey, model, messages, systemPrompt,
        tools: FILE_TOOLS,
        onDelta,
        onToolCall: async (toolCall) => {
          const toolResult = await executeTool(toolCall.name, toolCall.args);
          messages.push({
            role: "assistant", content: null,
            tool_calls: [{ id: toolCall.id, type: "function",
              function: { name: toolCall.name, arguments: toolCall.args } }],
          });
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: String(toolResult) });
          return toolResult;
        },
      });

      streamCursor?.remove();

      if (result.fullText) {
        await appendMessage({ type: "text", content: result.fullText });
        messages.push({ role: "assistant", content: result.fullText });
        lastResult = result.fullText;
      }

      if (!result.toolCall) break;
    }

    await updateActiveThread({ status: "done", result: lastResult });
  } catch (err) {
    console.error("[extra-hands] agent error:", err);
    await appendMessage({ type: "text", content: `Error: ${err.message}` });
    await updateActiveThread({ status: "error" });
    showToast(err.message);
  }

  await flushActiveThread();
  if (viewThread.style.display !== "none") renderThreadView();
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

  $("back-btn").addEventListener("click", showHome);

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
