#!/usr/bin/env node
/**
 * scripts/agent-loop.js — visualize the extra-hands agent loop in the terminal.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... node scripts/agent-loop.js --task "your task"
 *   make run TASK="your task" [WORKSPACE=/path] [MODEL=model-id]
 *
 * Options:
 *   --task        Task description (required)
 *   --workspace   Folder to operate in (default: current directory)
 *   --model       OpenRouter model ID (default: qwen/qwen3-32b:nitro)
 *   --key         OpenRouter API key (overrides env var)
 *   --max-turns   Max agent turns (default: 25)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { parseStream } from "../frontend/search.js";
import { boxPath, applyEdit } from "../frontend/utils.js";

// ── ANSI ──────────────────────────────────────────────────────────────────────
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const workspace  = resolve(getArg("--workspace") ?? ".");
const task       = getArg("--task");
const model      = getArg("--model")    ?? "qwen/qwen3-32b:nitro";
const apiKey     = getArg("--key")      ?? process.env.OPENROUTER_API_KEY;
const tavilyKey  = process.env.TAVILY_API_KEY;
const jinaKey    = process.env.JINA_API_KEY;
const maxTurns   = parseInt(getArg("--max-turns") ?? "25", 10);

if (!task)   { console.error(red('error: --task is required')); process.exit(1); }
if (!apiKey) { console.error(red('error: set OPENROUTER_API_KEY or pass --key')); process.exit(1); }

// ── Blocked files ─────────────────────────────────────────────────────────────
const BLOCKED = new Set([".env", ".env.local", ".env.production"]);

// ── File tools ────────────────────────────────────────────────────────────────
function _safe(path) { return boxPath(workspace, path ?? "."); }

function listDir(path) {
  return JSON.stringify(
    readdirSync(_safe(path), { withFileTypes: true })
      .map(e => ({ name: e.name, is_dir: e.isDirectory() }))
  );
}

function readFile(path) {
  const safe = _safe(path);
  if (BLOCKED.has(basename(safe))) return "Error: access denied — sensitive file.";
  return readFileSync(safe, "utf8");
}

function writeFile(path, content) {
  writeFileSync(_safe(path), content, "utf8");
  return "ok";
}

function editFile(path, oldString, newString, replaceAll = false) {
  const safe = _safe(path);
  if (BLOCKED.has(basename(safe))) return "Error: access denied — sensitive file.";
  const current = readFileSync(safe, "utf8");
  const { result, error } = applyEdit(current, oldString, newString, replaceAll);
  if (error) return `Error: ${error}`;
  writeFileSync(safe, result, "utf8");
  return "ok";
}

// ── Web tools (same impl as app.js) ──────────────────────────────────────────
async function webSearch(query) {
  if (!tavilyKey) return "Error: TAVILY_API_KEY not set.";
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: tavilyKey, query, search_depth: "basic", max_results: 6, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data.results.map(r => ({ title: r.title, url: r.url, snippet: r.content, score: r.score })));
}

async function fetchUrl(url) {
  const headers = { "Accept": "text/plain", "X-Return-Format": "markdown" };
  if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  if (!res.ok) throw new Error(`Jina ${res.status}`);
  const text = await res.text();
  return text.length > 12000 ? text.slice(0, 12000) + "\n\n[truncated]" : text;
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, argsStr) {
  let args;
  try { args = JSON.parse(argsStr); } catch { return "Error: could not parse tool args."; }
  try {
    if (name === "list_dir")   return listDir(args.path);
    if (name === "read_file")  return readFile(args.path);
    if (name === "write_file") return writeFile(args.path, args.content);
    if (name === "edit_file")  return editFile(args.path, args.old_string, args.new_string, args.replace_all ?? false);
    if (name === "web_search") return await webSearch(args.query);
    if (name === "fetch_url")  return await fetchUrl(args.url);
    return "Error: unknown tool.";
  } catch (err) {
    return `Error: ${err.message ?? String(err)}`;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const FILE_TOOLS = [
  { type: "function", function: { name: "list_dir",  description: "List files and subdirectories.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file",  description: "Read the full contents of a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file",  description: "Replace a specific string in a file. Always read_file first.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } } },
];

const WEB_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web. Returns ranked URLs with snippets.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "fetch_url",  description: "Fetch a web page as markdown.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

const tools = tavilyKey ? [...FILE_TOOLS, ...WEB_TOOLS] : FILE_TOOLS;

// ── System prompt (same as app.js) ────────────────────────────────────────────
const dateTimeStr = new Date().toLocaleString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
  hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

const systemPrompt = `Today is ${dateTimeStr}.

You are extra-hands, an autonomous agent working inside the user's local workspace.

## Before you start

First, assess whether the task has genuine ambiguity that would change what you do — scope unclear, multiple valid interpretations, or a risky/irreversible action involved. If yes, ask ONE focused question before touching any files. If no, proceed directly.

Do not ask about things you can figure out by exploring the workspace first. Do not ask multiple questions. One question, or none.

## Approach

**Explore first.** Start every task with list_dir(".") to understand the workspace. List subdirectories that seem relevant. Build a mental map before reading or writing anything.

**Plan before acting.** After exploring, think through the full task: which files need to be read, what will be created or changed, in what order. For multi-step tasks, state your plan briefly before starting.

**Read before you write.** Never call write_file or edit_file on a file you haven't read this session. The content may differ from what you expect. Prefer edit_file over write_file for existing files — it makes targeted changes rather than overwriting everything.

**Work incrementally.** Take small steps. After each tool call, check the result before continuing. Don't chain multiple writes without verifying the first succeeded.

**Never create duplicate files.** Modify files in place. Never create foo_backup.txt, foo_new.txt, foo_v2.txt, or similar unless the user explicitly asked for a copy.
${tavilyKey ? `
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

// ── OpenRouter call ───────────────────────────────────────────────────────────
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function callModel(messages, onDelta) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer":  "https://github.com/hr23232323/extra-hands",
      "X-Title":       "extra-hands",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      tools,
      tool_choice: "auto",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let fullText = "";
  const { toolCall } = await parseStream(
    res.body.getReader(),
    (delta) => { fullText += delta; onDelta(delta); },
    () => {},
  );
  return { fullText, toolCall };
}

// ── Display ───────────────────────────────────────────────────────────────────
const W = Math.min(process.stdout.columns || 80, 100);
const rule = (label = "") => dim("── " + label + " " + "─".repeat(Math.max(0, W - label.length - 4)));

// Summarize a message for the "INPUT" block — one line per message
function summarizeMsg(msg) {
  if (msg.role === "system") {
    return dim(`[system] ${msg.content}`);
  }
  if (msg.role === "user") {
    return `[user]   ${msg.content}`;
  }
  if (msg.role === "assistant" && msg.tool_calls) {
    const tc = msg.tool_calls[0].function;
    return `[asst]   → ${cyan(tc.name)}  ${dim(tc.arguments)}`;
  }
  if (msg.role === "assistant") {
    return `[asst]   ${msg.content}`;
  }
  if (msg.role === "tool") {
    return dim(`[tool]   ${msg.content}`);
  }
  return dim(JSON.stringify(msg));
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log();
console.log(bold(cyan("━━━ extra-hands ") + dim("─".repeat(W - 16))));
console.log(`  ${dim("workspace")}  ${workspace}`);
console.log(`  ${dim("model")}      ${model}`);
console.log(`  ${dim("web tools")}  ${tavilyKey ? green("on (Tavily)") : dim("off — set TAVILY_API_KEY to enable")}`);
console.log(`  ${dim("task")}       ${yellow(task)}`);
console.log();

const messages = [{ role: "user", content: task }];
let ranToCompletion = false;

for (let turn = 0; turn < maxTurns; turn++) {
  console.log(rule(`turn ${turn + 1}`));

  // ── INPUT: show every message in context this turn ──────────────────────────
  console.log();
  const fullContext = [{ role: "system", content: systemPrompt }, ...messages];
  for (const msg of fullContext) {
    console.log("  " + summarizeMsg(msg));
  }
  console.log();

  // ── OUTPUT: stream the model response live ───────────────────────────────────
  let firstDelta = true;
  let turnText = "";

  const { fullText, toolCall } = await callModel(messages, (delta) => {
    if (firstDelta) {
      process.stdout.write(bold("  output  "));
      firstDelta = false;
    }
    process.stdout.write(delta.replace(/\n/g, "\n          "));
    turnText += delta;
  });

  if (turnText) process.stdout.write("\n");

  if (toolCall) {
    if (!turnText) {
      // Tool call with no preceding text — print the output label
      console.log(bold("  output  ") + `→ ${cyan(toolCall.name)}  ${dim(toolCall.args)}`);
    } else {
      console.log(`\n          → ${cyan(toolCall.name)}  ${dim(toolCall.args)}`);
    }

    messages.push({
      role: "assistant",
      tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.args } }],
    });

    const result = await executeTool(toolCall.name, toolCall.args);
    const isError = String(result).startsWith("Error:");

    console.log(`  result  ${isError ? red(String(result)) : dim(String(result))}`);
    console.log();

    messages.push({ role: "tool", tool_call_id: toolCall.id, content: String(result) });

  } else {
    // Final response — done
    messages.push({ role: "assistant", content: fullText });
    ranToCompletion = true;
    break;
  }
}

console.log();
if (ranToCompletion) {
  console.log(bold(green("━━━ done ") + dim("─".repeat(W - 9))));
} else {
  console.log(bold(red(`━━━ hit ${maxTurns}-turn limit `) + dim("─".repeat(W - 20))));
}
console.log(`  ${dim("turns")}  ${messages.filter(m => m.role === "tool").length + 1}   ${dim("tool calls")}  ${messages.filter(m => m.role === "tool").length}`);
console.log();
