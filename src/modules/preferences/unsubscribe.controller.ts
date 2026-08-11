import { Controller, Get, Header, Post, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/auth/public.decorator';
import { PreferencesService } from './preferences.service';

@ApiTags('preferences')
@Controller('unsubscribe')
export class UnsubscribeController {
  constructor(private readonly preferences: PreferencesService) {}

  /**
   * One-click unsubscribe landing page.
   *
   * Public by necessity — it is opened from a mail client with no credentials, which is exactly
   * why the token is HMAC-signed. Returns HTML rather than JSON because a human is looking at it.
   */
  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'One-click unsubscribe via signed token' })
  async unsubscribe(@Query('token') token: string): Promise<string> {
    if (!token) return page('Missing token', 'This unsubscribe link is incomplete.', false);
    try {
      const result = await this.preferences.applyUnsubscribe(token);
      return page(
        'You have been unsubscribed',
        `You will no longer receive <strong>${escapeHtml(result.topicName)}</strong> messages ` +
          `on ${result.channel.toLowerCase().replace('_', '-')}.`,
        true,
      );
    } catch (err) {
      return page('We could not process that', escapeHtml((err as Error).message), false);
    }
  }

  /**
   * RFC 8058 `List-Unsubscribe-Post` target.
   *
   * Gmail and Outlook show a native "Unsubscribe" button when an email carries the
   * `List-Unsubscribe` headers, and they POST here rather than following the link. Supporting it
   * means users take the one-click path instead of the "mark as spam" path — which directly
   * protects sender reputation.
   */
  @Public()
  @Post()
  @ApiExcludeEndpoint()
  async unsubscribePost(@Query('token') token: string) {
    await this.preferences.applyUnsubscribe(token);
    return { unsubscribed: true };
  }
}

function page(title: string, message: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f5f6f8; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e6e8eb; } }
  .card { background: canvas; padding: 32px 36px; border-radius: 10px; max-width: 460px;
          box-shadow: 0 1px 3px rgb(0 0 0 / .12); text-align: center; }
  .icon { font-size: 40px; }
  h1 { font-size: 20px; margin: 12px 0 8px; }
  p { margin: 0; color: #6b7280; }
</style></head>
<body><div class="card">
  <div class="icon">${ok ? '✅' : '⚠️'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${message}</p>
</div></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
