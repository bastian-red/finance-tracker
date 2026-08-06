/**
 * A deterministic year of somebody's money.
 *
 * Two hard requirements shape this file.
 *
 * **It is deterministic.** Not "roughly the same each time": every date, amount,
 * description and category is identical on every run, on every machine. The E2E
 * suite asserts on specific totals, the demo GIF is recorded from these screens,
 * and the README's numbers come from here. A seed built on `Math.random()` makes
 * every one of those flaky in a way that looks like a product bug. So the
 * generator is a seeded mulberry32 and the reference date is a constant, never
 * `new Date()`.
 *
 * Primary keys are the exception, and deliberately so: they are cuids, they
 * differ on every run, and `fingerprint` differs with them because it is computed
 * over an account id. Nothing may assert on an id. `./scripts/seed-check.sh`
 * enforces the boundary by digesting the ledger's content and ignoring its keys.
 *
 * It is also idempotent. The demo user is deleted first and the cascades take
 * everything with it, so running it three times leaves the same 747 rows rather
 * than 2241.
 *
 * **It looks like a real ledger.** A dashboard seeded with uniform noise proves
 * nothing: every category is the same size, every month is the same shape, and
 * the charts that are supposed to show something show a flat line. Real spending
 * has structure — rent and salary land on fixed days, groceries cluster at
 * weekends, subscriptions repeat to the cent, December is worse than February —
 * and the seed reproduces that structure so the trend chart, the category
 * breakdown and the budget alerts all have something true to say.
 *
 * One month is deliberately over budget, one is deliberately near it, and a
 * handful of rows are deliberately left uncategorised, because those are the
 * three states the UI exists to show.
 *
 * Usage: pnpm db:seed
 */
import {
  addMonths,
  CATEGORY_SEEDS,
  daysInMonth,
  firstDayOfMonth,
  makeDay,
  makeMonth,
  merchantOf,
  monthRange,
  monthNumberOf,
  toUtcDate,
  yearOf,
  type CalendarDay,
  type CalendarMonth,
} from '@fin/shared';
import { categorize, compileRules, type CategorizeRule } from '@fin/categorize';
import { fingerprintOf, hashPassword } from '@fin/shared/server';
import { PrismaClient, type CategorySource, type MatcherType } from '../generated/client';

const prisma = new PrismaClient();

/**
 * The reference month. Everything is generated backwards from here.
 *
 * A constant rather than "now" for the reason above, and stated as a constant
 * rather than derived from the git date so that re-running the seed a year from
 * now produces the same database. The demo user's story is a fixed fourteen
 * months, not "the last fourteen months".
 */
const REFERENCE_MONTH = makeMonth(2026, 7);
const MONTHS_OF_HISTORY = 14;

const DEMO_EMAIL = 'demo@finance.local';
/**
 * The demo password, in plaintext, on purpose.
 *
 * It is not a secret: it protects a database of invented transactions that
 * anyone can recreate by running this file. Putting it here rather than in
 * `.env` means the README can print it, the E2E suite can use it, and gitleaks
 * has nothing to find. The allowlist in `.gitleaks.toml` does not need an entry
 * because this is not shaped like a credential — it is shaped like a sentence.
 */
const DEMO_PASSWORD = 'demo-password-1234';

/**
 * mulberry32: 32 bits of state, uniform enough for generating plausible
 * spending, and — the only property that matters here — identical on every
 * machine and every Node version. `Math.random()` is none of those things.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(0x11ce5eed);

/** An integer in [min, max], inclusive. */
const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));

const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

interface Merchant {
  label: string;
  category: string;
  /** Amount range in minor units, as a positive magnitude. */
  min: number;
  max: number;
}

/**
 * The merchant set. Spanish, because the demo user's locale is `es-ES` and the
 * importer's whole reason for existing is that `1.234,56` is a real thing banks
 * write.
 */
