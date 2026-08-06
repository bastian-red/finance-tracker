/**
 * Finding the header row and deciding what each column is.
 *
 * Two things make this harder than reading line 1. Banks put account metadata
 * above the header -- the account number, the holder, the period -- so the header
 * can be the fourth line, and those metadata lines are themselves delimited, so
 * they look like rows. And the labels are in whatever language the bank writes
 * in, which for this app's default locale means Spanish at least as often as
 * English.
 *
 * The header is therefore found by content rather than by position: it is the
 * line whose cells look most like column *names*. A data line scores zero here,
 * because `05/01/2026` and `-52,40` are not words in the table below, which is
 * what makes "the line with the most role matches" a safe rule rather than a
 * guess.
 *
 * Matching is whole-word against the normalised label, never a bare substring.
 * `merchantOf` is not used and `includes` is not used directly: `id` as a
 * substring appears in `Validado` and in `Divisa`, and an external-id column
 * pointed at the currency turns every row of a re-import into a duplicate of the
 * wrong transaction.
 */
import { normaliseDescription } from '@fin/shared';
import { ImportError } from './errors';

/** What a column is for. `debit` and `credit` only exist when the bank splits them. */
export type ColumnRole =
  'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'externalId';

/**
 * The label vocabulary, English and Spanish.
 *
 * Order within `ROLE_KEYWORDS` is the order they are tried, and it matters for
 * labels that carry two words: `Debit Amount` holds both `debit` and `amount`,
 * and it is a debit column. The specific reading is checked before the general
 * one, always.
 */
const ROLE_KEYWORDS: ReadonlyArray<readonly [ColumnRole, readonly string[]]> = [
  ['balance', ['balance', 'saldo', 'saldo posterior', 'running balance']],
  ['debit', ['debit', 'debito', 'cargo', 'cargos', 'debe', 'salida', 'pagos']],
  ['credit', ['credit', 'credito', 'abono', 'abonos', 'haber', 'ingreso', 'ingresos', 'entrada']],
  [
    'date',
    [
      'date',
      'fecha',
      'f valor',
      'fecha valor',
      'fecha operacion',
      'fecha contable',
      'booking date',
      'posting date',
      'transaction date',
      'value date',
      'posted',
    ],
  ],
  // `valor` is deliberately absent. In a Spanish statement it is almost always
  // the value *date* ("F. Valor", "Valor"), and an amount column pointed at a
  // date column makes every row an error row.
  ['amount', ['amount', 'importe', 'cantidad', 'monto', 'importe eur']],
  [
    'description',
    [
      'description',
      'descripcion',
      'concepto',
      'concepto ampliado',
      'detalle',
      'movimiento',
      'payee',
      'memo',
      'narrative',
      'beneficiario',
    ],
  ],
];

/**
 * External-id labels, matched by whole label rather than by keyword.
 *
 * The column is the bank's own row id and it is the only real idempotency key
 * this app has: `(account_id, external_id)` is unique in the schema, so pointing
 * it at the wrong column does not degrade duplicate detection, it corrupts it.
 * Whole-label equality is the conservative reading and a missed id column only
 * costs the fallback fingerprint path, which still works.
 */
const EXTERNAL_ID_LABELS: ReadonlySet<string> = new Set([
  'id',
  'transaction id',
  'transaction reference',
  'external id',
  'reference',
  'referencia',
  'referencia externa',
  'numero de operacion',
  'id de operacion',
]);

export interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  /**
   * Set only when the bank split the sign across two columns. Non-null means
   * `amount` is the *debit* column and the signed value is a subtraction.
   */
  credit: number | null;
  balance: number | null;
  /** Never reaches the wire: `detectedFormatSchema` has no field for it. */
  externalId: number | null;
}

export interface HeaderScan {
  /** Index into the record array, not the file line number. */
  recordIndex: number;
  labels: readonly string[];
  columns: ColumnMap;
}

