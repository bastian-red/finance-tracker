import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { day, importPreviewRowSchema, importPreviewSchema } from '@fin/shared';
import { compileRules } from '@fin/categorize';
import type { CategorizeRule } from '@fin/categorize';
import { detectStatement } from './detect';
import { buildPreview, MAX_DESCRIPTION, planCommit } from './preview';
import type { ExistingTransaction, ParseOptions, PreviewResult, StatementContext } from './types';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

/** `broken-rows.csv` is plain ASCII/UTF-8; read as text for the string-taking `preview()` helper. */
const fixtureText = (name: string): string => fixture(name).toString('utf8');

const opts: ParseOptions = {
  localeDecimal: '.',
  currency: 'EUR',
  maxBytes: 8_388_608,
  duplicateWindowDays: 3,
};

/** Build a preview from a CSV literal with the parts a caller actually varies. */
function preview(
  csv: string,
  overrides: Partial<Pick<StatementContext, 'existing' | 'rules'>> = {},
): PreviewResult {
  const bytes = Buffer.from(csv, 'utf8');
  const format = detectStatement(bytes, opts);
  const ctx: StatementContext = {
    importId: 'imp-1',
    filename: 'test.csv',
    accountId: 'acc-1',
    rules: overrides.rules ?? compileRules([]),
    existing: overrides.existing ?? [],
  };
  return buildPreview(bytes, format, ctx, opts);
}

describe('buildPreview -- amount sign', () => {
  it('reads an expense negative and income positive, in exact minor units', () => {
    // Real BBVA export: a comma decimal, semicolon delimiter, latin1 encoding,
    // one debit row and one income row (NÓMINA, a salary deposit).
    const bytes = fixture('bbva-es.csv');
    const format = detectStatement(bytes, opts);
    const result = buildPreview(
      bytes,
      format,
      {
        importId: 'imp-1',
        filename: 'bbva-es.csv',
        accountId: 'acc-1',
        rules: compileRules([]),
        existing: [],
      },
      opts,
    );
    const mercadona = result.rows.find((r) => r.description.startsWith('MERCADONA'));
    const nomina = result.rows.find((r) => r.description.startsWith('NÓMINA'));
    expect(mercadona?.amountMinor).toBe(-5240);
    expect(nomina?.amountMinor).toBe(185_000);
  });

  it('reads a split debit/credit column pair with the column carrying the sign, not the value', () => {
    // Chase writes both columns as bare magnitudes -- the sign lives entirely in
    // which column is non-empty. A debit-minus-credit reading would still land
    // on the right number here by coincidence unless it is checked on a row of
    // each kind, which is why this covers one debit row and the one credit row.
    const bytes = fixture('chase-us.csv');
    const format = detectStatement(bytes, opts);
    const result = buildPreview(
      bytes,
      format,
      {
        importId: 'imp-1',
        filename: 'chase-us.csv',
        accountId: 'acc-1',
        rules: compileRules([]),
        existing: [],
      },
      opts,
    );
    const debitRow = result.rows.find((r) => r.description.startsWith('WHOLE FOODS'));
    const creditRow = result.rows.find((r) => r.description.startsWith('ACME CORP PAYROLL'));
    expect(debitRow?.amountMinor).toBe(-8421);
    expect(creditRow?.amountMinor).toBe(123_456);
  });
});

describe('buildPreview -- broken rows', () => {
  it('turns each broken row into an error row and still previews every good one', () => {
    // fixtures/broken-rows.csv: an unparseable date, an unparseable amount, and
    // a row too short to have an amount cell at all -- three distinct failure
    // shapes, none of which may stop the other three good lines from previewing.
    const result = preview(fixtureText('broken-rows.csv'));

    expect(result.counts.total).toBe(6);
    expect(result.counts.error).toBe(3);
    // The good rows: one plain new row, one duplicate of another line in the
    // same file (the fixture repeats its last line on purpose), nothing else.
    const goodRows = result.rows.filter((r) => r.status !== 'error');
    expect(goodRows).toHaveLength(3);
    expect(result.counts.new + result.counts.duplicate).toBe(3);

    const messages = result.rows.filter((r) => r.status === 'error').map((r) => r.message);
    expect(messages).toEqual([
      '"notadate" is not a date in the detected format.',
      'Amount "no-es-un-importe" contains no digits.',
      'The amount cell is empty or the row is too short.',
    ]);

    // Error rows carry no day and no amount -- there is nothing safe to insert.
    for (const row of result.rows.filter((r) => r.status === 'error')) {
      expect(row.bookedOn).toBeNull();
      expect(row.amountMinor).toBeNull();
    }
  });
});

