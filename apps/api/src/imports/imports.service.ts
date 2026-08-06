/**
 * Statement import: upload, preview, correct, commit.
 *
 * The shape of this file is decided by one rule and one hazard.
 *
 * **The rule: the preview is a pure function of the stored bytes.** `upload`,
 * `get`, `setFormat` and `commit` all call the same `rebuild`, which reads the
 * file off disk, runs `@fin/import` over it and writes the resulting rows back to
 * `import_rows`. Nothing derives a preview from the persisted rows. That is what
 * makes a format correction a one-line change (store a different `format`, call
 * `rebuild`) instead of a migration of every stored row, and it is what
 * guarantees the plan a commit executes is the plan the user was looking at, down
 * to the fingerprints -- which are deliberately absent from the wire type and
 * therefore cannot come back from the browser.
 *
 * **The hazard: duplicate detection needs the ledger, and the ledger is large.**
 * A statement covers a date range this code does not know until it has parsed the
 * file, so the preview is built twice: once with no ledger rows, to learn the
 * range the file spans, and once with the account's transactions over that range
 * widened by `DUPLICATE_WINDOW_DAYS` at each end. The alternative -- fetch every
 * transaction on the account -- is a full table read per upload, and the
 * alternative to *that* -- guess a window -- is a duplicate that slips through
 * whenever somebody imports a two-year-old statement. Parsing twice costs
 * milliseconds; both other options are wrong rather than slow.
 *
 * Two more decisions worth naming, both of them things a reader would otherwise
 * try to "fix":
 *
 * - The commit is a `createMany` with `skipDuplicates`, not a row-by-row insert.
 *   `transactions_account_id_external_id_key` can still fire on a row the preview
 *   passed (the bank reissued an id, two files overlap on ids the ledger already
 *   has), and a unique violation inside a transaction aborts the whole
 *   transaction -- so catching it per row is not available. `skipDuplicates`
 *   turns that from a failed import into a smaller `imported` count, which is
 *   both true and reportable.
 * - `currency` is taken from the account row, never from `DEFAULT_CURRENCY`.
 *   `transactions_currency_matches_account` is a `BEFORE` trigger and rejects the
 *   entire statement, naming the trigger rather than the field.
 */
import {
  ImportError,
  buildPreview,
  decodeStatementAs,
  detectStatement,
  planCommit,
  readStatement,
  type ExistingTransaction,
  type ParseOptions,
  type PlannedRow,
  type PreviewResult,
} from '@fin/import';
import {
  day,
  fromUtcDate,
  toUtcDate,
  type CalendarDay,
  type CommitImport,
  type CommitResult,
  type DetectedFormat,
  type ImportPreview,
} from '@fin/shared';
import { IMPORT_SHA_UNIQUE, isUniqueViolation, type Prisma } from '@fin/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCacheService } from '../reports/report-cache.service';
import { RulesService } from '../rules/rules.service';
import {
  readStatementFile,
  removeStatement,
  sha256Of,
  storedPathFor,
  writeStatement,
} from './import-storage';
import { localeDecimalOf } from './locale-decimal';
import { rawLinesOf } from './raw-lines';

/** What multer hands over, narrowed to the two fields this service reads. */
export interface UploadedStatement {
  originalname: string;
  buffer: Buffer;
}

/** `filename` is `VARCHAR(255)` and the browser controls it. */
const MAX_FILENAME = 255;

