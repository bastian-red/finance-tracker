import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/config';
import { IS_PUBLIC_KEY } from './public.decorator';

/** The claims the web app puts in a service token, and the only ones read here. */
export interface TokenUser {
  id: string;
  email: string;
}

/** Where the verified caller is parked on the request object. */
export const REQUEST_USER = 'finUser';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  [REQUEST_USER]?: TokenUser;
}

/**
 * The API holds no session.
 *
 * The web app owns the browser session (Auth.js) and mints a short-lived HS256
 * token per server-side call, signed with `AUTH_SECRET`, which both processes
 * already share. This guard verifies that token and nothing else: no cookie, no
 * database round trip, no session table. That is what makes the API horizontally
 * scalable without a shared session store, and it is why every handler takes the
 * user id from the token rather than from a parameter.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request[REQUEST_USER] = verifyServiceToken(
      readBearer(request.headers.authorization),
      this.config.authSecret,
    );
    return true;
  }
}

/** The token out of `Authorization: Bearer <jwt>`, or a 401 if there is not one. */
export function readBearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new UnauthorizedException('Missing bearer token');
  // Case-insensitive on the scheme because RFC 7235 says the scheme is, and a
  // client sending `bearer` is not the bug worth failing on.
  const match = /^bearer\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) throw new UnauthorizedException('Malformed Authorization header');
  return match[1];
}

/**
 * Verify, with the algorithm list pinned.
 *
 * `algorithms: ['HS256']` is not a tidiness measure, it is the whole security
 * boundary. Without it `jsonwebtoken` accepts whatever the token's own header
 * asks for, and a token is attacker-controlled input: `{"alg":"none"}` verifies
 * with no signature at all, and `{"alg":"RS256"}` verifies an attacker-signed
 * token against the HMAC secret being read as a PEM public key. Both are
 * one-line forgeries of any user id.
 *
 * Every failure comes back as the same 401 with a generic message. Distinguishing
 * "expired" from "bad signature" in the response tells an attacker which half of
 * the token to keep working on.
 */
export function verifyServiceToken(token: string, secret: string): TokenUser {
  let claims: unknown;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    throw new UnauthorizedException('Invalid or expired service token');
  }

  if (typeof claims !== 'object' || claims === null) {
    throw new UnauthorizedException('Invalid or expired service token');
  }

  const { sub, email } = claims as { sub?: unknown; email?: unknown };
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedException('Invalid or expired service token');
  }
  if (typeof email !== 'string' || email.length === 0) {
    throw new UnauthorizedException('Invalid or expired service token');
  }

  return { id: sub, email };
}
