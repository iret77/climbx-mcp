import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://climbx.so/api/v1";

/**
 * Default key-file location. Resolved from the OS home directory at call time
 * (never a literal '~': Node does not expand shell tildes in paths).
 */
export function defaultKeyFilePath(): string {
  return join(homedir(), ".climbx", "api_key");
}

/** Reads a key file, trimming surrounding whitespace. Returns null if missing, unreadable, or empty. */
function readKeyFile(path: string): string | null {
  try {
    const key = readFileSync(path, "utf8").trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the ClimbX API key from, in order of precedence:
 *   1. the CLIMBX_API_KEY environment variable
 *   2. the file named by CLIMBX_API_KEY_FILE
 *   3. the default key file at ~/.climbx/api_key
 * Returns null when no source yields a non-empty key (callers show the setup hint).
 */
export function resolveApiKey(): string | null {
  const envKey = process.env.CLIMBX_API_KEY?.trim();
  if (envKey) return envKey;

  const fileEnv = process.env.CLIMBX_API_KEY_FILE;
  if (fileEnv) {
    const fromFile = readKeyFile(fileEnv);
    if (fromFile) return fromFile;
  }

  return readKeyFile(defaultKeyFilePath());
}

/** Actionable hints per ClimbX error code (see https://climbx.so/developers/docs). */
const ERROR_HINTS: Record<string, string> = {
  missing_bearer:
    "No API key was sent. Set the CLIMBX_API_KEY environment variable.",
  invalid_key:
    "The API key is unknown or revoked. Create a new one in ClimbX under Settings → API and update CLIMBX_API_KEY.",
  subscription_required:
    "The ClimbX account that owns this key has no active plan or trial. Check the subscription at climbx.so.",
  x_not_connected:
    "No X account is connected. Reconnect X in the ClimbX web app.",
  x_token_expired:
    "The X connection expired. Reconnect X in the ClimbX web app.",
  not_pending:
    "The scheduled post is no longer pending (already publishing or published) and can no longer be changed.",
  daily_post_cap_reached:
    "Daily post cap reached (5 posts/day across publish and schedule). Resets at 00:00 UTC. Do not retry.",
  rate_limited:
    "Too many read requests this minute (~60 GET/min per key). Back off and try again.",
  url_posts_not_allowed:
    "ClimbX rejects posts that contain a URL (link posts cut reach on X). Remove the link from the text.",
  image_rejected:
    "An image_url could not be used: bad URL, blocked host, too large, or not an image. Use public https image URLs.",
  not_found: "No scheduled post with that id exists on this account.",
  invalid_query:
    "One or more query parameters are invalid. Check get_inspiration_options for the accepted filter values.",
  read_only_key:
    "The API key is read-only and this endpoint writes. Create a read & write key in ClimbX under Settings > API.",
  insufficient_credits:
    "Out of shared daily AI drafting credits. The pool refills daily.",
  locked:
    "AI reply drafting is locked until the owner has written enough replies in their own words in the ClimbX app.",
};

export class ClimbxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ClimbxError";
  }
}

export interface ClimbxClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Allow a non-climbx.so base URL (dev/staging). Default false. */
  allowCustomHost?: boolean;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Guards against sending the Bearer key to an unexpected host: the base URL
 * must be https and a climbx.so host, unless the caller explicitly allows
 * custom hosts (dev/staging setups).
 */
export function validateBaseUrl(baseUrl: string, allowCustomHost = false): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `CLIMBX_BASE_URL is not a valid URL: ${baseUrl}`;
  }
  if (url.protocol !== "https:") {
    return `CLIMBX_BASE_URL must use https (the API key is sent as a Bearer header), got: ${url.protocol}//`;
  }
  if (!allowCustomHost && url.hostname !== "climbx.so" && !url.hostname.endsWith(".climbx.so")) {
    return (
      `CLIMBX_BASE_URL points at ${url.hostname}; refusing to send the API key to a non-climbx.so host. ` +
      "Set CLIMBX_ALLOW_CUSTOM_BASE_URL=1 if this is intentional (dev/staging)."
    );
  }
  return null;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const MAX_RETRY_AFTER_MS = 30_000;
const NETWORK_RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_SNIPPET_LEN = 200;

export class ClimbxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: ClimbxClientOptions) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    // Enforced here so no caller (tools, smoke test, future consumers) can bypass it.
    const baseUrlError = validateBaseUrl(baseUrl, opts.allowCustomHost ?? false);
    if (baseUrlError) {
      throw new ClimbxError(0, "invalid_base_url", baseUrlError);
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get(path: string, query?: RequestOptions["query"]): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, { body });
  }

  patch(path: string, body: unknown): Promise<unknown> {
    return this.request("PATCH", path, { body });
  }

  delete(path: string): Promise<unknown> {
    return this.request("DELETE", path, {});
  }

  private async request(
    method: string,
    path: string,
    opts: RequestOptions,
    isRetry = false,
  ): Promise<unknown> {
    // Writes are never retried automatically; only GETs are safe to repeat.
    const retryable = method === "GET" && !isRetry;

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (retryable) {
        await this.sleepFn(NETWORK_RETRY_DELAY_MS);
        return this.request(method, path, opts, true);
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new ClimbxError(
        0,
        isTimeout ? "timeout" : "network_error",
        isTimeout
          ? `${method} ${path} timed out after ${this.timeoutMs}ms`
          : `Network error calling ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let payload: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (res.ok) {
      return payload ?? {};
    }

    const errBody = (payload ?? {}) as { error?: string; message?: string };
    const code = errBody.error ?? `http_${res.status}`;
    let message = errBody.message ?? `${method} ${path} failed with HTTP ${res.status}`;
    if (!errBody.message && text) {
      // Non-JSON error body (proxy/HTML error page): keep a bounded snippet for diagnostics.
      message += `; response body (truncated): ${text.slice(0, ERROR_BODY_SNIPPET_LEN)}`;
    }

    if (code === "rate_limited" && retryable) {
      const retryAfterSec = Number(res.headers.get("Retry-After") ?? "1");
      const delay = Math.min(
        (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1) * 1000,
        MAX_RETRY_AFTER_MS,
      );
      await this.sleepFn(delay);
      return this.request(method, path, opts, true);
    }

    throw new ClimbxError(res.status, code, message, ERROR_HINTS[code]);
  }
}
