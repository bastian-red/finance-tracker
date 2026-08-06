'use client';

import type { Category, Matcher, Rule } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { money } from '../../../lib/format';
import { previewMatcher } from '../../../lib/matcher';
import { createRuleAction, deleteRuleAction, updateRuleAction } from './actions';

/**
 * The rule forms, and the tester that makes them honest.
 *
 * **The tester is the reason this is a client component.** A rule that silently
 * matches nothing is the most common way this feature disappoints, and the cause
 * is almost always invisible from the form: the engine compares against the
 * *normalised* description, so `MERCADONA 4023 MADRID` is `mercadona madrid` by
 * the time a pattern sees it. Somebody writing `MERCADONA \d{4}` gets no error, no
 * warning, and no matches. Showing both forms of each sample beside a live
 * verdict turns that from a mystery into something visible while typing.
 *
 * `previewMatcher` never throws, which matters more here than anywhere else in
 * the app: it runs on every keystroke, and a half-typed `(` is a `SyntaxError`
 * from `new RegExp`. It comes back as a sentence instead.
 *
 * **The preview is not the authority and does not pretend to be.** The API
 * compiles the pattern through `@fin/categorize` with a star-height check and a
 * timing ladder against adversarial input, and refuses anything that backtracks.
 * That needs `safe-regex2` and a high-resolution clock and has no business in a
 * browser. So the worst case here is a pattern that previews cleanly and is then
 * rejected on save, with the API's own sentence rendered verbatim.
 *
 * **The amount window is signed, and that is the field people get wrong.** The
 * ledger stores an expense negative, so "groceries over 50" is a *maximum* of
 * -50.00, not a minimum of 50.00. The hint says it in those words and the preview
 * line under the fields restates whatever was typed as a sentence, because a
 * reader who has mixed up the sign will recognise the mistake in prose long before
 * they recognise it in two number inputs.
 */

const MATCHER_TYPES: readonly { value: Matcher['type']; label: string; hint: string }[] = [
  { value: 'contains', label: 'Contains', hint: 'The text appears anywhere in the description.' },
  { value: 'startsWith', label: 'Starts with', hint: 'The description begins with the text.' },
  { value: 'equals', label: 'Equals', hint: 'The whole description is exactly the text.' },
  {
    value: 'regex',
    label: 'Regular expression',
    hint: 'Matched against the normalised description, which is lowercase and unaccented.',
  },
];

function useSubmit(): {
  result: ActionResult | null;
  pending: boolean;
  run: (action: () => Promise<ActionResult>) => void;
} {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return {
    result,
    pending,
    run: (action) => {
      setResult(null);
      startTransition(async () => {
        const outcome = await action();
        setResult(outcome);
        if (outcome.ok) router.refresh();
      });
    },
  };
}

/** A signed bound typed in major units, as a sentence. Empty means no bound. */
function boundSentence(
  min: string,
  max: string,
  format: { currency: string; locale: string },
): string {
  const readable = (raw: string): string | null => {
    const value = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    // Display only. The action converts by string surgery; this line never
    // produces a value that is sent anywhere.
    return money(Math.round(value * 100), format, 'always');
  };

  const low = min.trim() === '' ? null : readable(min);
  const high = max.trim() === '' ? null : readable(max);

  if (low === null && high === null) return 'Any amount matches.';
  if (low !== null && high !== null) return `Only amounts from ${low} to ${high} match.`;
  if (low !== null) return `Only amounts of ${low} or more match. Expenses are negative.`;
  return `Only amounts of ${high} or less match. Expenses are negative, so this is the usual bound for a spending rule.`;
}

/**
 * The fields, the live tester, and nothing else. Shared by create and edit so the
 * two cannot drift into offering different options for the same stored shape.
 */
