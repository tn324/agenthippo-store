---
name: debug-agent
description: Diagnose issues in LLM-powered agents (prompt, tools, context, looping, cost/latency). Optional repro/trace id via ARGUMENTS.
---

# Debug Agent Behavior

Use this skill when an agent isn't behaving as expected: wrong outputs, tool call failures, loops, or unexpected costs.

## Examples

- “Use debug-agent: the agent loops after tool calls”
- “Use debug-agent; trace id: …”
- “Use debug-agent; latency spiked after switching models”

## Guidelines

- If you see an `ARGUMENTS:` line, treat it as the primary lead (repro steps, trace id, failing tool, etc.).
- Distinguish **symptoms** (what we observe) from **root cause** (why it happens) and **fix** (what to change).
- Prefer fixes that improve **reliability** (schemas, retries, stop conditions) and **observability** (clear logs/traces).

## Diagnostic Steps

### 1. Reproduce & Isolate
- Get the exact input that triggers the issue.
- Identify which step in the agent loop fails (prompt → LLM → tool → observation → repeat).

### 2. Inspect the Prompt
- Is the system prompt clear and unambiguous?
- Are tool descriptions accurate and complete?
- Is context being truncated or exceeding token limits?

### 3. Check Tool Execution
- Are tools returning expected schemas?
- Are error messages being surfaced to the LLM?
- Is there a timeout or rate-limit being hit silently?

### 4. Review Observability
- Check traces in Langfuse / Helicone / AgentOps / LangSmith.
- Look for: token counts, latency spikes, repeated identical calls, empty responses.

### 5. Common Failure Patterns
| Symptom | Likely Cause |
|---------|--------------|
| Agent loops endlessly | Missing stop condition or ambiguous success criteria |
| Wrong tool chosen | Tool descriptions overlap or are too vague |
| Hallucinated tool args | Schema not enforced; missing `required` fields |
| Partial responses | Max tokens hit; increase limit or chunk output |
| High cost | Excessive context; consider summarization or retrieval |

## Output

Summarize the root cause and recommend a fix (prompt edit, schema change, retry logic, etc.).

