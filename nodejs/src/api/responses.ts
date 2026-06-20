/**
 * OpenAI Responses API conversion utilities.
 *
 * Converts between Responses API format and Chat Completions format,
 * allowing us to reuse existing provider adapters.
 *
 * Responses API spec: https://platform.openai.com/docs/api-reference/responses
 */

import { v4 as uuidv4 } from "uuid";

/** Shared TextEncoder instance — avoids per-call allocation. */
const sharedEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Responses API input item */
export type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: string | ContentPart[] }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id?: string; content?: unknown[]; summary?: unknown[] }
  | { type: "item_reference"; id: string };

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url?: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string }
  | { type: "refusal"; refusal: string };

/** Chat Completions message */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

// ---------------------------------------------------------------------------
// Input conversion: Responses API → Chat Completions
// ---------------------------------------------------------------------------

/**
 * Convert Responses API input to Chat Completions messages array.
 */
export function convertResponsesInputToMessages(
  input: string | ResponsesInputItem[],
  instructions?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Add instructions as system message
  if (instructions && instructions.trim()) {
    messages.push({ role: "system", content: instructions.trim() });
  }

  // String input → single user message
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  // Array of items
  for (const item of input) {
    const itemAny = item as Record<string, any>;
    const itemType = itemAny.type ?? inferItemType(itemAny);

    if (itemType === "message" || (!itemType && "role" in itemAny && "content" in itemAny)) {
      const mappedRole = mapRole(itemAny.role);
      const content = convertContent(itemAny.content);
      messages.push({ role: mappedRole, content });
    } else if (itemType === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: itemAny.call_id,
            type: "function",
            function: { name: itemAny.name, arguments: itemAny.arguments },
          },
        ],
      });
    } else if (itemType === "function_call_output") {
      messages.push({
        role: "tool",
        content: itemAny.output,
        tool_call_id: itemAny.call_id,
      });
    }
    // Skip "reasoning" and "item_reference" items
  }

  return messages;
}

function mapRole(role: string): "system" | "user" | "assistant" | "tool" {
  if (role === "developer" || role === "system") return "system";
  if (role === "assistant") return "assistant";
  return "user";
}

/**
 * Infer the item type from its shape when `type` field is missing.
 * OpenAI SDK sometimes omits `type: "message"` for shorthand input items.
 */
function inferItemType(item: Record<string, any>): string | null {
  if ("role" in item && "content" in item) return "message";
  if ("call_id" in item && "name" in item && "arguments" in item) return "function_call";
  if ("call_id" in item && "output" in item) return "function_call_output";
  return null;
}

// ---------------------------------------------------------------------------
// Tools conversion: Responses API → Chat Completions
// ---------------------------------------------------------------------------

/**
 * Convert Responses API tools to Chat Completions tools format.
 *
 * Responses API format:
 *   { type: "function", name: "...", description: "...", parameters: {...} }
 *
 * Chat Completions format:
 *   { type: "function", function: { name: "...", description: "...", parameters: {...} } }
 */
export function convertResponsesToolsToChatTools(
  tools: Record<string, any>[]
): Record<string, any>[] {
  return tools.map((tool) => {
    // Already in Chat Completions format (has nested "function" key)
    if (tool.function) return tool;

    // Responses API format: flatten into Chat Completions format
    if (tool.type === "function") {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    }

    // Web search, file search, etc. — skip for now (not supported in Chat Completions)
    return null;
  }).filter((t): t is Record<string, any> => t !== null);
}

function convertContent(content: string | ContentPart[]): string | unknown[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && part.image_url) {
      parts.push({
        type: "image_url",
        image_url: { url: part.image_url, detail: part.detail ?? "auto" },
      });
    } else if (part.type === "refusal") {
      parts.push({ type: "text", text: part.refusal });
    }
  }

  return parts.length > 0 ? parts : "";
}

// ---------------------------------------------------------------------------
// Output conversion: Chat Completions → Responses API
// ---------------------------------------------------------------------------

/**
 * Generate a unique response ID.
 */
function genId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Convert a Chat Completions response to Responses API format.
 */
