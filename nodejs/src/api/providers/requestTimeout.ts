export interface RequestTimeout {
  signal: AbortSignal;
  abort: () => void;
  clear: () => void;
}

export function createRequestTimeout(timeoutMs: number): RequestTimeout {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    clear: () => clearTimeout(timer),
  };
}

export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeout = createRequestTimeout(timeoutMs);
  try {
    return await run(timeout.signal);
  } finally {
    timeout.clear();
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
