# extra-hands

A macOS menu bar app that points an AI at your local files and runs tasks autonomously. Describe what you want done, grant folder access, step away.

**The problem it solves:** Most AI tools are still conversational — you ask, it answers, you act. extra-hands skips the middle step. It reads your files, reasons over them, writes outputs, and hands you the result.

---

## How it works

1. Click the menu bar icon to open the app (480×660px popover)
2. Select a workspace folder
3. Describe a task in plain language
4. The agent calls `list_dir`, `read_file`, and `write_file` in a loop until it's done
5. You see live tool steps and streaming output as it works
6. Follow up in the same thread or start a new task

The agent runs up to 8 turns per task. Each tool call goes through Rust — the webview never touches the filesystem directly.

---

## Features

- **Model-agnostic** — pick any model on OpenRouter (Qwen, Gemini, Claude, GPT-4o, etc.)
- **BYOK** — bring your own OpenRouter API key, stored locally via Tauri's secure store
- **Per-folder permissions** — deny / allow / always-allow per folder; trusted folders remembered across sessions
- **Path sandboxing** — all LLM-provided paths (relative, absolute, traversal attempts) are boxed into the workspace root in code, not by trusting the model
- **Live chat UX** — streaming markdown, thinking indicator with collapsible tool steps, follow-up messages in the same thread
- **Thread history** — all threads persisted locally, searchable, resumable
- **Dark mode** — system-aware, toggleable

---

## Stack

| Layer | Choice |
|-------|--------|
| Desktop shell | Tauri 2.x (Rust) |
| Frontend | Vanilla HTML/CSS/JS — no bundler |
| AI | OpenRouter streaming API |
| Storage | `tauri-plugin-store` → local JSON |
| Markdown | `streaming-markdown` (CDN, no build step) |
| Fonts | Playfair Display + Lora + JetBrains Mono |

---

## Dev setup

Requires: Rust, [Tauri CLI v2](https://tauri.app/start/prerequisites/)

```bash
# Install Tauri CLI
make setup

# Run with hot reload
make dev

# Build .app
make build
```

The frontend is plain files in `frontend/` — edit and the Tauri dev server picks up changes immediately. No npm, no bundler.

---

## Project structure

```
frontend/
  app.js        # UI controller — views, agent loop, chat rendering
  search.js     # OpenRouter streaming + SSE parsing
  state.js      # In-memory state + Tauri IPC persistence
  style.css     # All styles
  index.html    # Single HTML file

src-tauri/
  src/lib.rs    # Rust commands: file I/O, folder picker, store, tray
```

### Key IPC commands (Rust → JS)

| Command | What it does |
|---------|-------------|
| `pick_folder` | Native folder picker dialog (focus-guard prevents window hiding while open) |
| `read_file` / `write_file` / `list_dir` | Filesystem ops — only callable from the agent loop |
| `get_api_key` / `set_api_key` | Secure key storage |
| `get_prefs` / `set_prefs` | Model, theme, workspace, trusted folders |
| `get_thread` / `save_thread` / `get_thread_index` / `set_thread_index` | Thread persistence |

---

## Security model

- The LLM uses relative paths — the app resolves them, not the model
- `boxPath()` in `app.js` normalizes all paths into the workspace root; `../../etc/passwd` becomes `workspace/etc/passwd`
- File operations require explicit per-folder permission (deny / allow / always) unless the path is under the selected workspace
- Trusted folders are persisted and respected across sessions

---

## What it is not

- Not a coding assistant (Claude Code does that better)
- Not a general chat interface
- Not a cloud service — no extra-hands server, no account, no telemetry

---

## Roadmap / known gaps

- [ ] Only 3 tools today (`list_dir`, `read_file`, `write_file`) — `search_files` would unlock a lot
- [ ] No write preview / undo — the agent can overwrite files without confirmation
- [ ] macOS only — Tauri supports Windows/Linux but window sizing and tray behavior are macOS-tuned
- [ ] No background execution — task runs while the window is open
- [ ] Thread continuation loses tool-call history (only text turns reconstructed) — fine for single-shot tasks

---

## Contributing

The codebase is intentionally simple — no framework, no build toolchain, one HTML file. If you want to add a tool, add a Rust command in `lib.rs` and a tool definition + handler in `app.js`. That's the whole loop.

PRs welcome. Keep changes focused.