describe('buildPreview -- duplicate detection', () => {
  const existing: ExistingTransaction[] = [
    {
      id: 'existing-1',
      bookedOn: day('2026-01-01'),
      amountMinor: -1000,
      description: 'Some Shop',
      externalId: null,
    },
  ];

  it('flags a row inside the window, on the boundary day, as a duplicate of the ledger row', () => {
    const csv = 'Date,Description,Amount\n2026-01-04,SOME SHOP,-10.00\n'; // distance 3 == window
    const result = preview(csv, { existing });
    expect(result.rows[0]).toMatchObject({ status: 'duplicate', duplicateOfId: 'existing-1' });
  });

  it('treats the same row one day past the window as new', () => {
    const csv = 'Date,Description,Amount\n2026-01-05,SOME SHOP,-10.00\n'; // distance 4 > window
    const result = preview(csv, { existing });
    expect(result.rows[0]).toMatchObject({ status: 'new', duplicateOfId: null });
  });

  it('treats a different amount inside the window as new', () => {
    const csv = 'Date,Description,Amount\n2026-01-03,SOME SHOP,-11.00\n'; // distance 2, different amount
    const result = preview(csv, { existing });
    expect(result.rows[0]).toMatchObject({ status: 'new', duplicateOfId: null });
  });

  it('flags a repeated line inside the same file as a duplicate of the first, with no ledger id', () => {
    const csv =
      'Date,Description,Amount\n' +
      '2026-01-01,GLOVO NIGHT,-15.20\n' +
      '2026-01-01,GLOVO NIGHT,-15.20\n';
    const result = preview(csv);
    expect(result.rows[0]).toMatchObject({ status: 'new' });
    expect(result.rows[1]).toMatchObject({ status: 'duplicate', duplicateOfId: null });
    expect(result.rows[1]!.message).toContain('line 2');
  });

  it('flags an external-id collision even when the description differs entirely', () => {
    const withExternalId: ExistingTransaction[] = [
      {
        id: 'existing-2',
        bookedOn: day('2026-01-01'),
        amountMinor: -500,
        description: 'Old Desc',
        externalId: 'EXT001',
      },
    ];
    const csv =
      'Date,Description,Amount,Id\n2026-06-01,COMPLETELY DIFFERENT DESCRIPTION,-999.00,EXT001\n';
    const result = preview(csv, { existing: withExternalId });
    expect(result.rows[0]).toMatchObject({ status: 'duplicate', duplicateOfId: 'existing-2' });
  });
});

describe('buildPreview -- rule categorisation', () => {
  const rules: CategorizeRule[] = [
    {
      id: 'rule-1',
      categoryId: 'cat-1',
      matcherType: 'contains',
      matcherValue: 'mercadona',
      priority: 100,
      minAmountMinor: null,
      maxAmountMinor: null,
      active: true,
    },
  ];

  it('populates categoryId, categorySource and ruleId on a match, and leaves an unmatched row bare', () => {
    const csv =
      'Date,Description,Amount\n' +
      '2026-01-01,MERCADONA MADRID,-20.00\n' +
      '2026-01-02,UNRELATED SHOP,-5.00\n';
    const result = preview(csv, { rules: compileRules(rules) });

    expect(result.rows[0]).toMatchObject({ suggestedCategoryId: 'cat-1' });
    expect(result.rows[1]).toMatchObject({ suggestedCategoryId: null, suggestedBy: null });

    const [matched, unmatched] = result.plan;
    expect(matched).toMatchObject({
      categoryId: 'cat-1',
      categorySource: 'rule',
      ruleId: 'rule-1',
    });
    expect(unmatched).toMatchObject({ categoryId: null, categorySource: 'none', ruleId: null });
  });
});

