import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { getCorrelationId } from '../correlation/correlation.store';

/**
 * One error shape for every failure, with the correlation id echoed back so a user can quote it
 * in a bug report and you can grep the logs for it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, message, details } = this.normalize(exception);

    const payload = {
      statusCode: status,
      message,
      ...(details ? { details } : {}),
      path: req.url,
      correlationId: getCorrelationId(),
      timestamp: new Date().toISOString(),
    };

    const logMeta = { path: req.url, method: req.method, statusCode: status };
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
        'ExceptionFilter',
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} -> ${status}: ${message}`, {
        ...logMeta,
        context: 'ExceptionFilter',
      });
    }

    res.status(status).json(payload);
  }

  private normalize(exception: unknown): {
    status: number;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const body = response as Record<string, unknown>;
        return {
          status: exception.getStatus(),
          message: String(body['message'] ?? exception.message),
          details: body['details'] ?? body['errors'],
        };
      }
      return { status: exception.getStatus(), message: String(response) };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 = unique constraint. Surfacing it as 409 keeps idempotency races honest.
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          message: 'Resource already exists',
          details: exception.meta,
        };
      }
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, message: 'Resource not found' };
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `Database error ${exception.code}`,
        details: exception.meta,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Internal server error',
    };
  }
}
