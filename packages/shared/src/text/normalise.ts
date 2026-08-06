/**
 * Reducing a bank description to the part that identifies a merchant.
 *
 * This is the single most load-bearing string function in the app, because three
 * separate features are built on top of it and all three break the same way if it
 * drifts:
 *
 * - the rule engine matches keywords against the normalised form,
 * - the importer fingerprints rows with it to spot duplicates,
 * - the seed writes `merchant` with it so the two above have something to work on.
 *
 * It lives here, in the shared package, precisely so there is one of it. An
 * earlier draft duplicated it into the seed with a comment promising a test that
 * pinned the two copies in agreement. That test is a worse artefact than the
 * import it was avoiding: it can only ever tell you the copies have already
 * diverged, and by then every stored `merchant` and every stored `fingerprint`
 * was written by the old one.
 */

/**
 * What a bank actually writes on a line, and why each step exists.
 *
 * `MERCADONA 4023 MADRID` on Tuesday and `MERCADONA  4197 MADRID` on Friday are
 * the same shop. The card terminal number, the reference code and the padding
 * differ on every line of an otherwise identical purchase, so a rule matching the
 * raw string matches once and never again.
 *
 * - **NFD then strip combining marks.** `NÓMINA` and `NÓMINA` can be the same six
 *   glyphs and different bytes; a keyword typed in one form must match a
 *   description written in the other.
 * - **Lowercase, so a keyword can be typed in any case.** It has to sit after the
 *   decomposition and the mark strip, not before the `[^a-z0-9 ]` collapse on its
 *   own: `İSTANBUL` decomposes to `I` plus U+0307, and it is the strip that turns
 *   that into a plain `i` instead of a word broken in two by a stray dot.
 * - **Everything that is not `[a-z0-9 ]` becomes a space.** `NETFLIX.COM`,
 *   `AMAZON EU S.A R.L.` and `E.S. REPSOL` all carry punctuation that no human
 *   would type into a rule.
 * - **Runs of four or more digits are dropped.** Those are terminal ids, card
 *   suffixes and reference numbers: noise that differs per transaction. Shorter
 *   runs are kept, because `LIDL 214` and `GLOVO 24H` carry real store identity
 *   and, more to the point, dropping them would eat the `4` in `4G`.
 *
 * The result is idempotent: normalising a normalised string returns it unchanged.
 * `normalise.test.ts` pins that, because the importer normalises stored values
 * again on re-import and a non-idempotent version would change fingerprints on
 * the second pass.
 */
export function normaliseDescription(value: string): string {
  return (
    value
      .normalize('NFD')
      // Written as escapes on purpose. A literal combining-mark range is
      // invisible in every editor and every diff, so nobody could tell a correct
      // one from a corrupted one by looking.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\b\d{4,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * How long a stored `merchant` may be.
 *
 * The column is `varchar(120)`. Truncating here rather than at each call site
 * means the value the rule engine matched is the value the database holds.
 */
export const MERCHANT_MAX_LENGTH = 120;

/** The normalised form, truncated to what the `merchant` column accepts. */
export function merchantOf(description: string): string {
  return normaliseDescription(description).slice(0, MERCHANT_MAX_LENGTH);
}
