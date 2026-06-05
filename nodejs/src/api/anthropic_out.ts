/**
 * Anthropic Messages API conversion utilities (inbound).
 *
 * Converts between Anthropic Messages API format and OpenAI Chat Completions format,
 * so that clients using the Anthropic SDK can call our API server.
 *
 * Anthropic Messages API spec: https://docs.anthropic.com/en/api/messages
 */

import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}

function sseLine(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Input conversion: Anthropic Messages API → OpenAI Chat Completions
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic Messages API request body into an OpenAI Chat Completions
 * compatible shape (messages array + top-level parameters).
 */
export function convertAnthropicInputToMessages(
  body: Record<string, any>
): {
  messages: Array<{
    role: string;
    content: string | any[];
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }>;
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
} {
  const messages: Array<{
    role: string;
    content: string | any[];
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> = [];

  // --- system prompt ---
  if (body.system != null) {
    const sysContent = extractSystemText(body.system);
    if (sysContent) {
      messages.push({ role: "system", content: sysContent });
    }
  }

  // --- messages ---
  const rawMessages: Array<{ role: string; content: any }> = body.messages ?? [];
  for (const msg of rawMessages) {
    const role = msg.role ?? "user";
    const content = msg.content;

    // String content – keep as-is
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    // Array content – convert each block
    if (Array.isArray(content)) {
      const converted = convertAnthropicContentBlocks(content, role);
      // convertAnthropicContentBlocks may return multiple messages (e.g. tool_result → tool msg)
      for (const m of converted) {
        messages.push(m);
      }
      continue;
    }

    // Fallback
    messages.push({ role, content: String(content ?? "") });
  }

  // --- tools ---
  let openaiTools: any[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openaiTools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? t.parameters ?? {},
      },
    }));
  }

  // --- tool_choice ---
  let openaiToolChoice: any;
  if (body.tool_choice != null) {
    openaiToolChoice = convertToolChoice(body.tool_choice);
  }

  return {
    messages,
    model: body.model ?? "claude-3-sonnet",
    ...(body.max_tokens != null && { max_tokens: body.max_tokens }),
    ...(body.temperature != null && { temperature: body.temperature }),
    ...(body.top_p != null && { top_p: body.top_p }),
    ...(body.stop_sequences != null && { stop: body.stop_sequences }),
    ...(body.stream != null && { stream: body.stream }),
    ...(openaiTools && { tools: openaiTools }),
    ...(openaiToolChoice && { tool_choice: openaiToolChoice }),
  };
}

/**
 * Extract plain text from the Anthropic `system` field which can be either
 * a string or an array of content blocks.
 */
function extractSystemText(system: any): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Convert an array of Anthropic content blocks to one or more OpenAI messages.
 *
 * Most blocks produce content parts for the *same* message, but:
 * - `tool_result` → separate tool message
 * - `tool_use`    → assistant message with tool_calls
 */