export function convertChatCompletionToResponses(
  chatResp: Record<string, any>,
  model: string,
  options?: {
    instructions?: string;
    previousResponseId?: string;
    temperature?: number;
    top_p?: number;
  }
): Record<string, any> {
  const now = Math.floor(Date.now() / 1000);
  const choice = (chatResp.choices ?? [])[0] ?? {};
  const message = choice.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const usage = chatResp.usage ?? {};
  const reasoningText = message.reasoning ?? message.reasoning_content ?? "";

  const output: Record<string, any>[] = [];

  // Reasoning output item
  if (reasoningText) {
    output.push({
      type: "reasoning",
      id: genId("rs"),
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }

  // Message output item
  output.push({
    type: "message",
    id: genId("msg"),
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [] as unknown[],
        logprobs: [] as unknown[],
      },
    ],
  });

  return {
    id: genId("resp"),
    object: "response",
    created_at: now,
    completed_at: now,
    status: "completed",
    incomplete_details: null,
    model,
    previous_response_id: options?.previousResponseId ?? null,
    instructions: options?.instructions ?? null,
    output,
    error: null,
    tools: [],
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    text: { format: { type: "text" } },
    temperature: options?.temperature ?? 1,
    top_p: options?.top_p ?? 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    reasoning: null,
    user: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: "default",
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

// ---------------------------------------------------------------------------
// Streaming: Chat Completions SSE → Responses API SSE
// ---------------------------------------------------------------------------

function sseLine(event: string, data: unknown): Uint8Array {
  return sharedEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Convert a Chat Completions SSE stream to Responses API SSE stream.
 *
 * Handles:
 * - delta.content → output_text delta
 * - delta.reasoning → reasoning delta (emitted but not mixed into text)
 * - delta.tool_calls → function_call output items
 */
export async function* streamResponsesApi(
  providerStream: AsyncGenerator<Uint8Array> | AsyncIterable<Uint8Array>,
  model: string,
  options?: {
    instructions?: string;
    previousResponseId?: string;
    temperature?: number;
    top_p?: number;
  }
): AsyncGenerator<Uint8Array> {
  let localSeq = 0;
  const now = Math.floor(Date.now() / 1000);
  const respId = genId("resp");
  const msgId = genId("msg");
  const itemId = msgId;

  // Build the base response object
  const baseResponse: Record<string, any> = {
    id: respId,
    object: "response",
    created_at: now,
    completed_at: null,
    status: "in_progress",
    incomplete_details: null,
    model,
    previous_response_id: options?.previousResponseId ?? null,
    instructions: options?.instructions ?? null,
    output: [],
    error: null,
    tools: [],
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    text: { format: { type: "text" } },
    temperature: options?.temperature ?? 1,
    top_p: options?.top_p ?? 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    reasoning: null,
    user: null,
    usage: null,
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: "default",
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  };

  // Emit: response.created
  yield sseLine("response.created", {
    type: "response.created",
    sequence_number: ++localSeq,
    response: { ...baseResponse },
  });

  // Emit: response.in_progress
  yield sseLine("response.in_progress", {
    type: "response.in_progress",
    sequence_number: ++localSeq,
    response: { ...baseResponse },
  });

  // Track output items
  const outputItems: Record<string, any>[] = [];
  let currentOutputIndex = -1;
  let messageItemEmitted = false;

  // Track reasoning
  let reasoningText = "";
  const reasoningItemId = genId("rs");
  let reasoningItemEmitted = false;
  let reasoningOutputIndex = -1;

  // Emit: output_item.added (message item) — emitted lazily on first content
  const messageItem = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "in_progress",
    content: [],
  };

  // Process the Chat Completions stream
  let accumulatedText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let textPartEmitted = false;
  const decoder = new TextDecoder();

  // Track tool calls being built
  const toolCallBuffers: Map<number, { id: string; name: string; arguments: string }> = new Map();

  // SSE buffer: accumulate partial lines across TCP chunk boundaries
  let sseBuffer = "";

  // Helper: build the final completed response object — shared by finish and fallback paths
  const buildCompletedResponse = (output: Record<string, any>[]): Record<string, any> => ({
    ...baseResponse,
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    output,
    usage: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });

  for await (const chunk of providerStream) {
    sseBuffer += decoder.decode(chunk, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? ""; // keep incomplete trailing line

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

      // --- Handle tool_calls in delta ---
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

      // --- Handle reasoning delta (some providers send reasoning_content instead of reasoning) ---
      const reasoningDelta: string = delta.reasoning ?? delta.reasoning_content;
      if (reasoningDelta != null && reasoningDelta !== "") {
        if (!reasoningItemEmitted) {
          reasoningItemEmitted = true;
          reasoningOutputIndex = outputItems.length;
          const reasoningItem = {
            type: "reasoning",
            id: reasoningItemId,
            status: "in_progress",
            summary: [{ type: "summary_text", text: "" }],
          };
          outputItems.push(reasoningItem);
          yield sseLine("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: ++localSeq,
            output_index: reasoningOutputIndex,
            item: reasoningItem,
          });
        }

        reasoningText += reasoningDelta;
        yield sseLine("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          sequence_number: ++localSeq,
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta: reasoningDelta,
        });
      }

      // --- Handle text content ---
      if (delta.content != null && delta.content !== "") {
        // Emit message item header if not yet emitted
        if (!messageItemEmitted) {
          messageItemEmitted = true;
          currentOutputIndex = outputItems.length;
          outputItems.push(messageItem);
          yield sseLine("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: ++localSeq,
            output_index: currentOutputIndex,
            item: messageItem,
          });
        }

        // Emit text part header if not yet emitted
        if (!textPartEmitted) {
          textPartEmitted = true;
          yield sseLine("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: ++localSeq,
            item_id: itemId,
            output_index: currentOutputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          });
        }

        accumulatedText += delta.content;
        yield sseLine("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: ++localSeq,
          item_id: itemId,
          output_index: currentOutputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      // --- Finish ---
      if (finishReason) {
        // Finalize reasoning item if it was emitted
        if (reasoningItemEmitted) {
          yield sseLine("response.reasoning_summary_text.done", {
            type: "response.reasoning_summary_text.done",
            sequence_number: ++localSeq,
            item_id: reasoningItemId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            text: reasoningText,
          });

          const completedReasoningItem = {
            type: "reasoning",
            id: reasoningItemId,
            status: "completed",
            summary: [{ type: "summary_text", text: reasoningText }],
          };
          outputItems[reasoningOutputIndex] = completedReasoningItem;

          yield sseLine("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: ++localSeq,
            output_index: reasoningOutputIndex,
            item: completedReasoningItem,
          });
        }

        // Finalize tool calls first
        for (const [tcIdx, tcBuf] of toolCallBuffers) {
          const fcId = genId("fc");
          const callId = tcBuf.id || `call_${tcIdx}`;
          const fcItem = {
            type: "function_call",
            id: fcId,
            call_id: callId,
            name: tcBuf.name,
            arguments: tcBuf.arguments,
            status: "completed",
          };

          // Emit function_call output_item.added + done
          const fcOutputIndex = outputItems.length;
          outputItems.push(fcItem);
          yield sseLine("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: ++localSeq,
            output_index: fcOutputIndex,
            item: fcItem,
          });
          yield sseLine("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: ++localSeq,
            output_index: fcOutputIndex,
            item: fcItem,
          });
        }

        // Finalize text message if content was emitted
        if (textPartEmitted) {
          yield sseLine("response.output_text.done", {
            type: "response.output_text.done",
            sequence_number: ++localSeq,
            item_id: itemId,
            output_index: currentOutputIndex,
            content_index: 0,
            text: accumulatedText,
          });

          yield sseLine("response.content_part.done", {
            type: "response.content_part.done",
            sequence_number: ++localSeq,
            item_id: itemId,
            output_index: currentOutputIndex,
            content_index: 0,
            part: { type: "output_text", text: accumulatedText, annotations: [], logprobs: [] },
          });
        }

        // Finalize message item if emitted
        if (messageItemEmitted) {
          yield sseLine("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: ++localSeq,
            output_index: currentOutputIndex,
            item: {
              type: "message",
              id: itemId,
              role: "assistant",
              status: "completed",
              content: textPartEmitted
                ? [{ type: "output_text", text: accumulatedText, annotations: [], logprobs: [] }]
                : [],
            },
          });
        }

        // Build completed response
        const completedResponse = buildCompletedResponse(
          outputItems.map((item) => {
            if (item.type === "message") {
              return {
                type: "message",
                id: itemId,
                role: "assistant",
                status: "completed",
                content: textPartEmitted
                  ? [{ type: "output_text", text: accumulatedText, annotations: [], logprobs: [] }]
                  : [],
              };
            }
            return item;
          })
        );

        yield sseLine("response.completed", {
          type: "response.completed",
          sequence_number: ++localSeq,
          response: completedResponse,
        });

        yield sharedEncoder.encode("data: [DONE]\n\n");
        return;
      }
    }
  }

  // Flush remaining decoder bytes
  sseBuffer += decoder.decode();
  // Process any remaining data in buffer (stream ended without trailing newline)
  if (sseBuffer.trim()) {
    const remainingLines = sseBuffer.split("\n");
    for (const line of remainingLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) {
          totalInputTokens = parsed.usage.prompt_tokens ?? totalInputTokens;
          totalOutputTokens = parsed.usage.completion_tokens ?? totalOutputTokens;
        }
      } catch { /* ignore */ }
    }
  }

  // If we reach here without a finish_reason, still emit completed

  // Build completed response from whatever we collected
  const finalOutput: Record<string, any>[] = [];

  // Reasoning item
  if (reasoningItemEmitted || reasoningText) {
    finalOutput.push({
      type: "reasoning",
      id: reasoningItemId,
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }

  if (messageItemEmitted || accumulatedText) {
    finalOutput.push({
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: accumulatedText, annotations: [], logprobs: [] }],
    });
  }
  for (const [tcIdx, tcBuf] of toolCallBuffers) {
    finalOutput.push({
      type: "function_call",
      id: genId("fc"),
      call_id: tcBuf.id || `call_${tcIdx}`,
      name: tcBuf.name,
      arguments: tcBuf.arguments,
      status: "completed",
    });
  }

  const completedResponse = buildCompletedResponse(finalOutput);

  yield sseLine("response.completed", {
    type: "response.completed",
    sequence_number: ++localSeq,
    response: completedResponse,
  });

  yield sharedEncoder.encode("data: [DONE]\n\n");
}

