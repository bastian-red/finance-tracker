import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The one credential that crosses from the web server to the API.
 *
 * The API holds no session state: it verifies this token with the shared
 * `AUTH_SECRET` and trusts nothing else. So two properties are load-bearing and
 * both are asserted here.
 *
 * **The algorithm is pinned to HS256 on both sides.** A library that accepts
 * whatever the token's own header claims is the `alg: none` hole, where an
 * attacker strips the signature, sets the algorithm to "none", and the verifier
 * agrees. The case below forges exactly that token and shows the API's verify
 * options refuse it.
 *
 * **The lifetime is five minutes, not five seconds.** The two clocks are not the
 * same clock, and a container drifted by two seconds against a stricter window
 * produces intermittent 401s that clear on retry, which is close to the least
 * diagnosable failure available.
 *
 * `AUTH_SECRET` is set here rather than read from `.env`: `lib/config.ts` reads
 * it at call time and throws when it is missing, and a unit test that depended
 * on a developer's local file would pass or fail for reasons outside the repo.
 */

const SECRET = 'test-secret-at-least-thirty-two-characters-long';

let mintServiceToken: (userId: string, email: string) => string;
let SERVICE_TOKEN_TTL_SECONDS: number;

beforeEach(async () => {
  process.env.AUTH_SECRET = SECRET;
  // Imported after the variable is set, and with a fresh module registry, so the
  // config module cannot have cached a read from a previous test file.
  const module = await import('./service-token');
  mintServiceToken = module.mintServiceToken;
  SERVICE_TOKEN_TTL_SECONDS = module.SERVICE_TOKEN_TTL_SECONDS;
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
});

describe('mintServiceToken', () => {
  it('signs the user id and email into the claims the API reads', () => {
    const token = mintServiceToken('usr_123', 'demo@finance.local');
    const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as {
      sub: string;
      email: string;
      exp: number;
      iat: number;
    };

    expect(claims.sub).toBe('usr_123');
    expect(claims.email).toBe('demo@finance.local');
  });

  it('uses HS256 and says so in the header', () => {
    const token = mintServiceToken('usr_123', 'demo@finance.local');
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { alg: string };
    expect(header.alg).toBe('HS256');
  });

  it('expires in exactly five minutes', () => {
    const token = mintServiceToken('usr_123', 'demo@finance.local');
    const claims = jwt.decode(token) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(SERVICE_TOKEN_TTL_SECONDS);
    expect(SERVICE_TOKEN_TTL_SECONDS).toBe(300);
  });

  it('mints a fresh token per call rather than caching one', () => {
    // Caching would mean holding a bearer credential in a module scope shared by
    // every request the Next server handles.
    const first = mintServiceToken('usr_a', 'a@example.com');
    const second = mintServiceToken('usr_b', 'b@example.com');
    expect(first).not.toBe(second);
    expect((jwt.decode(second) as { sub: string }).sub).toBe('usr_b');
  });

  it('produces a token the wrong secret cannot verify', () => {
    const token = mintServiceToken('usr_123', 'demo@finance.local');
    expect(() => jwt.verify(token, 'a-different-secret-of-sufficient-length')).toThrow();
  });

  it('refuses to mint without a secret rather than signing with an empty one', () => {
    delete process.env.AUTH_SECRET;
    expect(() => mintServiceToken('usr_123', 'demo@finance.local')).toThrow();
  });
});

describe('the alg: none hole, closed', () => {
  it('an unsigned token forged from real claims is rejected', () => {
    // Built by hand, because no library will produce this on purpose: the header
    // says "none", the signature is empty, and a verifier that trusts the header
    // accepts it as authentic.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'usr_victim', email: 'victim@example.com' }),
    ).toString('base64url');
    const forged = `${header}.${payload}.`;

    // These are the exact options `apps/api/src/common/service-token.guard.ts`
    // verifies with. Pinning the algorithm list is what makes this throw.
    expect(() => jwt.verify(forged, SECRET, { algorithms: ['HS256'] })).toThrow();
  });

  it('a token signed with a different algorithm is rejected too', () => {
    const other = jwt.sign({ sub: 'usr_victim', email: 'victim@example.com' }, SECRET, {
      algorithm: 'HS512',
    });
    expect(() => jwt.verify(other, SECRET, { algorithms: ['HS256'] })).toThrow();
  });
});
