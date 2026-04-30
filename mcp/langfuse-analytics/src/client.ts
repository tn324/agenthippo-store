/**
 * Langfuse API Client
 *
 * Simple wrapper around Langfuse REST API for analytics queries.
 * Uses the public API endpoints documented at https://api.reference.langfuse.com/
 */

export interface LangfuseClientConfig {
	host: string;
	secretKey: string;
	publicKey: string;
}

export interface Session {
	id: string;
	createdAt: string;
	projectId: string;
	userId?: string;
	metadata?: Record<string, unknown>;
}

export interface Trace {
	id: string;
	name?: string;
	userId?: string;
	sessionId?: string;
	timestamp: string;
	metadata?: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
	tags?: string[];
	// Computed fields from observations
	latencyMs?: number;
	totalTokens?: number;
	promptTokens?: number;
	completionTokens?: number;
	totalCost?: number;
	level?: string;
	statusMessage?: string;
}

export interface Observation {
	id: string;
	traceId: string;
	type: string;
	name?: string;
	startTime: string;
	endTime?: string;
	model?: string;
	input?: unknown;
	output?: unknown;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
	};
	calculatedTotalCost?: number;
	level?: string;
	statusMessage?: string;
}

export interface CostSummaryItem {
	key: string;
	count: number;
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	estimatedCost: number;
}

export interface LatencySummaryItem {
	key: string;
	count: number;
	avgLatencyMs: number;
	minLatencyMs: number;
	maxLatencyMs: number;
	p50LatencyMs: number;
	p95LatencyMs: number;
}

export interface ErrorPatternItem {
	key: string;
	count: number;
	examples: Array<{
		traceId: string;
		message?: string;
		timestamp: string;
	}>;
}

export class LangfuseClient {
	private readonly baseUrl: string;
	private readonly authHeader: string;

	constructor(config: LangfuseClientConfig) {
		this.baseUrl = config.host.replace(/\/$/, "");
		// Langfuse uses Basic auth with publicKey:secretKey
		const credentials = Buffer.from(
			`${config.publicKey}:${config.secretKey}`
		).toString("base64");
		this.authHeader = `Basic ${credentials}`;
	}

