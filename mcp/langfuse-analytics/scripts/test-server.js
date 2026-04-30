#!/usr/bin/env node
/**
 * Test script for Langfuse Analytics MCP Server
 *
 * This script spawns the MCP server and sends test requests via stdio.
 *
 * Usage:
 *   # Set environment variables first:
 *   export LANGFUSE_BASE_URL=http://localhost:3000
 *   export LANGFUSE_SECRET_KEY=sk-lf-xxx
 *   export LANGFUSE_PUBLIC_KEY=pk-lf-xxx
 *
 *   # Run test:
 *   node scripts/test-server.js
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

// MCP JSON-RPC message helpers
let messageId = 1;

function createRequest(method, params = {}) {
  return {
    jsonrpc: "2.0",
    id: messageId++,
    method,
    params,
  };
}

function sendMessage(proc, message) {
  const json = JSON.stringify(message);
  const content = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  proc.stdin.write(content);
}

async function readResponse(rl) {
  return new Promise((resolve, reject) => {
    let headers = "";
    let contentLength = 0;
    let body = "";
    let readingHeaders = true;

    const onLine = (line) => {
      if (readingHeaders) {
        if (line === "") {
          readingHeaders = false;
          // Now read body
          const match = headers.match(/Content-Length:\s*(\d+)/i);
          if (match) {
            contentLength = parseInt(match[1], 10);
          }
        } else {
          headers += line + "\n";
        }
      }
    };

    rl.on("line", onLine);

    // For simplicity, just wait a bit and read what's available
    setTimeout(() => {
      rl.off("line", onLine);
      resolve(null);
    }, 2000);
  });
}

async function main() {
  console.log("🚀 Starting Langfuse Analytics MCP Server test...\n");

  // Check environment
  const host = process.env.LANGFUSE_BASE_URL || "http://localhost:3000";
  const hasSecretKey = !!process.env.LANGFUSE_SECRET_KEY;
  const hasPublicKey = !!process.env.LANGFUSE_PUBLIC_KEY;

  console.log(`📍 Langfuse Host: ${host}`);
  console.log(`🔑 Secret Key: ${hasSecretKey ? "✓ set" : "✗ missing"}`);
  console.log(`🔑 Public Key: ${hasPublicKey ? "✓ set" : "✗ missing"}`);
  console.log("");

  if (!hasSecretKey || !hasPublicKey) {
    console.error("❌ Please set LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY");
    console.error("");
    console.error("Example:");
    console.error("  export LANGFUSE_BASE_URL=http://localhost:3000");
    console.error("  export LANGFUSE_SECRET_KEY=sk-lf-xxx");
    console.error("  export LANGFUSE_PUBLIC_KEY=pk-lf-xxx");
    process.exit(1);
  }

  // Spawn the server
  console.log(`📦 Starting server: node ${serverPath}`);
  const server = spawn("node", [serverPath], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Collect stderr (server logs)
  let stderrOutput = "";
  server.stderr.on("data", (data) => {
    stderrOutput += data.toString();
    // Print server logs in real-time
    process.stderr.write(`[server] ${data}`);
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (server.exitCode !== null) {
    console.error("❌ Server exited prematurely");
    console.error(stderrOutput);
    process.exit(1);
  }

  console.log("\n✓ Server started\n");

  // Create readline for reading responses
  const rl = createInterface({
    input: server.stdout,
    crlfDelay: Infinity,
  });

  // Collect all stdout data
  let responseData = "";
  server.stdout.on("data", (chunk) => {
    responseData += chunk.toString();
  });

  // Test 1: Initialize
  console.log("📤 Sending: initialize");
  sendMessage(server, createRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  }));

  await new Promise((resolve) => setTimeout(resolve, 500));

  // Test 2: List tools
  console.log("📤 Sending: tools/list");
  sendMessage(server, createRequest("tools/list", {}));

  await new Promise((resolve) => setTimeout(resolve, 500));

  // Test 3: Call langfuse_list_traces
  console.log("📤 Sending: tools/call (langfuse_list_traces)");
  sendMessage(server, createRequest("tools/call", {
    name: "langfuse_list_traces",
    arguments: { limit: 5 },
  }));

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Test 4: Call langfuse_cost_summary
  console.log("📤 Sending: tools/call (langfuse_cost_summary)");
  sendMessage(server, createRequest("tools/call", {
    name: "langfuse_cost_summary",
    arguments: { groupBy: "model", limit: 10 },
  }));

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Print collected responses
  console.log("\n" + "=".repeat(60));
  console.log("📥 Responses received:");
  console.log("=".repeat(60) + "\n");

  // Parse and pretty-print responses
  const lines = responseData.split("\r\n\r\n");
  for (const line of lines) {
    if (line.trim() && !line.startsWith("Content-Length:")) {
      try {
        // Find JSON in the line
        const jsonMatch = line.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(JSON.stringify(parsed, null, 2));
          console.log("");
        }
      } catch {
        // Not JSON, print as-is
        if (line.trim()) {
          console.log(line);
        }
      }
    }
  }

  // Cleanup
  console.log("\n🛑 Stopping server...");
  server.kill("SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log("✅ Test complete!");
}

main().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});

