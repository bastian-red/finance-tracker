import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { findHeader, mapColumns, roleOfLabel, rolesOf } from './columns';

/** The `code` of whatever `ImportError` `run` throws, so each case reads as one line. */
function codeOf(run: () => unknown): string {
  try {
    run();
    throw new Error('expected an ImportError, nothing was thrown');
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe('findHeader', () => {
  it('scans past metadata lines to the row that actually names columns', () => {
    // Two lines above the header each name at most one role ('Periodo' names
    // nothing, a bare label like 'Some Bank' names nothing either) while the
    // header names three, which is what lets the scan tell them apart.
    const records = [
      { cells: ['Some Bank', ''] },
      { cells: ['Periodo', '01/2026'] },
      { cells: ['Fecha', 'Concepto', 'Importe'] },
      { cells: ['01/01/2026', 'Cafe', '-3,20'] },
    ];
    const header = findHeader(records);
    expect(header.recordIndex).toBe(2);
    expect(header.columns).toMatchObject({ date: 0, description: 1, amount: 2 });
  });
});

describe('roleOfLabel', () => {
  it('recognises the Spanish vocabulary', () => {
    expect(roleOfLabel('Fecha')).toBe('date');
    expect(roleOfLabel('Cargo')).toBe('debit');
    expect(roleOfLabel('Abono')).toBe('credit');
    expect(roleOfLabel('Concepto')).toBe('description');
    expect(roleOfLabel('Saldo')).toBe('balance');
    expect(roleOfLabel('Referencia')).toBe('externalId');
  });

  it('recognises the English vocabulary', () => {
    expect(roleOfLabel('Date')).toBe('date');
    expect(roleOfLabel('Debit')).toBe('debit');
    expect(roleOfLabel('Credit')).toBe('credit');
    expect(roleOfLabel('Description')).toBe('description');
    expect(roleOfLabel('Balance')).toBe('balance');
    expect(roleOfLabel('Reference')).toBe('externalId');
  });

  it('does not match a role as a bare substring', () => {
    // 'Divisa' (currency) contains no whole-word role keyword. If matching were
    // substring-based rather than whole-word, this would wrongly read as
    // something -- the module's own doc comment names 'Validado' and 'Divisa'
    // as the two labels this guards against.
    expect(roleOfLabel('Divisa')).toBeNull();
    expect(roleOfLabel('Validado')).toBeNull();
  });
});

describe('rolesOf', () => {
  it('keeps the first column when two cells claim the same role', () => {
    const roles = rolesOf(['Fecha', 'F. Valor', 'Concepto', 'Importe']);
    expect(roles.get('date')).toBe(0);
    expect(roles.get('description')).toBe(2);
    expect(roles.get('amount')).toBe(3);
  });
});

describe('mapColumns', () => {
  it('reads a split debit/credit layout', () => {
    const roles = new Map([
      ['date', 0],
      ['description', 1],
      ['debit', 2],
      ['credit', 3],
      ['balance', 4],
    ] as const);
    expect(mapColumns(roles)).toEqual({
      date: 0,
      description: 1,
      amount: 2,
      credit: 3,
      balance: 4,
      externalId: null,
    });
  });

  it('reads a single signed-amount layout', () => {
    const roles = new Map([
      ['date', 0],
      ['description', 1],
      ['amount', 2],
    ] as const);
    expect(mapColumns(roles)).toEqual({
      date: 0,
      description: 1,
      amount: 2,
      credit: null,
      balance: null,
      externalId: null,
    });
  });

  it('lets a signed amount column win outright over a credit column beside it', () => {
    // The trap the module's own comment names: a file with both a signed
    // 'Importe' and a 'Haber' is not a debit/credit file. Treating 'Importe' as
    // a debit magnitude here would negate every income row.
    const roles = new Map([
      ['date', 0],
      ['description', 1],
      ['amount', 2],
      ['credit', 3],
    ] as const);
    expect(mapColumns(roles)).toMatchObject({ amount: 2, credit: null });
  });

  it('raises the three distinct no-column errors', () => {
    expect(codeOf(() => mapColumns(new Map([['amount', 0]] as const)))).toBe('no-date-column');
    expect(codeOf(() => mapColumns(new Map([['date', 0]] as const)))).toBe('no-amount-column');
    expect(
      codeOf(() =>
        mapColumns(
          new Map([
            ['date', 0],
            ['amount', 1],
          ] as const),
        ),
      ),
    ).toBe('no-description-column');
  });
});
