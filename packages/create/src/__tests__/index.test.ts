import { describe, expect, it } from 'vitest';
import { buildProgram } from '../index.js';
import {
  INSTALL_AGENT_URL,
  writeInstallAgentGuidance,
} from '../install.js';

describe('create-answer-engine CLI', () => {
  it('exposes flag overrides for every interactive installer choice', () => {
    const flags = buildProgram().options.map((option) => option.long);

    expect(flags).toEqual(expect.arrayContaining([
      '--yes',
      '--models',
      '--agents',
      '--home',
      '--llm-provider',
      '--llm-key',
      '--chat-model',
      '--embedding-provider',
      '--embedding-key',
      '--embedding-model',
      '--embedding-dimension',
      '--api-key',
      '--uninstall',
      '--purge',
    ]));
  });

  it('points successful installs at the stable agent setup runbook', () => {
    const messages: string[] = [];

    writeInstallAgentGuidance({ write: (message) => messages.push(message) });

    expect(INSTALL_AGENT_URL).toBe(
      'https://raw.githubusercontent.com/the-answerai/answer-engine/master/INSTALL_AGENT.md',
    );
    expect(messages).toEqual([
      `Agent-guided configuration: ${INSTALL_AGENT_URL}`,
    ]);
  });
});
