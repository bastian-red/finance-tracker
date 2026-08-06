/**
 * Turning the uploaded bytes into a string, which is not the trivial step it
 * looks like.
 *
 * A Spanish bank export is very often `windows-1252`, not UTF-8. Decoded as
 * UTF-8 the byte `0xF3` is not a valid sequence, so `Buffer.toString('utf8')`
 * substitutes U+FFFD and `Alimentación` arrives as `Alimentaci<?>n`. Nothing
 * downstream throws: the row imports, the description looks *almost* right, and
 * every rule matching `alimentacion` silently stops firing, because
 * `normaliseDescription` turns the replacement character into a space and splits
 * the word in two. The failure surfaces weeks later as a category that stopped
 * being assigned.
 *
 * So the decode is checked rather than assumed. If UTF-8 produces replacement
 * characters the bytes were not UTF-8, and `latin1` is the fallback: it maps
 * every byte to a code point, so it never fails and never loses a character.
 * `windows-1252` differs from `latin1` only in the 0x80-0x9F range (curly quotes,
 * the euro sign), which is why the reported name is `latin1` -- that is what was
 * actually run, and claiming otherwise would make a wrong smart-quote harder to
 * explain, not easier.
 *
 * The BOM cases come before any of that. A leading U+FEFF left on the front of
 * the first cell makes the first header label unequal to itself: `"\ufeffFecha"`
 * is not `"Fecha"`, so the date column goes missing on a file that is otherwise
 * perfect.
 */

export type EncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1';

export interface DecodedStatement {
  text: string;
  encoding: EncodingName;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const REPLACEMENT = '\ufffd';

/** Decode, choosing the encoding from the bytes themselves. */
export function decodeStatement(bytes: Buffer): DecodedStatement {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), 'le'), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), 'be'), encoding: 'utf-16be' };
  }

  const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
  const asUtf8 = body.toString('utf8');
  if (!asUtf8.includes(REPLACEMENT)) return { text: asUtf8, encoding: 'utf-8' };

  return { text: body.toString('latin1'), encoding: 'latin1' };
}

/**
 * Decode with an encoding that has already been decided.
 *
 * `buildPreview` is handed the `DetectedFormat` rather than re-detecting, so a
 * reader who corrects the encoding in the UI gets their correction honoured on
 * the second pass. An unrecognised name falls back to detection instead of
 * throwing: the format may have been round-tripped through the database and a
 * stale value must not make an otherwise readable file unopenable.
 */
export function decodeStatementAs(bytes: Buffer, encoding: string): DecodedStatement {
  switch (encoding) {
    case 'utf-8':
      return {
        text: (hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes).toString('utf8'),
        encoding: 'utf-8',
      };
    case 'latin1':
      return {
        text: (hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes).toString('latin1'),
        encoding: 'latin1',
      };
    case 'utf-16le':
      return { text: decodeUtf16(stripUtf16Bom(bytes), 'le'), encoding: 'utf-16le' };
    case 'utf-16be':
      return { text: decodeUtf16(stripUtf16Bom(bytes), 'be'), encoding: 'utf-16be' };
    default:
      return decodeStatement(bytes);
  }
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

function stripUtf16Bom(bytes: Buffer): Buffer {
  const leading = (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0);
  return leading === 0xfffe || leading === 0xfeff ? bytes.subarray(2) : bytes;
}

/**
 * Node decodes UTF-16LE and nothing else, so the big-endian case is byte-swapped
 * first.
 *
 * The copy before `swap16` is not optional: `swap16` mutates the buffer in place,
 * and the buffer here is the caller's upload. Swapping it would corrupt the bytes
 * for anyone who reads them again, which `buildPreview` does by design.
 * A trailing odd byte is dropped rather than throwing -- a truncated last code
 * unit is a broken final row, not a broken file.
 */
function decodeUtf16(bytes: Buffer, endianness: 'le' | 'be'): string {
  const even = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
  if (endianness === 'le') return even.toString('utf16le');
  return Buffer.from(even).swap16().toString('utf16le');
}
