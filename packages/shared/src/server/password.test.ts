import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('hashPassword', () => {
  it('produces the documented three-part format', () => {
    const stored = hashPassword('correct horse battery staple');
    const [scheme, salt, hash] = stored.split(':');
    expect(scheme).toBe('scrypt');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('salts, so the same password never hashes to the same string twice', () => {
    // Without this, an attacker with the table can see which accounts share a
    // password, and one cracked hash unlocks all of them.
    expect(hashPassword('same password')).not.toBe(hashPassword('same password'));
  });
});

describe('verifyPassword', () => {
  it('accepts the password it was given', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects anything else, including near misses', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('handles non-ASCII passwords byte-for-byte', () => {
    const stored = hashPassword('contraseña más segura 🔐');
    expect(verifyPassword('contraseña más segura 🔐', stored)).toBe(true);
    // NFC vs NFD: visually identical, different bytes. scrypt hashes bytes, so
    // these must not match. Pinned so nobody "helpfully" adds a normalise step
    // and silently changes what every stored hash means.
    expect(verifyPassword('contraseña más segura 🔐'.normalize('NFD'), stored)).toBe(false);
  });

  it('returns false rather than throwing on a corrupted stored value', () => {
    // A crash here would be a 500 on a login route, which is its own kind of
    // oracle: it tells an attacker which rows are damaged.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt:only-two-parts',
      'bcrypt:abc:def',
      'scrypt::',
      'scrypt:abcd:zzzz',
      // Right shape, wrong length: a truncated hash must not compare equal to a
      // truncated derivation. `timingSafeEqual` throws on a length mismatch, so
      // this is the case that turns a bad row into a 500 if it is not checked.
      'scrypt:' + 'a'.repeat(32) + ':' + 'b'.repeat(64),
    ]) {
      expect(() => verifyPassword('anything', stored), stored).not.toThrow();
      expect(verifyPassword('anything', stored), stored).toBe(false);
    }
  });
});
