import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { logger } from '../../src/utils/logger.js';

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'codex',
      user_prompt: 'work',
      memory_session_id: null,
    }),
    getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
  } as unknown as DatabaseManager;
}

const observation = (name: string) => ({
  tool_name: name,
  tool_input: { name },
  tool_response: { ok: true },
  prompt_number: 1,
  cwd: '/repo',
});

let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => spies.forEach(spy => spy.mockRestore()));

describe('SessionManager observation batching', () => {
  it('buffers rapid observations and flushes them as one worker message', async () => {
    const manager = new SessionManager(makeDbManager());
    await manager.queueObservation(1, observation('Read'));
    await manager.queueObservation(1, observation('Edit'));

    expect(manager.getTotalQueueDepth()).toBe(2);
    expect(manager.getMessageBuffer().peekTypes(1)).toEqual([]);

    expect(manager.flushObservationBatch(1)).toBe(2);
    expect(manager.getTotalQueueDepth()).toBe(1);
    expect(manager.getMessageBuffer().peekTypes(1)).toEqual([
      { message_type: 'observation', tool_name: 'BatchedToolUse' },
    ]);
  });

  it('flushes pending observations before enqueuing a summary', async () => {
    const manager = new SessionManager(makeDbManager());
    await manager.queueObservation(1, observation('Write'));
    await manager.queueObservation(1, observation('Bash'));
    await manager.queueSummarize(1, 'done');

    expect(manager.getMessageBuffer().peekTypes(1)).toEqual([
      { message_type: 'observation', tool_name: 'BatchedToolUse' },
      { message_type: 'summarize', tool_name: null },
    ]);
  });

  it('suppresses duplicate tool-use IDs without passing them into a second dedup store', async () => {
    const manager = new SessionManager(makeDbManager());
    const duplicate = { ...observation('Read'), toolUseId: 'same-id' };
    await manager.queueObservation(1, duplicate);
    await manager.queueObservation(1, duplicate);
    manager.flushObservationBatch(1);

    const iterator = manager.getMessageIterator(1);
    const claimed = await iterator.next();
    expect(claimed.value?.tool_name).toBe('Read');
    expect(claimed.value?.toolUseId).toBeUndefined();
    expect(manager.getTotalQueueDepth()).toBe(1);
    await iterator.return?.();
  });

  it('explicit clear discards both delayed and worker-buffered observations', async () => {
    const manager = new SessionManager(makeDbManager());
    await manager.queueObservation(1, observation('Read'));
    expect(await manager.clearPendingForSession(1)).toBe(1);
    expect(manager.getTotalQueueDepth()).toBe(0);
  });
});