// ---------------------------------------------------------------------------
// Input conversion: Chat Completions → Responses API (reverse)
// ---------------------------------------------------------------------------

/**
 * Convert Chat Completions messages to Responses API input items.
 * System messages are extracted as *instructions* rather than input items.
 *
 * @returns `{ inputItems, instructions }`
 */
export function convertMessagesToResponsesInput(
  messages: ChatMessage[]
): { inputItems: Record<string, any>[]; instructions: string | null } {
  let instructions: string | null = null;
  const inputItems: Record<string, any>[] = [];

  for (const msg of messages) {
    const role = msg.role ?? "user";
    const content = msg.content;

    if (role === "system") {
      instructions = typeof content === "string" ? content : String(content);
      continue;
    }

    if (role === "tool") {
      inputItems.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: typeof content === "string" ? content : String(content),
      });
      continue;
    }

    if (role === "assistant") {
      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          inputItems.push({
            type: "function_call",
            call_id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        }
        continue;
      }

      // Regular assistant message
      inputItems.push({
        type: "message",
        role: "assistant",
        content: convertChatContentToResponses(content),
      });
      continue;
    }

    // User message
    inputItems.push({
      type: "message",
      role: "user",
      content: convertChatContentToResponses(content),
    });
  }

  return { inputItems, instructions };
}

