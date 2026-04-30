#!/usr/bin/env node
/**
 * Simple MCP server test - sends JSON-RPC messages and reads responses
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

let messageId = 1;

function createMessage(method, params = {}) {
  const msg = {
    jsonrpc: "2.0",
    id: messageId++,
    method,
    params,
  };
  const json = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

async function main() {
  console.log("🚀 Starting Langfuse MCP Server Test\n");

  const server = spawn("node", [serverPath], {
    env: {
      ...process.env,
      LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL || "http://localhost:3001",
      LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || "",
      LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stderr.on("data", (d) => console.log(`[stderr] ${d.toString().trim()}`));

  // Collect responses
  let buffer = "";
  const responses = [];

  server.stdout.on("data", (data) => {
    buffer += data.toString();
    // Parse Content-Length messages
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const parsed = JSON.parse(body);
        responses.push(parsed);
        console.log(`\n📥 Response ${parsed.id}:`);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log(`[parse error] ${e.message}`);
      }
    }
  });

  // Wait for server to start
  await new Promise((r) => setTimeout(r, 500));

  // 1. Initialize
  console.log("\n📤 [1] initialize");
  server.stdin.write(
    createMessage("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })
  );

  await new Promise((r) => setTimeout(r, 500));

  // 2. initialized notification
  console.log("\n📤 [2] initialized (notification)");
  server.stdin.write(
    `Content-Length: ${Buffer.byteLength('{"jsonrpc":"2.0","method":"notifications/initialized"}')}\r\n\r\n{"jsonrpc":"2.0","method":"notifications/initialized"}`
  );

  await new Promise((r) => setTimeout(r, 200));

  // 3. List tools
  console.log("\n📤 [3] tools/list");
  server.stdin.write(createMessage("tools/list", {}));

  await new Promise((r) => setTimeout(r, 500));

  // 4. Call cost summary tool
  console.log("\n📤 [4] tools/call (langfuse_cost_summary)");
  server.stdin.write(
    createMessage("tools/call", {
      name: "langfuse_cost_summary",
      arguments: { groupBy: "model", limit: 10 },
    })
  );

  await new Promise((r) => setTimeout(r, 2000));

  // 5. Call list traces tool
  console.log("\n📤 [5] tools/call (langfuse_list_traces)");
  server.stdin.write(
    createMessage("tools/call", {
      name: "langfuse_list_traces",
      arguments: { limit: 3 },
    })
  );

  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n" + "=".repeat(60));
  console.log(`✅ Test complete! Received ${responses.length} responses`);
  console.log("=".repeat(60));

  server.kill("SIGTERM");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Test failed:", e);
  process.exit(1);
});

