import { getQueueToken, InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { DeadLetterJobData, QUEUE } from 'src/queue/queue.constants';
import { CircuitBreakerService } from './circuit-breaker.service';

@ApiTags('operations')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/ops')
export class DlqController {
  constructor(
    @InjectQueue(QUEUE.DLQ) private readonly dlq: Queue<DeadLetterJobData>,
    private readonly moduleRef: ModuleRef,
    private readonly breaker: CircuitBreakerService,
  ) {}

  @Get('dlq')
  @ApiOperation({ summary: 'Inspect dead-lettered jobs' })
  async list(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50) {
    const jobs = await this.dlq.getJobs(['waiting', 'completed', 'failed'], 0, limit - 1);
    return jobs.map((job) => ({
      id: job.id,
      queue: job.data.queue,
      originalJobName: job.data.originalJobName,
      failedReason: job.data.failedReason,
      attemptsMade: job.data.attemptsMade,
      data: job.data.data,
      createdAt: new Date(job.timestamp).toISOString(),
    }));
  }

  /**
   * Re-drives a dead letter onto its original queue.
   *
   * Deliberately manual. Automatic replay of a dead letter is how you turn one bad payload into an
   * infinite loop — by the time a job reaches the DLQ it has already failed five times, so a human
   * should confirm the cause is fixed first.
   */
  @Post('dlq/:id/replay')
  @ApiOperation({ summary: 'Replay a dead-lettered job onto its original queue' })
  async replay(@Param('id') id: string) {
    const job = await this.dlq.getJob(id);
    if (!job) throw new NotFoundException(`No dead-letter job "${id}"`);

    const target = this.moduleRef.get<Queue>(getQueueToken(job.data.queue), { strict: false });
    const replayed = await target.add(job.data.originalJobName, job.data.data as never, {
      // No jobId: the original deterministic id may still be present in the queue's completed set,
      // which would make BullMQ silently discard the replay.
      attempts: 3,
    });

    await job.remove();
    return { replayed: true, queue: job.data.queue, newJobId: replayed.id };
  }

  @Delete('dlq/:id')
  @ApiOperation({ summary: 'Discard a dead-lettered job' })
  async discard(@Param('id') id: string) {
    const job = await this.dlq.getJob(id);
    if (!job) throw new NotFoundException(`No dead-letter job "${id}"`);
    await job.remove();
    return { discarded: true };
  }

  @Get('circuit-breakers')
  @ApiOperation({ summary: 'Circuit breaker state per provider' })
  breakers() {
    return this.breaker.snapshot(['resend', 'smtp', 'web-push', 'slack', 'twilio', 'mock-sms']);
  }

  @Post('circuit-breakers/:provider/reset')
  @ApiOperation({ summary: 'Force a circuit breaker closed' })
  async resetBreaker(@Param('provider') provider: string) {
    await this.breaker.reset(provider);
    return { provider, state: 'closed' };
  }
}
