/**
 * Turning a planned alert into the exact bytes of an email.
 *
 * Pure, and that is a property worth defending: no clock, no locale read from
 * the environment, no random boundary string, no "generated at" line. The same
 * alert renders to the same bytes on every machine, which is what makes a
 * snapshot of the body a test rather than a screenshot, and what makes a
 * duplicate send diagnosable (identical body means the planner ran twice;
 * different body means the numbers moved).
 *
 * Three rules the body obeys, each of which has a reader behind it:
 *
 * **Money and months are formatted, never concatenated.** Every amount goes
 * through `formatMoney`, which hands `Intl` an exact decimal string; every month
 * goes through `formatMonth`. A string built as `` `${spent / 100} €` `` is both
 * a float and wrong in half of Europe.
 *
 * **The level is never carried by colour alone.** The red banner is
 * reinforcement. The words ("Over budget") and a glyph carry the message, in the
 * HTML and identically in the plain text, because a deuteranopic reader sees the
 * amber and the red as near-identical greys and a text-only client sees no
 * colour at all.
 *
 * **Every interpolated value is escaped.** A category is a free-text field the
 * user typed. `Coffee & <b>cake</b>` has to arrive as those characters and not
 * as markup, and the same input has to be safe in the `<title>`, in the body,
 * and in the footer.
 *
 * The HTML is a table layout with inline styles only: no external stylesheet, no
 * web font, no `<style>` block. Gmail strips `<head>` styles, Outlook renders
 * with Word, and neither of them is going to be fixed by us. The `text` part is
 * not a fallback nobody reads either, it is what a screen reader in a text-mode
 * client gets, so it carries the same numbers in the same order.
 */
import { formatMonth, formatMoney, minor, type CalendarMonth } from '@fin/shared';
import type { AlertLevel, OutboundMessage, PlannedAlert, RenderContext } from './types';

/**
 * The non-colour channel, one per level.
 *
 * Written as escapes rather than pasted literals so the source stays ASCII and
 * nobody has to guess whether a variation selector snuck in beside the warning
 * sign. U+FE0F is invisible in every editor and would change the rendered bytes.
 */
const LEVEL_GLYPH: Record<AlertLevel, string> = {
  exceeded: '\u26A0', // WARNING SIGN
  approaching: '\u25B3', // WHITE UP-POINTING TRIANGLE
};

/** The same message in words. Present in both the HTML and the text part. */
const LEVEL_WORDS: Record<AlertLevel, string> = {
  exceeded: 'Over budget',
  approaching: 'Approaching the limit',
};

/**
 * Banner colours, chosen against measured contrast rather than by eye.
 *
 * Text on banner: 9.20:1 for exceeded, 7.54:1 for approaching. Both clear
 * WCAG AA for text at any size, which matters because a mail client may render
 * this at the reader's own zoom with no way for us to know.
 */