const MERCHANTS: readonly Merchant[] = [
  { label: 'MERCADONA 4023 MADRID', category: 'Groceries', min: 1_850, max: 9_400 },
  { label: 'CARREFOUR EXPRESS', category: 'Groceries', min: 890, max: 4_200 },
  { label: 'LIDL SUPERMERCADO 214', category: 'Groceries', min: 1_200, max: 6_100 },
  { label: 'FRUTERIA LA HUERTA', category: 'Groceries', min: 450, max: 2_300 },
  { label: 'RENFE CERCANIAS', category: 'Transport', min: 180, max: 940 },
  { label: 'EMT MADRID ABONO', category: 'Transport', min: 5_460, max: 5_460 },
  { label: 'REPSOL E.S. 1187', category: 'Transport', min: 3_400, max: 7_800 },
  { label: 'CABIFY RIDE 88213', category: 'Transport', min: 620, max: 2_450 },
  { label: 'BAR LA CAMPANA', category: 'Eating out', min: 480, max: 2_600 },
  { label: 'RESTAURANTE SOBRINO', category: 'Eating out', min: 2_200, max: 8_900 },
  { label: 'GLOVO ES', category: 'Eating out', min: 1_150, max: 3_400 },
  { label: 'CAFE COMERCIAL', category: 'Eating out', min: 250, max: 980 },
  { label: 'FARMACIA GRAN VIA', category: 'Health', min: 620, max: 4_500 },
  { label: 'CLINICA DENTAL SONRIE', category: 'Health', min: 4_500, max: 18_000 },
  { label: 'AMAZON EU S.A R.L.', category: 'Shopping', min: 990, max: 12_400 },
  { label: 'DECATHLON ESPANA', category: 'Shopping', min: 1_500, max: 9_800 },
  { label: 'ZARA ESPANA', category: 'Shopping', min: 2_290, max: 11_900 },
  { label: 'IKEA ALCORCON', category: 'Shopping', min: 1_800, max: 24_000 },
];

/** Fixed monthly commitments. Same day, same amount, to the cent. */
const RECURRING: readonly { label: string; category: string; day: number; amountMinor: number }[] =
  [
    { label: 'ALQUILER PISO C/ ATOCHA', category: 'Rent & bills', day: 1, amountMinor: -95_000 },
    { label: 'IBERDROLA CLIENTES', category: 'Rent & bills', day: 8, amountMinor: -7_240 },
    { label: 'AQUALIA AGUA', category: 'Rent & bills', day: 12, amountMinor: -2_180 },
    { label: 'VODAFONE ESPANA FIBRA', category: 'Rent & bills', day: 15, amountMinor: -4_490 },
    { label: 'NETFLIX.COM', category: 'Subscriptions', day: 3, amountMinor: -1_399 },
    { label: 'SPOTIFY AB', category: 'Subscriptions', day: 5, amountMinor: -1_099 },
    { label: 'GITHUB INC.', category: 'Subscriptions', day: 7, amountMinor: -400 },
    { label: 'ICLOUD ALMACENAMIENTO', category: 'Subscriptions', day: 18, amountMinor: -299 },
  ];

/**
 * Months whose spending is pushed up, so the trend chart and the budget alerts
 * have something to show.
 *
 * December is Christmas, August is a holiday. This is the difference between a
 * chart that demonstrates the feature and a chart that demonstrates nothing.
 */
const HEAVY_MONTHS: Readonly<Record<number, number>> = { 12: 165, 8: 140, 7: 120 };

const SALARY_MINOR = 232_000;

function amountFor(merchant: Merchant, monthNumber: number): number {
  const base = between(merchant.min, merchant.max);
  const weight = HEAVY_MONTHS[monthNumber] ?? 100;
  // Integer arithmetic end to end: multiply, then divide once. `base * 1.65`
  // would put a float into an amount, which is the one thing this codebase does
  // not do.
  return -Math.round((base * weight) / 100);
}

