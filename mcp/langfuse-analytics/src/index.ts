/**
 * Langfuse Analytics MCP Server
 *
 * Provides tools for querying Langfuse analytics data:
 * - List sessions
 * - Get trace details
 * - Cost summary
 * - Latency summary
 * - Error patterns
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LangfuseClient } from "./client.js";

const langfuseHost = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

// Initialize Langfuse client
const client = new LangfuseClient({
	host: langfuseHost,
	secretKey: process.env.LANGFUSE_SECRET_KEY || "",
	publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
});

// Create MCP server
const server = new McpServer({
	name: "langfuse-analytics",
	version: "1.0.0",
});

// -----------------------------------------------------------------------------
// Input Schemas
// -----------------------------------------------------------------------------

const ListSessionsSchema = z.object({
	limit: z.number().min(1).max(100).default(20).describe("Maximum number of sessions to return"),
	userId: z.string().optional().describe("Filter by user ID"),
	fromDate: z.string().optional().describe("Start date (ISO format, e.g., 2026-01-13)"),
	toDate: z.string().optional().describe("End date (ISO format, e.g., 2026-01-14)"),
});

const GetTraceSchema = z.object({
	traceId: z.string().describe("The trace ID to retrieve"),
});

const ListTracesSchema = z.object({
	limit: z.number().min(1).max(100).default(20).describe("Maximum number of traces to return"),
	userId: z.string().optional().describe("Filter by user ID"),
	sessionId: z.string().optional().describe("Filter by session ID"),
	name: z.string().optional().describe("Filter by trace name"),
	fromDate: z.string().optional().describe("Start date (ISO format)"),
	toDate: z.string().optional().describe("End date (ISO format)"),
});

const CostSummarySchema = z.object({
	groupBy: z.enum(["model", "session", "user"]).describe("Dimension to group costs by"),
	fromDate: z.string().optional().describe("Start date (ISO format)"),
	toDate: z.string().optional().describe("End date (ISO format)"),
	limit: z.number().min(1).max(100).default(50).describe("Maximum number of traces to analyze"),
});

const LatencySummarySchema = z.object({
	groupBy: z.enum(["model", "name", "session"]).describe("Dimension to group latencies by"),
	fromDate: z.string().optional().describe("Start date (ISO format)"),
	toDate: z.string().optional().describe("End date (ISO format)"),
	limit: z.number().min(1).max(100).default(50).describe("Maximum number of traces to analyze"),
});

const ErrorPatternsSchema = z.object({
	groupBy: z.enum(["error", "name", "model"]).default("error").describe("Dimension to group errors by"),
	fromDate: z.string().optional().describe("Start date (ISO format)"),
	toDate: z.string().optional().describe("End date (ISO format)"),
	limit: z.number().min(1).max(100).default(50).describe("Maximum number of traces to analyze"),
});

// -----------------------------------------------------------------------------
// Tool: List Sessions
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_list_sessions",
	{
		title: "List Sessions",
		description: "List recent Langfuse sessions with optional filtering by user ID or time range",
		inputSchema: ListSessionsSchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof ListSessionsSchema>) => {
		const sessions = await client.listSessions({
			limit: params.limit ?? 20,
			userId: params.userId,
			fromTimestamp: params.fromDate,
			toTimestamp: params.toDate,
		});

		return {
			content: [{ type: "text" as const, text: JSON.stringify(sessions, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Tool: Get Trace
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_get_trace",
	{
		title: "Get Trace",
		description: "Get detailed information about a specific trace by ID",
		inputSchema: GetTraceSchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof GetTraceSchema>) => {
		const trace = await client.getTrace(params.traceId);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(trace, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Tool: List Traces
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_list_traces",
	{
		title: "List Traces",
		description: "List traces with optional filtering",
		inputSchema: ListTracesSchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof ListTracesSchema>) => {
		const traces = await client.listTraces({
			limit: params.limit ?? 20,
			userId: params.userId,
			sessionId: params.sessionId,
			name: params.name,
			fromTimestamp: params.fromDate,
			toTimestamp: params.toDate,
		});

		return {
			content: [{ type: "text" as const, text: JSON.stringify(traces, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Tool: Cost Summary
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_cost_summary",
	{
		title: "Cost Summary",
		description: "Get aggregated costs grouped by model, session, or user. Returns total tokens and estimated costs.",
		inputSchema: CostSummarySchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof CostSummarySchema>) => {
		const summary = await client.getCostSummary({
			groupBy: params.groupBy,
			fromTimestamp: params.fromDate,
			toTimestamp: params.toDate,
			limit: params.limit ?? 50,
		});

		return {
			content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Tool: Latency Summary
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_latency_summary",
	{
		title: "Latency Summary",
		description: "Get latency statistics grouped by model, trace name, or session",
		inputSchema: LatencySummarySchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof LatencySummarySchema>) => {
		const summary = await client.getLatencySummary({
			groupBy: params.groupBy,
			fromTimestamp: params.fromDate,
			toTimestamp: params.toDate,
			limit: params.limit ?? 50,
		});

		return {
			content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Tool: Error Patterns
// -----------------------------------------------------------------------------

server.registerTool(
	"langfuse_error_patterns",
	{
		title: "Error Patterns",
		description: "Find error patterns in recent traces, grouped by error type or trace name",
		inputSchema: ErrorPatternsSchema,
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
	},
	async (params: z.infer<typeof ErrorPatternsSchema>) => {
		const patterns = await client.getErrorPatterns({
			groupBy: params.groupBy ?? "error",
			fromTimestamp: params.fromDate,
			toTimestamp: params.toDate,
			limit: params.limit ?? 50,
		});

		return {
			content: [{ type: "text" as const, text: JSON.stringify(patterns, null, 2) }],
		};
	}
);

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
	// Validate environment
	if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
		console.error("Warning: LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY should be set");
	}

	console.error(
		`[langfuse-analytics] Starting MCP server (host: ${langfuseHost})`
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error("[langfuse-analytics] MCP server running via stdio");
}

main().catch((error) => {
	console.error("[langfuse-analytics] Fatal error:", error);
	process.exit(1);
});