function convertAnthropicContentBlocks(
  blocks: any[],
  defaultRole: string
): Array<{
  role: string;
  content: string | any[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}> {
  const results: Array<{
    role: string;
    content: string | any[];
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> = [];

  const contentParts: any[] = [];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  for (const block of blocks) {
    const btype = block.type ?? "text";

    if (btype === "text") {
      contentParts.push({ type: "text", text: block.text ?? "" });
    } else if (btype === "image") {
      const src = block.source ?? {};
      if (src.type === "base64") {
        const dataUrl = `data:${src.media_type ?? "image/png"};base64,${src.data ?? ""}`;
        contentParts.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }
    } else if (btype === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    } else if (btype === "tool_result") {
      // tool_result becomes a separate tool message
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text ?? "")
                .join("")
            : String(block.content ?? "");
      results.push({
        role: "tool",
        content: resultContent,
        tool_call_id: block.tool_use_id ?? "",
      });
    }
  }

  // Build the primary message for this role
  if (toolCalls.length > 0) {
    results.push({
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : "",
      tool_calls: toolCalls,
    });
  } else if (contentParts.length > 0) {
    // Flatten single text part to plain string (cleaner for OpenAI)
    if (contentParts.length === 1 && contentParts[0].type === "text") {
      results.push({ role: defaultRole, content: contentParts[0].text });
    } else {
      results.push({ role: defaultRole, content: contentParts });
    }
  }

  return results;
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice.
 *
 * Anthropic:
 *   { type: "auto" } | { type: "any" } | { type: "tool", name: "..." } | "auto" | "any"
 * OpenAI:
 *   "auto" | "required" | "none" | { type: "function", function: { name: "..." } }
 */
function convertToolChoice(tc: any): any {
  if (typeof tc === "string") {
    if (tc === "any") return "required";
    return tc; // "auto" | "none"
  }
  const tctype = tc.type ?? "auto";
  if (tctype === "auto") return "auto";
  if (tctype === "any") return "required";
  if (tctype === "tool") {
    return { type: "function", function: { name: tc.name } };
  }
  // tool_choice with disable parallel
  if (tctype === "none") return "none";
  return "auto";
}

// ---------------------------------------------------------------------------
// Output conversion: OpenAI Chat Completions → Anthropic Messages API
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI Chat Completions response to an Anthropic Messages API response.
 */
export function convertChatCompletionToAnthropic(
  chatResp: Record<string, any>,
  model: string,
  _options?: Record<string, any>
): Record<string, any> {
  const choice = (chatResp.choices ?? [])[0] ?? {};
  const message = choice.message ?? {};
  const usage = chatResp.usage ?? {};

  const content: Array<Record<string, any>> = [];

  // Thinking/reasoning content (some providers return it in non-streaming)
  const reasoningText = message.reasoning ?? message.reasoning_content ?? "";
  if (reasoningText) {
    content.push({ type: "thinking", thinking: reasoningText });
  }

  // Text content
  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    content.push({ type: "text", text });
  }

  // Tool calls → tool_use content blocks
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let inputObj: any = {};
      try {
        inputObj = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        inputObj = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        input: inputObj,
      });
    }
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // Map finish_reason → stop_reason
  const stopReason = mapFinishReason(choice.finish_reason);

  return {
    id: genId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason.
 */
function mapFinishReason(reason: string | null | undefined): string {
  if (!reason) return "end_turn";
  const mapping: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  };
  return mapping[reason] ?? "end_turn";
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE Chat Completions → Anthropic SSE Messages
// ---------------------------------------------------------------------------

/**
 * Async generator that reads OpenAI Chat Completions SSE chunks from
 * `providerStream` and yields Anthropic Messages API SSE events.
 */
export async function* streamAnthropicApi(
  providerStream: AsyncGenerator<Uint8Array> | AsyncIterable<Uint8Array>,
  model: string,
  _options?: Record<string, any>
): AsyncGenerator<Uint8Array> {
  const msgId = genId("msg");

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const decoder = new TextDecoder();

  // Track tool calls being accumulated from deltas
  const toolCallBuffers: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();

  // Content block indices
  let currentBlockIndex = -1;
  let textBlockStarted = false;
  let thinkingBlockStarted = false;
  let thinkingText = "";
  let anyContentEmitted = false;

  // We'll emit message_start right away (but defer until first content or finish)
  let messageStarted = false;
  let pingEmitted = false;

  function ensureMessageStarted(): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (!messageStarted) {
      messageStarted = true;
      out.push(
        sseLine("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      );
    }
    return out;
  }

  // Process the OpenAI SSE stream
  for await (const chunk of providerStream) {
    const text = decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") continue;

      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      // Extract usage if present
      const chunkUsage = parsed.usage;
      if (chunkUsage) {
        totalInputTokens = chunkUsage.prompt_tokens ?? totalInputTokens;
        totalOutputTokens = chunkUsage.completion_tokens ?? totalOutputTokens;
      }

      const choices = parsed.choices ?? [];
      if (choices.length === 0) continue;
      const delta = choices[0].delta ?? {};
      const finishReason = choices[0].finish_reason;

      // --- Accumulate tool_call deltas ---
      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;
          if (!toolCallBuffers.has(tcIndex)) {
            toolCallBuffers.set(tcIndex, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          } else {
            const buf = toolCallBuffers.get(tcIndex)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          }
        }
      }

      // --- Reasoning/thinking delta ---
      if (delta.reasoning != null && delta.reasoning !== "") {
        // Ensure message_start has been emitted
        for (const b of ensureMessageStarted()) yield b;

        if (!thinkingBlockStarted) {
          thinkingBlockStarted = true;
          currentBlockIndex++;
          anyContentEmitted = true;

          yield sseLine("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          });

          // Emit ping once, after first content_block_start
          if (!pingEmitted) {
            pingEmitted = true;
            yield sseLine("ping", { type: "ping" });
          }
        }

        thinkingText += delta.reasoning;
        yield sseLine("content_block_delta", {
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning },
        });
      }

      // --- Text content delta ---
      if (delta.content != null && delta.content !== "") {
        // Ensure message_start has been emitted
        for (const b of ensureMessageStarted()) yield b;

        // Start text content block if not yet
        if (!textBlockStarted) {
          textBlockStarted = true;
          currentBlockIndex++;
          anyContentEmitted = true;

          yield sseLine("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "text", text: "" },
          });

          // Emit ping once, after first content_block_start
          if (!pingEmitted) {
            pingEmitted = true;
            yield sseLine("ping", { type: "ping" });
          }
        }

        yield sseLine("content_block_delta", {
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // --- Finish ---
      if (finishReason) {
        // Ensure message started
        for (const b of ensureMessageStarted()) yield b;

        // Close thinking block if open
        if (thinkingBlockStarted) {
          yield sseLine("content_block_stop", {
            type: "content_block_stop",
            index: currentBlockIndex,
          });
        }

        // Close text block if open
        if (textBlockStarted) {
          yield sseLine("content_block_stop", {
            type: "content_block_stop",
            index: currentBlockIndex,
          });
        }

        // Emit tool_use content blocks
        for (const [, tcBuf] of toolCallBuffers) {
          const toolBlockIndex = ++currentBlockIndex;

          let inputObj: any = {};
          try {
            inputObj = JSON.parse(tcBuf.arguments);
          } catch {
            inputObj = {};
          }

          yield sseLine("content_block_start", {
            type: "content_block_start",
            index: toolBlockIndex,
            content_block: {
              type: "tool_use",
              id: tcBuf.id,
              name: tcBuf.name,
              input: {},
            },
          });

          // Emit the full input as a single delta
          yield sseLine("content_block_delta", {
            type: "content_block_delta",
            index: toolBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(inputObj),
            },
          });

          yield sseLine("content_block_stop", {
            type: "content_block_stop",
            index: toolBlockIndex,
          });
        }

        const stopReason = mapFinishReason(finishReason);

        // message_delta with stop_reason and usage
        yield sseLine("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
          },
          usage: {
            output_tokens: totalOutputTokens,
          },
        });

        // message_stop
        yield sseLine("message_stop", {
          type: "message_stop",
        });

        return;
      }
    }
  }

  // If we reach here without a finish_reason, still close gracefully
  for (const b of ensureMessageStarted()) yield b;

  if (thinkingBlockStarted) {
    yield sseLine("content_block_stop", {
      type: "content_block_stop",
      index: currentBlockIndex,
    });
  }

  if (textBlockStarted) {
    yield sseLine("content_block_stop", {
      type: "content_block_stop",
      index: currentBlockIndex,
    });
  }

  yield sseLine("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: totalOutputTokens },
  });

  yield sseLine("message_stop", { type: "message_stop" });
}
