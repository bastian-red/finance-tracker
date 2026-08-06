import { createRuleSchema, type CreateRule, type Rule } from '@fin/shared';
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
import { RulesService } from './rules.service';

@Controller('rules')
@OrdinaryRate()
export class RulesController {
  constructor(@Inject(RulesService) private readonly rules: RulesService) {}

  @Get()
  list(@CurrentUser() user: TokenUser): Promise<Rule[]> {
    return this.rules.list(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRule,
  ): Promise<Rule> {
    return this.rules.create(user.id, body);
  }

  @Put(':id')
  update(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRule,
  ): Promise<Rule> {
    return this.rules.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.rules.remove(user.id, id);
  }
}
