# DeepSeek Observer Hardening Design

**Date:** 2026-07-20

**Status:** Direction approved, implementation pending

**Scope:** OpenRouter-compatible provider reliability, DeepSeek cache telemetry, log retention, and provider-aware health reporting

## Context

Claude-Mem is configured to use the OpenRouter-compatible provider directly against DeepSeek with `deepseek-v4-flash` and a 20-message context cap. A live comparison found that direct DeepSeek is operational and similar to the prior OpenRouter path, but its first 21 minutes included 38 empty responses and 56 non-XML responses across 240 calls. The existing code treats these as completed provider calls, passes them to `ResponseProcessor`, and confirms the claimed queue batch even though no observation or summary was stored.

The direct DeepSeek API also returns cache accounting fields that Claude-Mem currently discards. DeepSeek documents `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` in the chat-completion `usage` object, with `prompt_tokens` equal to their sum. Claude-Mem can therefore measure cache reuse directly without inspecting prompt content.

The local installation has 931 MB of logs across 129 daily files because the logger creates a daily file but never removes old ones. The health endpoint also resolves the active provider correctly but always reports the Claude-specific authentication description.

## Goals

1. Recover one empty or structurally invalid observation or summary response before the queue batch is discarded.
2. Expose provider-reported DeepSeek cache hit and miss token counts in local logs and privacy-scrubbed telemetry.
3. Bound daily Claude-Mem log growth automatically with a configurable retention period.
4. Make `/api/health` describe the authentication method of the selected provider without exposing credential values or credential locations unnecessarily.

## Non-goals

- Changing the selected model, direct DeepSeek base URL, or 20-message context cap.
- Retrying valid XML that parses but contains no useful observation content.
- Replacing XML with tool calling or JSON schema output.
- Requeuing malformed responses indefinitely.
- Estimating cache usage when the provider omits cache fields.
- Deleting database, Chroma, backup, runner-error, or non-daily log files.
- Adding a new provider enum for DeepSeek. It remains an OpenRouter-compatible custom endpoint.

## Decision 1: One bounded format-repair request

### Placement

Format repair will live in `OpenAICompatibleProvider`, immediately after a provider query and before `processAgentResponse`. It will be opt-in through a protected provider capability enabled by `OpenRouterProvider`. Gemini behavior will remain unchanged.

This boundary has the information needed to retry safely and is early enough to prevent `ResponseProcessor` from confirming and discarding the claimed batch.

### Validity check

The shared `parseAgentXml` parser is the source of truth. A response needs repair when `parseAgentXml(content).valid` is false, including empty and whitespace-only content. XML-shaped output that fails the parser is also invalid.

### Repair conversation

For an invalid observation or summary response:

1. Copy the stable conversation history already used for the original request.
2. If the invalid response is non-empty, append it to the copied history as an assistant message.
3. Append one short user correction that says the prior response violated the output protocol and asks for only the required XML form.
4. Call the same provider exactly once with that copied history and the same configuration.
5. Accept the repair only when `parseAgentXml` reports a valid result.

Neither the correction prompt nor the invalid response is written into `session.conversationHistory`. The caller appends only a successful repaired response. This keeps the durable multi-turn prefix stable and prevents corrective scaffolding from accumulating.

The provider's existing `query()` path still applies the 20-message cap. Because the repair request preserves the stable prefix and changes only the suffix, it remains eligible for DeepSeek prefix caching.

### Failure behavior

The repair is content-level, not transport-level. Existing HTTP retry rules remain responsible for rate limits and transient network or upstream failures.

If the repair call throws, that error follows the existing session error path. If the repair returns another invalid response, the original behavior is preserved: the final invalid content is passed to `ResponseProcessor`, classified, logged, confirmed, and discarded. There is no second content repair and no requeue loop.

The logs will record a repair attempt and one of `succeeded`, `still_invalid`, or `failed`, using only provider name, session identifier, and output class. Raw model output will not be logged by the new repair path.

### Alternatives rejected

- **Parser-level requeue:** Rejected because it can repeat the same malformed generation without a corrective prompt and can create observer loops.
- **Prompt tightening only:** Rejected because it cannot recover an empty response and the current strict XML prompts still produce malformed output.
- **Unbounded or multi-attempt repair:** Rejected because it increases cost and latency and can turn a format defect into a stuck queue.

## Decision 2: Provider cache telemetry

