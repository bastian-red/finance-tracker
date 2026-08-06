'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisMaximum, axisMonthLabel, type TrendPoint } from '../../lib/chart';
import { money, type MoneyFormat } from '../../lib/format';

/**
 * Income against spending, month by month.
 *
 * The rulings this chart is built on, so nobody has to rediscover them:
 *
 * **One axis.** Both series are money in the same currency, so they share a
 * scale and the comparison is real. A dual axis would let the two lines be
 * placed against each other arbitrarily and invent a relationship that is not in
 * the data; it is the single most common way a chart lies.
 *
 * **The domain is pinned, and it starts at zero.** `axisMaximum` rounds the
 * largest value up to a clean number. Left to autoscale, a month where income and
 * spending differ by 2% produces a chart where one line towers over the other.
 *
 * **Colour is the third channel here too.** `--income` and `--expense` are used
 * because these two series *are* the things those tokens name, which is the only
 * circumstance in which a status colour may be a series. They separate by 2.0:1
 * in greyscale in light mode, which is not enough on its own, so spending is
 * dashed and income is solid, and both are named in the legend and in the table.
 *
 * **The table is not optional.** `<details>` below carries the same numbers.
 * Recharts puts `role="application"` and `tabIndex={0}` on its own `<svg>` when
 * the accessibility layer is on, so the chart is focusable and arrow-navigable —
 * and wrapping it in `aria-hidden` would hide a subtree containing a focusable
 * element, which is a WCAG failure in itself. It is never hidden.
 */
export function TrendChart({
  points,
  format,
  caption,
}: {
  points: readonly TrendPoint[];
  format: MoneyFormat;
  caption: string;
}): JSX.Element {
  const maximum = axisMaximum([
    ...points.map((point) => point.incomeMinor),
    ...points.map((point) => point.expenseMinor),
  ]);

  if (points.length === 0) {
    return <p className="empty">No months to chart yet. Import a statement to see a trend.</p>;
  }

  return (
    <div className="stack">
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points as TrendPoint[]}
            margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
            aria-label={caption}
            title={caption}
            desc="Use the arrow keys to move between months."
          >
            {/* Hairline, solid, one step off the surface. A dashed grid reads as
                a threshold or a projection when it is only a grid. */}
            <CartesianGrid stroke="var(--border)" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={axisMonthLabel}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              stroke="var(--border-strong)"
              tickLine={false}
            />
            <YAxis
              // Pinned. See the header.
              domain={[0, maximum]}
              width={78}
              tickFormatter={(value: number) => money(value, format, 'never')}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              stroke="var(--border-strong)"
              tickLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
              // See `category-bar-chart.tsx` for why the two fields are read by
              // name instead of spread: recharts' content callback is typed
              // against its own value/name unions, and narrowing them in the
              // child makes the `<Tooltip>` element itself unassignable.
              content={({ active, label }) => (
                <TrendTooltip
                  active={active === true}
                  label={typeof label === 'string' ? label : ''}
                  points={points}
                  format={format}
                />
              )}
            />
            <Line
              type="monotone"
              dataKey="incomeMinor"
              name="Money in"
              stroke="var(--income)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="expenseMinor"
              name="Money out"
              stroke="var(--expense)"
              strokeWidth={2}
              // The non-colour channel. It survives greyscale, a photocopy and
              // full-severity CVD, which the 2.0:1 luminance gap does not.
              strokeDasharray="6 4"
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* The legend is written by hand rather than by Recharts, because Recharts
          draws its key as a coloured square and the dash is the half of the
          identity that has to survive greyscale. */}
      <ul className="chart-legend">
        <li>
          <span
            className="legend-key"
            style={{ borderTopColor: 'var(--income)' }}
            aria-hidden="true"
          />
          Money in (solid)
        </li>
        <li>
          <span
            className="legend-key legend-key-dashed"
            style={{ borderTopColor: 'var(--expense)' }}
            aria-hidden="true"
          />
          Money out (dashed)
        </li>
      </ul>

      <details className="data-table">
        <summary>Show these numbers as a table</summary>
        <div className="table-scroll">
          <table>
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th className="right" scope="col">
                  Money in
                </th>
                <th className="right" scope="col">
                  Money out
                </th>
                <th className="right" scope="col">
                  Net
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.month}>
                  <th scope="row">{point.label}</th>
                  <td className="right num">{money(point.incomeMinor, format, 'never')}</td>
                  <td className="right num">{money(point.expenseMinor, format, 'never')}</td>
                  <td className="right num">{money(point.netMinor, format, 'always')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/**
 * The hover layer.
 *
 * Written by hand so the amounts go through `money()` — Recharts' default
 * tooltip prints the raw number, which here is a count of cents. It also lets the
 * label be the full `julio de 2026` while the axis tick stays `07/26`.
 */
function TrendTooltip({
  active,
  label,
  points,
  format,
}: {
  active: boolean;
  label: string;
  points: readonly TrendPoint[];
  format: MoneyFormat;
}): JSX.Element | null {
  const point = points.find((candidate) => candidate.month === label);
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <div className="stack-tight">
        <span>In: {money(point.incomeMinor, format, 'never')}</span>
        <span>Out: {money(point.expenseMinor, format, 'never')}</span>
        <span>Net: {money(point.netMinor, format, 'always')}</span>
      </div>
    </div>
  );
}