function convertChatContentToResponses(content: string | unknown[]): string | unknown[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: unknown[] = [];
  for (const part of content as Record<string, any>[]) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text ?? "" });
    } else if (part.type === "image_url") {
      const urlData = part.image_url ?? {};
      parts.push({
        type: "input_image",
        image_url: urlData.url ?? "",
        detail: urlData.detail ?? "auto",
      });
    }
  }
  return parts.length > 0 ? parts : "";
}

// ---------------------------------------------------------------------------
// Tools conversion: Chat Completions → Responses API (reverse)
// ---------------------------------------------------------------------------

/**
 * Convert Chat Completions tools to Responses API tools format.
 *
 * Chat Completions: { type: "function", function: { name, description, parameters } }
 * Responses API:    { type: "function", name, description, parameters }
 */
export function convertChatToolsToResponsesTools(
  tools: Record<string, any>[]
): Record<string, any>[] {
  return tools.map((tool) => {
    // Already in Responses API format (no nested "function" key)
    if (!("function" in tool) && tool.type === "function") return tool;

    // Chat Completions format
    if ("function" in tool) {
      const fn = tool.function;
      return {
        type: "function",
        name: fn.name ?? "",
        description: fn.description ?? "",
        parameters: fn.parameters ?? {},
      };
    }

    return null;
  }).filter((t): t is Record<string, any> => t !== null);
}

