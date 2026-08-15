import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface Prompt {
  input(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  select(message: string, choices: string[]): Promise<string>;
  confirm?(message: string, defaultValue?: boolean): Promise<boolean>;
}

async function question(message: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
}

async function secretQuestion(message: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    return question(message);
  }

  stdout.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string): void => {
      if (chunk === '\u0003') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        reject(new Error('Setup cancelled.'));
        return;
      }
      if (chunk === '\r' || chunk === '\n') {
        finish();
        return;
      }
      if (chunk === '\u007f') {
        if (value.length > 0) value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    stdin.on('data', onData);
  });
}

export function createPrompt(): Prompt {
  return {
    async input(message, defaultValue) {
      const suffix = defaultValue ? ` (${defaultValue})` : '';
      const value = (await question(`${message}${suffix}: `)).trim();
      return value || defaultValue || '';
    },
    secret: (message) => secretQuestion(`${message}: `),
    async select(message, choices) {
      if (choices.length === 0) throw new Error(`No choices are available for ${message}.`);
      stdout.write(`${message}\n`);
      choices.forEach((choice, index) => stdout.write(`  ${index + 1}. ${choice}\n`));
      for (;;) {
        const raw = await question('Choose a number: ');
        const index = Number.parseInt(raw, 10) - 1;
        if (index >= 0 && index < choices.length) return choices[index];
        stdout.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    },
    async confirm(message, defaultValue = false) {
      const hint = defaultValue ? 'Y/n' : 'y/N';
      for (;;) {
        const value = (await question(`${message} (${hint}): `)).trim().toLowerCase();
        if (!value) return defaultValue;
        if (value === 'y' || value === 'yes') return true;
        if (value === 'n' || value === 'no') return false;
        stdout.write('Enter yes or no.\n');
      }
    },
  };
}
