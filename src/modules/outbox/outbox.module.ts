import { Module } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay';

@Module({
  providers: [OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxModule {}
