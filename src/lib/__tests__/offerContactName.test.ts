import { describe, it, expect } from 'vitest';
import { normalizeContactName, resolveOfferContactName } from '../offerContactName';

describe('normalizeContactName', () => {
  it('returns an empty string for null, undefined and blank input', () => {
    expect(normalizeContactName(null)).toBe('');
    expect(normalizeContactName(undefined)).toBe('');
    expect(normalizeContactName('   ')).toBe('');
  });

  it('trims and collapses internal whitespace', () => {
    expect(normalizeContactName('  Maria   Papadopoulou ')).toBe('Maria Papadopoulou');
  });
});

describe('resolveOfferContactName', () => {
  it('prefers the live contact name over the OfferContact snapshot', () => {
    // The contact was renamed after the offer stored its snapshot.
    expect(resolveOfferContactName('Maria Papadopoulou-Nikou', 'Maria Papadopoulou'))
      .toBe('Maria Papadopoulou-Nikou');
  });

  it('falls back to the snapshot when no live contact resolves', () => {
    expect(resolveOfferContactName(null, 'Legacy Contact')).toBe('Legacy Contact');
    expect(resolveOfferContactName('   ', 'Legacy Contact')).toBe('Legacy Contact');
  });

  it('returns an empty string when neither is available', () => {
    expect(resolveOfferContactName(null, null)).toBe('');
    expect(resolveOfferContactName(undefined, '')).toBe('');
  });
});
