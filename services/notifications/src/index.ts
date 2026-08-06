/**
 * `@fin/notifications`: what to say about a budget, and how to get it out.
 *
 * The service holds no database access and no persistence, and that split is the
 * point. It decides which budgets deserve an alert (`planAlerts`), renders one
 * (`renderAlert`), and sends it (`createChannel`). Whether an alert has already
 * gone out is not its question: the `@@unique([budgetId, month, level])`
 * constraint on the `alerts` table answers that, because it is the only place
 * that can answer it correctly when two requests arrive at once. `apps/api` owns
 * every write.
 *
 * Two of the three pieces are pure functions, so the interesting behaviour is
 * covered by gate tests that open no socket and read no clock. Only the channel
 * touches the world, and it takes its transport as an argument.
 */
export { createChannel, createSmtpChannel, type MailTransport } from './channel';
export { planAlerts } from './plan';
export { escapeHtml, renderAlert } from './render';
export type {
  AlertLevel,
  Channel,
  ChannelConfig,
  DeliveryResult,
  OutboundMessage,
  PlannedAlert,
  RenderContext,
} from './types';
