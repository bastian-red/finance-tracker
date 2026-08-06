import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config/config';
import { loadConfig } from '../config/config';
import {
  readBearer,
  ServiceTokenGuard,
  REQUEST_USER,
  verifyServiceToken,
} from './service-token.guard';

const SECRET = 'test-secret-at-least-sixteen-chars';

const config = (): ApiConfig =>
  loadConfig({
    DATABASE_URL: 'postgresql://fin:fin@localhost:5436/fin',
    REDIS_URL: 'redis://localhost:6383',
    AUTH_SECRET: SECRET,
  });

const sign = (claims: object, options: jwt.SignOptions = {}): string =>
  jwt.sign(claims, SECRET, { algorithm: 'HS256', expiresIn: '2m', ...options });

interface FakeRequest {
  headers: Record<string, string | undefined>;
  [REQUEST_USER]?: unknown;
}

const contextFor = (request: FakeRequest, handler: () => void = () => {}): never =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class Anonymous {},
  }) as never;

describe('readBearer', () => {
  it('reads the token out of a well-formed header', () => {
    expect(readBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts a lower-case scheme, because RFC 7235 says the scheme is case-insensitive', () => {
    expect(readBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('rejects a missing header', () => {
    expect(() => readBearer(undefined)).toThrow(UnauthorizedException);
  });

  it('rejects a header with no scheme', () => {
    expect(() => readBearer('abc.def.ghi')).toThrow(UnauthorizedException);
  });

  it('rejects a Basic header', () => {
    expect(() => readBearer('Basic dXNlcjpwYXNz')).toThrow(UnauthorizedException);
  });
});

describe('verifyServiceToken', () => {
  it('accepts a well-formed HS256 token and returns sub and email', () => {
    const token = sign({ sub: 'usr_1', email: 'someone@finance.local' });
    expect(verifyServiceToken(token, SECRET)).toEqual({
      id: 'usr_1',
      email: 'someone@finance.local',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign({ sub: 'usr_1', email: 'someone@finance.local' }, 'a-different-secret', {
      algorithm: 'HS256',
    });
    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects an expired token', () => {
    const token = sign({ sub: 'usr_1', email: 'someone@finance.local' }, { expiresIn: '-1s' });
    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects alg: none, which is a signature-free forgery of any user id', () => {
    // Hand-built rather than signed, because `jsonwebtoken` refuses to produce
    // one. This is exactly the shape an attacker sends.
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'usr_victim',
      email: 'victim@finance.local',
    })}.`;

    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects an HS512 token signed with the same secret', () => {
    // Without an explicit `algorithms` list, `jsonwebtoken` honours whatever the
    // token's own header asks for, and the header is attacker-controlled.
    const token = jwt.sign({ sub: 'usr_1', email: 'someone@finance.local' }, SECRET, {
      algorithm: 'HS512',
    });
    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyServiceToken('not-a-jwt', SECRET)).toThrow(UnauthorizedException);
    expect(() => verifyServiceToken('a.b.c', SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects a valid signature with no sub claim', () => {
    const token = sign({ email: 'someone@finance.local' });
    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('rejects a valid signature with no email claim', () => {
    const token = sign({ sub: 'usr_1' });
    expect(() => verifyServiceToken(token, SECRET)).toThrow(UnauthorizedException);
  });

  it('gives the same message for every failure, so it is not an oracle', () => {
    const messages = new Set<string>();
    const attempts = [
      sign({ sub: 'usr_1', email: 'a@b.c' }, { expiresIn: '-1s' }),
      jwt.sign({ sub: 'usr_1', email: 'a@b.c' }, 'another-secret-entirely'),
      'garbage',
    ];
    for (const token of attempts) {
      try {
        verifyServiceToken(token, SECRET);
      } catch (error) {
        messages.add(error instanceof Error ? error.message : String(error));
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe('ServiceTokenGuard', () => {
  const guard = (): ServiceTokenGuard => new ServiceTokenGuard(new Reflector(), config());

  it('parks the verified caller on the request', () => {
    const request: FakeRequest = {
      headers: { authorization: `Bearer ${sign({ sub: 'usr_7', email: 'seven@finance.local' })}` },
    };
    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(request[REQUEST_USER]).toEqual({ id: 'usr_7', email: 'seven@finance.local' });
  });

  it('refuses a request with no Authorization header', () => {
    expect(() => guard().canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('lets a @Public() handler through with no token at all', () => {
    // The metadata is read off the handler, so this is the real decorator path
    // rather than a stub of it.
    const handler = (): void => {};
    Reflect.defineMetadata('fin:public', true, handler);
    expect(guard().canActivate(contextFor({ headers: {} }, handler))).toBe(true);
  });
});
