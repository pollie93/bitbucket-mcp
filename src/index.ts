#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const server = createServer(loadConfig());
  await server.connect(new StdioServerTransport());
} catch (err) {
  // stdout es el canal del protocolo: los errores van a stderr
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
