import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const started = Date.now();
      await this.prisma.ping();
      return this.getStatus(key, true, { latencyMs: Date.now() - started });
    } catch (err) {
      throw new HealthCheckError(
        'Postgres check failed',
        this.getStatus(key, false, { message: (err as Error).message }),
      );
    }
  }
}