	private async fetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
		const url = new URL(`${this.baseUrl}/api/public${endpoint}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined && value !== "") {
					url.searchParams.set(key, value);
				}
			}
		}

		const response = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Authorization: this.authHeader,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Langfuse API error (${response.status}): ${errorText}`
			);
		}

		return response.json() as Promise<T>;
	}

	// ---------------------------------------------------------------------------
	// Sessions
	// ---------------------------------------------------------------------------

	async listSessions(options: {
		limit?: number;
		userId?: string;
		fromTimestamp?: string;
		toTimestamp?: string;
	}): Promise<{ sessions: Session[]; meta: { totalCount: number } }> {
		const params: Record<string, string> = {};
		if (options.limit) params.limit = String(options.limit);
		if (options.userId) params.userId = options.userId;
		if (options.fromTimestamp) params.fromTimestamp = options.fromTimestamp;
		if (options.toTimestamp) params.toTimestamp = options.toTimestamp;

		return this.fetch<{ sessions: Session[]; meta: { totalCount: number } }>(
			"/sessions",
			params
		);
	}

	// ---------------------------------------------------------------------------
	// Traces
	// ---------------------------------------------------------------------------

	async getTrace(traceId: string): Promise<Trace> {
		return this.fetch<Trace>(`/traces/${traceId}`);
	}

	async listTraces(options: {
		limit?: number;
		userId?: string;
		sessionId?: string;
		name?: string;
		fromTimestamp?: string;
		toTimestamp?: string;
	}): Promise<{ data: Trace[]; meta: { totalCount: number } }> {
		const params: Record<string, string> = {};
		if (options.limit) params.limit = String(options.limit);
		if (options.userId) params.userId = options.userId;
		if (options.sessionId) params.sessionId = options.sessionId;
		if (options.name) params.name = options.name;
		if (options.fromTimestamp) params.fromTimestamp = options.fromTimestamp;
		if (options.toTimestamp) params.toTimestamp = options.toTimestamp;

		return this.fetch<{ data: Trace[]; meta: { totalCount: number } }>(
			"/traces",
			params
		);
	}

	// ---------------------------------------------------------------------------
	// Observations (for computing aggregates)
	// ---------------------------------------------------------------------------

	async listObservations(options: {
		limit?: number;
		traceId?: string;
		type?: string;
		fromStartTime?: string;
		toStartTime?: string;
	}): Promise<{ data: Observation[]; meta: { totalCount: number } }> {
		const params: Record<string, string> = {};
		if (options.limit) params.limit = String(options.limit);
		if (options.traceId) params.traceId = options.traceId;
		if (options.type) params.type = options.type;
		if (options.fromStartTime) params.fromStartTime = options.fromStartTime;
		if (options.toStartTime) params.toStartTime = options.toStartTime;

		return this.fetch<{ data: Observation[]; meta: { totalCount: number } }>(
			"/observations",
			params
		);
	}

	// ---------------------------------------------------------------------------
	// Analytics: Cost Summary
	// ---------------------------------------------------------------------------

	async getCostSummary(options: {
		groupBy: "model" | "session" | "user";
		fromTimestamp?: string;
		toTimestamp?: string;
		limit?: number;
	}): Promise<{ summary: CostSummaryItem[]; totalCost: number; totalTokens: number }> {
		// Fetch observations (which contain token/cost data)
		const obs = await this.listObservations({
			limit: options.limit || 100,
			type: "GENERATION",
			fromStartTime: options.fromTimestamp,
			toStartTime: options.toTimestamp,
		});

		// For grouping by session/user, we need trace data
		let traceMap = new Map<string, Trace>();
		if (options.groupBy === "session" || options.groupBy === "user") {
			const traces = await this.listTraces({
				limit: options.limit || 100,
				fromTimestamp: options.fromTimestamp,
				toTimestamp: options.toTimestamp,
			});
			for (const t of traces.data) {
				traceMap.set(t.id, t);
			}
		}

		// Aggregate by groupBy dimension
		const groups = new Map<string, CostSummaryItem>();

		for (const o of obs.data) {
			let key: string;
			switch (options.groupBy) {
				case "model":
					key = o.model || "unknown";
					break;
				case "session":
					key = traceMap.get(o.traceId)?.sessionId || "no-session";
					break;
				case "user":
					key = traceMap.get(o.traceId)?.userId || "anonymous";
					break;
			}

			const existing = groups.get(key) || {
				key,
				count: 0,
				totalTokens: 0,
				promptTokens: 0,
				completionTokens: 0,
				estimatedCost: 0,
			};

			existing.count++;
			existing.totalTokens += o.usage?.totalTokens || 0;
			existing.promptTokens += o.usage?.promptTokens || 0;
			existing.completionTokens += o.usage?.completionTokens || 0;
			existing.estimatedCost += o.calculatedTotalCost || 0;

			groups.set(key, existing);
		}

		const summary = Array.from(groups.values()).sort(
			(a, b) => b.estimatedCost - a.estimatedCost
		);

		const totalCost = summary.reduce((sum, item) => sum + item.estimatedCost, 0);
		const totalTokens = summary.reduce((sum, item) => sum + item.totalTokens, 0);

		return { summary, totalCost, totalTokens };
	}

	// ---------------------------------------------------------------------------
	// Analytics: Latency Summary
	// ---------------------------------------------------------------------------

	async getLatencySummary(options: {
		groupBy: "model" | "name" | "session";
		fromTimestamp?: string;
		toTimestamp?: string;
		limit?: number;
	}): Promise<{ summary: LatencySummaryItem[] }> {
		const obs = await this.listObservations({
			limit: options.limit || 100,
			type: "GENERATION",
			fromStartTime: options.fromTimestamp,
			toStartTime: options.toTimestamp,
		});

		// For grouping by session, we need trace data
		let traceMap = new Map<string, Trace>();
		if (options.groupBy === "session") {
			const traces = await this.listTraces({
				limit: options.limit || 100,
				fromTimestamp: options.fromTimestamp,
				toTimestamp: options.toTimestamp,
			});
			for (const t of traces.data) {
				traceMap.set(t.id, t);
			}
		}

		// Collect latencies by group
		const latencyGroups = new Map<string, number[]>();

		for (const o of obs.data) {
			if (!o.startTime || !o.endTime) continue;

			const latencyMs =
				new Date(o.endTime).getTime() - new Date(o.startTime).getTime();

			let key: string;
			switch (options.groupBy) {
				case "model":
					key = o.model || "unknown";
					break;
				case "name":
					key = o.name || "unnamed";
					break;
				case "session":
					key = traceMap.get(o.traceId)?.sessionId || "no-session";
					break;
			}

			const existing = latencyGroups.get(key) || [];
			existing.push(latencyMs);
			latencyGroups.set(key, existing);
		}

		// Compute statistics
		const summary: LatencySummaryItem[] = [];

		for (const [key, latencies] of latencyGroups) {
			const sorted = latencies.sort((a, b) => a - b);
			const count = sorted.length;
			const sum = sorted.reduce((a, b) => a + b, 0);

			summary.push({
				key,
				count,
				avgLatencyMs: Math.round(sum / count),
				minLatencyMs: sorted[0],
				maxLatencyMs: sorted[count - 1],
				p50LatencyMs: sorted[Math.floor(count * 0.5)],
				p95LatencyMs: sorted[Math.floor(count * 0.95)] || sorted[count - 1],
			});
		}

		return {
			summary: summary.sort((a, b) => b.avgLatencyMs - a.avgLatencyMs),
		};
	}

	// ---------------------------------------------------------------------------
	// Analytics: Error Patterns
	// ---------------------------------------------------------------------------

	async getErrorPatterns(options: {
		groupBy: "error" | "name" | "model";
		fromTimestamp?: string;
		toTimestamp?: string;
		limit?: number;
	}): Promise<{ patterns: ErrorPatternItem[]; totalErrors: number }> {
		const obs = await this.listObservations({
			limit: options.limit || 100,
			fromStartTime: options.fromTimestamp,
			toStartTime: options.toTimestamp,
		});

		// Filter to errors
		const errors = obs.data.filter(
			(o) => o.level === "ERROR" || o.statusMessage
		);

		// Group errors
		const groups = new Map<string, ErrorPatternItem>();

		for (const o of errors) {
			let key: string;
			switch (options.groupBy) {
				case "error":
					key = o.statusMessage || "unknown-error";
					break;
				case "name":
					key = o.name || "unnamed";
					break;
				case "model":
					key = o.model || "unknown";
					break;
			}

			const existing = groups.get(key) || {
				key,
				count: 0,
				examples: [],
			};

			existing.count++;
			if (existing.examples.length < 3) {
				existing.examples.push({
					traceId: o.traceId,
					message: o.statusMessage,
					timestamp: o.startTime,
				});
			}

			groups.set(key, existing);
		}

		const patterns = Array.from(groups.values()).sort(
			(a, b) => b.count - a.count
		);

		return {
			patterns,
			totalErrors: errors.length,
		};
	}
}

