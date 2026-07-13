import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginKeySetup, closeKeySetup, getKeySetupStatus, type KeySetupOptions } from "../src/setup.js";

/**
 * Lifecycle contract under test: the setup listener must never outlive its
 * purpose. It closes on success, on TTL expiry, on repeated failures, and on
 * closeKeySetup(); a fresh beginKeySetup() invalidates the previous session.
 */

function options(overrides: Partial<KeySetupOptions> = {}): KeySetupOptions {
  return {
    validateKey: async () => ({ ok: true }),
    onKeySaved: () => {},
    keyFilePath: join(mkdtempSync(join(tmpdir(), "climbx-setup-")), ".climbx", "api_key"),
    ...overrides,
  };
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get("t") ?? "";
}

async function submitKey(url: string, key: string, token = tokenOf(url)): Promise<Response> {
  return fetch(new URL("/api/key", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, key }),
  });
}

/** True once nothing accepts connections at the session's port anymore. */
async function portClosed(url: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(new URL("/setup", url), { signal: AbortSignal.timeout(250) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

afterEach(() => {
  closeKeySetup();
});

describe("key setup listener", () => {
  it("serves the setup page only with the correct token", async () => {
    const session = await beginKeySetup(options());
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\?t=[0-9a-f]{32}$/);

    const okRes = await fetch(session.url);
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toContain("Connect ClimbX");

    const badRes = await fetch(session.url.replace(/t=.*$/, "t=" + "0".repeat(32)));
    expect(badRes.status).toBe(404);
  });

  it("validates, persists (0600), hot-swaps, responds ok, then closes itself", async () => {
    const saved: string[] = [];
    const keyFilePath = join(mkdtempSync(join(tmpdir(), "climbx-setup-")), ".climbx", "api_key");
    const session = await beginKeySetup(
      options({ keyFilePath, onKeySaved: (key) => saved.push(key) }),
    );

    const res = await submitKey(session.url, "climbx_sk_valid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(readFileSync(keyFilePath, "utf8")).toBe("climbx_sk_valid");
    if (process.platform !== "win32") {
      expect(statSync(keyFilePath).mode & 0o777).toBe(0o600);
    }
    expect(saved).toEqual(["climbx_sk_valid"]);

    expect(await portClosed(session.url)).toBe(true);
    expect(getKeySetupStatus().active).toBe(false);
  });

  it("stays open after a rejected key so the user can retry", async () => {
    const session = await beginKeySetup(
      options({
        validateKey: async (key) =>
          key === "climbx_sk_right" ? { ok: true } : { ok: false, message: "The API key is unknown or revoked." },
      }),
    );

    const bad = await submitKey(session.url, "climbx_sk_wrong");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("unknown or revoked");
    expect(getKeySetupStatus().active).toBe(true);

    const good = await submitKey(session.url, "climbx_sk_right");
    expect(good.status).toBe(200);
    expect(await portClosed(session.url)).toBe(true);
  });

  it("reports a network failure without saving and stays open", async () => {
    const session = await beginKeySetup(
      options({
        validateKey: async () => {
          throw new Error("getaddrinfo ENOTFOUND climbx.so");
        },
      }),
    );
    const res = await submitKey(session.url, "climbx_sk_offline");
    expect(res.status).toBe(502);
    expect(getKeySetupStatus().active).toBe(true);
  });

  it("expires and closes after the TTL", async () => {
    const session = await beginKeySetup(options({ ttlMs: 100 }));
    expect(getKeySetupStatus().active).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(getKeySetupStatus().active).toBe(false);
    expect(await portClosed(session.url)).toBe(true);
  });

  it("a new session invalidates and closes the previous one", async () => {
    const first = await beginKeySetup(options());
    const second = await beginKeySetup(options());
    expect(second.url).not.toBe(first.url);
    expect(await portClosed(first.url)).toBe(true);

    // The old token is useless against the new session too.
    const res = await submitKey(second.url, "climbx_sk_x", tokenOf(first.url));
    expect(res.status).toBe(404);
    expect(getKeySetupStatus().active).toBe(true);
  });

  it("closeKeySetup tears the listener down and is idempotent", async () => {
    const session = await beginKeySetup(options());
    closeKeySetup();
    closeKeySetup();
    expect(getKeySetupStatus().active).toBe(false);
    expect(await portClosed(session.url)).toBe(true);
  });

  it("rejects malformed and empty submissions without closing", async () => {
    const session = await beginKeySetup(options());

    const malformed = await fetch(new URL("/api/key", session.url), {
      method: "POST",
      body: "not json",
    });
    expect(malformed.status).toBe(400);

    const empty = await submitKey(session.url, "   ");
    expect(empty.status).toBe(400);
    expect(getKeySetupStatus().active).toBe(true);
  });
});
