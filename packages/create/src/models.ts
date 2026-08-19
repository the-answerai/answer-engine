import {
  UserConfigSchema,
  type UserConfig,
} from '@answer-engine/cli/scaffold';
import {
  FILE_WIRING_CLIENTS,
  type FileWiringClient,
} from '@answer-engine/cli/wiring';
import type { InstallerOptions, LlmProvider, EmbeddingProvider } from './options.js';
import type { Prompt } from './prompt.js';

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1';
const CLOUD_PROVIDERS: LlmProvider[] = ['anthropic', 'openai'];
const EMBEDDING_PROVIDERS: EmbeddingProvider[] = ['openai'];

export interface ModelSpec {
  chat: string;
  embedding: string;
}

export interface ModelRuntime {
  llmBaseUrl?: string;
  embeddingBaseUrl?: string;
}

export interface ModelSetup {
  config: UserConfig;
  runtime: ModelRuntime;
}

export interface ModelSetupDependencies {
  listLmStudioModels?: (url?: string) => Promise<string[]>;
  prompt?: Prompt;
}

interface NativeLmStudioModel {
  key?: unknown;
  loaded_instances?: unknown;
}

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--embedding-dimension must be a positive integer.');
  }
  return parsed;
}

export function parseModelSpec(value: string): ModelSpec {
  const parsed = new Map<string, string>();
  for (const assignment of value.split(',')) {
    const separator = assignment.indexOf('=');
    if (separator < 1) {
      throw new Error('--models must use chat=<id>,embedding=<id>.');
    }
    const key = assignment.slice(0, separator).trim();
    const model = assignment.slice(separator + 1).trim();
    if (key !== 'chat' && key !== 'embedding') {
      throw new Error(`Unknown model key "${key}"; use chat and embedding.`);
    }
    if (parsed.has(key)) throw new Error(`Duplicate model key "${key}".`);
    if (!model) throw new Error(`Model ${key} cannot be empty.`);
    parsed.set(key, model);
  }
  return {
    chat: nonEmpty(parsed.get('chat'), 'chat model'),
    embedding: nonEmpty(parsed.get('embedding'), 'embedding model'),
  };
}

export function parseAgents(value: string): FileWiringClient[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return [];
  const clients: FileWiringClient[] = [];
  for (const raw of normalized.split(',')) {
    const client = raw.trim();
    if (!FILE_WIRING_CLIENTS.includes(client as FileWiringClient)) {
      throw new Error(
        `Unknown agent "${client}"; choose ${FILE_WIRING_CLIENTS.join(', ')}, or none.`,
      );
    }
    if (!clients.includes(client as FileWiringClient)) clients.push(client as FileWiringClient);
  }
  return clients;
}

export async function listLmStudioModels(
  url: string = DEFAULT_LM_STUDIO_URL,
): Promise<string[]> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return [];
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload.data)) return [];
    return [...new Set(payload.data
      .map((model) => typeof model.id === 'string' ? model.id.trim() : '')
      .filter(Boolean))];
  } catch {
    return [];
  }
}

