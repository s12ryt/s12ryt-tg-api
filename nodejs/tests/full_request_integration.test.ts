/**
 * Integration test using a real-world full request (完整請求.md).
 *
 * This file is at the repo root and gitignored, so the test auto-skips
 * when the file is absent (e.g. in CI or on other machines).
 *
 * Run: npm test -- full_request_integration
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  extractInputTextFromBody,
  estimateTokens,
  countTokensAccurate,
} from "../src/api/usageTracker.js";

const FULL_REQUEST_PATH = join(__dirname, "../../完整請求.md");
const fullRequestExists = existsSync(FULL_REQUEST_PATH);

describe.skipIf(!fullRequestExists)(
  "Full request integration (完整請求.md)",
  () => {
    // Vitest's describe.skipIf still runs the factory function (to collect
    // test definitions) even when the suite is skipped. Guard the file
    // read so it doesn't throw ENOENT on CI / machines without the file.
    let body: any = {};
    if (fullRequestExists) {
      body = JSON.parse(readFileSync(FULL_REQUEST_PATH, "utf-8"));
    }

    it("request structure sanity check", () => {
      expect(body.model).toBe("agnes-2.0-flash");
      expect(Array.isArray(body.input)).toBe(true);
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools.length).toBeGreaterThan(50);
    });

    it("extractInputTextFromBody captures system prompt", () => {
      const text = extractInputTextFromBody(body);
      expect(text).toContain("OREO");
      expect(text).toContain("歐雷歐");
    });

    it("extractInputTextFromBody captures user input_text", () => {
      const text = extractInputTextFromBody(body);
      expect(text).toContain("api提供商沒有正確返回token用量");
    });

    it("extractInputTextFromBody captures ALL tool definitions", () => {
      const text = extractInputTextFromBody(body);
      // spot-check a handful of tool names
      expect(text).toContain("artifact_search");
      expect(text).toContain("ast_grep_replace");
      expect(text).toContain("context7_resolve-library-id");
      expect(text).toContain("github-mcp_search_code");
      expect(text).toContain("webfetch");
    });

    it("tools contribute the MAJORITY of input tokens (agentic workload)", () => {
      const fullText = extractInputTextFromBody(body);

      // Build a body WITHOUT tools to measure the delta
      const bodyWithoutTools = { ...body, tools: undefined };
      const textWithoutTools = extractInputTextFromBody(bodyWithoutTools);

      const tokensWithTools = estimateTokens(fullText);
      const tokensWithoutTools = estimateTokens(textWithoutTools);
      const toolTokens = tokensWithTools - tokensWithoutTools;

      // eslint-disable-next-line no-console
      console.log("═══════════════════════════════════════════");
      // eslint-disable-next-line no-console
      console.log("  Real request token estimation (heuristic)");
      // eslint-disable-next-line no-console
      console.log("═══════════════════════════════════════════");
      // eslint-disable-next-line no-console
      console.log(`  Total input tokens (with tools):    ${tokensWithTools}`);
      // eslint-disable-next-line no-console
      console.log(`  Input tokens without tools:         ${tokensWithoutTools}`);
      // eslint-disable-next-line no-console
      console.log(`  Tools-only tokens:                  ${toolTokens}`);
      // eslint-disable-next-line no-console
      console.log(`  Tools % of total:                   ${((toolTokens / tokensWithTools) * 100).toFixed(1)}%`);
      // eslint-disable-next-line no-console
      console.log(`  Number of tools:                    ${body.tools.length}`);
      // eslint-disable-next-line no-console
      console.log("═══════════════════════════════════════════");

      // Tools should be the majority of tokens in this agentic request
      expect(toolTokens).toBeGreaterThan(tokensWithoutTools);
      expect(toolTokens).toBeGreaterThan(5000);
    });

    it("countTokensAccurate (BPE) gives a more precise estimate", async () => {
      const fullText = extractInputTextFromBody(body);

      // OpenAI provider type → uses local gpt-tokenizer (o200k_base)
      // Signature: (providerType, text, config?, modelName?)
      const tokens = await countTokensAccurate(
        "openai_response",
        fullText,
        { apiKey: "dummy-not-used-for-openai" },
        "agnes-2.0-flash",
      );

      const heuristic = estimateTokens(fullText);

      // eslint-disable-next-line no-console
      console.log("───────────────────────────────────────────");
      // eslint-disable-next-line no-console
      console.log("  BPE tokenizer vs heuristic comparison");
      // eslint-disable-next-line no-console
      console.log("───────────────────────────────────────────");
      // eslint-disable-next-line no-console
      console.log(`  BPE (o200k_base):  ${tokens}`);
      // eslint-disable-next-line no-console
      console.log(`  Heuristic:         ${heuristic}`);
      // eslint-disable-next-line no-console
      console.log(`  Ratio (BPE/Heur):  ${(tokens / heuristic).toFixed(2)}`);
      // eslint-disable-next-line no-console
      console.log("───────────────────────────────────────────");

      expect(tokens).toBeGreaterThan(5000);
    });

    it("WITHOUT the fix: tools would be completely invisible", () => {
      // Simulate the OLD behavior: only messages/input/instructions, no tools
      const oldBody = { ...body, tools: undefined, functions: undefined };
      const oldText = extractInputTextFromBody(oldBody);
      const oldTokens = estimateTokens(oldText);

      const newText = extractInputTextFromBody(body);
      const newTokens = estimateTokens(newText);

      const missedTokens = newTokens - oldTokens;

      // eslint-disable-next-line no-console
      console.log("┌───────────────────────────────────────────┐");
      // eslint-disable-next-line no-console
      console.log("│  Token leak before this fix series        │");
      // eslint-disable-next-line no-console
      console.log("├───────────────────────────────────────────┤");
      // eslint-disable-next-line no-console
      console.log(`│  Old estimate:  ${String(oldTokens).padStart(8)} tokens      │`);
      // eslint-disable-next-line no-console
      console.log(`│  New estimate:  ${String(newTokens).padStart(8)} tokens      │`);
      // eslint-disable-next-line no-console
      console.log(`│  Was MISSING:   ${String(missedTokens).padStart(8)} tokens      │`);
      // eslint-disable-next-line no-console
      console.log(`│  Underreport:   ${(((missedTokens) / newTokens) * 100).toFixed(1)}%`.padEnd(44) + "│");
      // eslint-disable-next-line no-console
      console.log("└───────────────────────────────────────────┘");

      expect(missedTokens).toBeGreaterThan(5000);
    });
  }
);
