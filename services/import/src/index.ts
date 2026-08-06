/**
 * @fin/import -- reading a bank statement, with no side effects at all.
 *
 * The whole service is three calls and no state:
 *
 *   const format = detectStatement(bytes, opts);          // what kind of file is this
 *   const preview = buildPreview(bytes, format, ctx, opts); // what does it say
 *   const rows = planCommit(preview, skipLines);          // what should be written
 *
 * No database, no filesystem, no network, no clock. Everything it needs -- the
 * ledger rows to compare against, the compiled rules, the account, the currency,
 * the byte ceiling -- arrives as an argument. That is what lets `apps/api` run
 * `buildPreview` inside an open transaction without this package knowing what a
 * transaction is, and it is why the tests can push a real Spanish bank export
 * through the whole pipeline in a millisecond.
 *
 * The format is decided once and separately, because it is the part a human has
 * to be able to correct. `detectStatement` returns a `DetectedFormat`, the UI
 * renders it as a sentence ("semicolon separated, comma decimal, day first"), and
 * whatever comes back -- unchanged or edited -- is what `buildPreview` applies.
 * Nothing downstream re-decides.
 */
export { detectStatement, SAMPLE_LIMIT } from './detect';
export { buildPreview, planCommit, MAX_DESCRIPTION } from './preview';
export { ImportError } from './errors';
export type { ImportErrorCode } from './errors';
export type {
  ExistingTransaction,
  ParseOptions,
  PlannedRow,
  PreviewResult,
  StatementContext,
} from './types';

// The seams below are exported for the tests and for a future "fix the format"
// screen, which needs to re-run one decision without re-running the file.
export { DELIMITERS, SNIFF_LINES, sniffDelimiter } from './delimiter';
export type { Delimiter } from './delimiter';
export { decodeStatement, decodeStatementAs } from './encoding';
export type { DecodedStatement, EncodingName } from './encoding';
export { findHeader, mapColumns, roleOfLabel, rolesOf, MAX_HEADER_DEPTH } from './columns';
export type { ColumnMap, ColumnRole, HeaderScan } from './columns';
export {
  ASSUMED_SUFFIX,
  DateParseError,
  detectDateFormat,
  parseDateTemplate,
  parseStatementDay,
  UNKNOWN_DATE_FORMAT,
} from './dates';
export type { DateTemplate } from './dates';
export { cellAt, readStatement } from './records';
export type { ReadOverrides, StatementRead, StatementRecord } from './records';
