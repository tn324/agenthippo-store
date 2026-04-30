#!/usr/bin/env node
/**
 * Test using MCP SDK Client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

async function main() {
  console.log("🚀 Testing Langfuse MCP Server with SDK Client\n");

  // Create client transport
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL || "http://localhost:3001",
      LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || "",
      LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || "",
    },
  });

  // Create client
  const client = new Client({
    name: "test-client",
    version: "1.0.0",
  });

  console.log("📡 Connecting to server...");
  await client.connect(transport);
  console.log("✅ Connected!\n");

  // List tools
  console.log("📋 Listing available tools...");
  const tools = await client.listTools();
  console.log(`Found ${tools.tools.length} tools:`);
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 60)}...`);
  }

  // Call cost summary
  console.log("\n💰 Calling langfuse_cost_summary...");
  try {
    const costResult = await client.callTool({
      name: "langfuse_cost_summary",
      arguments: { groupBy: "model", limit: 5 },
    });
    console.log("Result:");
    if (costResult.content?.[0]?.type === "text") {
      const data = JSON.parse(costResult.content[0].text);
      console.log(`  Total cost: $${data.totalCost?.toFixed(4) || "N/A"}`);
      console.log(`  Total tokens: ${data.totalTokens || "N/A"}`);
      console.log(`  Groups: ${data.summary?.length || 0}`);
      if (data.summary?.length > 0) {
        console.log("  Top models:");
        for (const item of data.summary.slice(0, 3)) {
          console.log(`    - ${item.key}: $${item.estimatedCost?.toFixed(4)} (${item.totalTokens} tokens)`);
        }
      }
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // Call list traces
  console.log("\n📜 Calling langfuse_list_traces...");
  try {
    const tracesResult = await client.callTool({
      name: "langfuse_list_traces",
      arguments: { limit: 3 },
    });
    if (tracesResult.content?.[0]?.type === "text") {
      const data = JSON.parse(tracesResult.content[0].text);
      console.log(`  Found ${data.data?.length || 0} traces`);
      if (data.data?.length > 0) {
        for (const trace of data.data.slice(0, 3)) {
          console.log(`    - ${trace.id.slice(0, 8)}... (${trace.name || "unnamed"})`);
        }
      }
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // Cleanup
  console.log("\n🛑 Closing connection...");
  await client.close();

  console.log("\n✅ Test complete!");
}

main().catch((e) => {
  console.error("❌ Test failed:", e);
  process.exit(1);
});

