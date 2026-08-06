/**
 * Signup and login, and nothing else.
 *
 * The API holds **no session**. The web app owns the browser session and mints a
 * five-minute HS256 service token per server-side call, which `ServiceTokenGuard`
 * verifies. So these two routes do not issue a token, set a cookie or write a
 * session row: they answer "is this person who they say they are, and what is on
 * their profile". Everything after that is the web app's problem, which is what
 * lets this service scale horizontally with no shared session store.
 */
import type { Credentials, SessionUser, Signup } from '@fin/shared';
import { hashPassword, verifyPassword } from '@fin/shared/server';
import { isUniqueViolation, type Prisma, type User } from '@fin/db';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_ACCOUNT_NAME, seededCategories, seededRules } from './taxonomy';

/**
 * A real scrypt hash of a password nobody has, used only to burn the same CPU on
 * a missing account as on a wrong password.
 *
 * Without it, `login` returns in microseconds for an address that does not exist
 * and in ~100ms for one that does, because only the second path runs scrypt.
 * That difference is measurable over the network and turns the login route into
 * a user-enumeration oracle: an attacker learns which of a leaked address list
 * has an account here before trying a single password.
 *
 * Computed once at module load rather than written as a literal, so it stays a
 * valid hash if the format in `@fin/shared/server` ever changes, and so gitleaks
 * has no credential-shaped string to find.
 */
const DUMMY_HASH = hashPassword('no user with this address exists');

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Create the account and plant its taxonomy, in one transaction.
   *
   * All of it or none of it. A user row that committed while the category insert
   * failed is an account that can never categorise anything and that the signup
   * route can never be retried for, because the email is now taken. There is no
   * screen anywhere in this app that repairs that state, so it must not be
   * reachable.
   */
  async signup(input: Signup): Promise<SessionUser> {
    const currency = input.currency ?? this.config.defaultCurrency;

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email.toLowerCase(),
            passwordHash: hashPassword(input.password),
            name: input.name,
            currency,
            // Left to the column default when the caller says nothing, rather
            // than defaulted here: two defaults for one value is two places to
            // change it and one of them will be missed.
            ...(input.locale === undefined ? {} : { locale: input.locale }),
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          },
        });

        await tx.account.create({
          data: {
            userId: created.id,
            name: DEFAULT_ACCOUNT_NAME,
            kind: 'checking',
            currency,
          },
        });

        await tx.category.createMany({ data: seededCategories(created.id) });

        // Read the ids back rather than creating the ten categories one at a
        // time: `createMany` does not return rows, and ten sequential round trips
        // inside an open transaction is ten times the lock duration for no gain.
        const categories = await tx.category.findMany({
          where: { userId: created.id },
          select: { id: true, name: true },
        });
        const byName = new Map(categories.map((category) => [category.name, category.id]));

        await tx.rule.createMany({ data: seededRules(created.id, byName) });

        return created;
      });

      return sessionUserOf(user);
    } catch (error) {
      // The email index is the only unique constraint this transaction can hit,
      // and "that address is taken" is a 409 the caller can act on rather than
      // the 500 an unhandled Prisma error would become.
      if (isUniqueViolation(error)) {
        throw new ConflictException('An account with that email address already exists.');
      }
      throw error;
    }
  }

  /**
   * Verify a password. One message for every failure.
   *
   * "No such user" and "wrong password" are the same 401 with the same sentence,
   * because telling them apart is the enumeration oracle again, this time in
   * words instead of in timing.
   */
  async login(input: Credentials): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    const matches = verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !matches) {
      throw new UnauthorizedException('That email address and password do not match an account.');
    }

    return sessionUserOf(user);
  }

  /** The profile behind a service token, for the web app's session refresh. */
  async profile(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('That account no longer exists.');
    return sessionUserOf(user);
  }
}

/** The row, reduced to exactly what `sessionUserSchema` publishes. Never the hash. */
export function sessionUserOf(
  user: Pick<User, 'id' | 'email' | 'name' | 'locale' | 'timeZone' | 'currency'>,
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    timeZone: user.timeZone,
    currency: user.currency,
  };
}

/** Narrower than `PrismaService` so the gate tests can fake it in four lines. */
export type SignupTransaction = Prisma.TransactionClient;
