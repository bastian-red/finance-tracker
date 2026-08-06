'use client';

import type { CSSProperties } from 'react';
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axisMaximum, type CategoryBar } from '../../lib/chart';
import { money, percentFromBasisPoints, type MoneyFormat } from '../../lib/format';

/**
 * Where the month went, by category.
 *
 * **This is a sorted single-hue horizontal bar chart, and it is deliberately not
 * a donut.** The ruling, in full, because it is the one a reader of this repo is
 * most likely to want to overturn: a ten-slice pie needs ten categorical hues to
 * carry identity, ten categorical hues cannot pass a colour-vision-deficiency
 * check at any lightness, and the fallback — a legend — asks the reader to map a
 * colour back to a name for every slice. A sorted bar carries rank in position
 * and identity in a label sitting against the bar, so colour carries nothing and
 * is free to be one hue. The category swatches in the stylesheet still exist, and
 * they still appear beside category *names* in tables, where they are a
 * find-it-again aid rather than the only way to tell two things apart.
 *
 * The hue is `--accent`, which is this app's "look here" colour and is not a
 * status token. Painting these bars in `--expense` would be reusing a status
 * colour for something that is not the state it names.
 *
 * Every value is labelled at the bar's tip, so the value axis is hidden: a chart
 * that direct-labels everything does not also need ticks, and the axis it would
 * draw is one more line of chrome. The domain is still pinned, because the label
 * needs room at the right edge and an autoscaled domain puts the longest bar
 * flush against the frame.
 */
export function CategoryBarChart({
  bars,
  format,
  caption,
}: {
  bars: readonly CategoryBar[];
  format: MoneyFormat;
  caption: string;
}): JSX.Element {
  if (bars.length === 0) {
    return <p className="empty">Nothing was spent in this month yet.</p>;
  }

  const maximum = axisMaximum(bars.map((bar) => bar.amountMinor));

  return (
    <div className="stack">
      {/* The height is a function of the bar count rather than a fixed 260px:
          ten categories in a 260px box gives each one 18px of slot, and the
          labels collide. `--bars` is declared in the stylesheet with a fallback,
          so a missing value renders a short chart rather than an invisible one. */}
      <div className="chart-bars" style={{ '--bars': bars.length } as CSSProperties}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={bars as CategoryBar[]}
            margin={{ top: 4, right: 96, bottom: 4, left: 0 }}
            aria-label={caption}
            title={caption}
            desc="Use the arrow keys to move between categories."
          >
            <XAxis type="number" domain={[0, maximum]} hide />
            <YAxis
              type="category"
              dataKey="name"
              width={132}
              tick={{ fill: 'var(--text)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              // Only `active` and `label` are read, and they are passed by name
              // rather than spread. Recharts types the content callback with its
              // own `ValueType`/`NameType` unions, so spreading its props into a
              // component that narrowed them to `number`/`string` makes the whole
              // `<Tooltip>` element unassignable. Reading the two fields here
              // keeps the recharts generics inside the chart file.
              content={({ active, label }) => (
                <CategoryTooltip
                  active={active === true}
                  label={typeof label === 'string' ? label : ''}
                  bars={bars}
                  format={format}
                />
              )}
            />
            <Bar
              dataKey="amountMinor"
              name="Spent"
              fill="var(--accent)"
              // Capped rather than filling the band: the leftover is the air that
              // keeps ten bars from reading as a solid block.
              barSize={16}
              // Rounded at the data end, square at the baseline.
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="amountMinor"
                position="right"
                // Text wears a text token, never the series colour.
                fill="var(--text)"
                fontSize={12}
                // `LabelFormatter` hands over `string | number | undefined`, not
                // the `number` the data key holds, so the coercion is explicit.
                formatter={(value) => money(Number(value ?? 0), format, 'never')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <details className="data-table">
        <summary>Show these numbers as a table</summary>
        <div className="table-scroll">
          <table>
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th className="right" scope="col">
                  Spent
                </th>
                <th className="right" scope="col">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {bars.map((bar) => (
                <tr key={bar.categoryId ?? bar.name}>
                  <th scope="row">{bar.name}</th>
                  <td className="right num">{money(bar.amountMinor, format, 'never')}</td>
                  <td className="right num">{percentFromBasisPoints(bar.shareBasisPoints)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function CategoryTooltip({
  active,
  label,
  bars,
  format,
}: {
  active: boolean;
  label: string;
  bars: readonly CategoryBar[];
  format: MoneyFormat;
}): JSX.Element | null {
  const bar = bars.find((candidate) => candidate.name === label);
  if (!active || !bar) return null;
  return (
    <div className="chart-tooltip">
      <strong>{bar.name}</strong>
      <div className="stack-tight">
        <span>{money(bar.amountMinor, format, 'never')}</span>
        <span>{percentFromBasisPoints(bar.shareBasisPoints)}% of the month</span>
      </div>
    </div>
  );
}