/** How far down the file a header may hide before the file is called headerless. */
export const MAX_HEADER_DEPTH = 30;

/** A line has to name at least this many roles before it is believed to be a header. */
const MIN_HEADER_ROLES = 2;

export function roleOfLabel(label: string): ColumnRole | null {
  const normalised = normaliseDescription(label);
  if (normalised === '') return null;
  if (EXTERNAL_ID_LABELS.has(normalised)) return 'externalId';

  const padded = ` ${normalised} `;
  for (const [role, keywords] of ROLE_KEYWORDS) {
    if (keywords.some((keyword) => padded.includes(` ${keyword} `))) return role;
  }
  return null;
}

/** The roles a single line names, first column wins when two carry the same role. */
export function rolesOf(cells: readonly string[]): Map<ColumnRole, number> {
  const found = new Map<ColumnRole, number>();
  cells.forEach((cell, index) => {
    const role = roleOfLabel(cell);
    if (role !== null && !found.has(role)) found.set(role, index);
  });
  return found;
}

/**
 * The header line, and the columns read off it.
 *
 * Scans rather than stopping at the first plausible line, because a metadata line
 * reading `Fecha;01/01/2026 - 31/01/2026` names one role and the real header
 * names four. Ties go to the topmost line: a statement that repeats its header
 * mid-file (some banks restart it per month) should be read from the first one,
 * so every row below it is a data row.
 */
export function findHeader(records: ReadonlyArray<{ cells: readonly string[] }>): HeaderScan {
  let bestIndex = -1;
  let bestRoles: Map<ColumnRole, number> = new Map();

  const depth = Math.min(records.length, MAX_HEADER_DEPTH);
  for (let index = 0; index < depth; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const roles = rolesOf(record.cells);
    if (roles.size > bestRoles.size) {
      bestIndex = index;
      bestRoles = roles;
    }
  }

  const header = records[bestIndex];
  if (header === undefined || bestRoles.size < MIN_HEADER_ROLES) {
    throw new ImportError(
      'no-header',
      'No header row was found. The importer looks for a line naming a date, a description and an amount column, in English or Spanish.',
    );
  }

  return { recordIndex: bestIndex, labels: header.cells, columns: mapColumns(bestRoles) };
}

/**
 * Turn the roles into the five-plus-one column map.
 *
 * The amount decision is the one with a trap in it. A file that has both a signed
 * `Importe` and a `Haber` column is not a debit/credit file -- it is a signed file
 * that also breaks the amount out for the reader, and treating `Importe` as a
 * debit magnitude would negate every income row. So a signed amount column, when
 * present, wins outright and the credit column is dropped from the map.
 */
export function mapColumns(roles: ReadonlyMap<ColumnRole, number>): ColumnMap {
  const date = roles.get('date');
  if (date === undefined) {
    throw new ImportError(
      'no-date-column',
      'No date column was found. Expected a column named something like "Date", "Fecha" or "F. Valor".',
    );
  }

  const signed = roles.get('amount');
  const debit = roles.get('debit');
  const credit = roles.get('credit');
  if (signed === undefined && debit === undefined && credit === undefined) {
    throw new ImportError(
      'no-amount-column',
      'No amount column was found. Expected a column named something like "Amount", "Importe", or a "Debit"/"Credit" pair.',
    );
  }

  const description = roles.get('description');
  if (description === undefined) {
    throw new ImportError(
      'no-description-column',
      'No description column was found. Expected a column named something like "Description", "Concepto" or "Detalle".',
    );
  }

  const amount = signed ?? debit ?? credit ?? 0;
  return {
    date,
    description,
    amount,
    // Only a real pair sets this. A lone credit column with no debit beside it is
    // read as a signed column, because there is nothing to subtract it from.
    credit: signed === undefined && debit !== undefined && credit !== undefined ? credit : null,
    balance: roles.get('balance') ?? null,
    externalId: roles.get('externalId') ?? null,
  };
}
