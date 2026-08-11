import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Channel, DeliveryStatus } from '@prisma/client';
import { Observable, interval, map, merge } from 'rxjs';
import { Public } from 'src/common/auth/public.decorator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from './realtime.service';

@ApiTags('inbox')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/inbox')
export class InboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Cursor-paginated feed.
   *
   * Cursor rather than offset: an inbox has new rows arriving constantly, and `OFFSET 20` on a
   * shifting list silently skips or repeats items. A cursor anchored to a row id is stable.
   */
  @Get()
  @ApiOperation({ summary: 'In-app notification feed with unread count' })
  async list(
    @Query('userId') userId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('cursor') cursor?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const take = Math.min(Math.max(limit, 1), 100);

    const where = {
      channel: Channel.IN_APP,
      notification: { userId },
      // Only rows that actually reached the inbox — a SUPPRESSED in-app delivery is an audit
      // record, not something the user should see.
      status: { in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.OPENED] },
      ...(unreadOnly === 'true' ? { readAt: null } : {}),
    };

    const rows = await this.prisma.delivery.findMany({
      where,
      orderBy: { queuedAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        renderedSubject: true,
        renderedBody: true,
        readAt: true,
        queuedAt: true,
        notification: { select: { id: true, topicKey: true, data: true } },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    const unreadCount = await this.prisma.delivery.count({
      where: {
        channel: Channel.IN_APP,
        notification: { userId },
        readAt: null,
        status: { in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.OPENED] },
      },
    });

    return {
      items: items.map((row) => ({
        id: row.id,
        topicKey: row.notification.topicKey,
        subject: row.renderedSubject,
        body: row.renderedBody,
        data: row.notification.data,
        read: row.readAt !== null,
        readAt: row.readAt,
        createdAt: row.queuedAt,
      })),
      unreadCount,
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
    };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one in-app notification as read' })
  async markRead(@Param('id') id: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      select: { id: true, channel: true, readAt: true, notification: { select: { userId: true } } },
    });
    if (!delivery || delivery.channel !== Channel.IN_APP) {
      throw new NotFoundException(`Unknown in-app notification "${id}"`);
    }

    // Idempotent: re-marking keeps the original timestamp rather than moving it.
    if (!delivery.readAt) {
      await this.prisma.delivery.update({ where: { id }, data: { readAt: new Date() } });
      await this.realtime.publish({
        userId: delivery.notification.userId,
        type: 'read',
        payload: { deliveryId: id },
      });
    }

    return { id, read: true };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every in-app notification as read' })
  async markAllRead(@Query('userId') userId: string) {
    const result = await this.prisma.delivery.updateMany({
      where: { channel: Channel.IN_APP, readAt: null, notification: { userId } },
      data: { readAt: new Date() },
    });
    await this.realtime.publish({ userId, type: 'read-all', payload: { count: result.count } });
    return { updated: result.count };
  }

  /**
   * Server-Sent Events stream.
   *
   * SSE over WebSockets here because the traffic is strictly one-way (server -> browser), and SSE
   * gets automatic reconnection, plain HTTP semantics and no extra protocol for free. `EventSource`
   * also cannot send custom headers, which is why this route is @Public and takes the userId as a
   * query param — a real deployment would use a short-lived signed stream token instead.
   *
   * The merged 25-second heartbeat is not optional: proxies and load balancers close idle
   * connections, typically at 30-60s, and a comment frame keeps the stream alive.
   */
  @Public()
  @Sse('stream')
  @ApiOperation({ summary: 'Live in-app notification stream (SSE)' })
  stream(@Query('userId') userId: string): Observable<unknown> {
    const heartbeat = interval(25_000).pipe(
      map(() => ({ data: { type: 'ping', at: new Date().toISOString() } })),
    );
    return merge(this.realtime.streamFor(userId), heartbeat);
  }
}