describe('buildPreview -- fingerprint stays server-side', () => {
  it('puts fingerprint on the plan but never on the wire row', () => {
    const result = preview('Date,Description,Amount\n2026-01-01,COFFEE,-3.00\n');

    expect(result.plan[0]!.fingerprint).toBeTypeOf('string');
    expect(result.plan[0]!.fingerprint.length).toBeGreaterThan(0);

    const wireRow = result.rows[0]!;
    expect(Object.keys(wireRow)).not.toContain('fingerprint');
    expect(Object.keys(wireRow)).not.toContain('merchant');
    expect(importPreviewRowSchema.parse(wireRow)).toEqual(wireRow);
    expect(importPreviewSchema.parse(result)).toMatchObject({
      rows: result.rows,
      counts: result.counts,
    });
  });
});

describe('planCommit', () => {
  it('drops exactly the skipped line numbers and keeps line-number order', () => {
    const existing: ExistingTransaction[] = [
      {
        id: 'existing-3',
        bookedOn: day('2026-01-01'),
        amountMinor: -1000,
        description: 'Dup Row',
        externalId: null,
      },
    ];
    const csv =
      'Date,Description,Amount\n' +
      '2026-01-01,ALPHA,-1.00\n' + // line 2, new
      '2026-01-01,DUP ROW,-10.00\n' + // line 3, duplicate of existing-3
      '2026-01-01,BETA,-2.00\n' + // line 4, new
      'not-a-date,BROKEN,-3.00\n' + // line 5, error -- never enters `plan` at all
      '2026-01-01,GAMMA,-4.00\n'; // line 6, new
    const result = preview(csv, { existing });

    expect(result.counts).toEqual({ total: 5, new: 3, duplicate: 1, error: 1 });

    const committed = planCommit(result, [2]);
    expect(committed.map((r) => r.lineNumber)).toEqual([3, 4, 6]);
  });

  it('does not drop duplicates on its own -- that default belongs to the caller', () => {
    // The module's own comment is explicit about this: `planCommit` only removes
    // what `skipLines` names. A caller that wants "skip every duplicate by
    // default" builds that list itself, typically from `preview.rows` filtered
    // on `status === 'duplicate'`, and passes it in.
    const existing: ExistingTransaction[] = [
      {
        id: 'existing-4',
        bookedOn: day('2026-01-01'),
        amountMinor: -1000,
        description: 'Dup Row',
        externalId: null,
      },
    ];
    const csv = 'Date,Description,Amount\n2026-01-01,DUP ROW,-10.00\n';
    const result = preview(csv, { existing });

    expect(result.rows[0]!.status).toBe('duplicate');
    expect(planCommit(result, []).map((r) => r.lineNumber)).toEqual([2]);

    const skipLines = result.rows.filter((r) => r.status === 'duplicate').map((r) => r.lineNumber);
    expect(planCommit(result, skipLines)).toEqual([]);
  });
});

describe('buildPreview -- description length', () => {
  it('truncates at MAX_DESCRIPTION before the fingerprint and the plan ever see it', () => {
    const long = 'X'.repeat(400);
    const result = preview(`Date,Description,Amount\n2026-01-01,${long},-1.00\n`);
    expect(result.rows[0]!.description).toHaveLength(MAX_DESCRIPTION);
    expect(result.plan[0]!.description).toHaveLength(MAX_DESCRIPTION);
  });
});

describe('buildPreview -- purity', () => {
  it('is pure: the same input twice yields deep-equal results and never mutates `existing`', () => {
    const bytes = Buffer.from('Date,Description,Amount\n2026-01-01,COFFEE,-3.00\n', 'utf8');
    const format = detectStatement(bytes, opts);
    const existing: ExistingTransaction[] = [
      {
        id: 'e1',
        bookedOn: day('2026-01-01'),
        amountMinor: -300,
        description: 'Coffee',
        externalId: null,
      },
    ];
    const ctx: StatementContext = {
      importId: 'imp-1',
      filename: 'x.csv',
      accountId: 'acc-1',
      rules: compileRules([]),
      existing,
    };
    const existingBefore = structuredClone(existing);

    const first = buildPreview(bytes, format, ctx, opts);
    const second = buildPreview(bytes, format, ctx, opts);

    expect(second).toEqual(first);
    expect(existing).toEqual(existingBefore);
  });
});
