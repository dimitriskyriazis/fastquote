import { describe, expect, it } from 'vitest';
import {
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_RENEW_WINDOW_SECONDS,
  SESSION_TTL_SECONDS,
  nextSessionExp,
} from './sessionShared';

// The renewal rule is what replaced a 30-minute Windows-auth handshake, so its two
// guarantees are load-bearing: it must extend a live session without touching Active
// Directory, and it must REFUSE to extend past the absolute cap so the Windows identity
// still gets re-proven (once or twice a day instead of dozens of times).
describe('nextSessionExp', () => {
  const NOW = 1_800_000_000;

  it('does not renew a session that is not yet inside the renewal window', () => {
    const exp = NOW + SESSION_TTL_SECONDS;
    expect(nextSessionExp({ iat: NOW, exp }, NOW)).toBeNull();
  });

  it('renews once the session is inside the renewal window', () => {
    const iat = NOW - (SESSION_TTL_SECONDS - SESSION_RENEW_WINDOW_SECONDS + 600);
    const exp = iat + SESSION_TTL_SECONDS;
    expect(exp - NOW).toBeLessThan(SESSION_RENEW_WINDOW_SECONDS);

    const renewed = nextSessionExp({ iat, exp }, NOW);
    expect(renewed).not.toBeNull();
    expect(renewed!).toBeGreaterThan(exp);
    // Never beyond the absolute ceiling measured from the ORIGINAL login.
    expect(renewed!).toBeLessThanOrEqual(iat + SESSION_ABSOLUTE_TTL_SECONDS);
  });

  it('refuses to renew past the absolute ceiling, so a real handshake still happens', () => {
    const iat = NOW - (SESSION_ABSOLUTE_TTL_SECONDS - 600);
    const exp = NOW + 600; // ceiling is exactly here — nothing left to gain
    expect(nextSessionExp({ iat, exp }, NOW)).toBeNull();
  });

  it('cannot be walked forward by repeated renewals', () => {
    const iat = NOW - 1000;
    let exp = iat + SESSION_TTL_SECONDS;
    let now = NOW;
    const ceiling = iat + SESSION_ABSOLUTE_TTL_SECONDS;

    // Simulate a tab that keeps making requests for days.
    for (let i = 0; i < 500; i += 1) {
      const renewed = nextSessionExp({ iat, exp }, now);
      if (renewed !== null) exp = renewed;
      expect(exp).toBeLessThanOrEqual(ceiling);
      now += 600;
      if (now >= exp) break; // session died — /api/me takes over from here
    }
    expect(exp).toBeLessThanOrEqual(ceiling);
  });

  it('does not renew an already-expired session', () => {
    expect(nextSessionExp({ iat: NOW - SESSION_TTL_SECONDS - 10, exp: NOW - 10 }, NOW)).toBeNull();
  });

  it('treats a payload with no iat as issued now (cannot exceed the ceiling either)', () => {
    const exp = NOW + 60;
    const renewed = nextSessionExp({ exp }, NOW);
    expect(renewed).not.toBeNull();
    expect(renewed!).toBeLessThanOrEqual(NOW + SESSION_ABSOLUTE_TTL_SECONDS);
  });
});
