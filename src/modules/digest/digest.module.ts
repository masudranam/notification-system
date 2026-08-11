import { Module } from '@nestjs/common';
import { DeliveriesModule } from 'src/modules/deliveries/deliveries.module';
import { DigestController } from './digest.controller';
import { DigestProcessor } from './digest.processor';
import { DigestService } from './digest.service';

@Module({
  imports: [DeliveriesModule],
  controllers: [DigestController],
  providers: [DigestService, DigestProcessor],
  exports: [DigestService],
})
export class DigestModule {}
