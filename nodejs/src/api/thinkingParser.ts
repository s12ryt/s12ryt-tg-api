/**
 * Thinking effort / reasoning intensity parser and provider mapper.
 *
 * Supports two input methods:
 * 1. Model name suffix: "o3(high)", "claude-sonnet(medium)", "gemini-2.5-pro(low)"
 * 2. Request body parameter: reasoning_effort or thinking_effort
 *
 * Six unified levels: xhigh / high / medium / low / minimal / none
 *
 * Normalizes to a unified `thinking_effort` field on the body, then each provider
 * maps it to the upstream-specific format:
 * - OpenAI Chat      → reasoning_effort: "high"  (direct 1:1 for all 6 levels)
 * - OpenAI Responses → reasoning: { effort: "high" }
 * - Anthropic        → thinking: { type: "enabled", budget_tokens: N } or { type: "disabled" } for none
 * - Google Gemini    → generationConfig.thinkingConfig.thinkingBudget + thinkingLevel (Gemini 3.x)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThinkingLevel = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for model suffix: model_name(level) — allows optional whitespace */
const MODEL_SUFFIX_RE = /^(.+?)\s*\(\s*(xhigh|high|medium|low|minimal|none)\s*\)\s*$/i;

/** Regex to detect ANY (word) suffix — used to flag invalid thinking levels */
const ANY_SUFFIX_RE = /^(.+?)\s*\(\s*([a-zA-Z]+)\s*\)\s*$/;

/**
 * Anthropic thinking budget_tokens for each level.
 * Anthropic requires max_tokens > budget_tokens.
 * minimal uses 1024 (Anthropic minimum).
 * "none" is handled separately as { type: "disabled" }.
 */
export const ANTHROPIC_THINKING_BUDGET: Record<Exclude<ThinkingLevel, "none">, number> = {
  xhigh: 64000,
  high: 32048,
  medium: 16000,
  low: 5000,
  minimal: 1024,
};

/**
 * Google Gemini thinkingBudget for each level (Gemini 2.5 models).
 * 0 = disabled.
 */
export const GOOGLE_THINKING_BUDGET: Record<ThinkingLevel, number> = {
  xhigh: 32768,
  high: 24576,
  medium: 12288,
  low: 2048,
  minimal: 512,
  none: 0,
};

/**
 * Google Gemini thinkingLevel enum (Gemini 3.x models).
 * Mapped from our unified levels. 'none' has no thinkingLevel (uses budget=0).
 * 'xhigh' maps to "high" (Gemini max available).
 */
