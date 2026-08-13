import 'dotenv/config';
import { z } from 'zod';

const BooleanString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(5050),
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.coerce.number().int().positive().default(5433),
  DATABASE_NAME: z.string().default('answerengine'),
  DATABASE_USER: z.string().default('postgres'),
  DATABASE_PASSWORD: z.string().default('postgres'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DEFAULT_TENANT_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000001'),
  LLM_PROVIDER: z.enum(['lmstudio', 'openai', 'anthropic']).default('lmstudio'),
  LLM_BASE_URL: z.string().url().default('http://localhost:1234/v1'),
  LLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANSWER_ENGINE_API_KEY: z.string().trim().min(1).optional(),
  LOCAL_UI_AUTO_AUTH: BooleanString,
  MODELS_CHAT: z.string().optional(),
  MODELS_QA: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(['lmstudio', 'openai']).default('lmstudio'),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  MODELS_EMBEDDING: z.string().optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),
  WEB_UI_DIR: z.string().trim().min(1).optional(),
  AE_HOME: z.string().trim().min(1).default('/data'),
  LOCAL_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  LOG_LEVEL: z.string().default('info'),
});

export type Environment = z.infer<typeof EnvSchema>;
export const env = EnvSchema.parse(process.env);
