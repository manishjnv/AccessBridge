import { describe, it, expect } from 'vitest';
import { formatPlatform } from '../App.js';

describe('formatPlatform', () => {
  it('returns "Windows" for windows platform', () => {
    expect(formatPlatform({ platform: 'windows' })).toBe('Windows');
  });

  it('returns "macOS" for macos platform', () => {
    expect(formatPlatform({ platform: 'macos' })).toBe('macOS');
  });

  it('returns "Ubuntu 24.04" for linux with distroHint "ubuntu-24.04"', () => {
    expect(formatPlatform({ platform: 'linux', distroHint: 'ubuntu-24.04' })).toBe('Ubuntu 24.04');
  });

  it('returns "Fedora 40" for linux with distroHint "fedora-40"', () => {
    expect(formatPlatform({ platform: 'linux', distroHint: 'fedora-40' })).toBe('Fedora 40');
  });

  it('returns "Linux" for linux without distroHint', () => {
    expect(formatPlatform({ platform: 'linux' })).toBe('Linux');
  });

  it('returns "Linux" for linux with malformed distroHint', () => {
    expect(formatPlatform({ platform: 'linux', distroHint: 'garbage' })).toBe('Linux');
  });
});
