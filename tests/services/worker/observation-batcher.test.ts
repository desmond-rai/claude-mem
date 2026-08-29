import { describe, expect, test } from 'bun:test';
import { ObservationBatcher, type BatcherScheduler } from '../../../src/services/worker/ObservationBatcher.js';
import type { ObservationData } from '../../../src/services/worker-types.js';

class FakeScheduler implements BatcherScheduler {
  private time = 0;
  private nextId = 1;
  private jobs = new Map<number, { due: number; callback: () => void }>();

  now(): number { return this.time; }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.jobs.set(id, { due: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(Number(handle));
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].due;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

function observation(tool: string, overrides: Partial<ObservationData> = {}): ObservationData {
  return {
    tool_name: tool,
    tool_input: { tool },
    tool_response: { ok: tool },
    prompt_number: 1,
    cwd: '/repo',
    ...overrides,
  };
}

function setup(options: Partial<{ idleMs: number; maxMs: number; maxEvents: number; maxFieldChars: number }> = {}) {
  const scheduler = new FakeScheduler();
  const flushed: Array<{ sessionDbId: number; data: ObservationData; eventCount: number }> = [];
  const batcher = new ObservationBatcher(
    (sessionDbId, data, eventCount) => flushed.push({ sessionDbId, data, eventCount }),
    { scheduler, idleMs: 10_000, maxMs: 30_000, maxEvents: 10, maxFieldChars: 14_000, ...options },
  );
  return { scheduler, flushed, batcher };
}

describe('ObservationBatcher', () => {
  test('flushes one batch after ten quiet seconds', () => {
    const { scheduler, flushed, batcher } = setup();
    batcher.enqueue(1, observation('Read'));
    scheduler.advance(8_000);
    batcher.enqueue(1, observation('Edit'));
    scheduler.advance(9_999);
    expect(flushed).toHaveLength(0);
    scheduler.advance(1);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].eventCount).toBe(2);
    expect(flushed[0].data.tool_name).toBe('BatchedToolUse');
  });

  test('flushes at thirty seconds during continuous activity', () => {
    const { scheduler, flushed, batcher } = setup({ maxEvents: 100 });
    batcher.enqueue(1, observation('event-0'));
    for (let i = 1; i <= 5; i++) {
      scheduler.advance(5_000);
      batcher.enqueue(1, observation(`event-${i}`));
    }
    expect(flushed).toHaveLength(0);
    scheduler.advance(5_000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].eventCount).toBe(6);
  });

  test('flushes immediately at the event-count limit', () => {
    const { flushed, batcher } = setup({ maxEvents: 3 });
    batcher.enqueue(1, observation('one'));
    batcher.enqueue(1, observation('two'));
    batcher.enqueue(1, observation('three'));

    expect(flushed).toHaveLength(1);
    expect(flushed[0].eventCount).toBe(3);
  });

  test('flushes before adding an event that exceeds the field-size limit', () => {
    const { flushed, batcher } = setup({ maxFieldChars: 80 });
    batcher.enqueue(1, observation('one', { tool_response: 'A'.repeat(50) }));
    batcher.enqueue(1, observation('two', { tool_response: 'B'.repeat(50) }));

    expect(flushed).toHaveLength(1);
    expect(flushed[0].eventCount).toBe(1);
    expect(batcher.getPendingCount()).toBe(1);
  });

  test('includes batch wrapper metadata in the field-size limit', () => {
    const { flushed, batcher } = setup({ maxFieldChars: 220 });
    batcher.enqueue(1, observation('long-tool-name-one', { tool_input: { value: 'A'.repeat(30) } }));
    batcher.enqueue(1, observation('long-tool-name-two', { tool_input: { value: 'B'.repeat(30) } }));

    expect(flushed).toHaveLength(1);
    expect(flushed[0].eventCount).toBe(1);
    expect(batcher.getPendingCount()).toBe(1);
  });

  test('keeps sessions separate', () => {
    const { scheduler, flushed, batcher } = setup();
    batcher.enqueue(1, observation('one'));
    scheduler.advance(5_000);
    batcher.enqueue(2, observation('two'));
    scheduler.advance(5_000);
    expect(flushed.map(item => item.sessionDbId)).toEqual([1]);
    scheduler.advance(5_000);
    expect(flushed.map(item => item.sessionDbId)).toEqual([1, 2]);
  });

  test('flushes before mixing different agent identities', () => {
    const { flushed, batcher } = setup();
    batcher.enqueue(1, observation('main'));
    batcher.enqueue(1, observation('subagent', { agentId: 'agent-2', agentType: 'worker' }));

    expect(flushed).toHaveLength(1);
    expect(flushed[0].data.tool_name).toBe('main');
    expect(batcher.getPendingCount()).toBe(1);
  });

  test('preserves a single event without wrapping it', () => {
    const { flushed, batcher } = setup();
    const original = observation('Write', { toolUseId: 'tool-1' });
    batcher.enqueue(1, original);
    batcher.flush(1);

    expect(flushed).toEqual([{ sessionDbId: 1, data: original, eventCount: 1 }]);
  });

  test('discards a pending batch without flushing it', () => {
    const { flushed, batcher } = setup();
    batcher.enqueue(1, observation('Read'));
    expect(batcher.discard(1)).toBe(1);
    expect(batcher.getPendingCount()).toBe(0);
    expect(flushed).toHaveLength(0);
  });
});