interface ImportRecord {
  id: string;
  accountId: string;
  filename: string;
  status: string;
  format: Prisma.JsonValue | null;
  storedPath: string | null;
}

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ReportCacheService) private readonly cache: ReportCacheService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Take an upload, park the bytes, and answer with what the parser made of it.
   *
   * Re-uploading the identical file resumes the existing import. The check is the
   * `imports_user_id_sha256_key` unique index and a catch, not a `findFirst` and
   * an insert: two tabs both pass the lookup and one of them then fails on the
   * index, which is precisely the case the lookup was supposed to prevent.
   */
  async upload(userId: string, accountId: string, file: UploadedStatement): Promise<ImportPreview> {
    const account = await this.account(userId, accountId);
    const bytes = file.buffer;

    if (bytes.length === 0) {
      throw new UnprocessableEntityException('That file is empty.');
    }
    if (bytes.length > this.config.maxImportBytes) {
      throw new PayloadTooLargeException(
        `That file is ${bytes.length} bytes and the limit is ${this.config.maxImportBytes}. ` +
          'Narrow the date range on the export and try again.',
      );
    }

    const sha256 = sha256Of(bytes);
    const filename = file.originalname.slice(0, MAX_FILENAME) || 'statement.csv';
    const options = this.parseOptions(account.currency);

    // Detected before anything is written, so a file that cannot be read at all
    // leaves no row and no blob behind. `detectStatement` is the only call that
    // can reject the upload outright; everything after it is per-row.
    const format = this.guard(() => detectStatement(bytes, options));

    const path = storedPathFor(this.config.importRoot, userId, sha256);
    await writeStatement(path, bytes);

    let record: ImportRecord;
    try {
      record = await this.prisma.import.create({
        data: {
          userId,
          accountId: account.id,
          filename,
          byteSize: bytes.length,
          sha256,
          status: 'pending',
          format: format as unknown as Prisma.InputJsonValue,
          storedPath: path,
        },
        select: SELECT_IMPORT,
      });
    } catch (error) {
      if (!isUniqueViolation(error, IMPORT_SHA_UNIQUE)) throw error;

      const existing = await this.prisma.import.findFirst({
        where: { userId, sha256 },
        select: SELECT_IMPORT,
      });
      if (!existing) throw error;
      if (existing.status === 'committed') {
        throw new ConflictException(
          'This exact file has already been imported. Nothing was changed. ' +
            'Export a new statement, or delete the previous import first.',
        );
      }
      record = existing;
    }

    return toWire(await this.rebuild(userId, record, format, account.currency));
  }

  /** The preview as it stands now, rebuilt from the stored bytes. */
  async get(userId: string, importId: string): Promise<ImportPreview> {
    const record = await this.require(userId, importId);
    const account = await this.account(userId, record.accountId);
    return toWire(await this.rebuild(userId, record, this.formatOf(record), account.currency));
  }

  /**
   * Re-read the file with a format the reader corrected by hand.
   *
   * The detector is good and it is not always right: a file whose amounts are all
   * whole euros carries no evidence about its own decimal separator, and one
   * whose dates are all below the 13th carries none about day-first versus
   * month-first. Both are shown as ambiguous in the preview, and this is the
   * route that acts on the answer.
   */
  async setFormat(
    userId: string,
    importId: string,
    format: DetectedFormat,
  ): Promise<ImportPreview> {
    const record = await this.require(userId, importId);
    if (record.status === 'committed') {
      throw new ConflictException('This import has already been committed and cannot be re-read.');
    }
    const account = await this.account(userId, record.accountId);

    const updated = await this.prisma.import.update({
      where: { id: record.id },
      data: { format: format as unknown as Prisma.InputJsonValue, status: 'pending', error: null },
      select: SELECT_IMPORT,
    });

    return toWire(await this.rebuild(userId, updated, format, account.currency));
  }

  /**
   * Write the rows the user kept.
   *
   * `skipLines` is applied exactly as sent. The default of "skip every duplicate"
   * belongs to the form that builds the request, not here: a person looking at
   * two identical coffees on the same afternoon is allowed to decide both are
   * real, and a server that filtered duplicates unconditionally would give them
   * no way to say so.
   */
  async commit(userId: string, importId: string, input: CommitImport): Promise<CommitResult> {
    const record = await this.require(userId, importId);
    if (record.status === 'committed') {
      throw new ConflictException('This import has already been committed.');
    }
    const account = await this.account(userId, record.accountId);

    const preview = await this.rebuild(userId, record, this.formatOf(record), account.currency);
    const rows = planCommit(preview, input.skipLines);

    const imported = await this.insert(userId, record.id, account, rows);

    await this.prisma.import.update({
      where: { id: record.id },
      data: { status: 'committed', committedAt: new Date() },
    });

    // After the commit, in this order, for the reason in `TransactionsService`:
    // evaluating first would have the alert mailer read a cached report that
    // predates the rows it is reacting to.
    await this.cache.bump(userId);
    await this.evaluate(userId);

    return {
      importId: record.id,
      imported,
      skipped: preview.counts.total - imported,
      categorised: rows.filter((row) => row.categoryId !== null).length,
    };
  }

  /** Drop an import and its blob. Committed transactions keep their `importId` null. */
  async remove(userId: string, importId: string): Promise<void> {
    const record = await this.require(userId, importId);
    await this.prisma.import.delete({ where: { id: record.id } });
    if (record.storedPath !== null) await removeStatement(record.storedPath);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Parse the stored file and bring `import_rows` into line with the result.
   *
   * The two parses are the ledger-window problem described in the file header.
   * The first one is thrown away except for the date range of its plan.
   */
  private async rebuild(
    userId: string,
    record: ImportRecord,
    format: DetectedFormat,
    currency: string,
  ): Promise<PreviewResult> {
    if (record.storedPath === null) {
      throw new InternalServerErrorException(
        'This import has no stored file, so it cannot be re-read. Upload the statement again.',
      );
    }

    const bytes = await this.readFile(record.storedPath);
    const options = this.parseOptions(currency);
    const rules = await this.rules.compiledFor(userId);

    const context = {
      importId: record.id,
      filename: record.filename,
      accountId: record.accountId,
      rules,
      existing: [] as readonly ExistingTransaction[],
    };

    const firstPass = this.guard(() => buildPreview(bytes, format, context, options));
    const existing = await this.existingFor(
      record.accountId,
      firstPass.plan,
      options.duplicateWindowDays,
    );

    // Skipped when the file contributed no dated rows: there is nothing to
    // compare against, and the first pass is already the final answer.
    const preview =
      existing.length === 0
        ? firstPass
        : this.guard(() => buildPreview(bytes, format, { ...context, existing }, options));

    await this.persist(record.id, bytes, format, preview);
    return preview;
  }

  /**
   * Replace this import's rows with the current reading.
   *
   * `deleteMany` then `createMany`, inside one transaction, rather than an upsert
   * per line: a re-read after a format correction can change the *number* of rows
   * as well as their contents (a corrected header depth moves the first data
   * line), so there is no stable key to upsert on. 20,000 rows is one statement
   * and two statements.
   */
  private async persist(
    importId: string,
    bytes: Buffer,
    format: DetectedFormat,
    preview: PreviewResult,
  ): Promise<void> {
    const raw = this.rawFor(bytes, format);

    await this.prisma.$transaction([
      this.prisma.importRow.deleteMany({ where: { importId } }),
      this.prisma.importRow.createMany({
        data: preview.rows.map((row) => ({
          importId,
          lineNumber: row.lineNumber,
          status: row.status,
          message: row.message,
          bookedOn: row.bookedOn === null ? null : toUtcDate(day(row.bookedOn)),
          amountMinor: row.amountMinor,
          description: row.description,
          raw: raw.get(row.lineNumber) ?? '',
          suggestedCategoryId: row.suggestedCategoryId,
          suggestedBy: row.suggestedBy,
          duplicateOfId: row.duplicateOfId,
        })),
      }),
      this.prisma.import.update({
        where: { id: importId },
        data: {
          status: 'ready',
          totalRows: preview.counts.total,
          newRows: preview.counts.new,
          duplicateRows: preview.counts.duplicate,
          errorRows: preview.counts.error,
          error: null,
        },
      }),
    ]);
  }

  /** The verbatim text of every record, keyed by the line the record starts on. */
  private rawFor(bytes: Buffer, format: DetectedFormat): Map<number, string> {
    const options = this.parseOptions('EUR');
    const read = readStatement(
      bytes,
      { ...options, maxBytes: bytes.length },
      {
        encoding: format.encoding,
        delimiter: format.delimiter,
      },
    );
    const decoded = decodeStatementAs(bytes, format.encoding);
    return rawLinesOf(
      decoded.text,
      read.records.map((entry) => entry.line),
    );
  }

  /**
   * The ledger rows a duplicate could plausibly be a duplicate of.
   *
   * Bounded by the file's own span, widened by the duplicate window at both ends,
   * because a row dated the 1st can match an existing row dated the 3rd.
   */
  private async existingFor(
    accountId: string,
    plan: readonly PlannedRow[],
    windowDays: number,
  ): Promise<ExistingTransaction[]> {
    if (plan.length === 0) return [];

    const days = plan.map((row) => row.bookedOn).sort();
    const from = shiftDay(days[0] as CalendarDay, -windowDays);
    const to = shiftDay(days[days.length - 1] as CalendarDay, windowDays);

    const rows = await this.prisma.transaction.findMany({
      where: { accountId, bookedOn: { gte: toUtcDate(from), lte: toUtcDate(to) } },
      select: { id: true, bookedOn: true, amountMinor: true, description: true, externalId: true },
    });

    return rows.map((row) => ({
      id: row.id,
      bookedOn: fromUtcDate(row.bookedOn),
      amountMinor: row.amountMinor,
      description: row.description,
      externalId: row.externalId,
    }));
  }

  /** Insert the plan. Returns how many rows the database actually took. */
  private async insert(
    userId: string,
    importId: string,
    account: { id: string; currency: string },
    rows: readonly PlannedRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const result = await this.prisma.transaction.createMany({
      data: rows.map((row) => ({
        userId,
        accountId: account.id,
        importId,
        bookedOn: toUtcDate(row.bookedOn),
        amountMinor: row.amountMinor,
        // From the account row. See the file header.
        currency: account.currency,
        description: row.description,
        merchant: row.merchant,
        externalId: row.externalId,
        fingerprint: row.fingerprint,
        categoryId: row.categoryId,
        categorySource: row.categorySource,
        ruleId: row.ruleId,
      })),
      // See the file header: an external id the ledger already holds costs one
      // row, not the whole import.
      skipDuplicates: true,
    });

    return result.count;
  }

  /** Budget alerts for the user's current month, after the rows have landed. */
  private async evaluate(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    });
    if (!user) return;
    await this.alerts.evaluate(userId, this.alerts.monthFor(user.timeZone));
  }

  private parseOptions(currency: string): ParseOptions {
    return {
      localeDecimal: localeDecimalOf(this.config.defaultLocale),
      currency,
      maxBytes: this.config.maxImportBytes,
      duplicateWindowDays: this.config.duplicateWindowDays,
    };
  }

  /**
   * Turn an `ImportError` into the status code it means.
   *
   * `too-large` is the only one that is about the request rather than the file's
   * contents, and 413 is the code a client can act on without reading the body.
   * Everything else is a well-formed request carrying a file this parser cannot
   * read, which is 422 rather than 400: the syntax of the request was fine.
   */
  private guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      if (error.code === 'too-large') throw new PayloadTooLargeException(error.message);
      throw new UnprocessableEntityException(error.message);
    }
  }

  private async readFile(path: string): Promise<Buffer> {
    try {
      return await readStatementFile(path);
    } catch (error) {
      this.logger.error(`Stored statement is unreadable at ${path}: ${String(error)}`);
      throw new InternalServerErrorException(
        'The uploaded file is no longer readable on the server. Upload the statement again.',
      );
    }
  }

  private formatOf(record: ImportRecord): DetectedFormat {
    if (record.format === null) {
      throw new InternalServerErrorException(
        'This import has no stored format. Upload the statement again.',
      );
    }
    // Stored by this service from a value the contract already validated, so it
    // is read back without re-parsing. A hand-edited row is a database problem,
    // not a request problem, and would surface as a parse error on the next line.
    return record.format as unknown as DetectedFormat;
  }

  private async require(userId: string, importId: string): Promise<ImportRecord> {
    const record = await this.prisma.import.findFirst({
      where: { id: importId, userId },
      select: SELECT_IMPORT,
    });
    if (!record) throw new NotFoundException('No such import.');
    return record;
  }

  private async account(
    userId: string,
    accountId: string,
  ): Promise<{ id: string; currency: string }> {
    if (accountId.trim() === '') throw new BadRequestException('Choose an account to import into.');
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true, currency: true },
    });
    if (!account) throw new NotFoundException('No such account.');
    return account;
  }
}

const SELECT_IMPORT = {
  id: true,
  accountId: true,
  filename: true,
  status: true,
  format: true,
  storedPath: true,
} as const;

/**
 * Drop the server-side half before the preview goes on the wire.
 *
 * `plan` carries fingerprints, and a fingerprint the client can see is one the
 * client can send back. The whole reason it is computed from the account id on
 * the server is that it must not be supplied alongside one.
 */
export function toWire(preview: PreviewResult): ImportPreview {
  const { plan: _plan, ...wire } = preview;
  return wire;
}

/** `CalendarDay` arithmetic in UTC, which is the only zone a `date` column has. */
function shiftDay(value: CalendarDay, days: number): CalendarDay {
  const at = toUtcDate(value);
  at.setUTCDate(at.getUTCDate() + days);
  return fromUtcDate(at);
}
