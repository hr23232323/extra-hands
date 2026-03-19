// ── state.js — global singleton state for extra-hands ─────────────────────────
// Thread storage is split:
//   threadIndex  → lightweight metadata [{id, title, createdAt, status}]
//                  persisted in store.json under "thread_index"
//   thread files → full content {id, title, createdAt, messages, status, result}
//                  each in its own thread-{id}.json via separate store

const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

// ── Internal state ─────────────────────────────────────────────────────────────
let _state = {
  apiKey:         null,
  model:          "qwen/qwen3-32b:nitro",
  theme:          "light",
  workspace:      null,
  trustedFolders: [],
  threadIndex:    [],   // [{id, title, createdAt, status}] — always in memory
  activeThread:   null, // full thread object — loaded on demand
};

// ── Public API ─────────────────────────────────────────────────────────────────

export function getState() {
  return { ..._state, threadIndex: [..._state.threadIndex] };
}

export function setState(patch) {
  _state = { ..._state, ...patch };
}

// ── Thread helpers ─────────────────────────────────────────────────────────────

function _newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Create a new thread, add it to the index, persist both index and thread file.
 * @returns full thread object
 */
export async function createThread(title) {
  const thread = {
    id:        _newId(),
    title,
    prompt:    title,   // original task text — used as first LLM message, never changed
    createdAt: Date.now(),
    messages:  [],
    status:    "idle",
    result:    null,
  };
  const meta = { id: thread.id, title, createdAt: thread.createdAt, status: "idle" };

  _state = {
    ..._state,
    threadIndex:  [meta, ..._state.threadIndex],
    activeThread: thread,
  };

  // Persist both
  await Promise.all([
    invoke("set_thread_index", { index: _state.threadIndex }),
    invoke("save_thread", { id: thread.id, thread }),
  ]);

  return thread;
}

/**
 * Load a full thread by id from its store file. Sets activeThread in state.
 */
export async function loadThread(id) {
  const data = await invoke("get_thread", { id });
  if (data) {
    _state = { ..._state, activeThread: data };
    return data;
  }
  return null;
}

/**
 * Update fields on the active thread and persist.
 */
export async function updateActiveThread(patch) {
  if (!_state.activeThread) return;
  const updated = { ..._state.activeThread, ...patch };

  // Sync status and title into the index
  const index = _state.threadIndex.map(m =>
    m.id === updated.id ? { ...m, status: updated.status, title: updated.title } : m
  );

  _state = { ..._state, activeThread: updated, threadIndex: index };

  await Promise.all([
    invoke("save_thread", { id: updated.id, thread: updated }),
    invoke("set_thread_index", { index }),
  ]);
}

/**
 * Append a message to the active thread and persist.
 */
export async function appendMessage(msg) {
  if (!_state.activeThread) return;
  const updated = {
    ..._state.activeThread,
    messages: [..._state.activeThread.messages, msg],
  };
  _state = { ..._state, activeThread: updated };
  // Debounce: caller decides when to flush (avoid per-delta disk writes)
}

/** Flush active thread to disk. Call at meaningful checkpoints (done/error). */
export async function flushActiveThread() {
  if (!_state.activeThread) return;
  await invoke("save_thread", { id: _state.activeThread.id, thread: _state.activeThread });
}

// ── Persistence ────────────────────────────────────────────────────────────────

export async function loadState() {
  const [apiKey, prefs, threadIndex] = await Promise.all([
    invoke("get_api_key"),
    invoke("get_prefs"),
    invoke("get_thread_index"),
  ]);

  const patch = {};
  if (apiKey)           patch.apiKey      = apiKey;
  if (prefs?.model)     patch.model       = prefs.model;
  if (prefs?.theme)     patch.theme       = prefs.theme;
  if (prefs?.workspace) patch.workspace   = prefs.workspace;
  if (Array.isArray(prefs?.trustedFolders) && prefs.trustedFolders.length) patch.trustedFolders = prefs.trustedFolders;
  if (Array.isArray(threadIndex) && threadIndex.length) patch.threadIndex = threadIndex;

  if (Object.keys(patch).length) setState(patch);
}

export async function savePrefs() {
  const { model, theme, workspace, trustedFolders } = _state;
  await invoke("set_prefs", { prefs: { model, theme, workspace, trustedFolders } });
}

export function addTrustedFolder(folderPath) {
  const norm = folderPath.replace(/\\/g, "/");
  if (_state.trustedFolders.includes(norm)) return;
  setState({ trustedFolders: [..._state.trustedFolders, norm] });
  savePrefs();
}

export async function saveApiKey(key) {
  await invoke("set_api_key", { key });
  setState({ apiKey: key });
}
