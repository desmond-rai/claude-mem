import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { OpenRouterProvider } from '../src/services/worker/OpenRouterProvider.js';
import type { ProviderQueryResult } from '../src/services/worker/OpenAICompatibleProvider.js';
import type { ConversationMessage } from '../src/services/worker-types.js';
import type { DatabaseManager } from '../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../src/services/worker/SessionManager.js';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'observation prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

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

  repairForTest(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return this.queryWithFormatRepair(
      history,
      {
        apiKey: 'test-api-key',
        model: 'test/model',
        maxContextMessages: 20,
        apiUrl: 'https://api.deepseek.com/chat/completions',
      },
      17,
    );
  }
}

class FetchRepairProbeProvider extends OpenRouterProvider {
  private readonly testConfig = {
    apiKey: 'test-api-key',
    model: 'test/model',
    maxContextMessages: 20,
    apiUrl: 'https://api.deepseek.com/chat/completions',
  };

  repairForTest(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return this.queryWithFormatRepair(
      history,
      this.testConfig,
      18,
    );
  }

  queryForTest(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return this.query(history, this.testConfig);
  }

  usageForTest(result: ProviderQueryResult) {
    return this.buildLastUsage(result);
  }
}

describe('OpenRouterProvider context cap', () => {
  let originalFetch: typeof global.fetch;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let modeManagerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    }) as any);
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-api-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'test/model',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',
    }) as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    loadFromFileSpy.mockRestore();
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('caps outbound history while preserving the first observer prompt and newest messages', async () => {
    const originalHistory = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 0 ? 'original observer prompt' : `message-${index}`,
    }));
    let sentMessages: Array<{ role: string; content: string }> = [];

    global.fetch = mock(async (_url, init) => {
      sentMessages = JSON.parse(String(init?.body)).messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    });

    const dbManager = {} as DatabaseManager;
    const sessionManager = {
      getMessageIterator: async function* () { yield* []; },
    } as unknown as SessionManager;
    const provider = new OpenRouterProvider(dbManager, sessionManager);
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'memory-session',
      project: 'test-project',
      userPrompt: 'current prompt',
      conversationHistory: originalHistory.map(message => ({ ...message })),
      lastPromptNumber: 2,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    await provider.startSession(session);

    expect(sentMessages).toHaveLength(20);
    expect(sentMessages[0]?.content).toBe('original observer prompt');
    expect(sentMessages.at(-1)?.content).toContain('current prompt');
    expect(session.conversationHistory).toHaveLength(31);
  });

  it('repairs an empty response exactly once without mutating stable history', async () => {
    const stable = [{ role: 'user' as const, content: 'Return observation XML' }];
    const provider = new RepairProbeProvider({} as DatabaseManager, {} as SessionManager);
    provider.queued.push(
      { content: '' },
      { content: '<skip_summary reason="nothing to add"/>' },
    );

    const result = await provider.repairForTest(stable);

    expect(result.content).toContain('<skip_summary');
    expect(provider.histories).toHaveLength(2);
    expect(provider.histories[1]?.at(-1)?.content).toContain('required output protocol');
    expect(stable).toEqual([{ role: 'user', content: 'Return observation XML' }]);
  });

  it('includes invalid prose only in the copied repair history', async () => {
    const stable = [{ role: 'user' as const, content: 'Return summary XML' }];
    const provider = new RepairProbeProvider({} as DatabaseManager, {} as SessionManager);
    provider.queued.push(
      { content: 'I cannot produce that.' },
      { content: '<skip_summary reason="nothing to add"/>' },
    );

    await provider.repairForTest(stable);

    expect(provider.histories[1]?.at(-2)).toEqual({
      role: 'assistant',
      content: 'I cannot produce that.',
    });
    expect(provider.histories[1]?.at(-1)?.role).toBe('user');
    expect(stable).toEqual([{ role: 'user', content: 'Return summary XML' }]);
  });

  it('returns the second invalid response without a third query', async () => {
    const provider = new RepairProbeProvider({} as DatabaseManager, {} as SessionManager);
    provider.queued.push({ content: '' }, { content: 'still prose' });

    const result = await provider.repairForTest([{ role: 'user', content: 'Return XML' }]);

    expect(result.content).toBe('still prose');
    expect(provider.histories).toHaveLength(2);
  });

  it('does not repair a valid initial response', async () => {
    const provider = new RepairProbeProvider({} as DatabaseManager, {} as SessionManager);
    provider.queued.push({ content: '<skip_summary reason="nothing to add"/>' });

    await provider.repairForTest([{ role: 'user', content: 'Return summary XML' }]);

    expect(provider.histories).toHaveLength(1);
  });

  it('keeps the 20-message cap on both the original and repair requests', async () => {
    const sentHistories: Array<Array<{ role: string; content: string }>> = [];
    let requestCount = 0;
    global.fetch = mock(async (_url, init) => {
      sentHistories.push(JSON.parse(String(init?.body)).messages);
      requestCount++;
      const content = requestCount === 1
        ? ''
        : '<skip_summary reason="nothing to add"/>';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    });

    const stable = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 0 ? 'original observer prompt' : `message-${index}`,
    }));
    const provider = new FetchRepairProbeProvider({} as DatabaseManager, {} as SessionManager);

    await provider.repairForTest(stable);

    expect(sentHistories).toHaveLength(2);
    expect(sentHistories[0]).toHaveLength(20);
    expect(sentHistories[1]).toHaveLength(20);
    expect(sentHistories[0]?.[0]?.content).toBe('original observer prompt');
    expect(sentHistories[1]?.[0]?.content).toBe('original observer prompt');
    expect(sentHistories[1]?.at(-1)?.content).toContain('required output protocol');
    expect(stable).toHaveLength(30);
  });

  it('normalizes DeepSeek cache hit and miss usage', async () => {
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
    const provider = new FetchRepairProbeProvider({} as DatabaseManager, {} as SessionManager);

    const result = await provider.queryForTest([{ role: 'user', content: 'Return summary XML' }]);

    expect(result.cacheHitTokens).toBe(2176);
    expect(result.cacheMissTokens).toBe(19);
    expect(provider.usageForTest(result)).toEqual({
      input: 2195,
      output: 12,
      cacheHit: 2176,
      cacheMiss: 19,
    });
  });

  it('leaves omitted cache usage absent', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '<skip_summary reason="nothing to add"/>' } }],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 5,
        total_tokens: 45,
      },
    })));
    const provider = new FetchRepairProbeProvider({} as DatabaseManager, {} as SessionManager);

    const result = await provider.queryForTest([{ role: 'user', content: 'Return summary XML' }]);

    expect(result).not.toHaveProperty('cacheHitTokens');
    expect(result).not.toHaveProperty('cacheMissTokens');
    expect(provider.usageForTest(result)).toEqual({ input: 40, output: 5 });
  });

  it('preserves cache usage when the provider response content is empty', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
      usage: {
        prompt_tokens: 1024,
        completion_tokens: 0,
        total_tokens: 1024,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 24,
      },
    })));
    const provider = new FetchRepairProbeProvider({} as DatabaseManager, {} as SessionManager);

    const result = await provider.queryForTest([{ role: 'user', content: 'Return summary XML' }]);

    expect(result.content).toBe('');
    expect(result.cacheHitTokens).toBe(1000);
    expect(result.cacheMissTokens).toBe(24);
  });
});
