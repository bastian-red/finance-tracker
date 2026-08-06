import {
  budgetStatusQuerySchema,
  createBudgetSchema,
  type Budget,
  type BudgetStatus,
  type BudgetStatusQuery,
  type CreateBudget,
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
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { OrdinaryRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BudgetStatusService } from './budget-status.service';
import { BudgetsService } from './budgets.service';

@Controller('budgets')
@OrdinaryRate()
export class BudgetsController {
  constructor(
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(BudgetStatusService) private readonly statuses: BudgetStatusService,
  ) {}

  @Get()
  list(@CurrentUser() user: TokenUser): Promise<Budget[]> {
    return this.budgets.list(user.id);
  }

  /**
   * The stored budgets resolved against real spending, for one month.
   *
   * Declared before every parameterised route in this controller. Nest matches in
   * declaration order, so a `@Get(':id')` added above this one later would swallow
   * `/budgets/status` and answer it with a 404 for a budget whose id is the word
   * "status" -- a failure that reads as "the route does not exist" rather than as
   * "the route was shadowed".
   *
   * `month` is optional and the API resolves the default from the user's stored
   * time zone, not from the request. See `statusesForMonth`.
   */
  @Get('status')
  status(
    @CurrentUser() user: TokenUser,
    @Query(new ZodValidationPipe(budgetStatusQuerySchema)) query: BudgetStatusQuery,
  ): Promise<BudgetStatus[]> {
    return this.statuses.statusesForMonth(user.id, query.month);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudget,
  ): Promise<Budget> {
    return this.budgets.create(user.id, body);
  }

  /**
   * `PUT` rather than `PATCH`: a budget is four fields and they are decided
   * together. A partial update of `effectiveFrom` without `effectiveTo` is a
   * request whose meaning depends on what is already stored, which is exactly the
   * shape the exclusion constraint punishes.
   */
  @Put(':id')
  update(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudget,
  ): Promise<Budget> {
    return this.budgets.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.budgets.remove(user.id, id);
  }
}
