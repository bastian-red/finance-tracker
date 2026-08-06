/**
 * The failures that stop a whole file, as codes rather than prose.
 *
 * Two audiences read these. The API maps the code to an HTTP status and the web
 * app maps it to a sentence in the user's language, so the code has to be stable
 * and the message has to be readable on its own when neither of those layers
 * bothers. A message alone would force both layers to match on English text, and
 * a code alone would leave a support conversation with nothing to go on.
 *
 * Anything that only ruins **one row** is deliberately not in here. A statement
 * with three broken lines still has to preview the other nine hundred, so a bad
 * date is a row with `status: 'error'` and a message, never a thrown error. The
 * codes below are the cases where there is no file left to show: it is too big to
 * read, it has no bytes, or its header cannot be found, in which case every row
 * would be an error row and the reader learns more from one clear sentence.
 */

export type ImportErrorCode =
  | 'too-large'
  | 'empty'
  | 'no-header'
  | 'no-date-column'
  | 'no-amount-column'
  | 'no-description-column'
  | 'unreadable';

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}
