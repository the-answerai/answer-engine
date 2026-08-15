import { chmodSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configYamlPath } from './home.js';
import { SUPPORTED_SYNC_SOURCES } from './sync/types.js';

const ModelsSchema = z.object({
  chat: z.string().trim().min(1, 'select a chat model'),
  embedding: z.string().trim().min(1, 'select an embedding model'),
  chat_provider: z.enum(['lmstudio', 'anthropic', 'openai']),
  embedding_provider: z.enum(['lmstudio', 'openai']),
  embedding_dimension: z.number().int().positive(),
}).strict();

const SourceSchema = z.object({
  type: z.enum(SUPPORTED_SYNC_SOURCES),
  path: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  library: z.string().trim().min(1).optional(),
  include: z.array(z.string().trim().min(1)).min(1).optional(),
  exclude: z.array(z.string().trim().min(1)).optional(),
  content_type: z.literal('document').optional(),
  on_delete: z.enum(['leave', 'forget']).optional(),
  max_file_bytes: z.number().int().positive().optional(),
  options: z.record(z.unknown()).optional(),
}).strict().superRefine((source, context) => {
  if (
    (source.type === 'claude-code' || source.type === 'codex' || source.type === 'cowork')
    && source.url !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: `is not supported for ${source.type}; use path instead`,
    });
  }
  if (source.type === 'local_dir') {
    if (source.path === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'is required for local_dir',
      });
    }
    if (source.url !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'is not supported for local_dir; use path instead',
      });
    }
    return;
  }

  for (const field of ['include', 'exclude', 'content_type', 'on_delete', 'max_file_bytes'] as const) {
    if (source[field] !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: 'is only supported for local_dir',
      });
    }
  }
});

const ConnectorsSchema = z.object({
  anthropic_api_key: z.string().trim().min(1).optional(),
  openai_api_key: z.string().trim().min(1).optional(),
}).strict();

const ServerSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(5050),
  bind: z.string().trim().min(1).default('127.0.0.1'),
}).strict();

const HistorySyncSchema = z.object({
  enabled: z.boolean().default(false),
}).strict();

export const UserConfigSchema = z.object({
  models: ModelsSchema,
  sources: z.array(SourceSchema).default([]),
  connectors: ConnectorsSchema.default({}),
  server: ServerSchema.default({}),
  history_sync: HistorySyncSchema.optional(),
}).strict().superRefine((config, context) => {
  if (
    config.models.embedding_provider !== 'lmstudio'
    && config.models.embedding_dimension !== 1536
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models', 'embedding_dimension'],
      message: 'must be 1536 for OpenAI embedding providers',
    });
  }
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export const DEFAULT_USER_CONFIG: UserConfig = {
  models: {
    chat: 'replace-with-loaded-lm-studio-model-id',
    embedding: 'replace-with-loaded-lm-studio-embedding-model-id',
    chat_provider: 'lmstudio',
    embedding_provider: 'lmstudio',
    embedding_dimension: 768,
  },
  sources: [],
  connectors: {},
  server: {
    port: 5050,
    bind: '127.0.0.1',
  },
};

export class UserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConfigError';
  }
}

function issuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join('.') : '(root)';
}

function formatValidationError(path: string, error: z.ZodError): UserConfigError {
  const details = error.issues
    .map((issue) => `  - ${issuePath(issue.path)}: ${issue.message}`)
    .join('\n');
  return new UserConfigError(`Invalid Answer Engine config at ${path}:\n${details}`);
}

export function loadUserConfig(path: string = configYamlPath()): UserConfig {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'file not found. Create it or run the Answer Engine setup command.'
      : error instanceof Error ? error.message : String(error);
    throw new UserConfigError(`Unable to read Answer Engine config at ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserConfigError(`Invalid YAML in Answer Engine config at ${path}: ${reason}`);
  }

  const result = UserConfigSchema.safeParse(parsed);
  if (!result.success) throw formatValidationError(path, result.error);

  try {
    chmodSync(path, 0o600);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserConfigError(`Unable to secure Answer Engine config at ${path}: ${reason}`);
  }
  return result.data;
}
