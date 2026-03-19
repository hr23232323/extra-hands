# Contributing to extra-hands

Thanks for looking into contributing. The codebase is intentionally small and dependency-light — please keep it that way.

## Getting started

```bash
git clone https://github.com/hr23232323/extra-hands
cd extra-hands
make setup
make dev
```

See the README for full prerequisites.

## Architecture in 30 seconds

The agent loop lives entirely in `frontend/app.js`. Each tool call is wired to a Rust command in `src-tauri/src/lib.rs` via Tauri IPC. State and persistence are in `frontend/state.js`. That's it.

**Adding a new tool:**
1. Add a `#[tauri::command]` fn in `lib.rs` and register it in `invoke_handler!`
2. Add a tool definition in `FILE_TOOLS` in `app.js`
3. Handle it in `executeTool()` in `app.js`

## What we want

- New file / shell tools that make the agent more capable
- Bug fixes
- UX improvements to the chat interface

## What we don't want

- New dependencies without a strong reason
- Framework introductions (no React, no bundler)
- Features that require a server or account
- Premature abstractions — three similar lines of code is fine

## Pull requests

- Keep PRs focused — one thing per PR
- Write a clear description of what you changed and why
- If you're adding a Rust command, make sure it's listed in the invoke_handler

## Reporting bugs

Use the [issue tracker](https://github.com/hr23232323/extra-hands/issues). Include your macOS version, which model you were using, and what you expected vs what happened.
