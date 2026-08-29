import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseLogRetentionDays,
  pruneOldDailyLogs,
} from '../../src/utils/logger.js';

describe('daily log retention', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-log-retention-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses bounded retention values and falls back to 30 days', () => {
    expect(parseLogRetentionDays(undefined)).toBe(30);
    expect(parseLogRetentionDays('0')).toBe(0);
    expect(parseLogRetentionDays('30')).toBe(30);
    expect(parseLogRetentionDays('365')).toBe(365);
    expect(parseLogRetentionDays('-1')).toBe(30);
    expect(parseLogRetentionDays('1.5')).toBe(30);
    expect(parseLogRetentionDays('366')).toBe(30);
    expect(parseLogRetentionDays('forever')).toBe(30);
  });

  it('deletes only exact daily logs older than the calendar cutoff', () => {
    const oldLog = join(tempDir, 'claude-mem-2026-06-20.log');
    const cutoffLog = join(tempDir, 'claude-mem-2026-06-21.log');
    const currentLog = join(tempDir, 'claude-mem-2026-07-20.log');
    const runnerLog = join(tempDir, 'runner-errors.log');
    const backupLog = join(tempDir, 'claude-mem-2026-01-01.log.backup');
    const invalidDateLog = join(tempDir, 'claude-mem-2026-99-99.log');
    const matchingDirectory = join(tempDir, 'claude-mem-2026-01-01.log');

    for (const file of [oldLog, cutoffLog, currentLog, runnerLog, backupLog, invalidDateLog]) {
      writeFileSync(file, 'test');
    }
    mkdirSync(matchingDirectory);

    pruneOldDailyLogs(tempDir, new Date('2026-07-20T12:00:00Z'), 30);

    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(cutoffLog)).toBe(true);
    expect(existsSync(currentLog)).toBe(true);
    expect(existsSync(runnerLog)).toBe(true);
    expect(existsSync(backupLog)).toBe(true);
    expect(existsSync(invalidDateLog)).toBe(true);
    expect(existsSync(matchingDirectory)).toBe(true);
  });

  it('does not delete daily logs when retention is disabled', () => {
    const oldLog = join(tempDir, 'claude-mem-2020-01-01.log');
    writeFileSync(oldLog, 'test');

    pruneOldDailyLogs(tempDir, new Date('2026-07-20T12:00:00Z'), 0);

    expect(existsSync(oldLog)).toBe(true);
  });
});
