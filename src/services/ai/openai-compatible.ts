import { env } from '../../config/env.js';
import { ConfigurationError } from '../../utils/errors.js';

export interface LanguageProvider {
  embed(text: string): Promise<number[]>;
  complete(input: { system: string; prompt: string }): Promise<{ text: string; model: string; provider: string }>;
}

async function postJson<T>(url: string, apiKey: string | undefined, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Model provider returned ${response.status}: ${message.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

export class OpenAiCompatibleProvider implements LanguageProvider {
  async embed(text: string): Promise<number[]> {
    if (!env.MODELS_EMBEDDING) {
      throw new ConfigurationError('MODELS_EMBEDDING is required for semantic search');
    }
    const baseUrl = (env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL).replace(/\/$/, '');
    const response = await postJson<{ data: Array<{ embedding: number[] }> }>(
      `${baseUrl}/embeddings`,
      env.EMBEDDING_API_KEY ?? env.LLM_API_KEY ?? env.OPENAI_API_KEY,
      { model: env.MODELS_EMBEDDING, input: text },
    );
    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length !== env.EMBEDDING_DIMENSION) {
      throw new Error(`Embedding provider returned ${embedding?.length ?? 0} dimensions; expected ${env.EMBEDDING_DIMENSION}`);
    }
    return embedding;
  }

  async complete(input: { system: string; prompt: string }): Promise<{ text: string; model: string; provider: string }> {
    const model = env.MODELS_QA ?? env.MODELS_CHAT;
    if (!model) throw new ConfigurationError('MODELS_CHAT is required for summaries and answers');
    if (env.LLM_PROVIDER === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY) throw new ConfigurationError('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
      const response = await fetch(`${env.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 2048, temperature: 0.1, system: input.system, messages: [{ role: 'user', content: input.prompt }] }),
      });
      if (!response.ok) throw new Error(`Anthropic returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const data = await response.json() as { content: Array<{ type: string; text?: string }>; model?: string };
      const text = data.content.find((block) => block.type === 'text')?.text?.trim();
      if (!text) throw new Error('Anthropic returned an empty completion');
      return { text, model: data.model ?? model, provider: 'anthropic' };
    }
    const response = await postJson<{
      choices: Array<{ message?: { content?: string | null } }>;
      model?: string;
    }>(
      `${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      env.LLM_API_KEY ?? env.OPENAI_API_KEY,
      {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ],
      },
    );
    const text = response.choices[0]?.message?.content?.trim();
    if (!text) throw new Error('Model provider returned an empty completion');
    return { text, model: response.model ?? model, provider: env.LLM_PROVIDER };
  }
}
