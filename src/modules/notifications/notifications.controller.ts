import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  // 202, not 201: the work is accepted, not completed. The caller gets an id to poll, and the
  // actual sending happens in workers — so promising "created" would be a lie about a send that
  // may still be minutes away.
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Replay guard. Re-sending the same key returns the original response instead of ' +
      'creating a second notification. Strongly recommended for any producer that retries.',
  })
  @ApiOperation({ summary: 'Enqueue a notification for fan-out across channels' })
  @ApiResponse({ status: 202, description: 'Accepted and queued for dispatch' })
  @ApiResponse({ status: 400, description: 'Payload does not match the topic schema' })
  create(@Body() dto: CreateNotificationDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.notifications.ingest(dto, idempotencyKey?.trim() || undefined);
  }

  @Get()
  @ApiOperation({ summary: 'List notifications with a per-channel status summary' })
  list(
    @Query('userId') userId?: string,
    @Query('topicKey') topicKey?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.list({
      userId,
      topicKey,
      limit: Math.min(Math.max(limit, 1), 100),
      cursor,
    });
  }

  /** The trace view: every delivery and every event, in order. The main debugging tool. */
  @Get(':id')
  @ApiOperation({ summary: 'Full trace: notification, deliveries and delivery events' })
  findOne(@Param('id') id: string) {
    return this.notifications.findOne(id);
  }
}