// ---------------------------------------------------------------------------
// Output conversion: Responses API → Chat Completions (reverse)
// ---------------------------------------------------------------------------

/**
 * Convert a Responses API result to Chat Completions format.
 */
export function convertResponsesToChatCompletion(
  responsesResult: Record<string, any>,
  model: string
): Record<string, any> {
  const output = responsesResult.output ?? [];
  let text = "";
  let reasoningContent = "";
  const toolCalls: Record<string, any>[] = [];

  for (const item of output) {
    const itemType = item.type ?? "";

    if (itemType === "message") {
      const contentParts = item.content ?? [];
      for (const part of contentParts) {
        if (part.type === "output_text") {
          text += part.text ?? "";
        }
      }
    } else if (itemType === "reasoning") {
      const summaries = item.summary ?? [];
      for (const s of summaries) {
        if (s.type === "summary_text") {
          reasoningContent += s.text ?? "";
        }
      }
    } else if (itemType === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "",
        },
      });
    }
  }

  const usage = responsesResult.usage ?? {};

  const message: Record<string, any> = { role: "assistant", content: text };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: responsesResult.id ?? "",
    object: "chat.completion",
    created: responsesResult.created_at ?? 0,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: Responses API SSE → Chat Completions SSE (reverse)
// ---------------------------------------------------------------------------

/**
 * Convert a Responses API SSE stream to Chat Completions SSE stream.
 *
 * Parses `event:` / `data:` pairs from the upstream Responses API stream
 * and converts them to standard Chat Completions SSE chunks.
 */
export async function* streamChatFromResponses(
  providerStream: AsyncGenerator<Uint8Array> | AsyncIterable<Uint8Array>,
  model: string
): AsyncGenerator<Uint8Array> {
  const chatId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const decoder = new TextDecoder();

  function chatChunk(
    delta: Record<string, any>,
    finishReason?: string | null,
    usage?: Record<string, any> | null
  ): Uint8Array {
    const chunk: Record<string, any> = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    return sharedEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  let buffer = "";

  for await (const rawChunk of providerStream) {
    const text = decoder.decode(rawChunk, { stream: true });
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete trailing line

    let currentEvent = "";
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped.startsWith("event: ")) {
        currentEvent = stripped.slice(7);
        continue;
      }
      if (!stripped.startsWith("data: ")) {
        currentEvent = "";
        continue;
      }

      const data = stripped.slice(6);
      if (data === "[DONE]") {
        yield sharedEncoder.encode("data: [DONE]\n\n");
        return;
      }

      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(data);
      } catch {
        currentEvent = "";
        continue;
      }

      if (currentEvent === "response.output_text.delta") {
        yield chatChunk({ content: parsed.delta ?? "" });
      } else if (currentEvent === "response.reasoning_summary_text.delta") {
        yield chatChunk({ reasoning_content: parsed.delta ?? "" });
      } else if (currentEvent === "response.function_call_arguments.delta") {
        yield chatChunk({
          tool_calls: [
            {
              index: parsed.output_index ?? 0,
              id: parsed.call_id ?? "",
              type: "function",
              function: { name: "", arguments: parsed.delta ?? "" },
            },
          ],
        });
      } else if (currentEvent === "response.completed") {
        const resp = parsed.response ?? {};
        const usageData = resp.usage ?? {};
        const respOutput = resp.output ?? [];
        const hasToolCalls = respOutput.some(
          (i: Record<string, any>) => i.type === "function_call"
        );
        yield chatChunk(
          {},
          hasToolCalls ? "tool_calls" : "stop",
          {
            prompt_tokens: usageData.input_tokens ?? 0,
            completion_tokens: usageData.output_tokens ?? 0,
            total_tokens: usageData.total_tokens ?? 0,
          }
        );
      }

      currentEvent = "";
    }
  }

  // Safety: emit DONE if stream ended without one
  yield sharedEncoder.encode("data: [DONE]\n\n");
}
