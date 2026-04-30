#!/usr/bin/env node
/**
 * Simple test client for Langfuse API (without MCP)
 *
 * Tests direct connection to Langfuse to verify credentials and connectivity.
 *
 * Usage:
 *   export LANGFUSE_BASE_URL=http://localhost:3000
 *   export LANGFUSE_SECRET_KEY=sk-lf-xxx
 *   export LANGFUSE_PUBLIC_KEY=pk-lf-xxx
 *   node scripts/test-client.js
 */

const host = process.env.LANGFUSE_BASE_URL || "http://localhost:3000";
const secretKey = process.env.LANGFUSE_SECRET_KEY || "";
const publicKey = process.env.LANGFUSE_PUBLIC_KEY || "";

async function main() {
	console.log("🧪 Testing Langfuse API Connection\n");

	console.log(`📍 Host: ${host}`);
	console.log(`🔑 Public Key: ${publicKey ? publicKey.slice(0, 10) + "..." : "(not set)"}`);
	console.log(`🔑 Secret Key: ${secretKey ? secretKey.slice(0, 10) + "..." : "(not set)"}`);
	console.log("");

	if (!secretKey || !publicKey) {
		console.error("❌ Please set LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY");
		process.exit(1);
	}

	const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
	const authHeader = `Basic ${credentials}`;

	// Test 1: Health check (if available)
	console.log("1️⃣ Testing health endpoint...");
	try {
		const healthResp = await fetch(`${host}/api/public/health`, {
			headers: { Authorization: authHeader },
		});
		if (healthResp.ok) {
			const health = await healthResp.json();
			console.log(`   ✅ Health: ${JSON.stringify(health)}`);
		} else {
			console.log(`   ⚠️ Health endpoint returned ${healthResp.status} (may not exist)`);
		}
	} catch (e) {
		console.log(`   ⚠️ Health check failed: ${e.message}`);
	}

	// Test 2: List traces
	console.log("\n2️⃣ Fetching traces (limit=5)...");
	try {
		const tracesResp = await fetch(`${host}/api/public/traces?limit=5`, {
			headers: { Authorization: authHeader },
		});
		if (!tracesResp.ok) {
			const errorText = await tracesResp.text();
			console.log(`   ❌ Error ${tracesResp.status}: ${errorText}`);
		} else {
			const traces = await tracesResp.json();
			console.log(`   ✅ Found ${traces.data?.length || 0} traces`);
			if (traces.data?.length > 0) {
				console.log(`   📋 First trace: ${traces.data[0].id} (${traces.data[0].name || "unnamed"})`);
			}
		}
	} catch (e) {
		console.log(`   ❌ Failed: ${e.message}`);
	}

	// Test 3: List sessions
	console.log("\n3️⃣ Fetching sessions (limit=5)...");
	try {
		const sessionsResp = await fetch(`${host}/api/public/sessions?limit=5`, {
			headers: { Authorization: authHeader },
		});
		if (!sessionsResp.ok) {
			const errorText = await sessionsResp.text();
			console.log(`   ❌ Error ${sessionsResp.status}: ${errorText}`);
		} else {
			const sessions = await sessionsResp.json();
			console.log(`   ✅ Found ${sessions.sessions?.length || sessions.data?.length || 0} sessions`);
		}
	} catch (e) {
		console.log(`   ❌ Failed: ${e.message}`);
	}

	// Test 4: List observations (generations)
	console.log("\n4️⃣ Fetching observations (limit=5, type=GENERATION)...");
	try {
		const obsResp = await fetch(`${host}/api/public/observations?limit=5&type=GENERATION`, {
			headers: { Authorization: authHeader },
		});
		if (!obsResp.ok) {
			const errorText = await obsResp.text();
			console.log(`   ❌ Error ${obsResp.status}: ${errorText}`);
		} else {
			const obs = await obsResp.json();
			console.log(`   ✅ Found ${obs.data?.length || 0} observations`);
			if (obs.data?.length > 0) {
				const first = obs.data[0];
				console.log(`   📋 First observation:`);
				console.log(`      Model: ${first.model || "unknown"}`);
				console.log(`      Tokens: ${first.usage?.totalTokens || 0}`);
				console.log(`      Cost: $${first.calculatedTotalCost?.toFixed(4) || "?"}`);
			}
		}
	} catch (e) {
		console.log(`   ❌ Failed: ${e.message}`);
	}

	console.log("\n✅ Connection test complete!");
}

main().catch((e) => {
	console.error("❌ Test failed:", e);
	process.exit(1);
});

