import { describe, expect, it } from 'vitest';
import { FALLBACK_DECIMAL, localeDecimalOf } from './locale-decimal';

/**
 * Pins the separator this app derives from `DEFAULT_LOCALE`, and the two ways
 * that derivation is allowed to fail.
 *
 * The value decides how an ambiguous statement is read: a file whose every
 * amount looks like `1.234` is either 1234 units or 1.234 of them, nothing
 * inside the file settles it, and `localeDecimal` is the tie-breaker `@fin/import`
 * uses. Getting it wrong does not fail an import; it imports every row off by a
 * factor of a thousand.
 *
 * **Every expected separator below was produced by running Node, not recalled.**
 * They are ICU facts, not facts about this code, and this repo has already been
 * bitten once by a value typed from memory (see `packages/shared/src/platform.test.ts`).
 * The command:
 *
 *     node -e "for (const t of ['es-ES','en-US','de-DE','ar-EG'])
 *       console.log(t, JSON.stringify(new Intl.NumberFormat(t).formatToParts(1.1)
 *         .find(p => p.type === 'decimal').value))"
 *
 *     es-ES ","   en-US "."   de-DE ","   ar-EG U+066B
 */

describe('localeDecimalOf', () => {
  it('reads a comma for es-ES, which is the shipped default', () => {
    // `DEFAULT_LOCALE` defaults to es-ES, so this is the answer the app gives
    // when nobody configures anything.
    expect(localeDecimalOf('es-ES')).toBe(',');
  });

  it('reads a dot for en-US', () => {
    expect(localeDecimalOf('en-US')).toBe('.');
  });

  it('asks Intl rather than consulting a table of locales', () => {
    // de-DE appears in no list inside this repo. It works because the answer
    // comes from ICU, which is the whole design: a table would be wrong the
    // moment somebody sets DEFAULT_LOCALE to a locale nobody thought of.
    expect(localeDecimalOf('de-DE')).toBe(',');
    expect(localeDecimalOf('fr-FR')).toBe(',');
  });

  it('falls back to a dot for a tag Intl cannot parse', () => {
    // `es_ES` with an underscore is a POSIX locale name, not a BCP 47 tag, and
    // it is exactly what somebody copies out of a shell environment into a
    // `.env`. `Intl` answers it with a RangeError. `loadConfig` has already
    // accepted the string, so this must not take the import down.
    expect(localeDecimalOf('es_ES')).toBe(FALLBACK_DECIMAL);
    expect(localeDecimalOf('es_ES')).toBe('.');
  });

  it('falls back for an empty tag', () => {
    expect(localeDecimalOf('')).toBe('.');
  });

  it('falls back rather than throwing, whatever the tag looks like', () => {
    // The failure mode being prevented: an unparseable tag reaching `Intl`
    // uncaught turns a statement upload into a 500 that names a locale, not a
    // file.
    for (const tag of ['es_ES', '', 'not a locale', 'en-US-', '..']) {
      expect(() => localeDecimalOf(tag)).not.toThrow();
    }
  });

  it('never returns a separator the amount parser has no branch for', () => {
    // ar-EG formats with U+066B, the Arabic decimal separator. Written as an
    // escape rather than pasted: it is unreadable in a diff, and pasting it is
    // how the next person silently retypes it as something else.
    const arabic = new Intl.NumberFormat('ar-EG')
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value;
    expect(arabic).toBe('\u066b');

    // Returning it would make every amount in the file fail to parse with an
    // error about the row rather than about the setting.
    expect(localeDecimalOf('ar-EG')).toBe('.');
  });

  it('returns one of exactly two characters, for every locale it is asked', () => {
    for (const tag of ['es-ES', 'en-US', 'de-DE', 'ar-EG', 'ja-JP', 'pt-BR', 'nonsense']) {
      expect(['.', ',']).toContain(localeDecimalOf(tag));
    }
  });
});
