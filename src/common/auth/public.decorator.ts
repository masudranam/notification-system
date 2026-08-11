import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the global API-key guard.
 *
 * Used by: provider webhooks (authenticated by signature instead), the one-click unsubscribe
 * link (must work from an email client with no credentials), health, and metrics.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
