import {
  createTransactionSchema,
  transactionQuerySchema,
  updateTransactionSchema,
  type CreateTransaction,
  type Transaction,
  type TransactionPage,
  type TransactionQuery,
  type UpdateTransaction,
} from '@fin/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { OrdinaryRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
@OrdinaryRate()
export class TransactionsController {
  constructor(@Inject(TransactionsService) private readonly transactions: TransactionsService) {}

  /**
   * The pipe returns the schema's **output**, which is the point of using it on a
   * query string: `z.coerce.number()` turns `"50"` into `50` and the default
   * fills in `limit`. A handler reading the raw query would be comparing a string
   * to a number and silently paging by 1.
   */
  @Get()
  list(
    @CurrentUser() user: TokenUser,
    @Query(new ZodValidationPipe(transactionQuerySchema)) query: TransactionQuery,
  ): Promise<TransactionPage> {
    return this.transactions.list(user.id, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransaction,
  ): Promise<Transaction> {
    return this.transactions.create(user.id, body);
  }

  /** `PATCH`, not `PUT`: re-categorising one row must not require resending the amount. */
  @Patch(':id')
  update(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTransactionSchema)) body: UpdateTransaction,
  ): Promise<Transaction> {
    return this.transactions.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.transactions.remove(user.id, id);
  }
}
