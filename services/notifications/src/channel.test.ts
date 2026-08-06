import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannel, createSmtpChannel, type MailTransport } from './channel';
import type { ChannelConfig, OutboundMessage } from './types';

const MESSAGE: OutboundMessage = {
  to: 'reader@example.com',
  from: '',
  subject: 'Groceries: budget exceeded for March 2026',
  text: 'Limit: $400.00\nSpent: $431.20',
  html: '<p>Limit: $400.00</p>',
};

const SECRET = 'hunter2-not-in-any-log';

function config(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    host: undefined,
    port: undefined,
    secure: false,
    user: undefined,
    password: SECRET,
    from: 'alerts@finance.local',
    ...overrides,
  };
}

/** A transport that records what it was asked to send and never opens a socket. */
function fakeTransport(behaviour: {
  reject?: Error;
  messageId?: string;
}): MailTransport & { sent: OutboundMessage[]; closes: number } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    closes: 0,
    async sendMail(message: OutboundMessage) {
      sent.push(message);
      if (behaviour.reject) throw behaviour.reject;
      return { messageId: behaviour.messageId ?? '<generated@example.com>' };
    },
    close() {
      this.closes += 1;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChannel, selection', () => {
  it('falls back to the log channel when SMTP_HOST is empty', () => {
    expect(createChannel(config({ host: undefined })).kind).toBe('log');
    expect(createChannel(config({ host: '' })).kind).toBe('log');
    expect(createChannel(config({ host: '   ' })).kind).toBe('log');
  });

  it('uses SMTP when a host is configured', async () => {
    // `createTransport` builds an object; it connects on the first send, so this
    // opens no socket.
    const channel = createChannel(config({ host: 'localhost', port: 1029 }));

    expect(channel.kind).toBe('smtp');
    await channel.close();
  });

  it('refuses everything when MAIL_FROM is empty, rather than pretending', () => {
    // A message with no sender is rejected by every real MTA and silently
    // accepted by some test ones, which is the worst of both.
    expect(createChannel(config({ from: '' })).kind).toBe('null');
    expect(createChannel(config({ from: '  ', host: 'localhost' })).kind).toBe('null');
  });
});

describe('the log channel', () => {
  it('reports delivered and writes one line through the injected logger', async () => {
    const lines: string[] = [];
    const channel = createChannel(config({ logger: (line) => lines.push(line) }));

    const result = await channel.send(MESSAGE);

    expect(result).toEqual({ delivered: true, messageId: null, error: null, channel: 'log' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reader@example.com');
    expect(lines[0]).toContain('Groceries: budget exceeded for March 2026');
  });

  it('logs neither the password, the word password, nor the body', async () => {
    const lines: string[] = [];
    const channel = createChannel(
      config({ user: 'mailer', password: SECRET, logger: (line) => lines.push(line) }),
    );

    await channel.send(MESSAGE);
    const line = lines[0] ?? '';

    expect(line).not.toContain(SECRET);
    expect(line.toLowerCase()).not.toContain('password');
    expect(line).not.toContain('$431.20');
    expect(line).not.toContain('<p>');
  });

  it('uses console.log when no logger is injected', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const channel = createChannel(config());

    await channel.send(MESSAGE);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('reader@example.com');
  });

  it('fills the sender from configuration, since the renderer leaves it empty', async () => {
    const lines: string[] = [];
    const channel = createChannel(
      config({ from: 'alerts@finance.local', logger: (line) => lines.push(line) }),
    );

    await channel.send(MESSAGE);

    expect(lines[0]).toContain('from=alerts@finance.local');
  });

  it('does not throw when the injected logger throws', async () => {
    const channel = createChannel(
      config({
        logger: () => {
          throw new Error('logger exploded');
        },
      }),
    );

    const result = await channel.send(MESSAGE);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('logger exploded');
    expect(result.channel).toBe('log');
  });

  it('closes twice without throwing', async () => {
    const channel = createChannel(config({ logger: () => undefined }));

    await channel.close();
    await expect(channel.close()).resolves.toBeUndefined();
  });
});

describe('the null channel', () => {
  it('reports an undelivered message with a readable reason', async () => {
    const channel = createChannel(config({ from: '' }));

    const result = await channel.send(MESSAGE);

    expect(result).toEqual({
      delivered: false,
      messageId: null,
      error: 'No sender address is configured (MAIL_FROM is empty), so nothing was sent.',
      channel: 'null',
    });
    await expect(channel.close()).resolves.toBeUndefined();
  });
});

describe('the SMTP channel', () => {
  it('returns the transport-assigned message id on success', async () => {
    const transport = fakeTransport({ messageId: '<abc123@finance.local>' });
    const channel = createSmtpChannel(transport, 'alerts@finance.local');

    const result = await channel.send(MESSAGE);

    expect(result).toEqual({
      delivered: true,
      messageId: '<abc123@finance.local>',
      error: null,
      channel: 'smtp',
    });
    expect(transport.sent[0]?.from).toBe('alerts@finance.local');
    expect(transport.sent[0]?.subject).toBe(MESSAGE.subject);
  });

  it('keeps a sender the caller set explicitly', async () => {
    const transport = fakeTransport({});
    const channel = createSmtpChannel(transport, 'alerts@finance.local');

    await channel.send({ ...MESSAGE, from: 'someone-else@example.com' });

    expect(transport.sent[0]?.from).toBe('someone-else@example.com');
  });

  it('returns delivered:false with the error instead of throwing when the transport rejects', async () => {
    // A dead SMTP server must not fail the HTTP request that triggered the
    // alert: the alerts row is already committed and deliveredAt stays null.
    const transport = fakeTransport({ reject: new Error('connect ECONNREFUSED 127.0.0.1:1029') });
    const channel = createSmtpChannel(transport, 'alerts@finance.local');

    const result = await channel.send(MESSAGE);

    expect(result).toEqual({
      delivered: false,
      messageId: null,
      error: 'connect ECONNREFUSED 127.0.0.1:1029',
      channel: 'smtp',
    });
  });

  it('survives a transport that rejects with something that is not an Error', async () => {
    const transport: MailTransport = {
      async sendMail() {
        throw 'socket hang up';
      },
      close() {
        // nothing to release
      },
    };

    const result = await createSmtpChannel(transport, 'alerts@finance.local').send(MESSAGE);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('socket hang up');
  });

  it('reports a missing message id as null rather than undefined', async () => {
    const transport: MailTransport = {
      async sendMail() {
        return undefined;
      },
      close() {
        // nothing to release
      },
    };

    const result = await createSmtpChannel(transport, 'alerts@finance.local').send(MESSAGE);

    expect(result.messageId).toBeNull();
    expect(result.delivered).toBe(true);
  });

  it('closes the transport once, however many times close is called', async () => {
    const transport = fakeTransport({});
    const channel = createSmtpChannel(transport, 'alerts@finance.local');

    await channel.close();
    await expect(channel.close()).resolves.toBeUndefined();

    expect(transport.closes).toBe(1);
  });

  it('does not throw when the transport fails to close', async () => {
    const transport: MailTransport = {
      async sendMail() {
        return { messageId: 'x' };
      },
      close() {
        throw new Error('pool already gone');
      },
    };

    await expect(
      createSmtpChannel(transport, 'alerts@finance.local').close(),
    ).resolves.toBeUndefined();
  });
});
