import { describe, expect, it } from 'vitest';
import { month as calendarMonth } from '@fin/shared';
import { escapeHtml, renderAlert } from './render';
import type { PlannedAlert, RenderContext } from './types';

// Every expected money and month string in this file was produced by running the
// formatter, never typed from memory. `es-ES` puts U+00A0 (a no-break space)
// before the symbol, which is indistinguishable from a normal space in a diff,
// so it is always written as the escape `\u00A0`:
//
//   node -e "const s=require('./packages/shared/dist/index.js');
//     console.log(JSON.stringify(s.formatMoney(s.minor(40000),{currency:'EUR',locale:'es-ES'})))"
//   -> "400,00 €"   (the space is U+00A0)

const EXCEEDED: PlannedAlert = {
  budgetId: 'b-groceries',
  categoryId: 'c-groceries',
  categoryName: 'Groceries',
  month: calendarMonth('2026-03'),
  level: 'exceeded',
  limitMinor: 40_000,
  spentMinor: 43_120,
  usedBasisPoints: 10_780,
};

const APPROACHING: PlannedAlert = {
  budgetId: 'b-transport',
  categoryId: 'c-transport',
  categoryName: 'Transport',
  month: calendarMonth('2026-03'),
  level: 'approaching',
  limitMinor: 12_000,
  spentMinor: 9840,
  usedBasisPoints: 8200,
};

const EN_USD: RenderContext = {
  locale: 'en-US',
  currency: 'USD',
  appBaseUrl: 'http://localhost:3000',
  recipient: 'reader@example.com',
};

const ES_EUR: RenderContext = {
  locale: 'es-ES',
  currency: 'EUR',
  appBaseUrl: 'http://localhost:3000',
  recipient: 'lector@example.com',
};

describe('renderAlert, exceeded', () => {
  it('renders the subject and the numbers in en-US / USD', () => {
    const message = renderAlert(EXCEEDED, EN_USD);

    expect(message.subject).toBe('Groceries: budget exceeded for March 2026');
    expect(message.to).toBe('reader@example.com');
    expect(message.text).toContain(
      'You have spent $431.20 against a $400.00 budget for March 2026.',
    );
    expect(message.text).toContain('Limit: $400.00');
    expect(message.text).toContain('Spent: $431.20');
    expect(message.text).toContain('Over by: $31.20');
    expect(message.text).toContain('Used: 108% of the limit');
    expect(message.html).toContain('$431.20');
    expect(message.html).toContain('$31.20');
  });

  it('renders the same alert in es-ES / EUR', () => {
    const message = renderAlert(EXCEEDED, ES_EUR);

    expect(message.subject).toBe('Groceries: budget exceeded for marzo de 2026');
    expect(message.text).toContain('Limit: 400,00\u00A0€');
    expect(message.text).toContain('Spent: 431,20\u00A0€');
    expect(message.text).toContain('Over by: 31,20\u00A0€');
    expect(message.text).toContain(
      'You have spent 431,20\u00A0€ against a 400,00\u00A0€ budget for marzo de 2026.',
    );
  });

  it('states the level in words and with a glyph, not only in colour', () => {
    const message = renderAlert(EXCEEDED, EN_USD);

    expect(message.text).toContain('\u26A0 Over budget');
    expect(message.html).toContain('<span aria-hidden="true">\u26A0</span> Over budget');
  });
});

describe('renderAlert, approaching', () => {
  it('puts the integer percentage in the subject, in en-US / USD', () => {
    const message = renderAlert(APPROACHING, EN_USD);

    expect(message.subject).toBe('Transport: 82% of budget used for March 2026');
    expect(message.text).toContain('Limit: $120.00');
    expect(message.text).toContain('Spent: $98.40');
    expect(message.text).toContain('Left to spend: $21.60');
    expect(message.text).toContain('Used: 82% of the limit');
  });

  it('renders the same alert in es-ES / EUR', () => {
    const message = renderAlert(APPROACHING, ES_EUR);

    expect(message.subject).toBe('Transport: 82% of budget used for marzo de 2026');
    expect(message.text).toContain('Left to spend: 21,60\u00A0€');
    expect(message.text).toContain(
      'You have used 82% of your 120,00\u00A0€ budget for marzo de 2026.',
    );
  });

  it('formats a currency the locale writes differently: USD in es-ES, EUR in en-US', () => {
    const esUsd = renderAlert(APPROACHING, { ...ES_EUR, currency: 'USD' });
    const enEur = renderAlert(APPROACHING, { ...EN_USD, currency: 'EUR' });

    expect(esUsd.text).toContain('Limit: 120,00\u00A0US$');
    expect(enEur.text).toContain('Limit: €120.00');
  });

  it('states its own level in words and with its own glyph', () => {
    const message = renderAlert(APPROACHING, EN_USD);

    expect(message.text).toContain('\u25B3 Approaching the limit');
    expect(message.html).toContain('<span aria-hidden="true">\u25B3</span> Approaching the limit');
    expect(message.html).not.toContain('Over budget');
  });
});

