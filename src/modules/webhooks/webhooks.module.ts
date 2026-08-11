import { Module } from '@nestjs/common';
import { DeliveriesModule } from 'src/modules/deliveries/deliveries.module';
import { SuppressionModule } from 'src/modules/suppression/suppression.module';
import { ResendWebhookController } from './resend.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [DeliveriesModule, SuppressionModule],
  controllers: [ResendWebhookController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
