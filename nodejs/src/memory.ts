/**
 * Shared Node.js memory limit parsing.
 *
 * The .env key is intentionally lowercase (`memory`) for user-facing config.
 * MAX_OLD_SPACE is kept as a backwards-compatible fallback.
 */
export function parseMemoryLimitMB(value: string | undefined | null): number | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!/^\d+(?:\.\d)?$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 64) return null;

  return Math.floor(parsed);
}

export function getConfiguredMemoryMB(env: NodeJS.ProcessEnv = process.env): number | null {
  return parseMemoryLimitMB(env.memory) ?? parseMemoryLimitMB(env.MAX_OLD_SPACE);
}
