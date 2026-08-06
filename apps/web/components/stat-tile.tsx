import type { ReactNode } from 'react';

/**
 * A headline number.
 *
 * The form heuristic that produced it: when the data's job is a single magnitude,
 * the answer is not a chart. A one-bar bar chart of "money in this month" is a
 * decorated number, and the number reads faster.
 *
 * The value is not `.num`. Tabular figures give every digit the width of a zero,
 * which is exactly right in a column of amounts and looks loose at 34px on a
 * standalone figure. `.num` stays on the table cells, where the alignment is the
 * entire job.
 */
export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}): JSX.Element {
  return (
    <div className="card">
      <div className="stack-tight">
        <p className="tile-label">{label}</p>
        <p className="tile-value">{value}</p>
        {note ? <p className="tile-note">{note}</p> : null}
      </div>
    </div>
  );
}
