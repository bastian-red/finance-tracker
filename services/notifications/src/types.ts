/**
 * The contract `apps/api` imports.
 *
 * Kept in its own file because it is the only part of this service another
 * package is allowed to depend on, and a type that lives beside the code that
 * happens to produce it drifts into carrying that code's private concerns.
 *
 * Two shapes deserve a word:
 *
 * **`PlannedAlert` carries plain `number` amounts, not `Minor`.** The brand
 * cannot survive the JSON that `BudgetStatus` arrives as, so re-branding happens
 * at the one place that formats money (`renderAlert`) rather than at every
 * boundary in between. A brand that is cast back and forth six times proves
 * nothing.
 *
 * **`DeliveryResult` has no throwing counterpart.** Sending mail is the last
 * step of a request whose database write has already committed; a transport
 * error is information, not a reason to fail the HTTP call the user is waiting
 * on. Every failure path in this service ends in one of these objects.
 */
import type { CalendarMonth } from '@fin/shared';

export type AlertLevel = 'approaching' | 'exceeded';

/**
 * One alert this service thinks should exist, before the database has been
 * asked whether it already does.
 */
export interface PlannedAlert {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  month: CalendarMonth;
  level: AlertLevel;
  limitMinor: number;
  spentMinor: number;
  usedBasisPoints: number;
}

/** Everything the renderer needs that is not a property of the alert itself. */
export interface RenderContext {
  /** BCP 47, from DEFAULT_LOCALE. Drives number and month formatting. */
  locale: string;
  /** ISO 4217, from the account/report currency. */
  currency: string;
  /** Absolute base URL of the web app, for the deep link. From APP_BASE_URL. */
  appBaseUrl: string;
  recipient: string;
}

/** A rendered message, ready for any transport. Nothing here is transport specific. */
export interface OutboundMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface DeliveryResult {
  delivered: boolean;
  /** Transport-assigned id when there is one, for correlating with the mail log. */
  messageId: string | null;
  /** Populated when `delivered` is false. Never thrown at the caller. */
  error: string | null;
  channel: 'smtp' | 'log' | 'null';
}

export interface Channel {
  readonly kind: 'smtp' | 'log' | 'null';
  send(message: OutboundMessage): Promise<DeliveryResult>;
  /** Releases the transport. Safe to call twice. */
  close(): Promise<void>;
}

export interface ChannelConfig {
  host: string | undefined;
  port: number | undefined;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
  /** Injected so the log channel is testable and the API can route it to Nest's logger. */
  logger?: (line: string) => void;
}