describe('renderAlert, percentage', () => {
  it('rounds the basis points to an integer rather than printing a float', () => {
    // 10780 bp is 107.8%. A float would reach the subject as "107.8%".
    expect(renderAlert(EXCEEDED, EN_USD).text).toContain('Used: 108% of the limit');
    expect(renderAlert({ ...APPROACHING, usedBasisPoints: 8149 }, EN_USD).subject).toBe(
      'Transport: 81% of budget used for March 2026',
    );
    expect(renderAlert({ ...APPROACHING, usedBasisPoints: 8150 }, EN_USD).subject).toBe(
      'Transport: 82% of budget used for March 2026',
    );
  });
});

describe('renderAlert, HTML', () => {
  it('is a self-contained document with a language and a title', () => {
    const message = renderAlert(EXCEEDED, EN_USD);

    expect(message.html.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true);
    expect(message.html).toContain('<title>Groceries: budget exceeded for March 2026</title>');
    expect(message.html).toContain('</html>');
  });

  it('pulls in nothing external: no stylesheet, no style block, no web font, no image', () => {
    const message = renderAlert(EXCEEDED, EN_USD);

    expect(message.html).not.toContain('<link');
    expect(message.html).not.toContain('<style');
    expect(message.html).not.toContain('@import');
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('fonts.googleapis');
  });

  it('carries a plain-text part with the same numbers, for a text-only client', () => {
    const message = renderAlert(EXCEEDED, EN_USD);

    expect(message.text).not.toContain('<');
    expect(message.text).toContain('$431.20');
    expect(message.text).toContain('http://localhost:3000/budgets?month=2026-03');
  });

  it('escapes a category name that contains markup', () => {
    const nasty = { ...EXCEEDED, categoryName: `Coffee & <b>cake</b> "the" 'one'` };
    const message = renderAlert(nasty, EN_USD);

    expect(message.html).toContain(
      'Coffee &amp; &lt;b&gt;cake&lt;/b&gt; &quot;the&quot; &#39;one&#39;',
    );
    expect(message.html).not.toContain('<b>cake');
    expect(message.html).toContain(
      '<title>Coffee &amp; &lt;b&gt;cake&lt;/b&gt; &quot;the&quot; &#39;one&#39;: budget exceeded for March 2026</title>',
    );
    // The plain-text part is not markup and must not be entity-encoded.
    expect(message.text).toContain(`Coffee & <b>cake</b> "the" 'one'`);
    expect(message.text).not.toContain('&amp;');
  });
});

describe('escapeHtml', () => {
  it('escapes all five characters that can break out of text or an attribute', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a&b&c')).toBe('a&amp;b&amp;c');
  });

  it('leaves an already-safe string alone', () => {
    expect(escapeHtml('Groceries 2026')).toBe('Groceries 2026');
  });
});

describe('renderAlert, deep link', () => {
  it('builds the same link whether or not the base URL ends in a slash', () => {
    const withoutSlash = renderAlert(EXCEEDED, { ...EN_USD, appBaseUrl: 'http://localhost:3000' });
    const withSlash = renderAlert(EXCEEDED, { ...EN_USD, appBaseUrl: 'http://localhost:3000/' });
    const expected = 'http://localhost:3000/budgets?month=2026-03';

    expect(withoutSlash.text).toContain(`Review this budget: ${expected}`);
    expect(withSlash.text).toContain(`Review this budget: ${expected}`);
    expect(withoutSlash.html).toContain(`href="${expected}"`);
    expect(withSlash.html).toContain(`href="${expected}"`);
  });

  it('keeps a base URL that has its own path prefix', () => {
    const message = renderAlert(EXCEEDED, {
      ...EN_USD,
      appBaseUrl: 'https://money.example.com/app/',
    });

    expect(message.text).toContain('https://money.example.com/app/budgets?month=2026-03');
  });

  it('refuses a base URL that is not absolute, rather than mailing a dead link', () => {
    expect(() => renderAlert(EXCEEDED, { ...EN_USD, appBaseUrl: '/budgets' })).toThrow(
      /APP_BASE_URL must be an absolute URL/,
    );
  });
});

describe('renderAlert, purity', () => {
  it('renders byte-identical output when called twice', () => {
    const first = renderAlert(EXCEEDED, ES_EUR);
    const second = renderAlert(EXCEEDED, ES_EUR);

    expect(second.subject).toBe(first.subject);
    expect(second.text).toBe(first.text);
    expect(second.html).toBe(first.html);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('leaves the sender to the channel', () => {
    // MAIL_FROM is transport configuration; the renderer is not given it.
    expect(renderAlert(EXCEEDED, EN_USD).from).toBe('');
  });

  it('does not mutate the alert it was given', () => {
    const alert: PlannedAlert = { ...EXCEEDED };
    renderAlert(alert, EN_USD);

    expect(alert).toEqual(EXCEEDED);
  });
});
