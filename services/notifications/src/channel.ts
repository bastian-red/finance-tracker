/**
 * The one impure corner of this service: getting a rendered message out.
 *
 * Everything else here is a pure function over plain objects. This file owns the
 * socket, and it is written so that owning a socket costs the rest of the app
 * nothing:
 *
 * **`send` never throws.** By the time it runs, the `alerts` row is already
 * committed. A refused connection, a greylisting 4xx, a DNS failure, a Mailhog
 * container that is not up: none of those are reasons to turn a successful
 * request into a 500 for a user who did nothing wrong. The failure is returned
 * as data, the caller leaves `deliveredAt` null, and the row is still there to
 * retry or to show in the app's own alert list. The alert exists whether or not
 * the email does.
 *
 * **Nothing sensitive is logged.** Not the password, not the config object (which
 * contains the password), not the message body (which contains the user's
 * spending). One line, recipient and subject, which is what a "did it go out?"
 * question actually needs.
 *
 * **The transport is injectable.** `createSmtpChannel` takes a `MailTransport`
 * rather than building one, so the failure path gets a gate test without opening
 * a socket or waiting on a connection timeout. `createChannel` is the thin
 * wrapper that hands it a real nodemailer transport.
 */
import { createTransport } from 'nodemailer';
import type { Channel, ChannelConfig, DeliveryResult, OutboundMessage } from './types';

/**
 * The part of a nodemailer transporter this service uses.
 *
 * Narrow on purpose. A real `Transporter` satisfies it structurally, and so does
 * a four-line fake in a test, which is the whole point: the interesting case
 * (the transport rejects) is unreachable in a gate test otherwise.
 */
export interface MailTransport {
  sendMail(message: OutboundMessage): Promise<{ messageId?: string | null } | null | undefined>;
  close(): void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Pick a channel from configuration.
 *
 * The order of the checks is the order of severity, and it is deliberate:
 *
 * 1. **No sender: the null channel.** A message with no `From` is refused by
 *    every real MTA and quietly accepted by some test ones, so pretending to
 *    deliver it would hide a missing `MAIL_FROM` until someone wonders why no
 *    alert ever arrived. It reports `delivered: false` with a readable reason.
 *    Tests use it as a no-op that still returns a truthful result.
 * 2. **No host: the log channel.** This is the documented local default:
 *    `.env.example` says leaving `SMTP_HOST` empty falls back to logging, so a
 *    fresh clone with no mail server runs the whole budget-alert path and can
 *    see the alerts in the terminal. It must never throw, for the same reason
 *    `send` must never throw.
 * 3. **Otherwise SMTP.**
 */
export function createChannel(config: ChannelConfig): Channel {
  if (config.from.trim() === '') {
    return createNullChannel();
  }
  if (config.host === undefined || config.host.trim() === '') {
    return createLogChannel(config.from, config.logger ?? ((line) => console.log(line)));
  }

  const transport = createTransport({
    host: config.host,
    ...(config.port === undefined ? {} : { port: config.port }),
    secure: config.secure,
    // Auth is omitted entirely rather than passed with an undefined user.
    // Mailhog on port 1029 takes no credentials, and `auth: { user: undefined }`
    // makes nodemailer attempt an AUTH command with an empty username, which
    // fails with a protocol error that reads nothing like "you left SMTP_USER
    // empty".
    ...(config.user === undefined || config.user === ''
      ? {}
      : { auth: { user: config.user, pass: config.password } }),
    // Bounded waits. A dead SMTP host with no timeout holds the socket for the
    // OS default (over two minutes on Linux), and the request that triggered the
    // alert is waiting on it.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return createSmtpChannel(transport, config.from);
}

/**
 * The SMTP channel, over an already-built transport.
 *
 * Exported so the failure path is testable with a fake. Nothing outside this
 * package should need it; `apps/api` calls `createChannel`.
 */
export function createSmtpChannel(transport: MailTransport, from: string): Channel {
  let closed = false;

  return {
    kind: 'smtp',
    async send(message: OutboundMessage): Promise<DeliveryResult> {
      try {
        // `from` comes from configuration, not from the renderer, which has no
        // business knowing MAIL_FROM. A caller that did set one keeps it.
        const info = await transport.sendMail({ ...message, from: message.from || from });
        return {
          delivered: true,
          messageId: info?.messageId ?? null,
          error: null,
          channel: 'smtp',
        };
      } catch (error) {
        return { delivered: false, messageId: null, error: describe(error), channel: 'smtp' };
      }
    },
    async close(): Promise<void> {
      // Idempotent because the API closes it on shutdown and a test closes it in
      // an `afterEach`; nodemailer's `close` on an already-closed pool is
      // harmless, but a second call must not be able to throw past this.
      if (closed) return;
      closed = true;
      try {
        transport.close();
      } catch {
        // A transport that fails to release is not a caller's problem, and
        // throwing here would break the shutdown path it is called from.
      }
    },
  };
}

/**
 * The local default: print one line and report success.
 *
 * Success rather than failure is the honest answer. The line reached its
 * configured destination, which is the terminal. Reporting `delivered: false`
 * would fill every local run's `alerts` table with rows that look like an
 * outage.
 */
function createLogChannel(from: string, logger: (line: string) => void): Channel {
  return {
    kind: 'log',
    async send(message: OutboundMessage): Promise<DeliveryResult> {
      try {
        // Recipient, sender and subject only. The body carries the user's
        // spending and the config carries the SMTP credentials; neither belongs
        // in a log line that ends up in a CI artifact or a terminal scrollback.
        logger(
          `[notifications] log channel: to=${message.to} from=${message.from || from} subject=${JSON.stringify(message.subject)}`,
        );
        return { delivered: true, messageId: null, error: null, channel: 'log' };
      } catch (error) {
        // An injected logger that throws is the caller's bug, but it is not
        // worth failing the request over either.
        return { delivered: false, messageId: null, error: describe(error), channel: 'log' };
      }
    },
    async close(): Promise<void> {
      // Nothing to release. Present so the caller's shutdown path is uniform.
    },
  };
}

/** The refusal. See `createChannel` for why an empty sender is not a warning. */
function createNullChannel(): Channel {
  return {
    kind: 'null',
    async send(): Promise<DeliveryResult> {
      return {
        delivered: false,
        messageId: null,
        error: 'No sender address is configured (MAIL_FROM is empty), so nothing was sent.',
        channel: 'null',
      };
    },
    async close(): Promise<void> {
      // Nothing to release.
    },
  };
}
