import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Orphan guard: when the MCP host hangs up stdio, the server process must exit
 * on its own instead of lingering. This is what guarantees that nothing this
 * server does (including the key-setup listener) can outlive the host.
 */

const ROOT = join(__dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }) + "\n";

describe("process lifecycle", () => {
  it("exits by itself when stdin closes, after flushing the pending response", async () => {
    const child = spawn(TSX, ["src/index.ts"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      // A temp HOME so the runner's real ~/.climbx never leaks in.
      env: { ...process.env, CLIMBX_API_KEY: "", CLIMBX_API_KEY_FILE: "" },
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    // Wait until the server announces itself on stderr, then hand it one
    // request and hang up, exactly like a host quitting.
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const onData = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.includes("running on stdio")) resolve();
      };
      child.stderr.on("data", onData);
      child.once("error", reject);
      setTimeout(() => reject(new Error("server did not start in time")), 15_000);
    });

    child.stdin.write(INITIALIZE);
    // Give the response a moment, then close stdin (host hangup).
    await new Promise((r) => setTimeout(r, 300));
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", (code) => resolve(code));
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("server lingered after stdin closed"));
      }, 5_000);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"jsonrpc"');
  }, 30_000);
});
