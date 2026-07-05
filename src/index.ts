#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// Startup diagnostics on stderr (stdout is reserved for the MCP protocol). A host
// that spawns this server captures stderr, so if the launch ever fails to connect,
// this line proves the process started and shows the runtime it ran under.
console.error(
  `[climbx-mcp] starting: node=${process.version} pid=${process.pid} ` +
    `execPath=${process.execPath} cwd=${process.cwd()} argv=${JSON.stringify(process.argv)}`,
);

const server = new McpServer({
  name: "climbx-mcp",
  version: "0.4.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout belongs to the MCP protocol; log to stderr only.
console.error("climbx-mcp running on stdio");
