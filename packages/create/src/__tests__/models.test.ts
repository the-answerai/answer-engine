import { describe, expect, it, vi } from 'vitest';
import {
  parseAgents,
  parseModelSpec,
  resolveModelSetup,
} from '../models.js';

describe('installer option parsing', () => {
  it('parses explicit local models and agents for a headless install', () => {
    expect(parseModelSpec('chat=qwen2.5,embedding=nomic-embed-text')).toEqual({
      chat: 'qwen2.5',
      embedding: 'nomic-embed-text',
    });
    expect(parseAgents('claude-code,codex')).toEqual(['claude-code', 'codex']);
    expect(parseAgents('none')).toEqual([]);
  });

  it('rejects unsupported and duplicate model keys', () => {
    expect(() => parseModelSpec('chat=a,chat=b')).toThrow(/duplicate/i);
    expect(() => parseModelSpec('chat=a,rerank=b')).toThrow(/unknown model key/i);
    expect(() => parseAgents('codex,unknown')).toThrow(/unknown agent/i);
  });
});

describe('resolveModelSetup', () => {
  it('uses explicitly selected loaded LM Studio models without prompting', async () => {
    const prompt = { input: vi.fn(), secret: vi.fn(), select: vi.fn() };
    const setup = await resolveModelSetup({
      yes: true,
      models: 'chat=qwen2.5,embedding=nomic-embed-text',
      embeddingDimension: '768',
    }, {
      listLmStudioModels: vi.fn(() => Promise.resolve(['qwen2.5', 'nomic-embed-text'])),
      prompt,
    });

    expect(setup.config.models).toEqual({
      chat: 'qwen2.5',
      embedding: 'nomic-embed-text',
      chat_provider: 'lmstudio',
      embedding_provider: 'lmstudio',
      embedding_dimension: 768,
    });
    expect(setup.runtime).toEqual({
      llmBaseUrl: 'http://host.docker.internal:1234/v1',
      embeddingBaseUrl: 'http://host.docker.internal:1234/v1',
    });
    expect(prompt.input).not.toHaveBeenCalled();
  });

  it('fails headlessly with an actionable fix when model choices are missing', async () => {
    await expect(resolveModelSetup({ yes: true }, {
      listLmStudioModels: vi.fn(() => Promise.resolve([])),
    })).rejects.toThrow(
      'Start LM Studio and pass --models chat=<id>,embedding=<id>, or pass cloud provider flags.',
    );
  });

  it('builds a cloud OpenAI configuration from complete headless flags', async () => {
    const setup = await resolveModelSetup({
      yes: true,
      llmProvider: 'openai',
      llmKey: 'sk-test',
      chatModel: 'gpt-test',
      embeddingModel: 'text-embedding-3-small',
    });

    expect(setup.config).toMatchObject({
      models: {
        chat: 'gpt-test',
        embedding: 'text-embedding-3-small',
        chat_provider: 'openai',
        embedding_provider: 'openai',
        embedding_dimension: 1536,
      },
      connectors: { openai_api_key: 'sk-test' },
    });
  });
});
