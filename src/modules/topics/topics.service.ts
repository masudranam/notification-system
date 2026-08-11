import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Topic } from '@prisma/client';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * The topic registry, plus payload validation at the API boundary.
 *
 * Validating here rather than inside the worker is deliberate. A worker rejecting a bad payload
 * can only log and fail — nobody is listening. Rejecting at ingest gives the producer a 400 with
 * the exact JSON-pointer that was wrong, at the moment they can still fix it.
 */
@Injectable()
export class TopicsService {
  private readonly ajv: Ajv;
  private readonly validators = new Map<
    string,
    { validate: ValidateFunction; updatedAt: number }
  >();
  private topicCache = new Map<string, { topic: Topic; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 15_000;

  constructor(private readonly prisma: PrismaService) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    // Enables `format: 'uri'`, 'email', 'date-time' etc. Ajv ignores unknown formats otherwise.
    addFormats(this.ajv);
  }

  async list(): Promise<Topic[]> {
    return this.prisma.topic.findMany({ orderBy: { key: 'asc' } });
  }

  async get(key: string): Promise<Topic> {
    const cached = this.topicCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.topic;

    const topic = await this.prisma.topic.findUnique({ where: { key } });
    if (!topic) {
      throw new NotFoundException(`Unknown topic "${key}"`);
    }
    this.topicCache.set(key, { topic, expiresAt: Date.now() + TopicsService.CACHE_TTL_MS });
    return topic;
  }

  /**
   * Validates a producer payload against the topic's JSON Schema.
   *
   * Compiled validators are cached per topic and invalidated by the topic's `updatedAt`, so
   * editing a schema takes effect without a restart.
   */
  assertValidPayload(topic: Topic, data: unknown): void {
    const validate = this.validatorFor(topic);

    if (!validate(data)) {
      const details = (validate.errors ?? []).map((e) => ({
        path: e.instancePath || '/',
        message: e.message,
        params: e.params,
      }));
      throw new BadRequestException({
        message: `Payload does not match the schema for topic "${topic.key}"`,
        details,
      });
    }
  }

  /**
   * Compiled validator for a topic, cached and invalidated by the topic's `updatedAt`.
   *
   * Keyed on the timestamp rather than just the topic key so editing a payloadSchema takes effect
   * without a restart — a cache keyed on the key alone would keep accepting the old shape forever.
   */
  private validatorFor(topic: Topic): ValidateFunction {
    const cached = this.validators.get(topic.key);
    const updatedAt = topic.updatedAt.getTime();
    if (cached && cached.updatedAt === updatedAt) {
      return cached.validate;
    }

    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(topic.payloadSchema as object);
    } catch (err) {
      throw new BadRequestException(
        `Topic "${topic.key}" has an invalid payloadSchema: ${(err as Error).message}`,
      );
    }

    this.validators.set(topic.key, { validate, updatedAt });
    return validate;
  }

  /** `system.*` topics are internal (the digest sender uses one); producers must not post to them. */
  assertProducerAllowed(key: string): void {
    if (key.startsWith('system.')) {
      throw new BadRequestException(`Topic "${key}" is internal and cannot be triggered directly`);
    }
  }
}
