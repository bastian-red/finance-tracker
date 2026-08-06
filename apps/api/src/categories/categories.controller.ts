import { createCategorySchema, type Category, type CreateCategory } from '@fin/shared';
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
import { CategoriesService } from './categories.service';

@Controller('categories')
@OrdinaryRate()
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentUser() user: TokenUser): Promise<Category[]> {
    return this.categories.list(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategory,
  ): Promise<Category> {
    return this.categories.create(user.id, body);
  }

  @Put(':id')
  update(
    @CurrentUser() user: TokenUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategory,
  ): Promise<Category> {
    return this.categories.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<void> {
    return this.categories.remove(user.id, id);
  }
}
