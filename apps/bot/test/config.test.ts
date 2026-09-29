import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults are valid and empty optionals are ignored', () => {
    const c = loadConfig({ MAX_TICKS: '', INITIAL_COST_BASIS: '', PRIVATE_KEY: '' });
    expect(c.MODE).toBe('paper');
    expect(c.MAX_TICKS).toBeUndefined();
    expect(c.INITIAL_COST_BASIS).toBeUndefined();
  });
  it('live requires CONFIRM_LIVE and key', () => {
    expect(() => loadConfig({ MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64) })).toThrow(/CONFIRM_LIVE/);
    expect(() => loadConfig({ MODE: 'live', CONFIRM_LIVE: 'true' })).toThrow(/PRIVATE_KEY/);
  });
  it('jev requires api key', () => {
    expect(() => loadConfig({ DECISION_ENGINE: 'jev' })).toThrow(/TYPESAFE_API_KEY/);
  });
});
