import type { Account, Category } from '@fin/shared';

/**
 * Turning a list into something a table row can ask a question of.
 *
 * A transaction carries `categoryId` and `accountId`, not a name — which is
 * correct on the wire, and useless in a cell. Building a `Map` once per render
 * and looking each row up is O(rows); calling `categories.find()` inside the row
 * is O(rows x categories), and with 200 rows and 10 categories that is 2,000
 * comparisons for the same answer.
 *
 * These live in `lib/` rather than in the page so `lookup.test.ts` can pin the
 * one interesting case: an id the list does not contain. A missing category is a
 * normal state — the row is uncategorised — and it must never throw or render
 * `undefined`.
 */
export function categoryIndex(categories: readonly Category[]): Map<string, Category> {
  return new Map(categories.map((category) => [category.id, category]));
}

export function accountIndex(accounts: readonly Account[]): Map<string, Account> {
  return new Map(accounts.map((account) => [account.id, account]));
}

/** An account's name, or a placeholder that does not pretend to be one. */
export function accountName(accounts: Map<string, Account>, id: string): string {
  return accounts.get(id)?.name ?? 'Unknown account';
}
