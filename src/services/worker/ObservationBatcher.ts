import type { ObservationData } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export interface BatcherScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ObservationBatcherOptions {
  scheduler?: BatcherScheduler;
  idleMs?: number;
  maxMs?: number;
  maxEvents?: number;
  maxFieldChars?: number;
}

interface PendingBatch {
  events: ObservationData[];
  identity: string;
  idleTimer: unknown;
  maxTimer: unknown;
}

const defaultScheduler: BatcherScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function identityOf(data: ObservationData): string {
  return `${data.agentId ?? ''}\u0000${data.agentType ?? ''}`;
}

export class ObservationBatcher {
  private readonly batches = new Map<number, PendingBatch>();
  private readonly scheduler: BatcherScheduler;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly maxEvents: number;
  private readonly maxFieldChars: number;

  constructor(
    private readonly onFlush: (sessionDbId: number, data: ObservationData, eventCount: number) => void,
    options: ObservationBatcherOptions = {},
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.idleMs = options.idleMs ?? 10_000;
    this.maxMs = options.maxMs ?? 30_000;
    this.maxEvents = options.maxEvents ?? 10;
    this.maxFieldChars = options.maxFieldChars ?? 14_000;
  }

  enqueue(sessionDbId: number, data: ObservationData): void {
    let batch = this.batches.get(sessionDbId);

    if (batch && (
      batch.identity !== identityOf(data)
      || this.exceedsFieldLimit([...batch.events, data])
    )) {
      this.flush(sessionDbId);
      batch = undefined;
    }

    if (!batch) {
      batch = {
        events: [],
        identity: identityOf(data),
        idleTimer: undefined,
        maxTimer: this.scheduler.setTimeout(() => this.flush(sessionDbId), this.maxMs),
      };
      this.batches.set(sessionDbId, batch);
    }

    batch.events.push(data);
    this.scheduler.clearTimeout(batch.idleTimer);
    batch.idleTimer = this.scheduler.setTimeout(() => this.flush(sessionDbId), this.idleMs);

    if (
      batch.events.length >= this.maxEvents
      || this.exceedsFieldLimit(batch.events)
    ) {
      this.flush(sessionDbId);
    }
  }

  flush(sessionDbId: number): number {
    const batch = this.batches.get(sessionDbId);
    if (!batch) return 0;
    this.batches.delete(sessionDbId);
    this.scheduler.clearTimeout(batch.idleTimer);
    this.scheduler.clearTimeout(batch.maxTimer);

    const data = batch.events.length === 1 ? batch.events[0] : this.toBatchedObservation(batch.events);
    logger.debug('QUEUE', 'Observation batch ready', {
      sessionId: sessionDbId,
      eventCount: batch.events.length,
      toolName: data.tool_name,
    });
    this.onFlush(sessionDbId, data, batch.events.length);
    return batch.events.length;
  }

  discard(sessionDbId: number): number {
    const batch = this.batches.get(sessionDbId);
    if (!batch) return 0;
    this.batches.delete(sessionDbId);
    this.scheduler.clearTimeout(batch.idleTimer);
    this.scheduler.clearTimeout(batch.maxTimer);
    logger.debug('QUEUE', 'Observation batch discarded', {
      sessionId: sessionDbId,
      eventCount: batch.events.length,
    });
    return batch.events.length;
  }

  getPendingCount(sessionDbId?: number): number {
    if (sessionDbId !== undefined) {
      return this.batches.get(sessionDbId)?.events.length ?? 0;
    }
    let count = 0;
    for (const batch of this.batches.values()) count += batch.events.length;
    return count;
  }

  private batchedFields(events: ObservationData[]): { toolInput: unknown; toolResponse: unknown } {
    return {
      toolInput: {
        events: events.map((event, index) => ({
          index: index + 1,
          tool_name: event.tool_name,
          parameters: event.tool_input,
          cwd: event.cwd,
        })),
      },
      toolResponse: {
        events: events.map((event, index) => ({
          index: index + 1,
          tool_name: event.tool_name,
          outcome: event.tool_response,
        })),
      },
    };
  }

  private exceedsFieldLimit(events: ObservationData[]): boolean {
    if (events.length === 1) {
      return serializedChars(events[0].tool_input) >= this.maxFieldChars
        || serializedChars(events[0].tool_response) >= this.maxFieldChars;
    }
    const fields = this.batchedFields(events);
    return serializedChars(fields.toolInput) > this.maxFieldChars
      || serializedChars(fields.toolResponse) > this.maxFieldChars;
  }

  private toBatchedObservation(events: ObservationData[]): ObservationData {
    const latest = events[events.length - 1];
    const fields = this.batchedFields(events);
    return {
      tool_name: 'BatchedToolUse',
      tool_input: fields.toolInput,
      tool_response: fields.toolResponse,
      prompt_number: latest.prompt_number,
      cwd: latest.cwd,
      agentId: latest.agentId,
      agentType: latest.agentType,
    };
  }
}