const LEVEL_COLOURS: Record<AlertLevel, { background: string; border: string; text: string }> = {
  exceeded: { background: '#fbeaea', border: '#a01b1b', text: '#7a1717' },
  approaching: { background: '#fdf3e0', border: '#a86a12', text: '#6b4708' },
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for HTML text and for a double-quoted attribute.
 *
 * All five characters, not the three that "look dangerous". The quotes are the
 * ones that get skipped and they are the ones that matter here: the subject is
 * interpolated into `<title>` and the link into `href="..."`, so an unescaped
 * `"` ends the attribute and everything after it becomes markup.
 *
 * `&#39;` rather than `&apos;`: the named entity is HTML5 only and older mail
 * clients render it literally.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The deep link into the web app, for this budget's month.
 *
 * Built with `new URL` rather than by concatenation so `APP_BASE_URL` works
 * whether or not it ends in a slash, which is exactly the kind of difference
 * between a `.env` and a `.env.example` that nobody notices until the link
 * 404s. The base's own path is preserved (`https://host/app` keeps `/app`),
 * because a root-anchored path would silently drop it.
 *
 * Throws on a base that is not an absolute URL. That is a startup
 * misconfiguration, and a mail whose only call to action is a dead link is
 * worse than a loud failure the logs can name.
 */
function budgetsLink(appBaseUrl: string, month: CalendarMonth): string {
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    throw new Error(
      `APP_BASE_URL must be an absolute URL to build an alert link, got ${JSON.stringify(appBaseUrl)}.`,
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/budgets`;
  url.searchParams.set('month', month);
  return url.toString();
}

/**
 * Render one alert.
 *
 * The percentage comes from `usedBasisPoints` and nowhere else, integer-divided
 * by 100. Recomputing it from the amounts here would give a second rounding of
 * the same quantity, and the mail would eventually disagree with the progress
 * bar the reader is looking at by one point.
 */
export function renderAlert(alert: PlannedAlert, ctx: RenderContext): OutboundMessage {
  const money = (amountMinor: number): string =>
    formatMoney(minor(amountMinor), { currency: ctx.currency, locale: ctx.locale });

  const monthLabel = formatMonth(alert.month, ctx.locale);
  const percent = Math.round(alert.usedBasisPoints / 100);
  const limit = money(alert.limitMinor);
  const spent = money(alert.spentMinor);
  const glyph = LEVEL_GLYPH[alert.level];
  const words = LEVEL_WORDS[alert.level];
  const colours = LEVEL_COLOURS[alert.level];
  const link = budgetsLink(ctx.appBaseUrl, alert.month);

  const subject =
    alert.level === 'exceeded'
      ? `${alert.categoryName}: budget exceeded for ${monthLabel}`
      : `${alert.categoryName}: ${percent}% of budget used for ${monthLabel}`;

  const summary =
    alert.level === 'exceeded'
      ? `You have spent ${spent} against a ${limit} budget for ${monthLabel}.`
      : `You have used ${percent}% of your ${limit} budget for ${monthLabel}.`;

  // The difference row flips meaning with the level, so it flips label too.
  // "Remaining: -31,20 €" is a number the reader has to decode; "Over by" is not.
  const differenceLabel = alert.level === 'exceeded' ? 'Over by' : 'Left to spend';
  const difference = money(
    alert.level === 'exceeded'
      ? alert.spentMinor - alert.limitMinor
      : alert.limitMinor - alert.spentMinor,
  );

  const rows: Array<[string, string]> = [
    ['Category', alert.categoryName],
    ['Month', monthLabel],
    ['Limit', limit],
    ['Spent', spent],
    [differenceLabel, difference],
    ['Used', `${percent}% of the limit`],
  ];

  const text = [
    `${glyph} ${words}`,
    '',
    subject,
    '',
    summary,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Review this budget: ${link}`,
    '',
    `You are getting this because you set a budget for ${alert.categoryName}.`,
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f4f4f2;color:#1c1c1a;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f2;">',
    '<tr>',
    '<td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #d9d9d4;">',
    '<tr>',
    `<td style="padding:16px 24px;background-color:${colours.background};border-bottom:4px solid ${colours.border};">`,
    `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;font-weight:bold;color:${colours.text};">`,
    // The glyph is hidden from assistive tech because the words beside it say the
    // same thing; a screen reader announcing "warning sign Over budget" is noise.
    // Sighted readers who cannot separate the amber from the red get the shape.
    `<span aria-hidden="true">${escapeHtml(glyph)}</span> ${escapeHtml(words)}`,
    '</p>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:24px;font-family:Helvetica,Arial,sans-serif;">',
    `<h1 style="margin:0 0 8px 0;font-size:20px;line-height:28px;color:#1c1c1a;">${escapeHtml(subject)}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:#5a5a55;">${escapeHtml(summary)}</p>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:15px;line-height:22px;color:#1c1c1a;">',
    ...rows.map(
      ([label, value]) =>
        '<tr>' +
        `<th align="left" style="padding:6px 0;font-weight:normal;color:#5a5a55;">${escapeHtml(label)}</th>` +
        `<td align="right" style="padding:6px 0;font-weight:bold;">${escapeHtml(value)}</td>` +
        '</tr>',
    ),
    '</table>',
    // Underlined, not blue-only: colour is not the only thing marking a link either.
    `<p style="margin:24px 0 0 0;font-size:15px;line-height:22px;"><a href="${escapeHtml(link)}" style="color:#1a4fa0;text-decoration:underline;">Review this budget</a></p>`,
    '</td>',
    '</tr>',
    '<tr>',
    `<td style="padding:16px 24px;border-top:1px solid #d9d9d4;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#5a5a55;">You are getting this because you set a budget for ${escapeHtml(alert.categoryName)}.</td>`,
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');

  // `from` is left empty on purpose. The sender is transport configuration
  // (`MAIL_FROM`), not content, and the renderer has no business knowing it: the
  // same rendered alert has to be printable by the log channel and sendable by
  // SMTP without being re-rendered. `createChannel` fills it in, and refuses to
  // send at all when it has no sender to fill in with.
  return { to: ctx.recipient, from: '', subject, text, html };
}
