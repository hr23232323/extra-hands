import { describe, it, expect, vi } from "vitest";
import { parseStream } from "../frontend/search.js";

// Build a ReadableStreamDefaultReader from an array of SSE line strings
function mockReader(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + "\n"));
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined },
  };
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}`;
}

function textChunk(text) {
  return sseData({ choices: [{ delta: { content: text } }] });
}

function toolChunk({ index = 0, id, name, args }) {
  const tc = { index };
  if (id)   tc.id = id;
  if (name) tc.function = { name };
  else if (args !== undefined) tc.function = { arguments: args };
  return sseData({ choices: [{ delta: { tool_calls: [tc] } }] });
}

// ── Text-only stream ──────────────────────────────────────────────────────────

describe("parseStream — text only", () => {
  it("collects text deltas and returns null toolCall", async () => {
    const reader = mockReader([
      textChunk("Hello "),
      textChunk("world"),
      "data: [DONE]",
    ]);
    const deltas = [];
    const { toolCall } = await parseStream(reader, d => deltas.push(d));
    expect(deltas.join("")).toBe("Hello world");
    expect(toolCall).toBeNull();
  });
});

// ── Tool call stream ──────────────────────────────────────────────────────────

describe("parseStream — tool call", () => {
  it("assembles a tool call from streamed chunks", async () => {
    const reader = mockReader([
      toolChunk({ index: 0, id: "call_abc", name: "write_file" }),
      toolChunk({ index: 0, args: '{"path":"out' }),
      toolChunk({ index: 0, args: 'put.txt","content":"hi"}' }),
      "data: [DONE]",
    ]);
    const { toolCall } = await parseStream(reader, () => {});
    expect(toolCall.id).toBe("call_abc");
    expect(toolCall.name).toBe("write_file");
    expect(toolCall.args).toBe('{"path":"output.txt","content":"hi"}');
  });

  it("fires onToolName exactly once per tool call", async () => {
    const reader = mockReader([
      toolChunk({ index: 0, id: "call_1", name: "read_" }),
      toolChunk({ index: 0, name: "file" }),
      "data: [DONE]",
    ]);
    const names = [];
    await parseStream(reader, () => {}, n => names.push(n));
    // onToolName should fire only on first fragment, not subsequent
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("read_");
  });

  it("returns the first tool call when multiple are present", async () => {
    const reader = mockReader([
      toolChunk({ index: 0, id: "call_1", name: "write_file" }),
      toolChunk({ index: 0, args: '{"path":"a.txt","content":""}' }),
      toolChunk({ index: 1, id: "call_2", name: "read_file" }),
      toolChunk({ index: 1, args: '{"path":"b.txt"}' }),
      "data: [DONE]",
    ]);
    const { toolCall } = await parseStream(reader, () => {});
    expect(toolCall.name).toBe("write_file");
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("parseStream — error in stream", () => {
  it("throws when the stream contains an error payload", async () => {
    const reader = mockReader([
      sseData({ error: { message: "Rate limit exceeded" } }),
    ]);
    await expect(parseStream(reader, () => {})).rejects.toThrow("Rate limit exceeded");
  });
});