export const GOOGLE_THINKING_LEVEL: Partial<Record<ThinkingLevel, string>> = {
  xhigh: "high",
  high: "high",
  medium: "medium",
  low: "low",
  minimal: "minimal",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a model name that may contain a thinking-level suffix.
 *
 * Examples:
 *   "o3(high)"              → { model: "o3", thinkingLevel: "high" }
 *   "claude-sonnet(medium)" → { model: "claude-sonnet", thinkingLevel: "medium" }
 *   "gemini-2.5-pro( low )" → { model: "gemini-2.5-pro", thinkingLevel: "low" }
 *   "gpt-5.1(xhigh)"        → { model: "gpt-5.1", thinkingLevel: "xhigh" }
 *   "gpt-4o(none)"          → { model: "gpt-4o", thinkingLevel: "none" }
 *   "model(extreme)"        → { model: "model", invalidLevel: "extreme" }
 *   "gpt-4o"                → { model: "gpt-4o" }
 */
export function parseModelThinkingSuffix(model: string): {
  model: string;
  thinkingLevel?: ThinkingLevel;
  invalidLevel?: string;
} {
  const match = model.match(MODEL_SUFFIX_RE);
  if (match) {
    return {
      model: match[1].trim(),
      thinkingLevel: match[2].toLowerCase() as ThinkingLevel,
    };
  }
  // Detect any (word) suffix that looks like a thinking level attempt
  const anyMatch = model.match(ANY_SUFFIX_RE);
  if (anyMatch) {
    return {
      model: anyMatch[1].trim(),
      invalidLevel: anyMatch[2],
    };
  }
  return { model };
}

/**
 * Extract thinking level from a request body (without model suffix parsing).
 *
 * Priority:
 *   1. reasoning_effort (OpenAI standard field)
 *   2. thinking_effort  (custom unified field)
 *   3. thinking.budget_tokens (Anthropic format — reverse-map to level)
 *
 * Returns undefined if no thinking level is specified.
 */
export function extractThinkingLevel(
  body: Record<string, any>,
): ThinkingLevel | undefined {
  const VALID_LEVELS = new Set([
    "xhigh", "high", "medium", "low", "minimal", "none",
  ]);

  // 1. reasoning_effort (OpenAI standard)
  if (typeof body.reasoning_effort === "string") {
    const lvl = body.reasoning_effort.toLowerCase();
    if (VALID_LEVELS.has(lvl)) return lvl as ThinkingLevel;
  }

  // 2. Custom thinking_effort (our unified field)
  if (typeof body.thinking_effort === "string") {
    const lvl = body.thinking_effort.toLowerCase();
    if (VALID_LEVELS.has(lvl)) return lvl as ThinkingLevel;
  }

  // 3. Anthropic thinking format — reverse-map budget_tokens to level
  if (body.thinking && typeof body.thinking === "object") {
    if (body.thinking.type === "disabled") return "none";
    if (
      body.thinking.type === "enabled" &&
      typeof body.thinking.budget_tokens === "number"
    ) {
      const b = body.thinking.budget_tokens;
      if (b >= 48000) return "xhigh";
      if (b >= 24000) return "high";
      if (b >= 10000) return "medium";
      if (b >= 3000) return "low";
      return "minimal";
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Unified preprocessing — call at every endpoint entry point
// ---------------------------------------------------------------------------

/**
 * Process a request body at the server entry point:
 *
 * 1. Parse model suffix (e.g. "o3(high)" → model="o3" + thinking_effort="high")
 * 2. If no suffix, try to extract thinking level from body params
 * 3. Set body.model to the real model name (suffix stripped)
 * 4. Set body.thinking_effort to the resolved level (if any)
 *
 * Throws Error if the model suffix contains an invalid thinking level
 * (e.g. "model(extreme)" → throws "Invalid thinking level 'extreme'...").
 *
 * This MUST be called BEFORE lookupModelDb / dispatchWithFallback /
 * isModelAllowedForRequest, because those use body.model for DB lookup.
 *
 * Mutates `body` in-place.
 */
export function preprocessThinking(body: Record<string, any>): void {
  const rawModel = body.model;
  if (typeof rawModel !== "string" || !rawModel) return;

  // Step 1: Parse model suffix
  const { model: realModel, thinkingLevel: suffixLevel, invalidLevel } =
    parseModelThinkingSuffix(rawModel);

  if (suffixLevel || invalidLevel) {
    body.model = realModel;
  }

  // Throw on invalid level suffix
  if (invalidLevel) {
    throw new Error(
      `Invalid thinking level "${invalidLevel}". Supported levels: xhigh, high, medium, low, minimal, none`,
    );
  }

  // Step 2: Resolve thinking level — suffix takes priority over body params
  const level: ThinkingLevel | undefined =
    suffixLevel ?? extractThinkingLevel(body);

  if (level) {
    body.thinking_effort = level;
  }
}

// ---------------------------------------------------------------------------
// Provider-specific injection
// ---------------------------------------------------------------------------

/**
 * Inject thinking params into an Anthropic (Claude) request body.
 * Maps thinking_effort → thinking: { type: "enabled", budget_tokens: N }
 *                        or thinking: { type: "disabled" } for "none"
 * Ensures max_tokens > budget_tokens (Anthropic requirement).
 */
export function injectForAnthropic(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  if (level === "none") {
    body.thinking = { type: "disabled" };
    return;
  }

  const budgetTokens = ANTHROPIC_THINKING_BUDGET[level];
  body.thinking = { type: "enabled", budget_tokens: budgetTokens };

  // Anthropic requires max_tokens > budget_tokens
  const currentMax =
    typeof body.max_tokens === "number" ? body.max_tokens : 4096;
  if (currentMax <= budgetTokens) {
    body.max_tokens = budgetTokens + 8192;
  }
}

/**
 * Inject thinking params into an OpenAI Chat Completions request body.
 * Maps thinking_effort → reasoning_effort: "high"
 * OpenAI natively supports all 6 levels.
 */
export function injectForOpenAIChat(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  body.reasoning_effort = level;
}

/**
 * Inject thinking params into an OpenAI Responses API request body.
 * Maps thinking_effort → reasoning: { effort: "high" }
 * OpenAI natively supports all 6 levels.
 */
export function injectForOpenAIResponse(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  body.reasoning = { effort: level };
}

/**
 * Inject thinking params into a Google Gemini request body.
 * Maps thinking_effort → generationConfig.thinkingConfig.thinkingBudget (Gemini 2.5)
 *                      + generationConfig.thinkingConfig.thinkingLevel (Gemini 3.x)
 */
export function injectForGoogle(
  body: Record<string, any>,
  level: ThinkingLevel,
): void {
  if (!body.generationConfig) body.generationConfig = {};
  if (!body.generationConfig.thinkingConfig) {
    body.generationConfig.thinkingConfig = {};
  }

  // Set thinkingBudget (for Gemini 2.5 models)
  body.generationConfig.thinkingConfig.thinkingBudget =
    GOOGLE_THINKING_BUDGET[level];

  // Set thinkingLevel (for Gemini 3.x models) — skip for 'none'
  const thinkingLevel = GOOGLE_THINKING_LEVEL[level];
  if (thinkingLevel) {
    body.generationConfig.thinkingConfig.thinkingLevel = thinkingLevel;
  }
}
