/**
 * What the caller passes in and what it gets back.
 *
 * Every input this module needs is an argument: the ledger rows to compare
 * against, the compiled rules, the account, the byte ceiling. There is no
 * database handle, no filesystem, no clock and no environment lookup anywhere in
 * the package. That is not purity for its own sake -- it is what lets `apps/api`
 * call `buildPreview` inside an open transaction without the importer needing to
 * know a transaction exists, and it is what lets the tests run a whole bank
 * statement through the pipeline in a millisecond with three literals.
 */
import type { CalendarDay } from '@fin/shared';
import type { ImportPreview } from '@fin/shared';
import type { CompiledRuleSet } from '@fin/categorize';

export interface ParseOptions {
  /** Fallback decimal separator when the file itself is ambiguous. From DEFAULT_LOCALE. */
  localeDecimal: '.' | ',';
  /** ISO 4217 of the destination account. Drives the minor-unit exponent. */
  currency: string;
  /** Hard ceiling on the input, in bytes. From MAX_IMPORT_BYTES. */
  maxBytes: number;
  /**
   * A row within this many days of an existing one with the same amount and
   * normalised description is flagged `duplicate`. From DUPLICATE_WINDOW_DAYS.
   */
  duplicateWindowDays: number;
}

/** Rows already in the ledger for this account, for duplicate detection. */
export interface ExistingTransaction {
  id: string;
  bookedOn: CalendarDay;
  amountMinor: number;
  /**
   * The raw description as stored. This module normalises it before comparing,
   * so the caller hands over what the column holds and does not have to know
   * which of the two forms the index is keyed on.
   */
  description: string;
  /** Present when the bank gave the row an id. */
  externalId: string | null;
}

export interface StatementContext {
  importId: string;
  filename: string;
  accountId: string;
  rules: CompiledRuleSet;
  existing: readonly ExistingTransaction[];
}

/** One row cleared for insertion. The API turns these into Prisma creates. */
export interface PlannedRow {
  lineNumber: number;
  bookedOn: CalendarDay;
  amountMinor: number;
  description: string;
  merchant: string | null;
  externalId: string | null;
  fingerprint: string;
  categoryId: string | null;
  categorySource: 'rule' | 'none';
  ruleId: string | null;
}

/**
 * The preview, plus the server-side half of every row.
 *
 * `ImportPreview` is the wire contract, shared with the browser, and it must not
 * grow a `fingerprint` or a `merchant`: a fingerprint the client can see is one
 * the client can send back, and the whole point of computing it on the server
 * (packages/shared/src/server/fingerprint.ts) is that it is derived from the
 * account id rather than supplied alongside it. `planCommit` needs both fields,
 * so they travel beside the wire object instead of inside it, keyed by the same
 * line numbers.
 *
 * `apps/api` persists the wire subset and passes the whole `PreviewResult` to
 * `planCommit` within the same request, or rebuilds it from the stored
 * `ImportRow`s on a later commit.
 */
export type PreviewResult = ImportPreview & { readonly plan: readonly PlannedRow[] };