/** Weekends carry more discretionary spending than Tuesdays do. */
function isWeekend(value: CalendarDay): boolean {
  const weekday = toUtcDate(value).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * A transaction before anything has categorised it.
 *
 * Carries no category on purpose. The `category` column on `MERCHANTS` and
 * `RECURRING` records what the merchant *is*, for a reader of this file; it is
 * not an input to anything. Which category a row lands in is decided by
 * `@fin/categorize` running the rules the seed just wrote, so the ledger agrees
 * with the app by construction rather than by two implementations happening to
 * match.
 */
interface PlannedTransaction {
  bookedOn: CalendarDay;
  amountMinor: number;
  description: string;
  /** Left uncategorised on purpose, to seed the "needs review" queue. */
  leaveUncategorised: boolean;
}

function planMonth(monthKey: CalendarMonth): PlannedTransaction[] {
  const out: PlannedTransaction[] = [];
  const year = yearOf(monthKey);
  const monthNumber = monthNumberOf(monthKey);
  const length = daysInMonth(year, monthNumber);

  // Salary, last working day of the month, as Spanish payroll actually lands.
  let payday = length;
  while (isWeekend(makeDay(year, monthNumber, payday))) payday -= 1;
  out.push({
    bookedOn: makeDay(year, monthNumber, payday),
    amountMinor: SALARY_MINOR,
    description: 'NOMINA MENSUAL ACME S.L.',
    leaveUncategorised: false,
  });

  for (const item of RECURRING) {
    out.push({
      bookedOn: makeDay(year, monthNumber, Math.min(item.day, length)),
      amountMinor: item.amountMinor,
      description: item.label,
      leaveUncategorised: false,
    });
  }

  // Discretionary spending: 34-48 rows a month, weighted toward weekends.
  const count = between(34, 48);
  for (let i = 0; i < count; i += 1) {
    let dayNumber = between(1, length);
    // One resample toward the weekend. Two would over-cluster; none would make
    // every day of the week look identical, which no real ledger does.
    if (!isWeekend(makeDay(year, monthNumber, dayNumber)) && random() < 0.45) {
      dayNumber = between(1, length);
    }
    const merchant = pick(MERCHANTS);
    out.push({
      bookedOn: makeDay(year, monthNumber, dayNumber),
      amountMinor: amountFor(merchant, monthNumber),
      description: merchant.label,
      // Roughly one row in forty stays uncategorised. The review queue is a real
      // state of this app and an empty one teaches a reader nothing.
      leaveUncategorised: random() < 0.025,
    });
  }

  // Two or three travel or one-off rows a quarter, so the smaller categories
  // are not empty.
  if (monthNumber % 3 === 0) {
    out.push({
      bookedOn: makeDay(year, monthNumber, between(5, Math.min(26, length))),
      amountMinor: -between(8_900, 42_000),
      // "RENFE AVE LARGA DISTANCIA" is in this list deliberately, and the engine
      // files it under Transport rather than Travel because Transport's `renfe`
      // rule has the lower priority. That is the right answer and a real one: a
      // long-distance train ticket genuinely is ambiguous, and the rule that wins
      // is the rule the user wrote first. A seed that quietly forced it into
      // Travel would be inventing an outcome the app cannot reproduce.
      description: pick(['RYANAIR DAC', 'BOOKING.COM AMSTERDAM', 'RENFE AVE LARGA DISTANCIA']),
      leaveUncategorised: false,
    });
  }

  return out.sort((a, b) => (a.bookedOn < b.bookedOn ? -1 : a.bookedOn > b.bookedOn ? 1 : 0));
}

async function main(): Promise<void> {
  console.log('Seeding the ledger...');

  // Idempotent: delete the demo user and let the cascades take everything with
  // it. Anything less makes a second run double every total, and every number
  // in the README wrong.
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });

  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      passwordHash: hashPassword(DEMO_PASSWORD),
      name: 'Demo',
      locale: 'es-ES',
      timeZone: 'Europe/Madrid',
      currency: 'EUR',
    },
  });

  const current = await prisma.account.create({
    data: {
      userId: user.id,
      name: 'Cuenta corriente',
      kind: 'checking',
      currency: 'EUR',
      openingBalanceMinor: 412_000,
    },
  });

  const savings = await prisma.account.create({
    data: {
      userId: user.id,
      name: 'Ahorro',
      kind: 'savings',
      currency: 'EUR',
      openingBalanceMinor: 1_850_000,
    },
  });

  const categories = new Map<string, string>();
  for (const seed of CATEGORY_SEEDS) {
    const category = await prisma.category.create({
      data: { userId: user.id, name: seed.name, kind: seed.kind, colorSlot: seed.colorSlot },
    });
    categories.set(seed.name, category.id);
  }

  // Rules, seeded from the taxonomy's keywords. Priority ascends with the slot
  // so the ordering is stable and explicable rather than incidental.
  let priority = 10;
  const rules: CategorizeRule[] = [];
  for (const seed of CATEGORY_SEEDS) {
    for (const keyword of seed.keywords) {
      const rule = await prisma.rule.create({
        data: {
          userId: user.id,
          categoryId: categories.get(seed.name)!,
          matcherType: 'contains' satisfies MatcherType,
          matcherValue: keyword,
          priority,
        },
      });
      rules.push({
        id: rule.id,
        categoryId: rule.categoryId,
        matcherType: 'contains',
        matcherValue: rule.matcherValue,
        priority: rule.priority,
        minAmountMinor: null,
        maxAmountMinor: null,
        active: true,
      });
      priority += 1;
    }
  }

  /**
   * The rules the seed just wrote, compiled by the engine that will run them.
   *
   * Not a reimplementation of matching. An earlier version of this file walked
   * `CATEGORY_SEEDS` itself to work out which rule would have caught each row,
   * and got a different answer from the engine: it searched the row's *planned*
   * category rather than the priority order, because searching all of them in
   * taxonomy order filed "RENFE AVE LARGA DISTANCIA" under Transport's `renfe`
   * rule while the plan called it Travel.
   *
   * Transport is the right answer. That is what the engine does, it is what the
   * app will show, and a seed that disagrees with the engine is a seed that makes
   * the "why is this in Transport?" screen look broken. So the plan no longer
   * carries a category at all: the merchant table's `category` column is a note
   * about intent, and the engine decides.
   */
  const ruleSet = compileRules(rules);
  if (ruleSet.skipped.length > 0) {
    throw new Error(
      `The seeded rules do not all compile: ${ruleSet.skipped.map((s) => s.problem).join('; ')}`,
    );
  }

  const months = monthRange(addMonths(REFERENCE_MONTH, -(MONTHS_OF_HISTORY - 1)), REFERENCE_MONTH);
  const rows: {
    userId: string;
    accountId: string;
    categoryId: string | null;
    ruleId: string | null;
    bookedOn: Date;
    amountMinor: number;
    currency: string;
    description: string;
    merchant: string;
    categorySource: CategorySource;
    fingerprint: string;
  }[] = [];

  for (const monthKey of months) {
    for (const planned of planMonth(monthKey)) {
      // The engine's answer, not the seed's opinion of it. `leaveUncategorised`
      // still wins, because a row nobody has looked at yet is a state the review
      // queue exists to show and the rules would otherwise catch every one.
      const match = planned.leaveUncategorised ? null : categorize(ruleSet, planned);
      rows.push({
        userId: user.id,
        accountId: current.id,
        categoryId: match?.categoryId ?? null,
        ruleId: match?.ruleId ?? null,
        bookedOn: toUtcDate(planned.bookedOn),
        amountMinor: planned.amountMinor,
        currency: 'EUR',
        description: planned.description,
        merchant: merchantOf(planned.description),
        // Every categorised row here came from a rule, because that is the only
        // way this seed assigns one. `manual` is left for the app to write when a
        // human overrides, which is the distinction `category_source` exists to
        // preserve: re-running the rules must never overwrite a human's choice.
        categorySource: match
          ? ('rule' satisfies CategorySource)
          : ('none' satisfies CategorySource),
        fingerprint: fingerprintOf(
          current.id,
          planned.bookedOn,
          planned.amountMinor,
          planned.description,
        ),
      });
    }
  }

  // A standing transfer to savings, so the second account is not an empty shell
  // and the account filter has something to filter.
  for (const monthKey of months) {
    const bookedOn = makeDay(yearOf(monthKey), monthNumberOf(monthKey), 2);
    rows.push({
      userId: user.id,
      accountId: savings.id,
      categoryId: null,
      ruleId: null,
      bookedOn: toUtcDate(bookedOn),
      amountMinor: 25_000,
      currency: 'EUR',
      description: 'TRASPASO A AHORRO',
      merchant: merchantOf('TRASPASO A AHORRO'),
      categorySource: 'none' satisfies CategorySource,
      fingerprint: fingerprintOf(savings.id, bookedOn, 25_000, 'TRASPASO A AHORRO'),
    });
  }

  await prisma.transaction.createMany({ data: rows });

  /**
   * Budgets, sized against what this seed actually spends.
   *
   * Every limit below was chosen by running the seed and reading the real
   * per-month totals out of Postgres, not by guessing. Guessing produced an
   * earlier version where Transport was budgeted at 16000 against a median spend
   * of 43969 — 275% used, every month, on every screen. A budget that is always
   * violently over is as useless a demo as one stuck at 12%: the reader learns
   * nothing about the feature except that the numbers are made up.
   *
   * The limits are picked so the current month (`REFERENCE_MONTH`) shows all
   * three states at once, because all three are what the UI exists to
   * distinguish, and a screenshot with only green bars proves the code can draw
   * one bar.
   *
   * Three categories are left unbudgeted on purpose. "No budget set" is a real
   * state of this app, it is the state every category starts in, and a seed where
   * everything is budgeted never shows the empty case.
   *
   *   category       median/mo   2026-07     limit  state at an 80% threshold
   *   Rent & bills      108910    108910         -  no budget
   *   Shopping           80643     96206    140000  under        (69%)
   *   Transport          43969     48508     50000  approaching  (97%)
   *   Health             35881     73449         -  no budget
   *   Groceries          30723     27981     34000  approaching  (82%)
   *   Travel             21290         0         -  no budget
   *   Eating out         19140     42467     30000  exceeded    (142%)
   *   Subscriptions       3197      3197      5000  under        (64%)
   *
   * That table is the literal output of `./scripts/budget-fit.sh`, which reads
   * the numbers back out of Postgres and the limits back out of this file.
   * Re-run it after any change to the generator: stale numbers here mean limits
   * that were sized against a ledger that no longer exists.
   */
  const budgets: { category: string; limitMinor: number; from: CalendarMonth }[] = [
    { category: 'Groceries', limitMinor: 34_000, from: addMonths(REFERENCE_MONTH, -11) },
    { category: 'Eating out', limitMinor: 30_000, from: addMonths(REFERENCE_MONTH, -11) },
    { category: 'Transport', limitMinor: 50_000, from: addMonths(REFERENCE_MONTH, -11) },
    { category: 'Shopping', limitMinor: 140_000, from: addMonths(REFERENCE_MONTH, -5) },
    { category: 'Subscriptions', limitMinor: 5_000, from: addMonths(REFERENCE_MONTH, -11) },
  ];

  for (const budget of budgets) {
    await prisma.budget.create({
      data: {
        userId: user.id,
        categoryId: categories.get(budget.category)!,
        limitMinor: budget.limitMinor,
        effectiveFrom: toUtcDate(firstDayOfMonth(budget.from)),
      },
    });
  }

  /**
   * One superseded budget, to prove the range model is real.
   *
   * Travel was 30000 a month for the first half of the history and then stopped.
   * A closed period next to an open one is exactly what the exclusion constraint
   * is protecting, and a seed with only open-ended budgets never exercises it.
   */
  await prisma.budget.create({
    data: {
      userId: user.id,
      categoryId: categories.get('Travel')!,
      limitMinor: 30_000,
      effectiveFrom: toUtcDate(
        firstDayOfMonth(addMonths(REFERENCE_MONTH, -(MONTHS_OF_HISTORY - 1))),
      ),
      effectiveTo: toUtcDate(firstDayOfMonth(addMonths(REFERENCE_MONTH, -7))),
    },
  });

  const counts = {
    transactions: await prisma.transaction.count({ where: { userId: user.id } }),
    uncategorised: await prisma.transaction.count({ where: { userId: user.id, categoryId: null } }),
    categories: categories.size,
    rules: rules.length,
    budgets: await prisma.budget.count({ where: { userId: user.id } }),
  };

  console.log(
    [
      `  user           ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
      `  months         ${months[0]} to ${months[months.length - 1]}`,
      `  transactions   ${counts.transactions} (${counts.uncategorised} awaiting a category)`,
      `  categories     ${counts.categories}`,
      `  rules          ${counts.rules}`,
      `  budgets        ${counts.budgets}`,
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
