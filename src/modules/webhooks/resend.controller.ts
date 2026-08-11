import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Webhook } from 'svix';
import { Public } from 'src/common/auth/public.decorator';
import { AppConfig } from 'src/config/configuration';
import { ResendWebhookBody } from './resend-events';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('v1/webhooks')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Resend delivery-event endpoint.
   *
   * Public in the API-key sense, but *not* unauthenticated: the svix signature is the credential.
   * That is the correct model for webhooks — the provider cannot hold your API key, so it proves
   * identity by signing the payload with a shared secret.
   *
   * Always returns 2xx once the event is durably recorded, even if processing hit a snag. A non-2xx
   * makes Resend retry with backoff, and retrying an event we already stored just produces
   * duplicates for the idempotency layer to discard. Better to accept it and surface the problem in
   * our own logs.
   */
  @Public()
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend delivery events (svix-signed)' })
  async handleResend(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: ResendWebhookBody,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ) {
    const { webhookSecret, allowUnsignedWebhooks } = this.config.get('resend', { infer: true });

    let eventId = svixId;

    if (webhookSecret) {
      if (!svixId || !svixTimestamp || !svixSignature) {
        throw new UnauthorizedException('Missing svix signature headers');
      }
      if (!req.rawBody) {
        // If this fires, the raw-body middleware in main.ts is not covering this route. Verifying
        // against a re-serialised body would fail every time.
        throw new BadRequestException('Raw request body unavailable for signature verification');
      }

      try {
        // svix verifies the HMAC *and* the timestamp tolerance, which is what stops an attacker
        // replaying a captured-but-valid payload weeks later.
        new Webhook(webhookSecret).verify(req.rawBody.toString('utf8'), {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });
      } catch (err) {
        this.logger.warn(`Rejected Resend webhook ${svixId}: ${(err as Error).message}`);
        throw new UnauthorizedException('Invalid webhook signature');
      }
    } else if (allowUnsignedWebhooks) {
      // Development convenience so the pipeline is testable before a signing secret exists.
      // env.validation.ts refuses to boot with this enabled in production.
      eventId = svixId ?? `unsigned_${randomUUID()}`;
      this.logger.warn(
        `Accepting UNSIGNED Resend webhook (${body.type}) — RESEND_WEBHOOK_SECRET is not set`,
      );
    } else {
      throw new UnauthorizedException('Webhook signing is not configured');
    }

    if (!body?.type) {
      throw new BadRequestException('Webhook payload has no event type');
    }

    const result = await this.webhooks.handleResendEvent(eventId!, body);
    return { received: true, ...result };
  }

  /**
   * Development-only event injector.
   *
   * Real webhooks need a public URL (cloudflared/ngrok). This lets the whole tracking path —
   * status transitions, out-of-order handling, bounce suppression — be exercised locally without a
   * tunnel. Guarded by the same flag that permits unsigned webhooks, so it is unreachable in
   * production.
   */
  @Public()
  @Post('resend/simulate')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async simulate(@Body() body: ResendWebhookBody) {
    const { allowUnsignedWebhooks } = this.config.get('resend', { infer: true });
    if (!allowUnsignedWebhooks) {
      throw new UnauthorizedException('Webhook simulation is disabled');
    }
    if (!body?.type || !body.data?.email_id) {
      throw new BadRequestException('Simulated events need { type, data: { email_id } }');
    }
    return this.webhooks.handleResendEvent(`sim_${randomUUID()}`, body);
  }

  @Public()
  @Get('recent')
  @ApiOperation({ summary: 'Recently received provider webhooks' })
  recent() {
    return this.webhooks.recent();
  }
}
