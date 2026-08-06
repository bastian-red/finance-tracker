import {
  commitImportSchema,
  detectedFormatSchema,
  type CommitImport,
  type CommitResult,
  type DetectedFormat,
  type ImportPreview,
} from '@fin/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/current-user.decorator';
import { ImportRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ImportsService, type UploadedStatement } from './imports.service';

/**
 * The one controller in this API that does not take JSON.
 *
 * A statement arrives as `multipart/form-data` with the file under `file` and the
 * destination account under `accountId`, because a CSV is bytes and base64 in a
 * JSON body would inflate an 8 MB ceiling to 11 MB of request for no gain. The
 * body's *other* field is therefore a raw string rather than something the zod
 * pipe validated, so it is checked here: `accountId` is looked up against the
 * user before a single byte is written.
 *
 * The upload ceiling is enforced twice. Multer stops the stream at
 * `MAX_IMPORT_BYTES` (see `ImportsModule`) so an oversized upload never becomes
 * an oversized Buffer, and the service checks the length again so the limit still
 * holds for any caller that reaches it another way.
 */
@Controller('imports')
@ImportRate()
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: TokenUser,
    @UploadedFile() file: UploadedStatement | undefined,
    @Body('accountId') accountId: string | undefined,
  ): Promise<ImportPreview> {
    if (!file) {
      throw new BadRequestException('Attach a statement file under the "file" field.');
    }
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw new BadRequestException('Choose an account to import into.');
    }
    return this.imports.upload(user.id, accountId, file);
  }

  @Get(':id')
  get(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<ImportPreview> {
    return this.imports.get(user.id, id);
  }

  /**
   * `PUT`, not `PATCH`: the body is the whole format, every field of it. A
   * partial format is not a thing the parser can act on -- the delimiter and the
   * encoding decide how the columns are numbered, so half a correction would be
   * applied against a column map derived from the other half.
   */
  @Put(':id/format')
  setFormat(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(detectedFormatSchema)) body: DetectedFormat,
  ): Promise<ImportPreview> {
    return this.imports.setFormat(user.id, id, body);
  }

  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  commit(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(commitImportSchema)) body: CommitImport,
  ): Promise<CommitResult> {
    return this.imports.commit(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.imports.remove(user.id, id);
  }
}
