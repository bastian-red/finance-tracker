import { handlers } from '../../../../auth';

/**
 * Auth.js's own HTTP surface: `/api/auth/csrf`, `/api/auth/session`,
 * `/api/auth/callback/credentials`, `/api/auth/signout`.
 *
 * `scripts/dev-smoke.sh` signs in through exactly these three URLs rather than
 * through the login form, so this route is what makes that lane possible.
 */
export const { GET, POST } = handlers;
