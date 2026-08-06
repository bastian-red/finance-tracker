/**
 * Platform facts the money layer is built on.
 *
 * **The subject of this file is not our code.** Every assertion here is about
 * IEEE 754 or about the ICU data that ships inside Node. They are pinned because
 * the money design depends on them being true, and because when one of them
 * changes — an ICU update in a Node major, most plausibly — the failure should
 * name the rule that moved instead of surfacing as euro amounts rendering
 * strangely in the UI and a Playwright suite going red for no visible reason.
 *
 * It exists because of a specific mistake. Building `money.ts` I wrote four
 * expected values from memory rather than from the runtime, and all four were
 * wrong: that `123456 * 0.8` is an integer, that dividing by 100 at 1e15 loses
 * digits, that `es-ES` groups four-digit numbers, and that the space before `€`
 * is an ordinary one. The tests failed, which was the good outcome. The bad
 * outcome was one keystroke away: `toContain('1.234,56')` against a page
 * correctly rendering `1234,56` invites you to "fix" the formatter, after which
 * the test passes and defends the bug.
 *
 * So the facts get computed and written down once, here, where they are labelled
 * as borrowed rather than owned.
 */
import { describe, expect, it } from 'vitest';

describe('ICU: how currency actually renders', () => {
  const eur = (value: string, locale = 'es-ES') =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);

  it('does not group four-digit numbers in Spanish, and does group five', () => {
    // Spanish typography starts grouping at five digits. Every hand-rolled
    // formatter gets this wrong, which is why formatMoney defers to Intl instead
    // of splicing separators in itself.
    //
    // The separator is written `\u00a0` rather than pasted. The first draft of
    // this very file used an ordinary space here and failed — which is the
    // mistake the file exists to document, reproduced while documenting it. A
    // pasted non-breaking space is invisible in the editor, invisible in the
    // diff, and gets silently retyped as a normal space by the next person.
    expect(eur('1234.56')).toBe('1234,56\u00a0\u20ac');
    expect(eur('12345.56')).toBe('12.345,56\u00a0\u20ac');
  });

  it('separates the euro sign with U+00A0, not an ordinary space', () => {
    // Asserted by code point on purpose. A non-breaking space and a space are
    // indistinguishable in every editor and every diff, so a literal here would
    // document nothing and would be re-broken by the first person to retype it.
    const text = eur('12345.56');
    const separator = text[text.length - 2];
    expect(separator).toBeDefined();
    expect(separator?.codePointAt(0)).toBe(0x00a0);
    expect(separator).not.toBe(' ');
  });

  it('puts no separator at all before the dollar sign in en-US', () => {
    // Recorded so the rule this repo adopted for euros is not "helpfully"
    // applied to project002, whose E2E hardcodes '$42.00'. That literal is
    // correct there precisely because en-US has nothing to get wrong.
    const text = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format('42');
    expect(text).toBe('$42.00');
    expect(text).not.toMatch(/\s/u);
  });

  it('formats an exact decimal string without going through a float', () => {
    // The capability the whole display path rests on: Intl.NumberFormat accepts
    // a string, so an amount larger than a double can hold exactly still renders
    // exactly. Node 18.14+ / V8's Intl.NumberFormat V3.
    expect(
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(
        '123456789012345678.99',
      ),
    ).toBe('€123,456,789,012,345,678.99');
  });
});

describe('IEEE 754: the premise integer money exists to avoid', () => {
  it('does not represent tenths exactly', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBeCloseTo(0.3, 10);
  });

  it('drifts when a column of small amounts is accumulated', () => {
    // A thousand rows of seven cents. This is not a contrived edge case, it is
    // an ordinary month of coffees, and it is the entire argument for counting
    // in minor units. If this assertion ever stops holding, the integer design
    // is over-engineering and should be revisited rather than inherited.
    let total = 0;
    for (let i = 0; i < 1000; i += 1) total += 0.07;
    expect(total).not.toBe(70);
    expect(Math.abs(total - 70)).toBeGreaterThan(0);
  });

  it('produces a non-integer from an ordinary percentage', () => {
    // The hazard is not a wrong number, it is a value that is not a whole count
    // of cents and that nothing forces anyone to round before storing it.
    expect(Number.isInteger(123_456 * 0.8)).toBe(false);
  });

  it('loses the currency scale when dividing, even where the value is exact', () => {
    // `8990 / 100` is exactly 89.9. The problem is that "89.9" is not money:
    // the trailing zero is gone, and the obvious repair is toFixed(), which is
    // a float rounding step in the one place that must not have one.
    expect((8990 / 100).toString()).toBe('89.9');
  });

  it('stops representing consecutive integers above 2^53', () => {
    // Why minor() checks isSafeInteger rather than isInteger: past this boundary
    // arithmetic silently returns a neighbour of the right answer.
    expect(Number.MAX_SAFE_INTEGER).toBe(9_007_199_254_740_991);
    expect(Number.MAX_SAFE_INTEGER + 1).toBe(Number.MAX_SAFE_INTEGER + 2);
    expect(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});
