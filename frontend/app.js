// ── app.js — extra-hands UI controller ────────────────────────────────────────
import {
  getState, setState, subscribe,
  loadState, savePrefs, saveApiKey, saveThreads,
  createThread, updateThread, appendMessage,
} from "./state.js";
import { orchestrateMessage } from "./search.js";

// ── Tauri IPC stubs ────────────────────────────────────────────────────────────
const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

// File tool stubs — real Rust commands don't exist yet; these will be wired later.
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
let _activeThreadId = null;

function showHome() {
  viewHome.style.display   = "flex";
  viewThread.style.display = "none";
  _activeThreadId = null;
  renderThreadsList();
}

function showThread(threadId) {
  viewHome.style.display   = "none";
  viewThread.style.display = "flex";
  _activeThreadId = threadId;
  renderThread(threadId);
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

// ── Workspace ──────────────────────────────────────────────────────────────────
function renderWorkspace() {
  const { workspace } = getState();
  const pathEl = $("workspace-path");
  if (workspace) {
    // Show only last 2 path segments for brevity
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
  // Update run button hint
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

// ── Compose area ───────────────────────────────────────────────────────────────
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

// ── Recent threads ─────────────────────────────────────────────────────────────
function renderThreadsList() {
  const { threads } = getState();
  const section = $("threads-section");
  const list    = $("threads-list");

  if (!threads.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  list.innerHTML = "";

  for (const t of threads) {
    const item = document.createElement("div");
    item.className = "thread-item";
    item.dataset.id = t.id;

    const dot = document.createElement("div");
    dot.className = `thread-item-dot status-${t.status}`;

    const body = document.createElement("div");
    body.className = "thread-item-body";

    const title = document.createElement("div");
    title.className = "thread-item-title";
    title.textContent = t.title;

    const meta = document.createElement("div");
    meta.className = "thread-item-meta";
    meta.textContent = _relativeTime(t.createdAt) + " · " + t.status;

    body.appendChild(title);
    body.appendChild(meta);
    item.appendChild(dot);
    item.appendChild(body);

    item.addEventListener("click", () => showThread(t.id));
    list.appendChild(item);
  }
}

function _relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  return Math.floor(diff / 3_600_000) + "h ago";
}

// ── Thread view ────────────────────────────────────────────────────────────────
function renderThread(threadId) {
  const { threads } = getState();
  const thread = threads.find(t => t.id === threadId);
  if (!thread) { showHome(); return; }

  $("thread-task-title").textContent = thread.title;

  const badge = $("thread-status-badge");
  badge.className = `status-badge ${thread.status}`;
  badge.textContent = thread.status === "idle" ? "" : thread.status;

  const feed = $("agent-feed");
  feed.innerHTML = "";

  for (const msg of thread.messages) {
    if (msg.type === "tool") {
      feed.appendChild(_makeToolChip(msg));
    } else if (msg.type === "text") {
      const el = document.createElement("div");
      el.className = "feed-text";
      el.textContent = msg.content;
      feed.appendChild(el);
    }
  }

  // If running, last text bubble may still be streaming — show cursor
  if (thread.status === "running") {
    const last = feed.lastElementChild;
    if (last?.classList.contains("feed-text")) {
      const cursor = document.createElement("span");
      cursor.className = "cursor";
      last.appendChild(cursor);
    }
  }

  const resultBox = $("agent-result");
  if (thread.status === "done" && thread.result) {
    $("result-content").textContent = thread.result;
    resultBox.style.display = "block";
  } else {
    resultBox.style.display = "none";
  }
}

function _makeToolChip({ toolName, toolArg }) {
  const icons = {
    read_file:  `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="10" height="13" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`,
    write_file: `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z"/><polyline points="10 2 10 6 14 6"/></svg>`,
    list_dir:   `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h4l2 2h8v8H1z"/></svg>`,
    web_search: `<svg class="tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="15" y2="15"/></svg>`,
  };

  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.innerHTML = (icons[toolName] ?? "") +
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
      description: "List the files and subdirectories in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "Absolute path to the file." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
];

async function executeTool(toolName, argsStr, threadId) {
  let args;
  try { args = JSON.parse(argsStr); } catch { return "Error: could not parse tool args."; }

  // Record tool call in feed
  appendMessage(threadId, { type: "tool", toolName, toolArg: args.path ?? args.query ?? "" });
  if (_activeThreadId === threadId) renderThread(threadId);

  if (toolName === "list_dir")   return JSON.stringify(await listDir(args.path));
  if (toolName === "read_file")  return await readFile(args.path);
  if (toolName === "write_file") { await writeFile(args.path, args.content); return "ok"; }
  return "Error: unknown tool.";
}

async function runAgentLoop(threadId) {
  const { apiKey, model, workspace } = getState();
  if (!apiKey) { showToast("Add your OpenRouter API key in settings."); return; }

  updateThread(threadId, { status: "running" });

  const { threads } = getState();
  const thread = threads.find(t => t.id === threadId);

  const systemPrompt = `You are extra-hands, an autonomous file-based task agent.
The user has granted you access to their workspace at: ${workspace ?? "(none)"}
You can call list_dir, read_file, and write_file to complete the task.
Work autonomously. When done, summarize what you did and what files were created or modified.`;

  // Seed messages with the user task
  const messages = [{ role: "user", content: thread.title }];

  // Create a streaming text node
  let streamEl = null;
  let fullText  = "";

  function ensureStreamEl() {
    if (!streamEl) {
      streamEl = document.createElement("div");
      streamEl.className = "feed-text";
      $("agent-feed")?.appendChild(streamEl);
    }
  }

  function onDelta(delta) {
    fullText += delta;
    if (_activeThreadId === threadId) {
      ensureStreamEl();
      const cursor = streamEl.querySelector(".cursor");
      if (cursor) cursor.remove();
      streamEl.textContent = fullText;
      const c = document.createElement("span");
      c.className = "cursor";
      streamEl.appendChild(c);
      $("agent-feed").scrollTop = $("agent-feed").scrollHeight;
    }
  }

  // Multi-turn agentic loop (max 8 turns to prevent runaway)
  const MAX_TURNS = 8;
  let turn = 0;
  let lastResult = null;

  try {
    while (turn < MAX_TURNS) {
      turn++;
      fullText = "";
      streamEl = null;

      // Include tool call history in messages for next turn
      const result = await orchestrateMessage({
        apiKey,
        model,
        messages,
        systemPrompt,
        tools: FILE_TOOLS,
        onDelta,
        onToolCall: async (toolCall) => {
          const toolResult = await executeTool(toolCall.name, toolCall.args, threadId);

          // Append tool exchange to messages so model sees results
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.args },
            }],
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: String(toolResult),
          });

          return toolResult;
        },
      });

      if (result.fullText) {
        // Remove streaming cursor
        streamEl?.querySelector(".cursor")?.remove();
        appendMessage(threadId, { type: "text", content: result.fullText });
        messages.push({ role: "assistant", content: result.fullText });
        lastResult = result.fullText;
      }

      // If no tool was called, the model is done
      if (!result.toolCall) break;
    }

    updateThread(threadId, { status: "done", result: lastResult });
    await saveThreads();
  } catch (err) {
    console.error("[extra-hands] agent error:", err);
    updateThread(threadId, { status: "error" });
    appendMessage(threadId, { type: "text", content: `Error: ${err.message}` });
    await saveThreads();
    showToast(err.message);
  }

  if (_activeThreadId === threadId) renderThread(threadId);
  renderThreadsList();
}

