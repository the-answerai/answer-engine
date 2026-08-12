import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL } from '../config.js';

describe('auth command helpers', () => {
  it('uses the local API URL as the packaged default', () => {
    expect(DEFAULT_API_URL).toBe('http://localhost:5050');
  });
});
