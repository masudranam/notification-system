import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueueDepthCollector } from './queue-depth.collector';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, QueueDepthCollector],
  exports: [MetricsService],
})
export class MetricsModule {}