// ── Boot ───────────────────────────────────────────────────────────────────────
async function init() {
  await loadState();
  const { theme, model, apiKey } = getState();

  applyTheme(theme);

  // Populate model selector
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

  // Show settings if no API key
  if (!apiKey) showSettings();

  renderWorkspace();
  renderThreadsList();
}

// ── Wire up events ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Header
  $("theme-btn").addEventListener("click", toggleTheme);
  $("settings-btn").addEventListener("click", toggleSettings);

  // Settings
  $("save-key-btn").addEventListener("click", async () => {
    const key = $("api-key-input").value.trim();
    if (key) { await saveApiKey(key); hideSettings(); }
  });
  $("api-key-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const key = e.target.value.trim();
      if (key) { await saveApiKey(key); hideSettings(); }
    }
  });

  // Workspace
  $("pick-folder-btn").addEventListener("click", handlePickFolder);

  // Compose
  $("task-input").addEventListener("input", updateRunButton);

  // Example chips — fill task input
  document.querySelectorAll(".example-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      $("task-input").value = chip.dataset.task;
      $("task-input").focus();
      updateRunButton();
    });
  });

  // Run task
  $("run-btn").addEventListener("click", async () => {
    const title = $("task-input").value.trim();
    if (!title) return;

    const thread = createThread(title);
    $("task-input").value = "";
    updateRunButton();
    saveThreads(); // fire-and-forget — persist immediately so the thread survives a crash

    showThread(thread.id);
    await runAgentLoop(thread.id);
  });

  // Back button
  $("back-btn").addEventListener("click", showHome);

  // Close settings when clicking outside
  document.addEventListener("click", (e) => {
    const bar = $("settings-bar");
    const btn = $("settings-btn");
    if (bar.classList.contains("open") && !bar.contains(e.target) && !btn.contains(e.target)) {
      hideSettings();
    }
  });

  init();
});
