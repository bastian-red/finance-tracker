import jwt from 'jsonwebtoken';
import { authSecret } from './config';

/** Five minutes, in seconds. Exported so the test asserts the same number the code signs. */
export const SERVICE_TOKEN_TTL_SECONDS = 300;

export interface ServiceTokenClaims {
  sub: string;
  email: string;
}

/**
 * Mint the token the API verifies with the shared `AUTH_SECRET`.
 *
 * The web server holds the Auth.js session; the API holds no session state at
 * all. This token is the only thing that crosses between them, and it is minted
 * fresh per request rather than stored, which is what lets it live five minutes:
 * there is no refresh path to build because nothing ever holds one long enough
 * to need refreshing.
 *
 * Five minutes rather than five seconds because the two clocks are not the same
 * clock. A container whose time has drifted by a couple of seconds would reject
 * every request signed by a stricter window, and the symptom -- intermittent
 * 401s that clear on retry -- is one of the least diagnosable failures there is.
 *
 * HS256 rather than RS256 because both sides already share one secret and there
 * is no third party to verify without it. The `algorithm` is pinned on purpose:
 * a token library that accepts whatever the header claims is the classic `alg:
 * none` hole, and the API pins it on the verify side for the same reason.
 */
export function mintServiceToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email } satisfies ServiceTokenClaims, authSecret(), {
    algorithm: 'HS256',
    expiresIn: SERVICE_TOKEN_TTL_SECONDS,
  });
}
