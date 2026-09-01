import { describe, it, expect } from 'vitest';
import { buildTextMatchPredicate } from '../gridFilters';

/**
 * The fuzzy variants a text filter adds on top of its plain "contains" clause.
 *
 * Every one of them is a typo tolerance, so every one of them has to stay
 * within one edit of what the user typed. A variant that widens into "this
 * fragment, then anything, then that fragment" stops being a typo and starts
 * returning the table: `%ΟΠΤΙ%Α%` — what the substitution variant used to
 * generate for "ΟΠΤΙΜΑ" — matched 130 of 11,814 customers, none of them the
 * company being looked for.
 */
const fuzzyPatterns = (term: string): string[] => {
  const { params } = buildTextMatchPredicate('c.Name', term, { paramKey: 'p' });
  // The first parameter is the plain contains clause; the rest are the variants.
  return params.slice(1).map((p) => String(p.value));
};

// '%' between two fragments of the term; the outer '%...%' of a contains match
// is expected and not what this is looking for.
const hasInnerWildcardGap = (pattern: string): boolean => /[^%]%[^%]/.test(pattern.slice(1, -1));

describe('fuzzy text filter variants', () => {
  it('substitutes a single character rather than an open gap', () => {
    const patterns = fuzzyPatterns('ΟΠΤΙΜΑ');
    expect(patterns).toContain('%ΟΠΤΙ_Α%');
    expect(patterns).not.toContain('%ΟΠΤΙ%Α%');
  });

  it('never emits a variant whose tail fragment is a single character behind a gap', () => {
    for (const term of ['ΟΠΤΙΜΑ', 'ΤΗΛΕΟΠΤΙΚ', 'ΚΑΡΑΓΙΑΝ', 'TELMACO', 'CRESTON']) {
      for (const pattern of fuzzyPatterns(term)) {
        if (!hasInnerWildcardGap(pattern)) continue;
        // Insertion variants keep an open gap on purpose (a stored name can hold
        // several extra characters: "TEL. MACO"), but both sides stay long
        // enough to identify the company.
        const fragments = pattern.replace(/^%|%$/g, '').split('%');
        fragments.forEach((fragment) => expect(fragment.length).toBeGreaterThanOrEqual(3));
      }
    }
  });

  it('collapses a doubled character into a contiguous fragment', () => {
    // "ΟΠΤΤΙΜΑ" is the extra-keystroke typo; the variant that finds "ΟΠΤΙΜΑ" has
    // to be the whole word, not two fragments with a gap.
    expect(fuzzyPatterns('ΟΠΤΤΙΜΑ')).toContain('%ΟΠΤΙΜΑ%');
  });

  it('adds no doubled-character variant to a term with no repeat', () => {
    const patterns = fuzzyPatterns('ΚΑΡΑΓΙΑΝ');
    const collapsed = patterns.filter((p) => p.length === 'ΚΑΡΑΓΙΑΝ'.length + 1);
    expect(collapsed).toHaveLength(0);
  });

  it('keeps the plain contains clause first and leaves short/numeric terms alone', () => {
    expect(fuzzyPatterns('ΑΒΓ')).toHaveLength(0);
    expect(fuzzyPatterns('AVC4000')).toHaveLength(0);
  });
});
