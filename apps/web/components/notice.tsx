import type { ActionResult } from '../lib/action-result';

/**
 * The one way this app tells someone what just happened.
 *
 * `role="alert"` rather than a plain paragraph, because the message appears
 * after a form submission that did not move focus, and a sighted user sees it
 * while a screen-reader user would never learn it existed. `aria-live` is
 * implied by the role and is `assertive`, which is right here and would be wrong
 * for a passive status line.
 *
 * The left border is 4px and coloured, and the colour is never the only channel:
 * the message itself says what happened, and the border only agrees with it.
 */
export function Notice({
  result,
  className,
}: {
  result: ActionResult | null;
  className?: string;
}): JSX.Element | null {
  if (!result) return null;
  return (
    <p
      role="alert"
      className={`notice ${result.ok ? 'notice-ok' : 'notice-error'}${
        className ? ` ${className}` : ''
      }`}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}
