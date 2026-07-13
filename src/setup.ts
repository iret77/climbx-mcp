import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultKeyFilePath } from "./client.js";

/**
 * One-shot local key-setup page.
 *
 * begin_key_setup starts a tiny HTTP listener INSIDE this MCP server process,
 * bound to 127.0.0.1 on an ephemeral port, guarded by a one-time token. The
 * user opens the returned URL, pastes their ClimbX API key into a masked form,
 * the server validates it live against the API, persists it to the default key
 * file (dir 0700, file 0600), swaps it into the running process, and shuts the
 * listener down. The key never passes through the chat or the MCP client.
 *
 * Lifecycle invariants (nothing may linger and pollute the host):
 *   - No extra process is ever spawned; the listener lives and dies with this
 *     MCP server process, which the MCP host starts and stops.
 *   - The listener closes itself on success, on TTL expiry, on too many failed
 *     attempts, and on closeKeySetup() (called on server shutdown).
 *   - The listening socket, every connection, and the TTL timer are unref()ed,
 *     so an open setup page can never keep this process alive once the MCP
 *     host hangs up stdio.
 *   - At most one setup session exists per process; starting a new one closes
 *     the previous listener first.
 */

export interface KeyValidationResult {
  ok: boolean;
  /** Human-readable reason when ok is false. Never contains the key. */
  message?: string;
}

export interface KeySetupOptions {
  /** Validates a candidate key live against the ClimbX API. */
  validateKey: (key: string) => Promise<KeyValidationResult>;
  /** Called after the key has been validated and persisted. */
  onKeySaved: (key: string) => void;
  /** Where to persist the key. Defaults to ~/.climbx/api_key. Injectable for tests. */
  keyFilePath?: string;
  /** Session lifetime in ms. Defaults to 10 minutes. */
  ttlMs?: number;
}

export interface KeySetupSession {
  url: string;
  expiresAt: Date;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_BODY_BYTES = 8 * 1024;

interface ActiveSession {
  server: Server;
  token: string;
  url: string;
  expiresAt: Date;
  attempts: number;
  timer: NodeJS.Timeout;
}

let active: ActiveSession | null = null;

/** Constant-time token comparison; length mismatch is an immediate reject. */
function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function persistKey(key: string, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, key, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode only applies on create; enforce it for existing files too.
  chmodSync(filePath, 0o600);
}

/** Closes the current setup listener, if any. Safe to call repeatedly. */
export function closeKeySetup(): void {
  if (!active) return;
  clearTimeout(active.timer);
  active.server.close();
  active = null;
}

export function getKeySetupStatus(): { active: boolean; url?: string; expiresAt?: Date } {
  if (!active) return { active: false };
  return { active: true, url: active.url, expiresAt: active.expiresAt };
}

/**
 * Starts (or restarts) the local key-setup session and returns its one-time URL.
 * Restarting invalidates any previous session's URL.
 */
export function beginKeySetup(opts: KeySetupOptions): Promise<KeySetupSession> {
  closeKeySetup();

  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const keyFilePath = opts.keyFilePath ?? defaultKeyFilePath();
  const token = randomBytes(16).toString("hex");

  const server = createServer((req, res) => {
    // Never cache and never sniff; the page is one-time and local-only.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Connection", "close");

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/setup") {
      if (!active || !tokenMatches(url.searchParams.get("t"), active.token)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("This setup link is invalid or has expired. Ask Claude to run the ClimbX setup again.");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      });
      res.end(setupPageHtml());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/key") {
      let body = "";
      let overflow = false;
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES) {
          overflow = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (overflow) return;
        void handleSubmit(body, res, opts, keyFilePath);
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  });

  // A held-open browser connection must never keep this process alive.
  server.on("connection", (socket) => socket.unref());
  server.unref();

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      active = null;
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        active = null;
        reject(new Error("Could not determine the setup listener port."));
        return;
      }
      const sessionUrl = `http://127.0.0.1:${address.port}/setup?t=${token}`;
      const expiresAt = new Date(Date.now() + ttlMs);
      const timer = setTimeout(closeKeySetup, ttlMs);
      timer.unref();
      active = { server, token, url: sessionUrl, expiresAt, attempts: 0, timer };
      resolve({ url: sessionUrl, expiresAt });
    });
  });
}

