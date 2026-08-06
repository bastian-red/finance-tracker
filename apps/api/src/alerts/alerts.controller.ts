import type { Alert } from '@fin/shared';
import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { OrdinaryRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { AlertsService } from './alerts.service';

@Controller('alerts')
@OrdinaryRate()
export class AlertsController {
  constructor(@Inject(AlertsService) private readonly alerts: AlertsService) {}

  /**
   * The in-app alert list.
   *
   * It exists separately from the email because the email may not have been sent:
   * the channel is allowed to fail and `deliveredAt` stays null, and the alert is
   * still a thing that happened. A notification list that only shows what an SMTP
   * server accepted is one that goes quiet during an outage without saying so.
   */
  @Get()
  list(@CurrentUser() user: TokenUser): Promise<Alert[]> {
    return this.alerts.list(user.id);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: TokenUser, @Param('id') id: string): Promise<Alert> {
    return this.alerts.markRead(user.id, id);
  }
}
