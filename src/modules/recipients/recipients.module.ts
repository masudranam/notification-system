import { Module } from '@nestjs/common';
import { RecipientsController } from './recipients.controller';

@Module({
  controllers: [RecipientsController],
})
export class RecipientsModule {}
