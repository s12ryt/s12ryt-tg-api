/**
 * Multi API-Key Selector with Failover Tracking
 *
 * Storage format in DB: providers.api_key stores JSON array string
 *   e.g. '["sk-xxx1","sk-xxx2","sk-xxx3"]'
 *   Legacy single key: "sk-xxx1" (auto-migrated on startup)
 *
 * Selection strategy (stored in providers.key_strategy):
 *   - "failover"    (default): Always use the first available key;
 *                   switch to next only when current key is suspended
 *                   after 3 consecutive failures.
 *   - "round_robin": Rotate through available keys on each request
 *                   (key1 → key2 → key3 → key1 ...).
 *   - "random":     Pick a completely random available key each request.
 *
 * All strategies share the same failover safety net:
 *   - Track consecutive failures per (provider_id, key_index)
 *   - After 3 consecutive failures → suspend for 60 seconds
 *   - Suspended keys are skipped until they auto-recover
 *   - On success → reset fail count
 */

// ── Configuration ──────────────────────────────────────────────
const MAX_CONSECUTIVE_FAILURES = 3;
const SUSPEND_DURATION_MS = 60_000; // 60 seconds

// ── In-memory state ────────────────────────────────────────────
// { providerId: { keyIndex: { failCount, suspendedUntil } } }
const _state: Map<number, Map<number, { failCount: number; suspendedUntil: number }>> = new Map();

// Round-robin cursor: { providerId: lastUsedOriginalIndex }
const _roundRobinIndex: Map<number, number> = new Map();

// ── Public API ─────────────────────────────────────────────────

export function parseApiKeys(apiKeyJson: string): string[] {
  /** Parse api_key field into list of keys.
   *  Accepts JSON array string or legacy single string.
   */
  if (!apiKeyJson) return [];
  try {
    const parsed = JSON.parse(apiKeyJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((k): k is string => typeof k === 'string' && Boolean(k.trim())).map(k => k.trim());
    }
  } catch { /* not JSON */ }
  // Legacy single key
  const key = apiKeyJson.trim();
  return key ? [key] : [];
}

export function selectKey(
  providerId: number,
  apiKeyJson: string,
  strategy: string = "failover",
): { key: string | null; keyIndex: number | null } {
  /** Select an API key for a provider according to the configured strategy.
   *  All strategies skip suspended keys and share the failover safety net. */
  const keys = parseApiKeys(apiKeyJson);
  if (!keys.length) return { key: null, keyIndex: null };

  const now = Date.now();
  let providerState = _state.get(providerId);
  let providerDirty = false;

  /** Check if a key index is available, auto-recovering expired suspensions. */
  const isAvailable = (idx: number): boolean => {
    if (!providerState) return true;
    const entry = providerState.get(idx);
    const suspendedUntil = entry?.suspendedUntil ?? 0;
    if (suspendedUntil > 0 && now >= suspendedUntil) {
      providerState.set(idx, { failCount: 0, suspendedUntil: 0 });
      providerDirty = true;
      return true;
    }
    return suspendedUntil <= 0;
  };

  // Collect indices of available (non-suspended) keys
  const availableIndices: number[] = [];
  for (let idx = 0; idx < keys.length; idx++) {
    if (isAvailable(idx)) availableIndices.push(idx);
  }

  let chosenIdx: number;

  if (availableIndices.length > 0) {
    if (strategy === "random") {
      const pick = Math.floor(Math.random() * availableIndices.length);
      chosenIdx = availableIndices[pick];
    } else if (strategy === "round_robin") {
      const lastIdx = _roundRobinIndex.get(providerId) ?? -1;
      const next = availableIndices.find((i) => i > lastIdx);
      chosenIdx = next !== undefined ? next : availableIndices[0];
      _roundRobinIndex.set(providerId, chosenIdx);
    } else {
      // failover (default): first available key
      chosenIdx = availableIndices[0];
    }
  } else {
    // All keys suspended — force-recover the one that recovers soonest
    if (!providerState) {
      providerState = new Map();
      _state.set(providerId, providerState);
    }
    let soonestIdx = 0;
    let soonestTime = Infinity;
    for (let idx = 0; idx < keys.length; idx++) {
      const entry = providerState.get(idx);
      const suspendedUntil = entry?.suspendedUntil ?? 0;
      if (suspendedUntil < soonestTime) {
        soonestTime = suspendedUntil;
        soonestIdx = idx;
      }
    }
    providerState.set(soonestIdx, { failCount: 0, suspendedUntil: 0 });
    providerDirty = true;
    chosenIdx = soonestIdx;
  }

  if (providerDirty) _state.set(providerId, providerState!);
  return { key: keys[chosenIdx], keyIndex: chosenIdx };
}

export function reportSuccess(providerId: number, keyIndex: number): void {
  /** Report a successful API call — reset fail count. */
  const providerState = _state.get(providerId);
  if (!providerState) return;
  if (providerState.has(keyIndex)) {
    providerState.set(keyIndex, { failCount: 0, suspendedUntil: 0 });
  }
}

export function reportFailure(providerId: number, keyIndex: number): void {
  /** Report a failed API call — increment fail count, suspend if threshold reached. */
  let providerState = _state.get(providerId);
  if (!providerState) {
    providerState = new Map();
    _state.set(providerId, providerState);
  }

  const entry = providerState.get(keyIndex) ?? { failCount: 0, suspendedUntil: 0 };
  entry.failCount += 1;

  if (entry.failCount >= MAX_CONSECUTIVE_FAILURES) {
    entry.suspendedUntil = Date.now() + SUSPEND_DURATION_MS;
  }

  providerState.set(keyIndex, entry);
}

export interface KeyStatus {
  index: number;
  keyPrefix: string;
  failCount: number;
  isSuspended: boolean;
  suspendedUntil: number | null;
}

export function getKeyStatus(providerId: number, apiKeyJson: string): KeyStatus[] {
  /** Get status of all keys for display purposes. */
  const keys = parseApiKeys(apiKeyJson);
  const now = Date.now();
  const providerState = _state.get(providerId) ?? new Map();

  return keys.map((key, idx) => {
    const entry = providerState.get(idx);
    const failCount = entry?.failCount ?? 0;
    const suspendedUntil = entry?.suspendedUntil ?? 0;
    const isSuspended = suspendedUntil > now;

    return {
      index: idx,
      keyPrefix: key.length > 8 ? key.slice(0, 8) + '...' : key,
      failCount,
      isSuspended,
      suspendedUntil: isSuspended ? suspendedUntil : null,
    };
  });
}

export function getFirstKey(apiKeyJson: string): string {
  /** Get the first API key from JSON string (for model fetching, detection, etc). */
  const keys = parseApiKeys(apiKeyJson);
  return keys[0] ?? '';
}

export function clearProviderKeyState(providerId: number): void {
  /** Remove all in-memory state for a provider (fail counts, round-robin cursor).
   *  Called when a provider is deleted from the DB to prevent memory leak. */
  _state.delete(providerId);
  _roundRobinIndex.delete(providerId);
}
