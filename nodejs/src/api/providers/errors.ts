/**
 * Error thrown by provider adapters when the upstream API returns a non-OK
 * HTTP response. Carries the HTTP status code as a typed property so callers
 * can make retry decisions without type-unsafe `(error as any).status` access.
 */
export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}
