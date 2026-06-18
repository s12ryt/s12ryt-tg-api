/**
 * In-memory API request log store — ring buffer for recent API calls.
 *
 * Captures detailed request information (including system prompts and parameters)
 * for admin inspection in the web console. Not persisted — cleared on restart.
 */

const MAX_LOGS = 50;
/** Max messages kept in log body to limit memory per entry. */
const MAX_LOG_MESSAGES = 5;

export interface ApiLogEntry {
  id: number;
  timestamp: string;
  path: string;
  model: string;
  actualModel: string;
  providerName: string;
  username: string;
  body: Record<string, any>;
  responseStatus: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

type MutableApiLog = Omit<ApiLogEntry, "body"> & { body: Record<string, any> };

/** Ring buffer storage. */
const buffer: MutableApiLog[] = [];
let head = 0;
let count = 0;
let nextId = 1;

/** Truncate large arrays in body (e.g. messages) to limit memory usage.
 *  Keeps first 3 + last 1 message, replacing the rest with a marker. */
function truncateBody(body: Record<string, any>): Record<string, any> {
  const clone: Record<string, any> = { ...body };
  if (Array.isArray(clone.messages) && clone.messages.length > MAX_LOG_MESSAGES) {
    const head3 = clone.messages.slice(0, 3);
    const last = clone.messages[clone.messages.length - 1];
    const omitted = clone.messages.length - 4;
    clone.messages = [
      ...head3,
      { role: "system", content: `[... ${omitted} messages truncated ...]` },
      last,
    ];
    clone._messagesTruncated = true;
  }
  return clone;
}

/**
 * Add an API log entry. Deep-copies the body to avoid mutation after recording.
 */
export function addApiLog(entry: Omit<ApiLogEntry, "id">): void {
  const record: MutableApiLog = {
    ...entry,
    id: nextId++,
    // Shallow-clone body and truncate large arrays to limit memory usage
    body: truncateBody(entry.body),
  };

  if (count < MAX_LOGS) {
    buffer.push(record);
    count++;
  } else {
    buffer[head] = record;
    head = (head + 1) % MAX_LOGS;
  }
}

/**
 * Get all stored API logs, newest first.
 */
export function getApiLogs(): ApiLogEntry[] {
  // Buffer is ordered oldest-first in ring buffer order
  const sorted = count < MAX_LOGS
    ? buffer.slice()
    : buffer.slice(head).concat(buffer.slice(0, head));
  return sorted.reverse(); // newest first
}

/**
 * Clear all logs (for testing).
 */
export function clearApiLogs(): void {
  buffer.length = 0;
  head = 0;
  count = 0;
}
