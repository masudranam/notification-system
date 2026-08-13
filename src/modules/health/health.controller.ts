import { Controller, Get, Redirect } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from 'src/common/auth/public.decorator';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisHealthIndicator } from './redis.health';
import { ProvidersHealthIndicator } from './providers.health';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly providers: ProvidersHealthIndicator,
  ) {}

  /** Hitting the bare host should land somewhere useful rather than a 404. */
  @Public()
  @Get()
  @Redirect('/demo', 302)
  @ApiExcludeEndpoint()
  root() {
    return;
  }

  /**
   * Liveness + readiness in one endpoint.
   *
   * Postgres and Redis are hard dependencies: without them the service cannot accept or process
   * anything, so they fail the check. Providers are reported but never fail it — a Resend outage
   * must not make an orchestrator kill a pod that is still happily queueing work for later.
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check (postgres + redis hard, providers informational)' })
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prisma.isHealthy('postgres'),
      () => this.redis.isHealthy('redis'),
      () => this.providers.report('providers'),
    ]);
  }
}
