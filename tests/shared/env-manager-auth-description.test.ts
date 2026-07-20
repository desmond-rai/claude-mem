import { describe, expect, it } from 'bun:test';
import {
  getAuthMethodDescription,
  getProviderAuthMethodDescription,
} from '../../src/shared/EnvManager.js';

describe('getProviderAuthMethodDescription', () => {
  it('describes OpenRouter-compatible and Gemini API-key auth', () => {
    expect(getProviderAuthMethodDescription('openrouter')).toBe('OpenRouter-compatible API key');
    expect(getProviderAuthMethodDescription('gemini')).toBe('Gemini API key');
  });

  it('preserves the existing Claude auth description', () => {
    expect(getProviderAuthMethodDescription('claude')).toBe(getAuthMethodDescription());
  });
});