`OpenRouterResponse.usage` will accept these optional numeric fields:

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`

They will flow through `ProviderQueryResult` and `ActiveSession.lastUsage` as optional values. A missing field stays absent rather than being reported as zero. Non-finite values are ignored.

For each response that includes usage, the existing `OpenRouter API usage` log entry will include `cacheHitTokens` and `cacheMissTokens` when present.

The `session_compressed` telemetry event will add:

- `cache_hit_tokens`
- `cache_miss_tokens`

The per-session `observer_turn_rollup` will add:

- `total_cache_hit_tokens`
- `total_cache_miss_tokens`

The telemetry scrubber will whitelist only these numeric counters. No prompt, response, cache key, project name, or credential data is added. Tests will prove that the rollup sums finite values and that the scrubber rejects non-primitive or unapproved data.

This reflects DeepSeek's documented usage response directly. It does not claim a cache hit rate when either counter is absent. A consumer can calculate hit rate as `hit / (hit + miss)` only when the denominator is greater than zero.

## Decision 3: Automatic daily-log retention

Add a setting named `CLAUDE_MEM_LOG_RETENTION_DAYS` with a default of `30`.

- A positive integer retains matching daily log files whose date is within that many calendar days, including the current day.
- `0` disables automatic pruning.
- Invalid, negative, or non-integer values fall back to `30`.
- The accepted maximum is `365` days to prevent accidental unbounded configuration.

On the logger's existing lazy file initialization, a best-effort pruning helper will scan only `paths.logsDir()` and remove files that exactly match `claude-mem-YYYY-MM-DD.log` when the encoded date is older than the retention cutoff. It will never remove the current file, directories, `runner-errors.log`, or files with another naming pattern.

Pruning failure must not prevent the current log file from being created or written. A concise console diagnostic may report the failure without recursively invoking the logger.

The pruning helper will accept an explicit directory and current date so unit tests can use a temporary directory and deterministic dates.

## Decision 4: Provider-aware health authentication

Add a pure provider-aware description helper in `EnvManager`:

- `claude`: preserve the current Claude API key, gateway token, or OAuth description.
- `openrouter`: `OpenRouter-compatible API key`.
- `gemini`: `Gemini API key`.

`worker-service` will pass the resolved provider to this helper. The endpoint will continue reporting `provider: "openrouter"` for a direct DeepSeek-compatible base URL because that is the configured Claude-Mem provider implementation. The authentication description will no longer claim that Claude OAuth is serving that provider.

The health response will not disclose the API key, base URL, settings path, environment-variable name, or whether a key came from a specific secret store.

## Data flow

```text
queued observation or summary
  -> stable conversation history
  -> OpenRouter-compatible query
  -> valid XML? -> yes -> append response -> store observation or summary
       |
       no
       -> copied history + one correction suffix
       -> one repair query
       -> valid XML? -> yes -> append repaired response -> store
            |
            no
            -> existing classify, confirm, and discard fallback

provider usage
  -> input/output/cache token fields
  -> local usage log
  -> lastUsage
  -> privacy scrubber
  -> per-session rollup totals
```

## Test strategy

Implementation will follow test-first development. Each behavior begins with a focused failing test and the failure must be caused by the missing behavior.

### Format repair

- An empty observation response triggers exactly one repair query.
- A prose or malformed XML response triggers exactly one repair query.
- A valid repair is the only assistant response appended to stable history and is processed normally.
- The copied repair request includes the invalid non-empty output and correction but does not mutate stable history.
- A second invalid response is forwarded to the existing discard path with no third query.
- A valid initial response makes only one provider query.
- Gemini does not acquire repair behavior.
- The 20-message cap still applies to both original and repair calls.

### Cache telemetry

- DeepSeek cache hit and miss fields are parsed and returned when present.
- Missing fields remain absent.
- `lastUsage` carries finite cache values.
- Telemetry scrub permits the four new per-turn and rollup numeric fields.
- Per-session rollup totals sum cache hits and misses independently.

### Log retention

- Default setting is `30` and API validation accepts integers from `0` through `365`.
- Files older than the cutoff with the exact daily-log name are deleted.
- The current file, files within retention, unrelated files, and directories remain.
- `0` makes no deletions.
- A deletion error does not prevent logger initialization.

### Health

- Claude health preserves its current description behavior.
- OpenRouter-selected health reports `OpenRouter-compatible API key`.
- Gemini-selected health reports `Gemini API key`.
- No credential value or secret source is present.

### Regression and live verification

Run the focused provider, response processor, telemetry, logger, settings, and worker API test suites first. Then run the repository's normal typecheck and broader test gate. After installing the built plugin locally, verify:

1. `/api/health` reports the OpenRouter-compatible authentication method.
2. A DeepSeek usage log contains cache hit and miss counters when the API returns them.
3. A synthetic malformed first response is recovered by one valid repair, with only the repaired output stored.
4. A temporary old daily log is pruned while unrelated files remain.
5. The configured model and context cap remain `deepseek-v4-flash` and `20`.

## Rollout and rollback

The changes are local and backward-compatible. Missing cache fields do not change existing providers. Format repair is opt-in for the OpenRouter-compatible provider. Log pruning is bounded to an exact filename pattern and can be disabled with retention `0`.

Rollback is a normal revert of the implementation commit. The existing invalid-output discard path remains intact, so removing the repair restores current behavior without a migration. Telemetry additions are optional fields, health is response text only, and log retention has no persisted schema.

## Acceptance criteria

- One and only one content repair occurs for an invalid OpenRouter-compatible observation or summary response.
- No repair metadata pollutes durable conversation history.
- DeepSeek cache hit and miss token counts are visible locally and survive session telemetry rollup when the API supplies them.
- Daily Claude-Mem logs have a safe 30-day default retention with a disable switch.
- `/api/health` no longer reports Claude OAuth when OpenRouter-compatible or Gemini is active.
- All focused and repository verification gates pass with no secret values in code, tests, logs, telemetry, or health output.
