import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Service-to-service auth for /v1/*.
 *
 * Keys are stored as SHA-256 digests, never plaintext — the same reason you hash passwords. A
 * plain digest (no bcrypt) is appropriate here because API keys are long and high-entropy, so
 * there is nothing to brute-force; the slow-hash argument only applies to human-chosen secrets.
 *
 * Verified keys are cached briefly so a hot ingest path does not hit Postgres on every request.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly cache = new Map<string, { id: string; scopes: string[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const raw = req.headers[API_KEY_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;

    if (!provided) {
      throw new UnauthorizedException(`Missing ${API_KEY_HEADER} header`);
    }

    const hashed = createHash('sha256').update(provided).digest('hex');
    const cached = this.cache.get(hashed);
    if (cached && cached.expiresAt > Date.now()) {
      this.attach(req, cached.id, cached.scopes);
      return true;
    }

    const key = await this.prisma.apiKey.findUnique({ where: { hashedKey: hashed } });
    if (!key || key.revokedAt) {
      throw new UnauthorizedException('Invalid API key');
    }

    this.cache.set(hashed, {
      id: key.id,
      scopes: key.scopes,
      expiresAt: Date.now() + ApiKeyGuard.CACHE_TTL_MS,
    });
    // Fire-and-forget: last-used tracking must never add latency to the request path.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    this.attach(req, key.id, key.scopes);
    return true;
  }

  private attach(req: Request, apiKeyId: string, scopes: string[]) {
    (req as Request & { apiKey?: { id: string; scopes: string[] } }).apiKey = {
      id: apiKeyId,
      scopes,
    };
  }
}
