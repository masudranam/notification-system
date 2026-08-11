import { Module } from '@nestjs/common';
import { SuppressionController } from './suppression.controller';
import { SuppressionService } from './suppression.service';

@Module({
  controllers: [SuppressionController],
  providers: [SuppressionService],
  exports: [SuppressionService],
})
export class SuppressionModule {}