export async function prepareLmStudioModels(
  models: ModelSpec,
  url: string = DEFAULT_LM_STUDIO_URL,
): Promise<void> {
  const apiRoot = new URL(url).origin;
  let available: NativeLmStudioModel[];
  try {
    const response = await fetch(`${apiRoot}/api/v1/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      // The server speaks /v1 but not LM Studio's native management API.
      // Generic OpenAI-compatible servers such as Ollama load models on
      // demand, so there is nothing to pre-load.
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { models?: NativeLmStudioModel[] };
    available = Array.isArray(payload.models) ? payload.models : [];
  } catch (error) {
    throw new Error(
      `Could not inspect LM Studio model state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const [kind, model] of Object.entries(models) as Array<['chat' | 'embedding', string]>) {
    const state = available.find((candidate) => candidate.key === model);
    if (Array.isArray(state?.loaded_instances) && state.loaded_instances.length > 0) continue;
    const response = await fetch(`${apiRoot}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        context_length: kind === 'chat' ? 32_768 : 2_048,
        ...(kind === 'chat' ? { flash_attention: true } : {}),
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `LM Studio could not load ${kind} model "${model}" (${response.status}): ${detail}`,
      );
    }
  }
}

function ensureLoadedModels(selected: ModelSpec, loaded: string[]): void {
  if (loaded.length === 0) {
    throw new Error(
      'LM Studio is not reachable. Start its local server on port 1234, load both models, '
      + 'or pass cloud provider flags.',
    );
  }
  for (const kind of ['chat', 'embedding'] as const) {
    const model = selected[kind];
    if (!loaded.includes(model)) {
      throw new Error(
        `${kind} model "${model}" is not loaded in LM Studio. Load it or choose one of: `
        + loaded.join(', '),
      );
    }
  }
}

function containerBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid LM Studio URL: ${url}`);
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString().replace(/\/$/, '');
}

function localConfig(
  models: ModelSpec,
  embeddingDimension: number,
  lmStudioUrl: string = DEFAULT_LM_STUDIO_URL,
): ModelSetup {
  return {
    config: UserConfigSchema.parse({
      models: {
        chat: models.chat,
        embedding: models.embedding,
        chat_provider: 'lmstudio',
        embedding_provider: 'lmstudio',
        embedding_dimension: embeddingDimension,
      },
      sources: [],
      connectors: {},
      server: { port: 5050, bind: '127.0.0.1' },
    }),
    runtime: {
      llmBaseUrl: containerBaseUrl(lmStudioUrl),
      embeddingBaseUrl: containerBaseUrl(lmStudioUrl),
    },
  };
}

function parseLlmProvider(value: string): LlmProvider {
  if (!CLOUD_PROVIDERS.includes(value as LlmProvider)) {
    throw new Error(`--llm-provider must be one of: ${CLOUD_PROVIDERS.join(', ')}.`);
  }
  return value as LlmProvider;
}

function parseEmbeddingProvider(value: string): EmbeddingProvider {
  if (!EMBEDDING_PROVIDERS.includes(value as EmbeddingProvider)) {
    throw new Error(`--embedding-provider must be one of: ${EMBEDDING_PROVIDERS.join(', ')}.`);
  }
  return value as EmbeddingProvider;
}

async function requiredValue(
  value: string | undefined,
  flag: string,
  message: string,
  options: InstallerOptions,
  prompt: Prompt | undefined,
  secret = false,
): Promise<string> {
  if (value?.trim()) return value.trim();
  if (options.yes || !prompt) throw new Error(`${flag} is required for a headless install.`);
  const answer = secret ? await prompt.secret(message) : await prompt.input(message);
  return nonEmpty(answer, flag);
}

async function cloudSetup(
  provider: LlmProvider,
  options: InstallerOptions,
  prompt: Prompt | undefined,
): Promise<ModelSetup> {
  const chat = await requiredValue(
    options.chatModel,
    '--chat-model',
    `${provider} chat model ID`,
    options,
    prompt,
  );
  const connectors: UserConfig['connectors'] = {};

  if (provider === 'anthropic') {
    connectors.anthropic_api_key = await requiredValue(
      options.llmKey,
      '--llm-key',
      'Anthropic API key',
      options,
      prompt,
      true,
    );
  } else if (provider === 'openai') {
    connectors.openai_api_key = await requiredValue(
      options.llmKey,
      '--llm-key',
      'OpenAI API key',
      options,
      prompt,
      true,
    );
  }

  let embeddingProvider: EmbeddingProvider;
  if (options.embeddingProvider) {
    embeddingProvider = parseEmbeddingProvider(options.embeddingProvider);
  } else if (provider === 'anthropic') {
    if (options.yes || !prompt) {
      throw new Error(
        '--embedding-provider is required with Anthropic; choose openai.',
      );
    }
    embeddingProvider = parseEmbeddingProvider(await prompt.select(
      'Anthropic does not provide embeddings. Choose an embedding provider',
      EMBEDDING_PROVIDERS,
    ));
  } else {
    embeddingProvider = provider;
  }

  if (embeddingProvider === 'openai' && !connectors.openai_api_key) {
    connectors.openai_api_key = await requiredValue(
      options.embeddingKey,
      '--embedding-key',
      'OpenAI embedding API key',
      options,
      prompt,
      true,
    );
  }
  const defaultEmbeddingModel = 'text-embedding-3-small';
  const embedding = options.embeddingModel?.trim()
    || (options.yes || !prompt
      ? defaultEmbeddingModel
      : await prompt.input('Embedding model ID', defaultEmbeddingModel));
  return {
    config: UserConfigSchema.parse({
      models: {
        chat,
        embedding,
        chat_provider: provider,
        embedding_provider: embeddingProvider,
        embedding_dimension: 1536,
      },
      sources: [],
      connectors,
      server: { port: 5050, bind: '127.0.0.1' },
    }),
    runtime: {},
  };
}

export async function resolveModelSetup(
  options: InstallerOptions,
  dependencies: ModelSetupDependencies = {},
): Promise<ModelSetup> {
  const fetchModels = dependencies.listLmStudioModels ?? listLmStudioModels;
  const prompt = dependencies.prompt;

  if (options.models) {
    if (options.llmProvider) {
      throw new Error('--models selects LM Studio and cannot be combined with --llm-provider.');
    }
    const selected = parseModelSpec(options.models);
    ensureLoadedModels(selected, await fetchModels(options.lmStudioUrl));
    return localConfig(
      selected,
      parsePositiveInteger(options.embeddingDimension, 768),
      options.lmStudioUrl,
    );
  }

  if (options.llmProvider) {
    return cloudSetup(parseLlmProvider(options.llmProvider), options, prompt);
  }

  const loaded = await fetchModels(options.lmStudioUrl);
  if (loaded.length > 0 && !options.yes && prompt) {
    const chat = await prompt.select('Choose the LM Studio chat model', loaded);
    const embedding = await prompt.select('Choose the LM Studio embedding model', loaded);
    const dimension = await prompt.input('Embedding dimension', '768');
    return localConfig(
      { chat, embedding },
      parsePositiveInteger(dimension, 768),
      options.lmStudioUrl,
    );
  }

  if (options.yes || !prompt) {
    throw new Error(
      'Start LM Studio and pass --models chat=<id>,embedding=<id>, or pass cloud provider flags.',
    );
  }

  const provider = parseLlmProvider(await prompt.select(
    'LM Studio was not detected. Choose a cloud chat provider',
    CLOUD_PROVIDERS,
  ));
  return cloudSetup(provider, options, prompt);
}
