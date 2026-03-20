// ── search.js — streaming + tool-call orchestration ───────────────────────────
// No DOM. No CDN imports. fetch is injectable for testing.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Parse one OpenRouter SSE stream.
 * Calls onDelta(text) for each content chunk.
 * Returns { toolCall: { id, name, args } | null }
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {(delta: string) => void} onDelta
 */
export async function parseStream(reader, onDelta, onToolName) {
  const decoder = new TextDecoder();
  let buffer = "";
  const pendingToolCalls = {}; // keyed by index

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;
      try {
        const data = JSON.parse(payload);
        if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));

        const delta = data.choices?.[0]?.delta;
        const tcDelta = delta?.tool_calls;
        if (tcDelta) {
          for (const tc of tcDelta) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls[idx]) pendingToolCalls[idx] = { id: "", name: "", args: "" };
            if (tc.id) pendingToolCalls[idx].id = tc.id;
            if (tc.function?.name) {
              // Fire onToolName once, as soon as we first see the name
              if (!pendingToolCalls[idx].name) onToolName?.(tc.function.name);
              pendingToolCalls[idx].name += tc.function.name;
            }
            if (tc.function?.arguments) pendingToolCalls[idx].args += tc.function.arguments;
          }
        }

        const content = delta?.content;
        if (content) onDelta(content);
      } catch (e) {
        if (e.message !== "undefined") throw e;
      }
    }
  }

  const firstToolCall = Object.values(pendingToolCalls).find(tc => tc.name) ?? null;
  return { toolCall: firstToolCall };
}

/**
 * Make one streaming call to OpenRouter and return the result.
 *
 * @param {object} opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {Array}    opts.messages
 * @param {string}   opts.systemPrompt
 * @param {Array}    [opts.tools]          tool definitions (OpenAI format)
 * @param {function} opts.onDelta          called with each streamed text chunk
 * @param {function} [opts._fetch]         injectable fetch for tests
 * @returns {{ fullText: string, toolCall: object | null }}
 */
export async function orchestrateMessage({
  apiKey,
  model,
  messages,
  systemPrompt,
  tools,
  onDelta,
  onToolName,
  _fetch = fetch,
}) {
  console.log("[extra-hands] orchestrateMessage — model:", model, "| tools:", tools?.length ?? 0);

  async function post(body) {
    const res = await _fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/hr23232323/extra-hands",
        "X-Title": "extra-hands",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res;
  }

  const res = await post({
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: true,
    ...(tools?.length && { tools, tool_choice: "auto" }),
  });

  let fullText = "";
  const { toolCall } = await parseStream(res.body.getReader(), (delta) => {
    fullText += delta;
    onDelta(delta);
  }, onToolName);

  console.log("[extra-hands] stream done — toolCall:", toolCall ? toolCall.name : "null");

  return { fullText, toolCall };
}
