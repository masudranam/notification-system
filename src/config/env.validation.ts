import Ajv, { ValidateFunction } from 'ajv';

/**
 * Fail fast at boot rather than at 3am when the first email tries to send.
 *
 * Only truly required vars are enforced here. Provider credentials are optional because the
 * system is designed to degrade: with no RESEND_API_KEY the email channel falls back to SMTP,
 * with no VAPID keys the push channel reports itself unavailable and its deliveries are skipped.
 */
const schema = {
  type: 'object',
  required: ['DATABASE_URL', 'REDIS_URL'],
  properties: {
    NODE_ENV: { type: 'string', enum: ['development', 'test', 'production'] },
    PORT: { type: 'string', pattern: '^\\d+$' },
    DATABASE_URL: { type: 'string', pattern: '^postgres(ql)?://' },
    REDIS_URL: { type: 'string', pattern: '^redis(s)?://' },
    PROVIDER_MODE: { type: 'string', enum: ['sandbox', 'live'] },
    SMS_PROVIDER: { type: 'string', enum: ['mock', 'twilio'] },
    RESEND_API_KEY: { type: 'string' },
    EMAIL_RATE_LIMIT_PER_SEC: { type: 'string', pattern: '^\\d+$' },
  },
} as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false });
  // Typed as ValidateFunction rather than letting Ajv infer a shape from `schema`: the inferred
  // type acts as a type guard and would narrow `present` to only the properties the schema names,
  // hiding the vars the production guards below need to read.
  const validate: ValidateFunction = ajv.compile(schema);

  // Strip undefined/empty values so `enum` checks don't trip on unset optional vars.
  // Deliberately a plain index-signature record: the schema names only a subset of the vars, and
  // the production guards below need to read ones it does not describe.
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== '') present[key] = value;
  }

  if (!validate(present)) {
    const details = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || e.params?.['missingProperty'] || ''} ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const mode = present['PROVIDER_MODE'] ?? 'sandbox';
  if (present['NODE_ENV'] === 'production') {
    if (mode !== 'live') {
      throw new Error('PROVIDER_MODE must be "live" when NODE_ENV=production');
    }
    if (!present['RESEND_API_KEY']) {
      throw new Error('RESEND_API_KEY is required when NODE_ENV=production');
    }
    if (present['WEBHOOK_ALLOW_UNSIGNED'] === 'true') {
      throw new Error('WEBHOOK_ALLOW_UNSIGNED must not be enabled in production');
    }
  }

  return config;
}
