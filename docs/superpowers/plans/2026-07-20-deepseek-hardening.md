# DeepSeek Observer Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover one malformed OpenRouter-compatible observer response, measure DeepSeek context-cache reuse, bound daily logs, and report provider authentication correctly.

**Architecture:** Add an opt-in format-repair wrapper at the shared OpenAI-compatible provider boundary, then carry optional provider cache counters through existing usage and telemetry types. Add a pure daily-log pruning helper called during lazy logger initialization and a pure provider-auth description helper used by worker health.

**Tech Stack:** TypeScript, Bun test runner, Express worker API, PostHog telemetry scrubber and rollup buffer, Node filesystem APIs.

## Global Constraints

- Keep the direct DeepSeek endpoint, `deepseek-v4-flash`, and `CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES=20` unchanged.
- Make at most one content-level repair query per invalid OpenRouter-compatible observation or summary.
- Do not add repair messages or invalid model output to durable conversation history.
- Leave missing provider cache counters absent rather than estimating or coercing them to zero.
- Default `CLAUDE_MEM_LOG_RETENTION_DAYS` to `30`; `0` disables pruning; accepted values are integers from `0` through `365`.
- Delete only exact `claude-mem-YYYY-MM-DD.log` files older than the calendar cutoff.
- Do not expose credential values, secret sources, base URLs, prompts, responses, or project names in health, logs, or telemetry.

---

## File Structure

- `src/services/worker/OpenAICompatibleProvider.ts`: owns the optional one-shot content repair wrapper and calls it for observation and summary turns.
- `src/services/worker/OpenRouterProvider.ts`: enables repair and normalizes DeepSeek cache usage counters.
- `src/services/worker-types.ts`: extends the existing per-turn usage shape with optional cache counters.
- `src/services/worker/agents/ResponseProcessor.ts`: forwards cache counters into `session_compressed` telemetry.
- `src/services/telemetry/buffer.ts`: sums per-turn cache counters into session rollups.
- `src/services/telemetry/scrub.ts`: permits only the new numeric telemetry fields.
- `src/utils/logger.ts`: parses retention and prunes exact daily-log files during lazy initialization.
- `src/shared/SettingsDefaultsManager.ts`: declares the retention setting and its default.
- `src/services/worker/http/routes/SettingsRoutes.ts`: persists and validates retention updates.
- `src/shared/EnvManager.ts`: maps selected provider to a safe auth description.
- `src/services/worker-service.ts`: passes the resolved provider to the auth-description helper.
- `tests/openrouter_provider.test.ts`: covers repair behavior, context cap, and cache usage normalization.
- `tests/telemetry/buffer.test.ts`: covers cache rollup sums.
- `tests/telemetry/scrub.test.ts`: covers cache-field privacy whitelist behavior.
- `tests/utils/logger-retention.test.ts`: covers deterministic retention parsing and pruning.
- `tests/shared/settings-defaults-manager.test.ts`: covers the new default.
- `tests/worker/settings-routes.test.ts`: covers retention validation.
- `tests/shared/env-manager-auth-description.test.ts`: covers provider-aware health descriptions.

### Task 1: One-shot OpenRouter-compatible format repair

**Files:**
- Modify: `tests/openrouter_provider.test.ts`
- Modify: `src/services/worker/OpenAICompatibleProvider.ts`
- Modify: `src/services/worker/OpenRouterProvider.ts`

**Interfaces:**
- Consumes: `parseAgentXml(raw: string)` and `classifyObserverOutput(raw: unknown)`.
- Produces: `protected readonly repairInvalidResponses: boolean` and `protected queryWithFormatRepair(history, config, sessionId): Promise<ProviderQueryResult>`.

- [ ] **Step 1: Write focused failing repair tests**

Add a test subclass that exposes the protected wrapper and queues normalized results without invoking the database path:

