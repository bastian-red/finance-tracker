import { normaliseDescription, type Matcher } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { describeMatcher, previewMatcher } from './matcher';

/**
 * The rule tester.
 *
 * What it pins: that the preview compares exactly what the engine compares. The
 * subject is normalised, a literal needle is normalised with it, and a regex is
 * left alone.
 *
 * What breaks without it: rules that never fire, for a reason the user cannot
 * see. `MERCADONA 4023 MADRID` is `mercadona madrid` by the time a rule reaches
 * it, so a pattern written against the raw description matches nothing and the
 * app reports no error at all. If the preview normalised a regex too, the
 * pattern `^[a-z]+ ?[0-9]{2}$` would arrive as the literal `a z 0 9 2` and the
 * preview would confidently disagree with the engine.
 *
 * The second property here is that it never throws. This runs on every keystroke
 * in the rule form; an exception blanks the page while someone is typing.
 */

const SAMPLES = [
  'MERCADONA 4023 MADRID',
  'Café Comercial',
  'NETFLIX.COM 4021',
  'GLOVO 24H',
] as const;

describe('previewMatcher: what the engine actually sees', () => {
  it('reports the normalised subject beside the raw one', () => {
    // Both forms, because the gap between them is the thing the user cannot
    // guess. The four-digit terminal number is gone, the case is gone, the
    // accent is gone.
    const preview = previewMatcher({ type: 'contains', value: 'mercadona' }, SAMPLES);
    expect(preview.problem).toBeNull();
    expect(preview.probes).not.toBeNull();
    expect(preview.probes![0]).toEqual({
      description: 'MERCADONA 4023 MADRID',
      normalised: 'mercadona madrid',
      matched: true,
    });
    expect(preview.probes!.map((probe) => probe.normalised)).toEqual([
      'mercadona madrid',
      'cafe comercial',
      'netflix com',
      'glovo 24h',
    ]);
  });

  it('keeps one probe per sample, in order', () => {
    const preview = previewMatcher({ type: 'contains', value: 'a' }, SAMPLES);
    expect(preview.probes).toHaveLength(SAMPLES.length);
    expect(preview.probes!.map((probe) => probe.description)).toEqual([...SAMPLES]);
  });
});

describe('previewMatcher: literals are normalised too', () => {
  it('matches an accented, cased needle against a bank line', () => {
    // "Café Comercial" typed by a person, "CAFE COMERCIAL 4021" written by a
    // bank. Neither side should have to know the other exists.
    const preview = previewMatcher({ type: 'contains', value: 'Café Comercial' }, [
      'CAFE COMERCIAL 4021',
    ]);
    expect(preview.probes![0]!.matched).toBe(true);
  });

  it.each([
    ['contains', 'comercial', true],
    ['contains', 'mercadona', false],
    ['startsWith', 'cafe', true],
    ['startsWith', 'comercial', false],
    ['equals', 'cafe comercial', true],
    ['equals', 'cafe', false],
  ] as const)('%s "%s" against "Café Comercial" is %s', (type, value, expected) => {
    const preview = previewMatcher({ type, value } as Matcher, ['Café Comercial']);
    expect(preview.problem).toBeNull();
    expect(preview.probes![0]!.matched).toBe(expected);
  });

  it('refuses a literal that normalises to nothing', () => {
    // "!!!" normalises to the empty string, and the empty string is a substring
    // of everything: one such rule swallows the whole ledger into one category
    // on the next import.
    expect(normaliseDescription('!!!')).toBe('');
    const preview = previewMatcher({ type: 'contains', value: '!!!' }, SAMPLES);
    expect(preview.probes).toBeNull();
    expect(preview.problem).toMatch(/no letters or digits/);
  });

  it('refuses an empty matcher before it refuses anything else', () => {
    for (const value of ['', '   ']) {
      const preview = previewMatcher({ type: 'contains', value }, SAMPLES);
      expect(preview.probes).toBeNull();
      expect(preview.problem).toBe('Type something to match on.');
    }
  });
});

describe('previewMatcher: regexes are not normalised', () => {
  it('runs the pattern the user typed, against the normalised subject', () => {
    const preview = previewMatcher({ type: 'regex', value: '^mercadona' }, SAMPLES);
    expect(preview.probes!.map((probe) => probe.matched)).toEqual([true, false, false, false]);
  });

  it('survives a pattern that normalisation would destroy', () => {
    // Normalising `^[a-z]+ ?[0-9]{2}$` gives the literal `a z 0 9 2`, which
    // matches nothing. The preview must not do that to it.
    const pattern = '^[a-z]+ ?[0-9]{2}$';
    expect(normaliseDescription(pattern)).toBe('a z 0 9 2');
    const preview = previewMatcher({ type: 'regex', value: pattern }, ['GLOVO 24']);
    expect(preview.probes![0]!.normalised).toBe('glovo 24');
    expect(preview.probes![0]!.matched).toBe(true);
  });

  it('shows the user why a four-digit pattern can never fire', () => {
    // The documented trap: runs of four or more digits are stripped from the
    // subject before any rule sees it, so `\d{4}` matches nothing, ever.
    const preview = previewMatcher({ type: 'regex', value: '\\d{4}' }, SAMPLES);
    expect(preview.problem).toBeNull();
    expect(preview.probes!.every((probe) => !probe.matched)).toBe(true);
  });

  it('is case-sensitive, because the subject is already lowercase', () => {
    const preview = previewMatcher({ type: 'regex', value: 'MERCADONA' }, SAMPLES);
    expect(preview.probes![0]!.matched).toBe(false);
  });

  it('carries no g flag, so one sample does not skip the next', () => {
    // A `g` regex keeps `lastIndex` between `test()` calls. With it, two
    // identical samples would report matched, then not matched, and the bug
    // would look like a data problem.
    const preview = previewMatcher({ type: 'regex', value: 'a' }, ['a', 'a', 'a']);
    expect(preview.probes!.map((probe) => probe.matched)).toEqual([true, true, true]);
  });

  it('reports an invalid pattern instead of throwing it at the form', () => {
    const preview = previewMatcher({ type: 'regex', value: '([a-' }, SAMPLES);
    expect(preview.probes).toBeNull();
    expect(preview.problem).toMatch(/not a valid regular expression/);
  });

  it('never throws, whatever it is handed', () => {
    const hostile: Matcher[] = [
      { type: 'regex', value: '(' },
      { type: 'regex', value: '[' },
      { type: 'regex', value: '\\' },
      { type: 'regex', value: '*' },
      { type: 'contains', value: '   ' },
      { type: 'equals', value: '---' },
    ];
    for (const matcher of hostile) {
      expect(() => previewMatcher(matcher, SAMPLES), matcher.value).not.toThrow();
    }
  });
});

describe('describeMatcher', () => {
  it('shows a regex verbatim and a literal as the engine stored it', () => {
    // The literal is shown normalised on purpose: that is the string the rule
    // will actually compare, and showing the raw one would be a second lie about
    // what the engine does.
    expect(describeMatcher({ type: 'regex', value: '^merc' })).toBe('matches /^merc/');
    expect(describeMatcher({ type: 'contains', value: 'Café Comercial' })).toBe(
      'contains "cafe comercial"',
    );
    expect(describeMatcher({ type: 'startsWith', value: 'NETFLIX.COM' })).toBe(
      'startsWith "netflix com"',
    );
    expect(describeMatcher({ type: 'equals', value: 'LIDL 214' })).toBe('equals "lidl 214"');
  });
});
