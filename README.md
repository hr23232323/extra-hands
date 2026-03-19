# extra-hands

**macOS menu bar app. Point AI at a folder, describe a task, step away.**

No cloud. No account. No conversation back-and-forth. The agent reads your files, reasons over them, writes the output, and hands you the result.

![Platform](https://img.shields.io/badge/platform-macOS-black) ![License](https://img.shields.io/badge/license-MIT-blue) ![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange)

---

> **Early alpha** — core agent loop works, shell execution coming next.

---

## Demo

<!-- TODO: drop a GIF here -->

![extra-hands demo](docs/demo.gif)

---

## How it works

```
1. Click the menu bar icon
2. Pick a workspace folder
3. Describe a task in plain language
```

The agent calls `list_dir → read_file → write_file` in a loop until the task is done. You watch live tool steps and streaming output as it works. Follow up in the same thread or start fresh.

All file ops go through Rust. The webview never touches the filesystem directly. Paths are resolved deterministically in code — the model is never trusted to construct absolute paths.

---

## Getting started

**Requirements:** macOS, Rust, [Tauri CLI v2](https://tauri.app/start/prerequisites/), an [OpenRouter](https://openrouter.ai) API key.

```bash
git clone https://github.com/hr23232323/extra-hands
cd extra-hands

make setup   # installs Tauri CLI
make dev     # hot-reload dev build
make build   # production .app
```

No npm. No bundler. Frontend is plain HTML/CSS/JS — edit and the dev server picks it up immediately.

On first launch: open Settings (gear icon) → paste your OpenRouter key → pick a workspace folder → write a task.

---

## Stack

| | |
|---|---|
| Shell | Tauri 2.x (Rust) |
| Frontend | Vanilla JS, no bundler |
| AI | OpenRouter (model-agnostic) |
| Storage | `tauri-plugin-store` — local JSON, no server |
| Markdown | `streaming-markdown` |

BYOK. Fully local-first. No telemetry.

---

## What's working / what's not

**Working**
- `list_dir`, `read_file`, `write_file` file tools
- Streaming markdown + live tool step replay
- Per-folder permission prompts (deny / allow / always)
- Thread history — persistent, searchable, resumable
- Follow-up messages in the same thread
- Model switching (any OpenRouter model)
- Dark mode

**Not yet**
- Shell / command execution — biggest gap; most real tasks need it
- `delete_file`, `move_file`, `search_files`
- Background execution (window must stay open)
- Binary file support
- Packaged binary release — build from source for now

---

## Contributing

Codebase is intentionally simple:
- Add a Rust command in `src-tauri/src/lib.rs`
- Add a tool definition + handler in `frontend/app.js`

That's the whole loop. PRs welcome — keep changes focused.

```
frontend/
  app.js      — views, agent loop, chat rendering
  search.js   — OpenRouter streaming + SSE parsing
  state.js    — state + Tauri IPC persistence
  style.css
  index.html

src-tauri/
  src/lib.rs  — file I/O, folder picker, store, tray
```
