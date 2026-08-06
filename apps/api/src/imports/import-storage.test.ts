import { isAbsolute, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeSegment, sha256Of, storedPathFor } from './import-storage';

/**
 * Pins the two properties the stored-statement path is built on: the file is
 * addressed by the digest of its own bytes, and no part of the path comes from
 * anything a browser sent.
 *
 * The digest is the import's identity, which is what makes re-uploading the same
 * statement resume the existing import instead of creating a second one. The
 * segment guard is what keeps `originalname` out of the path forever: it comes
 * from the client, it is stored in a column, and a future caller reaching for it
 * to build a filename is the failure this file is here to prevent.
 *
 * No filesystem is touched. Every function under test is pure, and a gate test
 * that writes to disk is a gate test that fails on a read-only checkout.
 *
 * The expected digests were produced by running Node, not recalled:
 *
 *     node -e "const {createHash}=require('node:crypto');
 *       console.log(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
 *       console.log(createHash('sha256').update(Buffer.from('abc','utf8')).digest('hex'))"
 */

/** A statement small enough to write out, with its digest computed once. */
const STATEMENT = 'date,description,amount\n2026-03-01,Mercadona,-12.34\n';
const STATEMENT_SHA256 = 'dfc6b0f8f68f6dece5b92f5385decb9c897e7bb8cff22f639b009a1582677496';

/** A cuid, which is what the user id and the import id actually look like. */
const CUID = 'clz8k2q4t0000t3n4c8m1x9a7';

