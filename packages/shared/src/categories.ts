/**
 * The starting category taxonomy, and the colour slot each category owns.
 *
 * Two decisions worth spelling out.
 *
 * **The taxonomy is seeded, not enforced.** A new account gets these rows and is
 * then free to rename, delete or add to them. A fixed enum would be smaller code
 * and wrong: "Padel" is a real budget line for exactly one person, and an app
 * that cannot hold it is an app they stop using in week two.
 *
 * **Colour is a stored slot, not a render-order index.** Charts on the dashboard
 * are drawn from whatever rows the query returned, and that order changes as
 * soon as spending changes. If the palette were assigned at render time, Groceries
 * would be blue in March and orange in April, which quietly destroys the one
 * thing a categorical palette is for: recognising a series without reading the
 * legend. So the slot is a column, decided once, and the chart looks it up.
 *
 * The palette itself lives in the web app (`app/globals.css`), because the number
 * of distinguishable hues depends on the colour scheme and this package has no
 * business knowing about that. What lives here is the stable index into it.
 */

export type CategoryKind = 'income' | 'expense';

export interface CategorySeed {
  name: string;
  kind: CategoryKind;
  /** Stable index into the chart palette. Unique across the seed set. */
  colorSlot: number;
  /** Seeded matching rules, as literal keywords. See services/categorize. */
  keywords: readonly string[];
}

/**
 * Eight expense categories and two income ones.
 *
 * Eight is not an arbitrary number: it is roughly the ceiling on how many
 * categorical colours stay reliably distinguishable to a reader with a colour
 * vision deficiency, which is why the dashboard's category chart tops out at
 * seven slices plus "Other" rather than drawing all of them. More categories
 * than that is a table, not a pie.
 */
export const CATEGORY_SEEDS: readonly CategorySeed[] = [
  {
    name: 'Groceries',
    kind: 'expense',
    colorSlot: 0,
    keywords: ['mercadona', 'carrefour', 'lidl', 'aldi', 'supermercado', 'grocery', 'dia %'],
  },
  {
    name: 'Rent & bills',
    kind: 'expense',
    colorSlot: 1,
    keywords: [
      'alquiler',
      'rent',
      'endesa',
      'iberdrola',
      'naturgy',
      'aqualia',
      'vodafone',
      'movistar',
    ],
  },
  {
    name: 'Transport',
    kind: 'expense',
    colorSlot: 2,
    keywords: ['renfe', 'emt', 'metro', 'uber', 'cabify', 'bolt', 'repsol', 'cepsa', 'bicimad'],
  },
  {
    name: 'Eating out',
    kind: 'expense',
    colorSlot: 3,
    keywords: ['restaurante', 'bar ', 'cafe', 'café', 'glovo', 'just eat', 'ubereats', 'deliveroo'],
  },
  {
    name: 'Health',
    kind: 'expense',
    colorSlot: 4,
    keywords: ['farmacia', 'pharmacy', 'clinica', 'clínica', 'dentista', 'sanitas', 'adeslas'],
  },
  {
    name: 'Subscriptions',
    kind: 'expense',
    colorSlot: 5,
    keywords: ['netflix', 'spotify', 'github', 'openai', 'icloud', 'google one', 'amazon prime'],
  },
  {
    name: 'Shopping',
    kind: 'expense',
    colorSlot: 6,
    keywords: ['amazon', 'zara', 'decathlon', 'ikea', 'mediamarkt', 'el corte ingles'],
  },
  {
    name: 'Travel',
    kind: 'expense',
    colorSlot: 7,
    keywords: ['booking.com', 'airbnb', 'ryanair', 'vueling', 'iberia', 'hotel'],
  },
  {
    name: 'Salary',
    kind: 'income',
    colorSlot: 8,
    keywords: ['nomina', 'nómina', 'salary', 'payroll'],
  },
  {
    name: 'Other income',
    kind: 'income',
    colorSlot: 9,
    keywords: ['transferencia recibida', 'refund', 'devolucion', 'devolución'],
  },
];

/** How many slots the palette has to supply. */
export const COLOR_SLOT_COUNT = CATEGORY_SEEDS.length;

/**
 * Where an uncategorised amount goes on a chart.
 *
 * A negative slot rather than a magic name: "Uncategorised" is a real, common
 * state (a fresh import before any rule has run), it must be visible on the
 * chart rather than dropped, and it must not steal a hue that a real category
 * could be using.
 */
export const UNCATEGORISED_SLOT = -1;
