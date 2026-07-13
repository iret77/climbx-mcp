#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { closeKeySetup } from "./setup.js";

// Startup diagnostics on stderr (stdout is reserved for the MCP protocol). A host
// that spawns this server captures stderr, so if the launch ever fails to connect,
// this line proves the process started and shows the runtime it ran under. Only the
// node version and pid are logged; argv, cwd, and env are deliberately left out.
console.error(`[climbx-mcp] starting: node=${process.version} pid=${process.pid}`);

const server = new McpServer({
  name: "climbx-mcp",
  version: "0.5.0",
});

registerTools(server);

// When the MCP host hangs up stdio (app quit, plugin disabled, host crash), this
// process must go with it: close the key-setup listener (if any) and exit instead
// of lingering as an orphan. The grace timer lets an in-flight response flush
// first, is unref()ed so it never delays a natural exit, and hard-exits only if
// something is still holding the event loop open after the pipe is gone.
function shutdownOnHangup(): void {
  closeKeySetup();
  setTimeout(() => process.exit(0), 500).unref();
}
process.stdin.once("end", shutdownOnHangup);
process.stdin.once("close", shutdownOnHangup);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout belongs to the MCP protocol; log to stderr only.
console.error("climbx-mcp running on stdio");
