export type LlmProvider = 'anthropic' | 'openai';
export type EmbeddingProvider = 'openai';

export interface InstallerOptions {
  channel?: string;
  action?: string;
  image?: string;
  yes?: boolean;
  models?: string;
  clients?: string;
  agents?: string;
  coworkMode?: string;
  home?: string;
  llmProvider?: string;
  llmKey?: string;
  chatModel?: string;
  embeddingProvider?: string;
  embeddingKey?: string;
  embeddingModel?: string;
  embeddingDimension?: string;
  apiKey?: string;
  lmStudioUrl?: string;
  uninstall?: boolean;
  purge?: boolean;
  json?: boolean;
}
