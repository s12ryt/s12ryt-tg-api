import { describe, it, expect, vi, afterEach } from "vitest";
import { chatCompletion as anthropicChatCompletion } from "../src/api/providers/anthropic.js";
import { chatCompletion as googleChatCompletion } from "../src/api/providers/google.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

function mockJsonFetch(body: Record<string, unknown>): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

describe("provider adapters", () => {
  it("preserves Anthropic consecutive multimodal content blocks", async () => {
    mockJsonFetch({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-test",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await anthropicChatCompletion(
      {
        model: "claude-test",
        stream: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
          },
        ],
      },
      { baseUrl: "https://anthropic.test", apiKey: "key" },
    );

    const requestBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(requestBody.messages).toHaveLength(1);
    expect(Array.isArray(requestBody.messages[0].content)).toBe(true);
    expect(JSON.stringify(requestBody.messages[0].content)).not.toContain("[object Object]");
    expect(requestBody.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "hello" }),
        expect.objectContaining({ type: "image" }),
      ]),
    );
  });

  it("combines multiple Google system messages", async () => {
    mockJsonFetch({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });

    await googleChatCompletion(
      {
        model: "gemini-test",
        stream: false,
        messages: [
          { role: "system", content: "first instruction" },
          { role: "system", content: "second instruction" },
          { role: "user", content: "hello" },
        ],
      },
      { baseUrl: "https://gemini.test", apiKey: "key" },
    );

    const requestBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(requestBody.systemInstruction.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "first instruction" }),
        expect.objectContaining({ text: "second instruction" }),
      ]),
    );
  });

  it("maps Google streaming SAFETY finish reason to content_filter", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"candidates":[{"finishReason":"SAFETY","content":{"parts":[]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":0,"totalTokenCount":1}}\n\n',
          ));
          controller.close();
        },
      }),
      text: vi.fn().mockResolvedValue(""),
    }) as unknown as typeof fetch;

    const result = await googleChatCompletion(
      { model: "gemini-test", stream: true, messages: [{ role: "user", content: "hi" }] },
      { baseUrl: "https://gemini.test", apiKey: "key" },
    );

    let finishReason: string | undefined;
    for await (const chunk of result as AsyncGenerator<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        finishReason = JSON.parse(line.slice(6)).choices[0].finish_reason;
      }
    }

    expect(finishReason).toBe("content_filter");
  });
});