```ts
class RepairProbeProvider extends OpenRouterProvider {
  readonly queued: ProviderQueryResult[] = [];
  readonly histories: ConversationMessage[][] = [];

  protected override async query(
    history: ConversationMessage[],
    _config: any,
  ): Promise<ProviderQueryResult> {
    this.histories.push(history.map(message => ({ ...message })));
    return this.queued.shift() ?? { content: '' };
  }

  repairForTest(history: ConversationMessage[]) {
    return this.queryWithFormatRepair(
      history,
      { apiKey: 'test', model: 'test/model', maxContextMessages: 20, apiUrl: 'https://api.deepseek.com/chat/completions' },
      17,
    );
  }
}
```

Cover these cases:

```ts
it('repairs an empty response exactly once without mutating stable history', async () => {
  const stable = [{ role: 'user' as const, content: 'Return observation XML' }];
  const provider = new RepairProbeProvider({} as any, {} as any);
  provider.queued.push(
    { content: '' },
    { content: '<observation><type>discovery</type><title>Recovered</title></observation>' },
  );

  const result = await provider.repairForTest(stable);

  expect(result.content).toContain('<observation>');
  expect(provider.histories).toHaveLength(2);
  expect(provider.histories[1]?.at(-1)?.content).toContain('required output protocol');
  expect(stable).toEqual([{ role: 'user', content: 'Return observation XML' }]);
});

it('includes invalid prose only in the copied repair history', async () => {
  const provider = new RepairProbeProvider({} as any, {} as any);
  provider.queued.push(
    { content: 'I cannot produce that.' },
    { content: '<skip_summary reason="nothing to add"/>' },
  );

  await provider.repairForTest([{ role: 'user', content: 'Return summary XML' }]);

  expect(provider.histories[1]?.at(-2)).toEqual({ role: 'assistant', content: 'I cannot produce that.' });
  expect(provider.histories[1]?.at(-1)?.role).toBe('user');
});

it('returns the second invalid response without a third query', async () => {
  const provider = new RepairProbeProvider({} as any, {} as any);
  provider.queued.push({ content: '' }, { content: 'still prose' });

  const result = await provider.repairForTest([{ role: 'user', content: 'Return XML' }]);

  expect(result.content).toBe('still prose');
  expect(provider.histories).toHaveLength(2);
});

it('does not repair a valid initial response', async () => {
  const provider = new RepairProbeProvider({} as any, {} as any);
  provider.queued.push({ content: '<skip_summary reason="nothing to add"/>' });

  await provider.repairForTest([{ role: 'user', content: 'Return summary XML' }]);

  expect(provider.histories).toHaveLength(1);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `bun test tests/openrouter_provider.test.ts`

Expected: FAIL because `queryWithFormatRepair` and the repair capability do not exist.

- [ ] **Step 3: Implement the minimal repair wrapper**

In `OpenAICompatibleProvider.ts`, import the parser and classifier, default repair off, and add the protected wrapper:

```ts
protected readonly repairInvalidResponses = false;

