# Changelog

## Unreleased

### Added
- Shell / command execution tool (`run_command`) — planned next

---

## 0.1.0 — 2026-03-19 (alpha)

Initial working build.

### Added
- macOS menu bar tray app (Tauri 2.x)
- Agent loop with `list_dir`, `read_file`, `write_file` tools
- Streaming markdown output with live tool step replay
- Per-folder permission prompts (deny / allow / always-allow)
- Path sandboxing — all LLM paths boxed into workspace root in code
- Thread history — persistent, searchable, resumable
- Follow-up messages in the same thread
- Auto-generated thread titles (short LLM call, runs in parallel)
- Inline-editable thread title
- Dark mode
- Model switching via OpenRouter (any model)
- BYOK — key stored locally, no server
