import { Module } from '@nestjs/common';
import { DeliveriesModule } from 'src/modules/deliveries/deliveries.module';
import { DigestModule } from 'src/modules/digest/digest.module';
import { SuppressionModule } from 'src/modules/suppression/suppression.module';
import { ChannelResolverService } from './channel-resolver.service';
import { DispatchProcessor } from './dispatch.processor';
import { QuietHoursService } from './quiet-hours.service';

@Module({
  imports: [SuppressionModule, DeliveriesModule, DigestModule],
  providers: [ChannelResolverService, QuietHoursService, DispatchProcessor],
  exports: [ChannelResolverService, QuietHoursService],
})
export class DispatchModule {}