function RuleFields({
  idPrefix,
  categories,
  samples,
  currency,
  locale,
  rule,
  defaultPriority,
}: {
  idPrefix: string;
  categories: readonly Category[];
  samples: readonly string[];
  currency: string;
  locale: string;
  rule?: Rule;
  defaultPriority?: number;
}): JSX.Element {
  const [type, setType] = useState<Matcher['type']>(rule?.matcher.type ?? 'contains');
  const [value, setValue] = useState(rule?.matcher.value ?? '');
  const [min, setMin] = useState(rule ? majorOf(rule.minAmountMinor) : '');
  const [max, setMax] = useState(rule ? majorOf(rule.maxAmountMinor) : '');

  // Recomputed only when the pattern or the samples change, not on every render
  // of the parent. With a dozen samples this is a dozen regex executions.
  const preview = useMemo(
    () => previewMatcher({ type, value } as Matcher, samples),
    [type, value, samples],
  );
  const matchCount = preview.probes?.filter((probe) => probe.matched).length ?? 0;
  const typeHint = MATCHER_TYPES.find((option) => option.value === type)?.hint ?? '';

  return (
    <>
      <div className="grid-3">
        <div className="field">
          <label htmlFor={`${idPrefix}-category`}>File it as</label>
          <select
            id={`${idPrefix}-category`}
            name="categoryId"
            required
            defaultValue={rule?.categoryId ?? ''}
          >
            <option value="" disabled>
              Choose a category
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.kind === 'income' ? ' (income)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-type`}>Match by</label>
          <select
            id={`${idPrefix}-type`}
            name="matcherType"
            value={type}
            onChange={(event) => setType(event.target.value as Matcher['type'])}
          >
            {MATCHER_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="field-hint">{typeHint}</span>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-priority`}>Priority</label>
          {/* `step={1}`, not `step={10}`.

              A number input validates its value against `min + n * step`, and a
              value that fails silently blocks the whole form: the browser
              refuses the submit, shows a transient tooltip on a field nobody was
              looking at, and no request is made. The suggested next priority is
              the last rule's plus ten, so the moment any rule sits on a priority
              that is not a multiple of ten -- 85, here, from a seeded ledger --
              the Create button stopped working with no error anywhere. The
              contract accepts any integer from 0 to 10,000; this now says so. */}
          <input
            id={`${idPrefix}-priority`}
            name="priority"
            type="number"
            min={0}
            max={10000}
            step={1}
            defaultValue={String(rule?.priority ?? defaultPriority ?? 0)}
          />
          <span className="field-hint">Lower runs first. The first rule that matches wins.</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-value`}>Pattern</label>
        <input
          id={`${idPrefix}-value`}
          name="matcherValue"
          type="text"
          required
          maxLength={type === 'regex' ? 200 : 120}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${idPrefix}-tester`}
        />
        <span className="field-hint">
          {type === 'regex'
            ? 'Written against the normalised description: lowercase, no accents, no terminal numbers. A pattern with \\d{4} in it will never match.'
            : 'Case and accents are ignored. "Café" finds "CAFE COMERCIAL 4021".'}
        </span>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${idPrefix}-min`}>Lowest amount</label>
          <input
            id={`${idPrefix}-min`}
            name="minAmount"
            type="text"
            inputMode="decimal"
            value={min}
            onChange={(event) => setMin(event.target.value)}
            placeholder="no lower bound"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-max`}>Highest amount</label>
          <input
            id={`${idPrefix}-max`}
            name="maxAmount"
            type="text"
            inputMode="decimal"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            placeholder="no upper bound"
            autoComplete="off"
          />
        </div>
      </div>

      <p className="field-hint" role="status">
        {boundSentence(min, max, { currency, locale })}
      </p>

      {/* The tester. `aria-live="polite"` and not "assertive": it updates on every
          keystroke, and an assertive region would interrupt a screen reader
          mid-word on every character typed into the field above. */}
      <div className="stack-tight" id={`${idPrefix}-tester`}>
        <h4>Against your last transactions</h4>

        {preview.problem !== null ? (
          <p className="state state-exceeded" aria-live="polite">
            <span aria-hidden="true" className="state-glyph">
              &times;
            </span>
            {preview.problem}
          </p>
        ) : samples.length === 0 ? (
          <p className="empty">
            Nothing in the ledger to test against yet. Import a statement and this fills in.
          </p>
        ) : (
          <>
            <p aria-live="polite">
              {value.trim() === ''
                ? 'Type a pattern to see what it would catch.'
                : `${matchCount} of ${samples.length} would match.`}
            </p>
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">
                  Sample descriptions, what the engine compares against, and whether this pattern
                  matches
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Match</th>
                    <th scope="col">On the statement</th>
                    <th scope="col">What the engine sees</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.probes ?? []).map((probe) => (
                    <tr key={probe.description}>
                      <td>
                        {probe.matched ? (
                          <span className="state state-income">
                            <span aria-hidden="true" className="state-glyph">
                              +
                            </span>
                            Yes
                          </span>
                        ) : (
                          <span className="state state-neutral">
                            <span aria-hidden="true" className="state-glyph">
                              &minus;
                            </span>
                            No
                          </span>
                        )}
                      </td>
                      <td>{probe.description}</td>
                      <td className="num">{probe.normalised}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Minor units back to the major-unit text the form edits. Never divides in float. */
function majorOf(amountMinor: number | null): string {
  if (amountMinor === null) return '';
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function CreateRuleForm({
  categories,
  samples,
  currency,
  locale,
  defaultPriority,
}: {
  categories: readonly Category[];
  samples: readonly string[];
  currency: string;
  locale: string;
  defaultPriority: number;
}): JSX.Element {
  const { result, pending, run } = useSubmit();
  // Remounts the fields after a successful create, which is what clears the
  // controlled pattern and amount inputs. `form.reset()` cannot: those inputs are
  // driven by state, and resetting the DOM would leave the tester showing the old
  // pattern's verdict beside an empty field.
  const [formKey, setFormKey] = useState(0);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(async () => {
      const outcome = await createRuleAction(currency, form);
      if (outcome.ok) setFormKey((key) => key + 1);
      return outcome;
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <RuleFields
        key={formKey}
        idPrefix="new-rule"
        categories={categories}
        samples={samples}
        currency={currency}
        locale={locale}
        defaultPriority={defaultPriority}
      />

      <div className="row">
        {/* Checked by default: a rule somebody just wrote is a rule they want
            running. HTML omits an unchecked box from the submission entirely,
            which is what `checked()` in lib/form-fields.ts reads. */}
        <label htmlFor="new-rule-active">
          <input id="new-rule-active" name="active" type="checkbox" defaultChecked /> Active
        </label>

        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Create rule'}
        </button>
      </div>
    </form>
  );
}

export function EditRuleForm({
  rule,
  categories,
  samples,
  currency,
  locale,
}: {
  rule: Rule;
  categories: readonly Category[];
  samples: readonly string[];
  currency: string;
  locale: string;
}): JSX.Element {
  const { result, pending, run } = useSubmit();
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => updateRuleAction(rule.id, currency, form));
  }

  function onDelete(): void {
    setConfirming(false);
    run(() => deleteRuleAction(rule.id));
  }

  return (
    <form className="stack-tight" onSubmit={onSubmit}>
      <Notice result={result} />

      {/* Collapsed by default. A ledger accumulates twenty rules and each expanded
          form carries a twelve-row tester; rendering all of them at once makes the
          page unusable. `<details>` and not a state toggle so it is keyboard
          operable and findable by in-page search without any code. */}
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>Edit this rule</summary>

        <div className="stack">
          {/* Mounted only while open: `RuleFields` runs the tester on mount, and
              twenty hidden copies would each execute the samples for nothing. */}
          {open ? (
            <RuleFields
              idPrefix={`rule-${rule.id}`}
              categories={categories}
              samples={samples}
              currency={currency}
              locale={locale}
              rule={rule}
            />
          ) : null}

          <div className="row">
            <label htmlFor={`rule-${rule.id}-active`}>
              <input
                id={`rule-${rule.id}-active`}
                name="active"
                type="checkbox"
                defaultChecked={rule.active}
              />{' '}
              Active
            </label>

            <button className="btn" type="submit" disabled={pending || !open}>
              {pending ? 'Saving...' : 'Save'}
            </button>

            {confirming ? (
              <>
                <button className="btn" type="button" onClick={onDelete} disabled={pending}>
                  Yes, delete this rule
                </button>
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                className="btn btn-quiet"
                type="button"
                onClick={() => setConfirming(true)}
                disabled={pending}
              >
                Delete
              </button>
            )}
          </div>

          <p className="tile-note" role="status">
            {confirming
              ? 'Transactions this rule already filed keep their category. Only the rule goes.'
              : ''}
          </p>
        </div>
      </details>
    </form>
  );
}
