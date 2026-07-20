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
  repairForTest(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return this.queryWithFormatRepair(
      history,
      {
        apiKey: 'test-api-key',
        model: 'test/model',
        maxContextMessages: 20,
        apiUrl: 'https://api.deepseek.com/chat/completions',
      },
      18,
    );
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
});
