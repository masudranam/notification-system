import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { CORRELATION_HEADER, newCorrelationId, runWithCorrelationId } from './correlation.store';

/** Accepts an inbound correlation id (so callers can trace across services) or mints a new one. */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const inbound = req.headers[CORRELATION_HEADER];
    const correlationId =
      (Array.isArray(inbound) ? inbound[0] : inbound)?.trim() || newCorrelationId();

    (req as Request & { correlationId?: string }).correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);

    return runWithCorrelationId(correlationId, () => next.handle());
  }
}
