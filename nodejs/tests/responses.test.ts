import { describe, expect, it } from "vitest";
import {
  convertResponsesToChatCompletion,
  streamChatFromResponses,
} from "../src/api/responses.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function* responseEvents(chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield encoder.encode(chunk);
  }
}

async function collectChatChunks(chunks: string[]): Promise<Record<string, any>[]> {
  const parsedChunks: Record<string, any>[] = [];
  for await (const chunk of streamChatFromResponses(responseEvents(chunks), "gpt-test")) {
    const text = decoder.decode(chunk);
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      parsedChunks.push(JSON.parse(line.slice(6)));
    }
  }
  return parsedChunks;
}

function reasoningDeltas(chunks: Record<string, any>[]): string[] {
  return chunks
    .map((chunk) => chunk.choices[0].delta.reasoning_content)
    .filter((value): value is string => typeof value === "string");
}

describe("Responses API conversion", () => {
  it("preserves summary_text reasoning in non-streaming conversion", () => {
    const result = convertResponsesToChatCompletion(
      {
        id: "resp_1",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary reasoning" }],
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "final answer" }],
          },
        ],
      },
      "gpt-test",
    );

    expect(result.choices[0].message.content).toBe("final answer");
    expect(result.choices[0].message.reasoning_content).toBe("summary reasoning");
  });

  it("extracts reasoning_text content and item text in non-streaming conversion", () => {
    const result = convertResponsesToChatCompletion(
      {
        id: "resp_2",
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "content reasoning " }],
            text: "item reasoning",
          },
          {
            type: "message",
            content: [{ type: "text", text: "answer" }],
          },
        ],
      },
      "gpt-test",
    );

    expect(result.choices[0].message.content).toBe("answer");
    expect(result.choices[0].message.reasoning_content).toBe(
      "content reasoning item reasoning",
    );
  });

  it("maps reasoning_text deltas to chat reasoning_content chunks", async () => {
    const chunks = await collectChatChunks([
      'event: response.reasoning_text.delta\n',
      'data: {"delta":"step 1"}\n\n',
      'event: response.completed\ndata: {"response":{"output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ]);

    expect(reasoningDeltas(chunks)).toEqual(["step 1"]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  });

  it("backfills final reasoning from completed output when no reasoning delta streamed", async () => {
    const chunks = await collectChatChunks([
      'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"final reasoning"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ]);

    expect(reasoningDeltas(chunks)).toEqual(["final reasoning"]);
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
  });

  it("does not duplicate completed reasoning already streamed", async () => {
    const chunks = await collectChatChunks([
      'event: response.reasoning_summary_text.delta\ndata: {"delta":"full reasoning"}\n\n',
      'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"full reasoning"}]}],"usage":{}}}\n\n',
    ]);

    expect(reasoningDeltas(chunks)).toEqual(["full reasoning"]);
  });
});
