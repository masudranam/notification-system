import { InjectQueue } from '@nestjs/bullmq';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DigestMode } from '@prisma/client';
import { Queue } from 'bullmq';
import { IsEnum } from 'class-validator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { JOB, QUEUE } from 'src/queue/queue.constants';
import { DigestService } from './digest.service';

class FlushDigestDto {
  @IsEnum(DigestMode)
  window!: DigestMode;
}

@ApiTags('digest')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/digests')
export class DigestController {
  constructor(
    private readonly digest: DigestService,
    @InjectQueue(QUEUE.DIGEST) private readonly digestQueue: Queue,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Inspect open (unflushed) digest buckets' })
  async list(@Query('userId') userId?: string) {
    const buckets = await this.digest.stats(userId);
    return buckets.map((b) => ({
      ...b,
      itemCount: Array.isArray(b.items) ? b.items.length : 0,
    }));
  }

  /** Lets you see the digest path work without waiting for the top of the hour. */
  @Post('flush')
  @ApiOperation({ summary: 'Flush digest buckets now instead of waiting for the schedule' })
  async flush(@Body() dto: FlushDigestDto) {
    const job = await this.digestQueue.add(JOB.FLUSH_DIGEST, { window: dto.window });
    return { queued: true, jobId: job.id, window: dto.window };
  }
}
