import { Body, Controller, Delete, Get, Headers, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsString, IsUrl, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { Public } from 'src/common/auth/public.decorator';
import { AppConfig } from 'src/config/configuration';
import { PrismaService } from 'src/prisma/prisma.service';

class SubscriptionKeysDto {
  @IsString()
  p256dh!: string;

  @IsString()
  auth!: string;
}

class RegisterDeviceDto {
  @IsString()
  userId!: string;

  @IsUrl({ require_tld: false })
  endpoint!: string;

  @ValidateNested()
  @Type(() => SubscriptionKeysDto)
  keys!: SubscriptionKeysDto;
}

class UnregisterDeviceDto {
  @IsString()
  endpoint!: string;
}

@ApiTags('devices')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/devices')
export class DevicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * The browser needs the VAPID public key before it can call `pushManager.subscribe()`.
   *
   * Public because the demo page fetches it before any credentials exist, and a VAPID *public*
   * key is meant to be public — it is the private half that authenticates you.
   */
  @Public()
  @Get('vapid-public-key')
  @ApiOperation({ summary: 'VAPID public key for pushManager.subscribe()' })
  vapidPublicKey() {
    const vapid = this.config.get('vapid', { infer: true });
    return { publicKey: vapid.publicKey || null, configured: Boolean(vapid.publicKey) };
  }

  /**
   * Registers a push subscription.
   *
   * Upsert on `endpoint`, not create: the browser returns the *same* endpoint when a user
   * re-subscribes on the same profile, so a plain insert would collide on every page reload.
   * Re-registering also clears `disabledAt`, which is how a previously-pruned subscription comes
   * back to life if the user re-enables notifications.
   */
  @Public()
  @Post()
  @ApiOperation({ summary: 'Register a Web Push subscription' })
  async register(@Body() dto: RegisterDeviceDto, @Headers('user-agent') userAgent?: string) {
    const device = await this.prisma.pushDevice.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId: dto.userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: userAgent?.slice(0, 255),
      },
      update: {
        userId: dto.userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: userAgent?.slice(0, 255),
        lastSeenAt: new Date(),
        disabledAt: null,
      },
    });
    return { id: device.id, registered: true };
  }

  @Public()
  @Delete()
  @ApiOperation({ summary: 'Unregister a Web Push subscription' })
  async unregister(@Body() dto: UnregisterDeviceDto) {
    await this.prisma.pushDevice
      .delete({ where: { endpoint: dto.endpoint } })
      .catch(() => undefined);
    return { unregistered: true };
  }

  @Get()
  @ApiOperation({ summary: "List a user's push subscriptions" })
  list(@Query('userId') userId: string) {
    return this.prisma.pushDevice.findMany({
      where: { userId },
      select: {
        id: true,
        endpoint: true,
        userAgent: true,
        lastSeenAt: true,
        disabledAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
