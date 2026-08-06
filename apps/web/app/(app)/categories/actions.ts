'use server';

import { COLOR_SLOT_COUNT, createCategorySchema } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import { failed, runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { text } from '../../../lib/form-fields';
import { authedRequest } from '../../../lib/session';

/**
 * Creating, renaming and removing a category.
 *
 * Three things about this file are decided rather than obvious.
 *
 * **The update is a `PUT` and carries every field.** `PUT /categories/:id`
 * validates against `createCategorySchema`, the same schema as the `POST`, so a
 * request that omitted `kind` would fail validation rather than leave the kind
 * alone. The form therefore always renders the current kind and always sends it
 * back.
 *
 * **The colour slot is always sent, including on create.** If it is absent the
 * API assigns `max(slot) + 1`, which for the seeded taxonomy is 10 -- outside the
 * ten-hue palette, which `categorySwatchVar` folds onto `--cat-none`, the grey
 * that means "uncategorised". See `lib/palette.ts`.
 *
 * **Delete revalidates four paths.** Deleting a category is the widest write in
 * this app: `transactions.category_id` is `ON DELETE SET NULL`, so rows move into
 * the uncategorised queue and keep their history, while budgets and rules for a
 * category that no longer exists are cascaded away. Every page that names a
 * category is wrong the moment this returns.
 */

/** The pages that render a category name, a swatch or a category total. */
const AFFECTED = ['/categories', '/rules', '/budgets', '/transactions', '/reports', '/'];

function revalidateAffected(): void {
  for (const path of AFFECTED) revalidatePath(path);
}

/**
 * Read the slot the form sent.
 *
 * Returns `undefined` rather than a number when the field is missing or outside
 * the palette, which lets the API's own assignment take over instead of storing a
 * slot that renders as the uncategorised grey. `Number.parseInt` and not
 * `Number`: an empty select value is `''`, and `Number('')` is `0`, which would
 * silently repaint a category with the first hue.
 */
function colorSlotFrom(form: FormData): number | undefined {
  const raw = text(form, 'colorSlot');
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= COLOR_SLOT_COUNT) return undefined;
  return parsed;
}

function parseForm(form: FormData): ReturnType<typeof createCategorySchema.safeParse> {
  return createCategorySchema.safeParse({
    name: text(form, 'name'),
    kind: text(form, 'kind'),
    colorSlot: colorSlotFrom(form),
  });
}

/** The first zod complaint, as a sentence naming the field it is about. */
function firstIssue(parsed: ReturnType<typeof createCategorySchema.safeParse>): string {
  if (parsed.success) return 'Check the form.';
  const issue = parsed.error.issues[0];
  return issue ? `${String(issue.path[0] ?? 'That')}: ${issue.message}` : 'Check the form.';
}

export async function createCategoryAction(form: FormData): Promise<ActionResult> {
  const parsed = parseForm(form);
  if (!parsed.success) return failed(firstIssue(parsed));

  return runAction(`"${parsed.data.name}" created.`, async () => {
    await authedRequest(endpoints.categories, null, { method: 'POST', json: parsed.data });
    revalidateAffected();
  });
}

export async function updateCategoryAction(
  categoryId: string,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseForm(form);
  if (!parsed.success) return failed(firstIssue(parsed));

  return runAction('Category saved.', async () => {
    await authedRequest(endpoints.category(categoryId), null, {
      method: 'PUT',
      json: parsed.data,
    });
    revalidateAffected();
  });
}

export async function deleteCategoryAction(categoryId: string): Promise<ActionResult> {
  return runAction('Category removed. Its transactions are now uncategorised.', async () => {
    await authedRequest(endpoints.category(categoryId), null, { method: 'DELETE' });
    revalidateAffected();
  });
}
