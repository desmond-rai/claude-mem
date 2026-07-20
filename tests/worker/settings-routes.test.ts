import { describe, expect, it } from 'bun:test';
import { validateLogRetentionDays } from '../../src/services/worker/http/routes/SettingsRoutes.js';

describe('validateLogRetentionDays', () => {
  it('accepts integer day counts from 0 through 365', () => {
    expect(validateLogRetentionDays('0')).toEqual({ valid: true });
    expect(validateLogRetentionDays('30')).toEqual({ valid: true });
    expect(validateLogRetentionDays('365')).toEqual({ valid: true });
  });

  it('rejects non-integers and values outside the supported range', () => {
    for (const value of ['-1', '1.5', '366', 'forever', '']) {
      expect(validateLogRetentionDays(value)).toEqual({
        valid: false,
        error: 'CLAUDE_MEM_LOG_RETENTION_DAYS must be an integer between 0 and 365',
      });
    }
  });
});
