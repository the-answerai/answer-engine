import { cpSync, mkdirSync } from 'node:fs';

const output = new URL('../dist/', import.meta.url);
mkdirSync(output, { recursive: true });
cpSync(new URL('../src/renderer/', import.meta.url), new URL('./renderer/', output), { recursive: true });
cpSync(new URL('../assets/', import.meta.url), new URL('./assets/', output), { recursive: true });
