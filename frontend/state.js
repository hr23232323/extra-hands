// ── state.js — global singleton state for extra-hands ─────────────────────────
// All persistent state lives here. UI modules import and subscribe.
// Persistence: tauri-plugin-store → store.json (no-op fallback for browser dev).

const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null));

// ── Internal state ─────────────────────────────────────────────────────────────
let _state = {
  apiKey:    null,   // string | null
  model:     "qwen/qwen3-32b:nitro",
  theme:     "light",
  workspace: null,   // string | null — absolute folder path
  threads:   [],     // Thread[]
};

// ── Subscribers ────────────────────────────────────────────────────────────────
const _subscribers = new Set();

function _notify() {
  const snapshot = getState();
  for (const fn of _subscribers) fn(snapshot);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Read a shallow copy of current state. */
export function getState() {
  return { ..._state, threads: [..._state.threads] };
}

/**
 * Update state and notify subscribers.
 * @param {Partial<typeof _state>} patch
 */
export function setState(patch) {
  _state = { ..._state, ...patch };
  _notify();
}

/**
 * Subscribe to state changes.
 * @param {(state: typeof _state) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

// ── Thread helpers ─────────────────────────────────────────────────────────────

/** @returns {string} */
function _newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Create a new thread and return it.
 * @param {string} title — the user's task description
 * @returns {{ id: string, title: string, createdAt: number, messages: Array, status: string }}
 */
export function createThread(title) {
  const thread = {
    id:        _newId(),
    title,
    createdAt: Date.now(),
    messages:  [],
    status:    "idle",  // idle | running | done | error
  };
  _state = { ..._state, threads: [thread, ..._state.threads] };
  _notify();
  return thread;
}

/**
 * Update a thread by id.
 * @param {string} id
 * @param {object} patch
 */
export function updateThread(id, patch) {
  _state = {
    ..._state,
    threads: _state.threads.map(t => t.id === id ? { ...t, ...patch } : t),
  };
  _notify();
}

/**
 * Append a message to a thread.
 * @param {string} threadId
 * @param {{ role: string, content: string, [key: string]: any }} msg
 */
export function appendMessage(threadId, msg) {
  _state = {
    ..._state,
    threads: _state.threads.map(t =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, msg] }
        : t
    ),
  };
  _notify();
}

// ── Persistence ────────────────────────────────────────────────────────────────

/** Load all persisted state from Tauri store. Call once at boot. */
export async function loadState() {
  const [apiKey, prefs, threads] = await Promise.all([
    invoke("get_api_key"),
    invoke("get_prefs"),
    invoke("get_threads"),
  ]);

  const patch = {};
  if (apiKey)           patch.apiKey    = apiKey;
  if (prefs?.model)     patch.model     = prefs.model;
  if (prefs?.theme)     patch.theme     = prefs.theme;
  if (prefs?.workspace) patch.workspace = prefs.workspace;
  if (Array.isArray(threads) && threads.length) patch.threads = threads;

  if (Object.keys(patch).length) setState(patch);
}

/** Persist prefs to Tauri store. */
export async function savePrefs() {
  const { model, theme, workspace } = _state;
  await invoke("set_prefs", { prefs: { model, theme, workspace } });
}

/** Persist threads to Tauri store. */
export async function saveThreads() {
  await invoke("set_threads", { threads: _state.threads });
}

export async function saveApiKey(key) {
  await invoke("set_api_key", { key });
  setState({ apiKey: key });
}
