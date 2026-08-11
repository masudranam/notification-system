import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { API_KEY_HEADER, ApiKeyGuard } from './common/auth/api-key.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CorrelationInterceptor } from './common/correlation/correlation.interceptor';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer logs until Winston is wired in, so early boot messages aren't lost.
    bufferLogs: true,
    // Webhook signature verification needs the untouched request bytes; see below.
    rawBody: true,
  });

  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  const isProduction = config.get('isProduction', { infer: true });

  app.use(
    helmet({
      // The demo UI is served from this same origin and uses a small inline script.
      contentSecurityPolicy: isProduction ? undefined : false,
    }),
  );
  app.enableCors({ origin: true, credentials: true, exposedHeaders: ['x-correlation-id'] });

  /**
   * Raw-body capture, scoped to the webhook path only.
   *
   * A signature is computed over the exact bytes the provider sent. Once express.json() has
   * parsed and re-serialised the payload, key order and whitespace can differ and the signature
   * will never match again — so the webhook route must see the original Buffer.
   */
  app.use(
    '/v1/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = req.body;
        try {
          req.body = JSON.parse(req.body.toString('utf8'));
        } catch {
          req.body = {};
        }
      }
      next();
    },
  );

  app.setGlobalPrefix('', { exclude: [] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown fields outright: a typo'd `topicKeys` should fail loudly, not be ignored.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(new CorrelationInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalGuards(new ApiKeyGuard(app.get(PrismaService), app.get(Reflector)));

  const swagger = new DocumentBuilder()
    .setTitle('Notification System')
    .setDescription(
      'Multi-channel notification service: email (Resend), in-app + SSE, web push, Slack, SMS.\n\n' +
        `Authenticate /v1/* calls with the \`${API_KEY_HEADER}\` header.`,
    )
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: API_KEY_HEADER, in: 'header' }, API_KEY_HEADER)
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  // Flush queues and close DB/Redis connections on SIGTERM instead of dropping in-flight jobs.
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Listening on http://localhost:${port}  (docs: /docs, demo: /demo)`, 'Bootstrap');
}

void bootstrap();