protected async queryWithFormatRepair(
  history: ConversationMessage[],
  config: TConfig,
  sessionId: string | number,
): Promise<ProviderQueryResult> {
  const initial = await this.query(history, config);
  if (!this.repairInvalidResponses || parseAgentXml(initial.content).valid) {
    return initial;
  }

  const repairHistory = history.map(message => ({ ...message }));
  if (initial.content.trim()) {
    repairHistory.push({ role: 'assistant', content: initial.content });
  }
  repairHistory.push({
    role: 'user',
    content: 'Your previous response violated the required output protocol. Return only the XML form requested by the preceding user message. Do not include markdown fences, prose, or explanation.',
  });

  logger.warn('SDK', `${this.providerName} format repair attempted`, {
    sessionId,
    outputClass: classifyObserverOutput(initial.content),
  });

  try {
    const repaired = await this.query(repairHistory, config);
    const repairedIsValid = parseAgentXml(repaired.content).valid;
    if (repairedIsValid) {
      logger.info('SDK', `${this.providerName} format repair succeeded`, {
        sessionId,
        outputClass: classifyObserverOutput(repaired.content),
      });
    } else {
      logger.warn('SDK', `${this.providerName} format repair still invalid`, {
        sessionId,
        outputClass: classifyObserverOutput(repaired.content),
      });
    }
    return repaired;
  } catch (error: unknown) {
    logger.error('SDK', `${this.providerName} format repair failed`, { sessionId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
```

Enable it in `OpenRouterProvider`:

```ts
protected override readonly repairInvalidResponses = true;
```

Replace only observation and summary calls:

```ts
const obsResponse = await this.queryWithFormatRepair(
  session.conversationHistory,
  config,
  session.sessionDbId,
);
```

```ts
const summaryResponse = await this.queryWithFormatRepair(
  session.conversationHistory,
  config,
  session.sessionDbId,
);
```

Do not change the init query.

- [ ] **Step 4: Run repair and response fallback tests**

Run: `bun test tests/openrouter_provider.test.ts tests/worker/agents/response-processor.test.ts`

Expected: PASS. The existing invalid-output confirmation test proves the one-repair failure fallback still drains the batch.

- [ ] **Step 5: Commit repair behavior**

```bash
git add tests/openrouter_provider.test.ts src/services/worker/OpenAICompatibleProvider.ts src/services/worker/OpenRouterProvider.ts
git commit -m "fix: repair malformed observer output once"
```

### Task 2: DeepSeek cache usage telemetry

**Files:**
- Modify: `tests/openrouter_provider.test.ts`
- Modify: `tests/telemetry/buffer.test.ts`
- Modify: `tests/telemetry/scrub.test.ts`
- Modify: `src/services/worker/OpenRouterProvider.ts`
- Modify: `src/services/worker/OpenAICompatibleProvider.ts`
- Modify: `src/services/worker-types.ts`
- Modify: `src/services/worker/agents/ResponseProcessor.ts`
- Modify: `src/services/telemetry/buffer.ts`
- Modify: `src/services/telemetry/scrub.ts`

**Interfaces:**
- Produces: `ProviderQueryResult.cacheHitTokens?: number`, `ProviderQueryResult.cacheMissTokens?: number`, and matching optional `lastUsage.cacheHit/cacheMiss` values.
- Produces telemetry keys: `cache_hit_tokens`, `cache_miss_tokens`, `total_cache_hit_tokens`, `total_cache_miss_tokens`.

- [ ] **Step 1: Write failing provider and telemetry tests**

Expose provider query and usage normalization from a test subclass, then mock a DeepSeek response:

```ts
global.fetch = mock(async () => new Response(JSON.stringify({
  model: 'deepseek-v4-flash',
  choices: [{ message: { content: '<skip_summary reason="nothing to add"/>' } }],
  usage: {
    prompt_tokens: 2195,
    completion_tokens: 12,
    total_tokens: 2207,
    prompt_cache_hit_tokens: 2176,
    prompt_cache_miss_tokens: 19,
  },
})));

expect(result.cacheHitTokens).toBe(2176);
expect(result.cacheMissTokens).toBe(19);
expect(provider.usageForTest(result)).toEqual({
  input: 2195,
  output: 12,
  cacheHit: 2176,
  cacheMiss: 19,
});
```

Add a second response without cache fields and assert both properties are absent.

In `buffer.test.ts`, record two turns and assert sums:

```ts
telemetryBuffer.record('session_compressed', 71, { cache_hit_tokens: 2100, cache_miss_tokens: 100 });
telemetryBuffer.record('session_compressed', 71, { cache_hit_tokens: 1800, cache_miss_tokens: 200 });
telemetryBuffer.flushSession(71, 'session_end');
const props = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
expect(props.total_cache_hit_tokens).toBe(3900);
expect(props.total_cache_miss_tokens).toBe(300);
```

In `scrub.test.ts`, assert the four numeric keys survive and unknown cache metadata is dropped.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `bun test tests/openrouter_provider.test.ts tests/telemetry/buffer.test.ts tests/telemetry/scrub.test.ts`

Expected: FAIL because cache properties are not parsed, typed, rolled up, or whitelisted.

- [ ] **Step 3: Normalize provider cache counters**

Extend `ProviderQueryResult`:

```ts
cacheHitTokens?: number;
cacheMissTokens?: number;
```

Extend OpenRouter usage and result construction:

```ts
prompt_cache_hit_tokens?: number;
prompt_cache_miss_tokens?: number;
```

```ts
const cacheHitTokens = Number.isFinite(data.usage?.prompt_cache_hit_tokens)
  ? data.usage?.prompt_cache_hit_tokens
  : undefined;
const cacheMissTokens = Number.isFinite(data.usage?.prompt_cache_miss_tokens)
  ? data.usage?.prompt_cache_miss_tokens
  : undefined;
```

Include optional `cacheHitTokens` and `cacheMissTokens` in the usage log and returned result. Extend `ActiveSession.lastUsage` and `buildLastUsage`:

```ts
lastUsage?: {
  input: number;
  output: number;
  costUsd?: number;
  cacheHit?: number;
  cacheMiss?: number;
} | null;
```

- [ ] **Step 4: Carry cache counters through telemetry**

In `ResponseProcessor.ts` add:

```ts
cache_hit_tokens: usage?.cacheHit,
cache_miss_tokens: usage?.cacheMiss,
```

In `buffer.ts`, add both per-turn fields, finite-number accumulators, and rollup properties:

```ts
total_cache_hit_tokens: totalCacheHitTokens,
total_cache_miss_tokens: totalCacheMissTokens,
```

In `scrub.ts`, whitelist all four exact property names.

- [ ] **Step 5: Run provider and telemetry tests**

Run: `bun test tests/openrouter_provider.test.ts tests/telemetry/buffer.test.ts tests/telemetry/scrub.test.ts tests/worker/agents/response-processor.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit cache telemetry**

```bash
git add tests/openrouter_provider.test.ts tests/telemetry/buffer.test.ts tests/telemetry/scrub.test.ts src/services/worker/OpenRouterProvider.ts src/services/worker/OpenAICompatibleProvider.ts src/services/worker-types.ts src/services/worker/agents/ResponseProcessor.ts src/services/telemetry/buffer.ts src/services/telemetry/scrub.ts
git commit -m "feat: report DeepSeek cache usage"
```

### Task 3: Safe daily-log retention

**Files:**
- Create: `tests/utils/logger-retention.test.ts`
- Create: `tests/worker/settings-routes.test.ts`
- Modify: `tests/shared/settings-defaults-manager.test.ts`
- Modify: `src/utils/logger.ts`
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/services/worker/http/routes/SettingsRoutes.ts`

**Interfaces:**
- Produces: `parseLogRetentionDays(value: unknown): number`.
- Produces: `pruneOldDailyLogs(logsDir: string, now: Date, retentionDays: number): void`.
- Produces: `validateLogRetentionDays(value: unknown): { valid: boolean; error?: string }`.

- [ ] **Step 1: Write failing retention tests**

Create a temporary directory test that writes exact daily logs, an unrelated file, and a directory:

```ts
expect(parseLogRetentionDays(undefined)).toBe(30);
expect(parseLogRetentionDays('0')).toBe(0);
expect(parseLogRetentionDays('365')).toBe(365);
expect(parseLogRetentionDays('-1')).toBe(30);
expect(parseLogRetentionDays('1.5')).toBe(30);
expect(parseLogRetentionDays('366')).toBe(30);

pruneOldDailyLogs(tempDir, new Date('2026-07-20T12:00:00Z'), 30);
expect(existsSync(join(tempDir, 'claude-mem-2026-06-20.log'))).toBe(false);
expect(existsSync(join(tempDir, 'claude-mem-2026-06-21.log'))).toBe(true);
expect(existsSync(join(tempDir, 'claude-mem-2026-07-20.log'))).toBe(true);
expect(existsSync(join(tempDir, 'runner-errors.log'))).toBe(true);
expect(existsSync(join(tempDir, 'claude-mem-2026-01-01.log.backup'))).toBe(true);
```

Add a separate `retentionDays=0` test proving no files are removed. Add settings tests asserting the default is `'30'` and validator accepts `'0'`, `'30'`, and `'365'` but rejects `'-1'`, `'1.5'`, `'366'`, and non-numeric strings.

- [ ] **Step 2: Run retention tests and verify RED**

Run: `bun test tests/utils/logger-retention.test.ts tests/shared/settings-defaults-manager.test.ts tests/worker/settings-routes.test.ts`

Expected: FAIL because the setting, parser, pruning helper, and validator do not exist.

- [ ] **Step 3: Implement retention parsing and pruning**

In `logger.ts`, import `readdirSync` and `unlinkSync`, then add:

```ts
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export function parseLogRetentionDays(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^\d+$/.test(text)) return DEFAULT_LOG_RETENTION_DAYS;
  const days = Number(text);
  return Number.isSafeInteger(days) && days >= 0 && days <= 365
    ? days
    : DEFAULT_LOG_RETENTION_DAYS;
}
```

Implement `pruneOldDailyLogs` using `readdirSync(logsDir, { withFileTypes: true })`, exact regex `^claude-mem-(\d{4}-\d{2}-\d{2})\.log$`, valid UTC date round-tripping, and a cutoff equal to `now UTC midnight - (retentionDays - 1) days`. Return immediately for `0`.

During `ensureLogFileInitialized`, read `CLAUDE_MEM_LOG_RETENTION_DAYS` from environment first and settings second, call the parser, and invoke pruning inside its own `try/catch` before assigning the current log path. A pruning error prints one console diagnostic and does not null the current log path.

- [ ] **Step 4: Add and validate the setting**

Add to `SettingsDefaults` and `DEFAULTS`:

```ts
CLAUDE_MEM_LOG_RETENTION_DAYS: string;
```

```ts
CLAUDE_MEM_LOG_RETENTION_DAYS: '30',
```

Export a route validator:

```ts
export function validateLogRetentionDays(value: unknown): { valid: boolean; error?: string } {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^\d+$/.test(text)) {
    return { valid: false, error: 'CLAUDE_MEM_LOG_RETENTION_DAYS must be an integer between 0 and 365' };
  }
  const days = Number(text);
  return Number.isSafeInteger(days) && days >= 0 && days <= 365
    ? { valid: true }
    : { valid: false, error: 'CLAUDE_MEM_LOG_RETENTION_DAYS must be an integer between 0 and 365' };
}
```

Add the key to `settingKeys` and call the validator from `validateSettings` whenever the request includes the key.

- [ ] **Step 5: Run retention tests**

Run: `bun test tests/utils/logger-retention.test.ts tests/shared/settings-defaults-manager.test.ts tests/worker/settings-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit retention behavior**

```bash
git add tests/utils/logger-retention.test.ts tests/worker/settings-routes.test.ts tests/shared/settings-defaults-manager.test.ts src/utils/logger.ts src/shared/SettingsDefaultsManager.ts src/services/worker/http/routes/SettingsRoutes.ts
git commit -m "feat: prune expired daily logs"
```

### Task 4: Provider-aware health auth reporting

**Files:**
- Create: `tests/shared/env-manager-auth-description.test.ts`
- Modify: `src/shared/EnvManager.ts`
- Modify: `src/services/worker-service.ts`

**Interfaces:**
- Produces: `getProviderAuthMethodDescription(provider: 'claude' | 'gemini' | 'openrouter'): string`.

- [ ] **Step 1: Write the failing auth-description test**

```ts
import {
  getAuthMethodDescription,
  getProviderAuthMethodDescription,
} from '../../src/shared/EnvManager.js';

expect(getProviderAuthMethodDescription('openrouter')).toBe('OpenRouter-compatible API key');
expect(getProviderAuthMethodDescription('gemini')).toBe('Gemini API key');
expect(getProviderAuthMethodDescription('claude')).toBe(getAuthMethodDescription());
```

- [ ] **Step 2: Run the auth test and verify RED**

Run: `bun test tests/shared/env-manager-auth-description.test.ts`

Expected: FAIL because `getProviderAuthMethodDescription` is not exported.

- [ ] **Step 3: Implement the provider-aware helper and health call**

In `EnvManager.ts`:

```ts
export function getProviderAuthMethodDescription(
  provider: 'claude' | 'gemini' | 'openrouter',
): string {
  if (provider === 'openrouter') return 'OpenRouter-compatible API key';
  if (provider === 'gemini') return 'Gemini API key';
  return getAuthMethodDescription();
}
```

In `worker-service.ts`, import the new helper and use:

```ts
authMethod: getProviderAuthMethodDescription(provider),
```

- [ ] **Step 4: Run auth and worker API tests**

Run: `bun test tests/shared/env-manager-auth-description.test.ts tests/integration/worker-api-endpoints.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit health reporting**

```bash
git add tests/shared/env-manager-auth-description.test.ts src/shared/EnvManager.ts src/services/worker-service.ts
git commit -m "fix: report provider auth in health"
```

### Task 5: Integrated verification, local rollout, and publication

**Files:**
- Modify only if a failing verification gate exposes a defect in the files already listed.

**Interfaces:**
- Consumes all four independently committed behaviors.
- Produces a verified local plugin and a merged fork pull request.

- [ ] **Step 1: Run the focused regression gate**

Run:

```bash
bun test tests/openrouter_provider.test.ts tests/worker/agents/response-processor.test.ts tests/telemetry/buffer.test.ts tests/telemetry/scrub.test.ts tests/utils/logger-retention.test.ts tests/shared/settings-defaults-manager.test.ts tests/worker/settings-routes.test.ts tests/shared/env-manager-auth-description.test.ts tests/integration/worker-api-endpoints.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run static and repository gates**

Run:

```bash
npm run typecheck
npm run lint:hook-io
npm run lint:spawn-env
npm test
npm run build
git diff --check desmond/main...HEAD
```

Expected: every command exits `0`.

- [ ] **Step 3: Prove the repair guard bites**

Temporarily invert the repair validity check in the working tree, run the focused repair test, and verify it fails because a valid first response is repaired or an invalid response is not repaired. Restore the line with `apply_patch`, rerun `bun test tests/openrouter_provider.test.ts`, and confirm PASS. Do not commit the temporary mutation.

- [ ] **Step 4: Build and install the plugin locally**

Run the repository build and sync path already used by this checkout, then restart the worker. Verify the worker reports ready before exercising health and logs. Do not print settings or credential values.

- [ ] **Step 5: Verify live health, cache, retention, and unchanged configuration**

Use the local worker health endpoint to assert provider `openrouter` and auth method `OpenRouter-compatible API key`. Trigger a normal observation and inspect only structured usage keys in the newest log to confirm cache hit and miss counters appear when DeepSeek returns them. Use a temporary isolated logs directory to prove an expired exact daily log is removed and an unrelated file remains. Read back only the model name and context-cap setting, expecting `deepseek-v4-flash` and `20`.

- [ ] **Step 6: Push the feature branch and open the fork pull request**

```bash
git push -u desmond codex/deepseek-hardening
gh pr create --repo desmond-rai/claude-mem --base main --head codex/deepseek-hardening --title "Harden DeepSeek observer reliability" --body $'## Summary\n- repair one malformed OpenRouter-compatible observer response\n- report DeepSeek cache hit and miss tokens\n- prune expired daily logs\n- report provider-aware health authentication\n\n## Verification\n- focused Bun test gate\n- npm run typecheck\n- npm test\n- npm run build'
```

The PR body must summarize the four changes and list exact verification commands and outcomes. It must not contain credentials or local paths.

- [ ] **Step 7: Merge and verify the merged result**

After required checks pass, merge the PR without force-pushing. Fetch `desmond/main`, create or use a clean verification worktree at the merged SHA, and rerun the focused regression gate there. Confirm the PR state is `MERGED`, record the merge SHA, and report whether the local feature worktree remains clean.