async function handleSubmit(
  body: string,
  res: import("node:http").ServerResponse,
  opts: KeySetupOptions,
  keyFilePath: string,
): Promise<void> {
  const respond = (status: number, payload: { ok: boolean; message?: string }) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  let parsed: { token?: string; key?: string };
  try {
    parsed = JSON.parse(body) as { token?: string; key?: string };
  } catch {
    respond(400, { ok: false, message: "Malformed request." });
    return;
  }

  if (!active || !tokenMatches(parsed.token ?? null, active.token)) {
    respond(404, { ok: false, message: "This setup session is no longer valid. Ask Claude to run the setup again." });
    return;
  }

  const key = parsed.key?.trim();
  if (!key) {
    respond(400, { ok: false, message: "Paste your ClimbX API key first." });
    return;
  }

  active.attempts += 1;
  if (active.attempts > MAX_ATTEMPTS) {
    respond(429, { ok: false, message: "Too many attempts. Ask Claude to run the setup again." });
    closeKeySetup();
    return;
  }

  let result: KeyValidationResult;
  try {
    result = await opts.validateKey(key);
  } catch (err) {
    respond(502, {
      ok: false,
      message: `Could not reach the ClimbX API to check the key: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`,
    });
    return;
  }

  if (!result.ok) {
    respond(400, { ok: false, message: result.message ?? "ClimbX rejected this key." });
    return;
  }

  try {
    persistKey(key, keyFilePath);
  } catch (err) {
    respond(500, {
      ok: false,
      message: `The key is valid but could not be saved: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  opts.onKeySaved(key);
  respond(200, { ok: true });
  // The single purpose of this listener is fulfilled; stop accepting new
  // connections now. server.close() lets the in-flight response flush.
  setImmediate(closeKeySetup);
}

/** The self-contained setup page. No external assets, light/dark aware. */
function setupPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect ClimbX</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box;
    background: #fafafa; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #0d0f13; color: #e8e8e8; } }
  main { max-width: 26rem; width: 100%; }
  h1 { font-size: 1.3rem; margin: 0 0 0.5rem; }
  p { line-height: 1.5; margin: 0.5rem 0; }
  .muted { opacity: 0.7; font-size: 0.85rem; }
  input {
    width: 100%; box-sizing: border-box; font-size: 1rem; font-family: ui-monospace, monospace;
    padding: 0.6rem 0.7rem; margin: 0.8rem 0 0.6rem; border-radius: 8px;
    border: 1px solid #8886; background: transparent; color: inherit;
  }
  button {
    width: 100%; font-size: 1rem; padding: 0.6rem; border-radius: 8px;
    border: none; background: #2563eb; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #msg { min-height: 1.5rem; font-size: 0.9rem; }
  #msg.error { color: #dc2626; }
  #msg.okay { color: #16a34a; font-weight: 600; }
  #done { display: none; }
</style>
</head>
<body>
<main>
  <div id="form">
    <h1>Connect ClimbX</h1>
    <p>Paste your ClimbX API key below. Create one in the ClimbX app under <strong>Settings &gt; API</strong> (the full key is shown only once).</p>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="climbx_sk_...">
    <button id="save">Save and connect</button>
    <p id="msg" role="status"></p>
    <p class="muted">This page is served locally on your machine by the climbx-mcp server and closes itself after saving. The key is checked against climbx.so, stored only on this computer, and never enters the chat.</p>
  </div>
  <div id="done">
    <h1>Connected.</h1>
    <p>Your ClimbX key is saved. You can close this tab and go back to Claude.</p>
  </div>
</main>
<script>
  var token = new URLSearchParams(location.search).get("t");
  var input = document.getElementById("key");
  var button = document.getElementById("save");
  var msg = document.getElementById("msg");
  function submit() {
    var key = input.value.trim();
    if (!key) { msg.className = "error"; msg.textContent = "Paste your ClimbX API key first."; return; }
    button.disabled = true;
    msg.className = ""; msg.textContent = "Checking the key with ClimbX...";
    fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, key: key })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (data.ok) {
        document.getElementById("form").style.display = "none";
        document.getElementById("done").style.display = "block";
      } else {
        button.disabled = false;
        msg.className = "error"; msg.textContent = data.message || "ClimbX rejected this key.";
      }
    }).catch(function () {
      button.disabled = false;
      msg.className = "error";
      msg.textContent = "The setup session ended before the key was saved. Ask Claude to run the setup again.";
    });
  }
  button.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  input.focus();
</script>
</body>
</html>
`;
}
