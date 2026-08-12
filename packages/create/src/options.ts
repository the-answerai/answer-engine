export type LlmProvider = 'anthropic' | 'openai';
export type EmbeddingProvider = 'openai';

export interface InstallerOptions {
  yes?: boolean;
  models?: string;
  agents?: string;
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
}
