import { createAccountSchema, type Account, type CreateAccount } from '@fin/shared';
import {
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
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { OrdinaryRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccountsService } from './accounts.service';

@Controller('accounts')
@OrdinaryRate()
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  list(@CurrentUser() user: TokenUser): Promise<Account[]> {
    return this.accounts.list(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccount,
  ): Promise<Account> {
    return this.accounts.create(user.id, body);
  }

  @Put(':id')
  update(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccount,
  ): Promise<Account> {
    return this.accounts.update(user.id, id, body);
  }

  /** Archiving is its own route because it is not an edit of the same fields. */
  @Post(':id/archive')
  archive(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<Account> {
    return this.accounts.setArchived(user.id, id, true);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<Account> {
    return this.accounts.setArchived(user.id, id, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.accounts.remove(user.id, id);
  }
}