describe('sha256Of', () => {
  it('is the hex SHA-256 of the bytes', () => {
    expect(sha256Of(Buffer.from(STATEMENT, 'utf8'))).toBe(STATEMENT_SHA256);
    expect(sha256Of(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('has an answer for an empty upload rather than an exception', () => {
    // A zero-byte file is a real upload. It has to reach the parser and be
    // reported as an empty statement, not fail while being addressed.
    expect(sha256Of(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('gives byte-identical uploads the same address, which is what resumes an import', () => {
    // The `imports_user_id_sha256_key` unique index enforces one import per
    // (user, digest). It can only do that if this function agrees with itself
    // across two requests.
    expect(sha256Of(Buffer.from(STATEMENT, 'utf8'))).toBe(sha256Of(Buffer.from(STATEMENT, 'utf8')));
  });

  it('separates two statements that differ by one cent', () => {
    const other = STATEMENT.replace('12.34', '12.35');
    expect(sha256Of(Buffer.from(other, 'utf8'))).toBe(
      '29d44db178b35b74bed1f708551574635641eebe71beab9793f8bdcd3938c01d',
    );
    expect(sha256Of(Buffer.from(other, 'utf8'))).not.toBe(STATEMENT_SHA256);
  });

  it('hashes bytes, not text, so a latin-1 export is addressable', () => {
    // Spanish bank exports are routinely cp1252. The digest is taken before any
    // decoding, which is why the encoding can still be re-detected later.
    expect(sha256Of(Buffer.from([0xff, 0x00, 0x41]))).toBe(
      '0fa3e62511779f0398b77cad37b3cc4763bb96253b91fcd61500f8a979ad9920',
    );
  });

  it('produces a value that is itself a safe path segment', () => {
    // Hex only, 64 characters. The output of this function is the input to
    // `assertSafeSegment` one line later.
    const digest = sha256Of(Buffer.from(STATEMENT, 'utf8'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertSafeSegment('sha256', digest)).not.toThrow();
  });
});

describe('assertSafeSegment', () => {
  it('accepts a cuid, which is what the database hands it', () => {
    expect(() => assertSafeSegment('userId', CUID)).not.toThrow();
  });

  it('accepts the dash and underscore a cuid2 or a nanoid can contain', () => {
    expect(() => assertSafeSegment('userId', 'user_id-01')).not.toThrow();
  });

  it('refuses the parent directory', () => {
    // The one value that turns `<root>/<userId>/<sha>.csv` into a write anywhere
    // on the disk the process can reach.
    expect(() => assertSafeSegment('userId', '..')).toThrow(/userId/);
  });

  it('refuses a separator, so a value can never contribute two segments', () => {
    expect(() => assertSafeSegment('userId', 'a/b')).toThrow(/userId/);
    expect(() => assertSafeSegment('userId', '../../etc/passwd')).toThrow(/userId/);
  });

  it('refuses an empty segment, which would collapse the path silently', () => {
    // `join(root, '', 'x.csv')` is `root/x.csv`. No error, one directory level
    // gone, and every user's statements in the same folder.
    expect(() => assertSafeSegment('userId', '')).toThrow(/userId/);
  });

  it('refuses a segment longer than any real id', () => {
    // 128 is the ceiling, so 129 is the first refusal. Long names are how a
    // path limit gets hit on the filesystem rather than here.
    expect(() => assertSafeSegment('userId', 'a'.repeat(128))).not.toThrow();
    expect(() => assertSafeSegment('userId', 'a'.repeat(129))).toThrow(/userId/);
  });

  it('refuses a NUL and a newline, which truncate a path in a syscall', () => {
    expect(() => assertSafeSegment('userId', 'a\u0000b')).toThrow(/userId/);
    expect(() => assertSafeSegment('userId', 'a\nb')).toThrow(/userId/);
  });

  it('names the label and quotes the value, so the log says which one was wrong', () => {
    expect(() => assertSafeSegment('sha256', '..')).toThrow('sha256=".."');
  });
});

describe('storedPathFor', () => {
  const ROOT = './var/imports';

  it('builds an absolute path under the resolved root', () => {
    // The config value is relative (`./var/imports` is the default), and the
    // process may chdir. An absolute path is what makes the write reproducible.
    const path = storedPathFor(ROOT, CUID, STATEMENT_SHA256);

    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(resolve(ROOT) + sep)).toBe(true);
    expect(path).toBe(join(resolve(ROOT), CUID, `${STATEMENT_SHA256}.csv`));
  });

  it('gives each user their own directory', () => {
    // Two users uploading the same statement must not share one file: deleting
    // one import would then delete the other's bytes.
    const mine = storedPathFor(ROOT, CUID, STATEMENT_SHA256);
    const theirs = storedPathFor(ROOT, 'clz8k2q4t0000t3n4c8m1x9b8', STATEMENT_SHA256);
    expect(mine).not.toBe(theirs);
  });

  it('is stable, so preview and commit read the file the upload wrote', () => {
    expect(storedPathFor(ROOT, CUID, STATEMENT_SHA256)).toBe(
      storedPathFor(ROOT, CUID, STATEMENT_SHA256),
    );
  });

  it('refuses a traversal in the user id', () => {
    expect(() => storedPathFor(ROOT, '..', STATEMENT_SHA256)).toThrow(/userId/);
    expect(() => storedPathFor(ROOT, '../../etc', STATEMENT_SHA256)).toThrow(/userId/);
  });

  it('refuses a traversal in the digest', () => {
    // The digest is computed here and cannot be attacker-controlled today. The
    // check is what keeps that true when somebody passes an id instead.
    expect(() => storedPathFor(ROOT, CUID, '..')).toThrow(/sha256/);
    expect(() => storedPathFor(ROOT, CUID, '../../../etc/passwd')).toThrow(/sha256/);
  });

  it('resolves a root that contains its own traversal, because the root is trusted', () => {
    // `IMPORT_ROOT` comes from the operator, not from a request. It is
    // normalised rather than refused, and the result still lands under the
    // normalised root.
    const path = storedPathFor('./var/tmp/../imports', CUID, STATEMENT_SHA256);
    expect(path).toBe(join(resolve('./var/imports'), CUID, `${STATEMENT_SHA256}.csv`));
  });

  it('always ends in .csv, so nothing stored is executable by extension', () => {
    expect(storedPathFor(ROOT, CUID, STATEMENT_SHA256).endsWith('.csv')).toBe(true);
  });

  it('takes three parameters, none of which is the uploaded filename', () => {
    // `originalname` comes from the browser. It is stored in a column and shown
    // to the reader, and the reason it can never reach a path is that this
    // signature has nowhere to put it. A fourth parameter appearing here is the
    // change that would need arguing about.
    expect(storedPathFor.length).toBe(3);
  });
});
