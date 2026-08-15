import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveClientConfigPath,
  unwireClient,
  wireClient,
  type FileWiringClient,
} from '@answer-engine/cli/wiring';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  AgentClientIdSchema,
  ClientCapabilitySchema,
  CoworkModeSchema,
  capabilityForClient,
  type AgentClientId,
  type ClientCapability,
  type CoworkMode,
} from './clients.js';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';
import { writePrivateFileAtomic } from './safe-file.js';

const OperationKindSchema = z.enum([
  'mcp-config', 'plugin', 'marketplace', 'cli-config', 'plugin-command',
]);
type OperationKind = z.infer<typeof OperationKindSchema>;

const IntegrationOperationSchema = z.object({
  client: AgentClientIdSchema,
  kind: OperationKindSchema,
  path: z.string().min(1),
  description: z.string().min(1),
}).strict();
export type IntegrationOperation = z.infer<typeof IntegrationOperationSchema>;

const IntegrationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(['stable', 'staging']),
  aeHome: z.string().min(1),
  homeDir: z.string().min(1),
  clients: z.array(ClientCapabilitySchema),
  operations: z.array(IntegrationOperationSchema),
}).strict();
export type IntegrationPlan = z.infer<typeof IntegrationPlanSchema>;

const LedgerEntrySchema = z.object({
  client: AgentClientIdSchema,
  kind: OperationKindSchema,
  path: z.string().min(1),
  created: z.boolean(),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupPath: z.string().min(1).optional(),
}).strict();

const VerificationSchema = z.object({
  client: AgentClientIdSchema,
  status: z.enum(['passed', 'guided', 'unavailable', 'failed']),
  detail: z.string().min(1),
}).strict();

const IntegrationLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.literal('stable'),
  home: z.string().min(1),
  clients: z.array(AgentClientIdSchema),
  entries: z.array(LedgerEntrySchema),
  verification: z.array(VerificationSchema).default([]),
}).strict();
export type IntegrationLedger = z.infer<typeof IntegrationLedgerSchema>;
const UnknownRecordSchema = z.record(z.unknown());
const MarketplaceSchema = z.object({
  name: z.literal('personal'),
  interface: z.record(z.unknown()).optional(),
  plugins: z.array(z.unknown()),
}).passthrough();
const ApplySecretSchema = z.object({
  apiKey: z.string().regex(/^ae_[A-Za-z0-9_-]+$/),
  apiUrl: z.string().url(),
}).strict();

export interface BuildIntegrationPlanInput {
  channel: 'stable' | 'staging';
  aeHome: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  clients: readonly AgentClientId[];
  coworkMode?: CoworkMode;
}

function addOperation(operations: IntegrationOperation[], operation: IntegrationOperation): void {
  if (operations.some((candidate) => candidate.kind === operation.kind && candidate.path === operation.path)) return;
  operations.push(IntegrationOperationSchema.parse(operation));
}

function pluginPath(homeDir: string, host: 'codex' | 'claude'): string {
  return host === 'codex'
    ? join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine')
    : join(homeDir, '.claude', 'skills', 'answer-engine');
}

export function buildIntegrationPlan(input: BuildIntegrationPlanInput): IntegrationPlan {
  if (input.channel !== 'stable' && input.clients.length > 0) {
    throw new Error('Staging cannot write global client integrations; select no clients.');
  }
  const homeDir = input.homeDir ?? homedir();
  const coworkMode = CoworkModeSchema.parse(input.coworkMode ?? 'unknown');
  const clients = input.clients.map((client) => capabilityForClient(client, coworkMode));
  const operations: IntegrationOperation[] = [];

  for (const capability of clients) {
    if (!capability.supported) continue;
    switch (capability.id) {
      case 'codex':
        addOperation(operations, {
          client: 'codex', kind: 'marketplace',
          path: join(homeDir, '.agents', 'plugins', 'marketplace.json'),
          description: 'Register the Answer Engine plugin in the personal Codex marketplace.',
        });
        addOperation(operations, {
          client: 'codex', kind: 'plugin', path: pluginPath(homeDir, 'codex'),
          description: 'Install the checksum-verified Answer Engine plugin for Codex.',
        });
        addOperation(operations, {
          client: 'codex', kind: 'mcp-config',
          path: resolveClientConfigPath('codex', { homeDir, platform: input.platform }),
          description: 'Merge the Answer Engine stdio MCP entry into Codex config.',
        });
        addOperation(operations, {
          client: 'codex', kind: 'plugin-command', path: 'codex:answer-engine@personal',
          description: 'Ask Codex to install the registered personal plugin.',
        });
        break;
      case 'claude-code':
        addOperation(operations, {
          client: 'claude-code', kind: 'plugin', path: pluginPath(homeDir, 'claude'),
          description: 'Install the checksum-verified Answer Engine plugin for Claude Code.',
        });
        addOperation(operations, {
          client: 'claude-code', kind: 'mcp-config',
          path: resolveClientConfigPath('claude-code', { homeDir, platform: input.platform }),
          description: 'Merge the Answer Engine stdio MCP entry into Claude Code config.',
        });
        break;
      case 'claude-cowork':
        addOperation(operations, {
          client: 'claude-cowork', kind: 'plugin', path: pluginPath(homeDir, 'claude'),
          description: 'Install the local-session Answer Engine plugin for Cowork.',
        });
        break;
      case 'claude-desktop':
      case 'cursor':
        addOperation(operations, {
          client: capability.id, kind: 'mcp-config',
          path: resolveClientConfigPath(capability.id, { homeDir, platform: input.platform }),
          description: `Merge the Answer Engine stdio MCP entry into ${capability.label} config.`,
        });
        break;
      case 'chatgpt-desktop':
      case 'chatgpt-work':
      case 'chatgpt-web':
        break;
    }
  }

  if (clients.some((client) => client.supported)) {
    addOperation(operations, {
      client: clients.find((client) => client.supported)?.id ?? 'codex',
      kind: 'cli-config', path: join(homeDir, '.config', 'answer-engine', 'config.yml'),
      description: 'Configure channel-aware Answer Engine CLI access without printing the API key.',
    });
  }
  return IntegrationPlanSchema.parse({
    schemaVersion: 1, channel: input.channel, aeHome: input.aeHome, homeDir, clients, operations,
  });
}

function ledgerPath(aeHome: string): string {
  return join(aeHome, 'integrations', 'ledger.json');
}

function emptyLedger(plan: IntegrationPlan): IntegrationLedger {
  return IntegrationLedgerSchema.parse({
    schemaVersion: 1,
    channel: 'stable',
    home: plan.aeHome,
    clients: plan.clients.map((client) => client.id),
    entries: [],
    verification: [],
  });
}

export function readIntegrationLedger(aeHome: string): IntegrationLedger {
  const path = ledgerPath(aeHome);
  if (lstatSync(path).isSymbolicLink()) throw new Error('Integration ledger must not be a symbolic link.');
  return IntegrationLedgerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function readLedgerIfPresent(plan: IntegrationPlan): IntegrationLedger {
  if (!existsSync(ledgerPath(plan.aeHome))) return emptyLedger(plan);
  const ledger = readIntegrationLedger(plan.aeHome);
  if (ledger.channel !== 'stable' || ledger.home !== plan.aeHome) {
    throw new Error('Integration ledger belongs to another Answer Engine installation.');
  }
  return { ...ledger, clients: [...new Set([...ledger.clients, ...plan.clients.map((client) => client.id)])] };
}

function writeLedger(ledger: IntegrationLedger): void {
  const path = ledgerPath(ledger.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(path, `${JSON.stringify(IntegrationLedgerSchema.parse(ledger), null, 2)}\n`, 'Integration ledger');
}

function sha256Bytes(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function filesUnder(root: string, relative = ''): string[] {
  const directory = join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Integration template must not contain symbolic links: ${child}`);
    return entry.isDirectory() ? filesUnder(root, child) : [child];
  }).sort();
}

function sha256Path(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Managed integration path must not be a symbolic link: ${path}`);
  if (stat.isFile()) return sha256Bytes(readFileSync(path));
  const hash = createHash('sha256');
  for (const relative of filesUnder(path)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(join(path, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function secureTree(root: string): void {
  chmodSync(root, 0o700);
  for (const relative of filesUnder(root)) {
    const path = join(root, relative);
    chmodSync(path, 0o600);
    let parent = dirname(path);
    while (parent.startsWith(root) && parent !== root) {
      chmodSync(parent, 0o700);
      parent = dirname(parent);
    }
  }
}

function backupManagedPath(aeHome: string, path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backupRoot = join(aeHome, 'integrations', 'backups');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = join(backupRoot, `${sha256Bytes(path).slice(0, 16)}-${basename(path)}`);
  if (!existsSync(backupPath)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to back up symbolic link integration path: ${path}`);
    if (stat.isDirectory()) {
      cpSync(path, backupPath, { recursive: true, errorOnExist: true });
      secureTree(backupPath);
    } else {
      copyFileSync(path, backupPath);
      chmodSync(backupPath, 0o600);
    }
  }
  return backupPath;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must contain a top-level object.`);
  return parsed.data;
}

function writeMarketplace(path: string): void {
  const root = existsSync(path)
    ? MarketplaceSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : MarketplaceSchema.parse({ name: 'personal', interface: { displayName: 'Personal' }, plugins: [] });
  const plugins = [...root.plugins];
  const entry = {
    name: 'answer-engine',
    source: { source: 'local', path: './plugins/answer-engine' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  const index = plugins.findIndex((plugin) => objectValue(plugin, 'Codex marketplace plugin').name === 'answer-engine');
  if (index >= 0) plugins[index] = entry;
  else plugins.push(entry);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(path, `${JSON.stringify({ ...root, plugins }, null, 2)}\n`, 'Codex marketplace');
}

function writeCliConfig(path: string, apiKey: string, apiUrl: string): void {
  const existing = existsSync(path) ? parseYaml(readFileSync(path, 'utf8')) : {};
  const config = objectValue(existing ?? {}, 'Answer Engine CLI config');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(path, stringifyYaml({ ...config, api_key: apiKey, api_url: apiUrl }), 'Answer Engine CLI config');
}

function installPlugin(path: string, templateDir: string, apiKey: string, apiUrl: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  cpSync(templateDir, path, { recursive: true, errorOnExist: true });
  const mcpPath = join(path, '.mcp.json');
  const mcp = objectValue(JSON.parse(readFileSync(mcpPath, 'utf8')), 'Answer Engine plugin MCP config');
  const servers = objectValue(mcp.mcpServers, 'Answer Engine plugin MCP servers');
  const answerEngine = objectValue(servers['answer-engine'], 'Answer Engine plugin server');
  const env = objectValue(answerEngine.env, 'Answer Engine plugin environment');
  const configured = {
    ...mcp,
    mcpServers: {
      ...servers,
      'answer-engine': {
        ...answerEngine,
        env: {
          ...env,
          ANSWER_ENGINE_API_KEY: apiKey,
          ANSWER_ENGINE_API_URL: apiUrl,
        },
      },
    },
  };
  writePrivateFileAtomic(mcpPath, `${JSON.stringify(configured, null, 2)}\n`, 'Installed Answer Engine plugin MCP config');
  secureTree(path);
}

function fileClientFor(client: AgentClientId): FileWiringClient {
  if (client === 'codex' || client === 'claude-code' || client === 'claude-desktop' || client === 'cursor') return client;
  throw new Error(`Client ${client} does not use a standalone MCP config.`);
}

export interface ApplyIntegrationOptions {
  apiKey: string;
  apiUrl: string;
  templateDir?: string;
  runCommand?: CommandRunner;
}

export async function applyIntegrationPlan(
  planInput: IntegrationPlan,
  options: ApplyIntegrationOptions,
): Promise<{ changed: number; ledger: IntegrationLedger }> {
  const plan = IntegrationPlanSchema.parse(planInput);
  const secret = ApplySecretSchema.parse({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  if (plan.channel !== 'stable') throw new Error('Staging cannot apply global client integrations.');
  const templateDir = options.templateDir
    ?? fileURLToPath(new URL('../templates/integrations/answer-engine', import.meta.url));
  const command = options.runCommand ?? defaultRunCommand;
  let ledger = readLedgerIfPresent(plan);
  let changed = 0;

  for (const operation of plan.operations) {
    const prior = ledger.entries.find((entry) => entry.kind === operation.kind && entry.path === operation.path);
    if (prior) {
      if (operation.kind === 'plugin-command') continue;
      if (existsSync(operation.path) && sha256Path(operation.path) === prior.afterSha256) continue;
      throw new Error(`Managed integration drift detected at ${operation.path}; remove or reconcile it before retrying.`);
    }
    if (operation.kind === 'plugin-command') {
      await command('codex', ['plugin', 'add', 'answer-engine@personal', '--json']);
      ledger.entries.push({
        client: operation.client, kind: operation.kind, path: operation.path, created: true,
        afterSha256: sha256Bytes(operation.path),
      });
      writeLedger(ledger);
      changed += 1;
      continue;
    }

    const created = !existsSync(operation.path);
    const beforeSha256 = created ? undefined : sha256Path(operation.path);
    const backupPath = backupManagedPath(plan.aeHome, operation.path);
    switch (operation.kind) {
      case 'mcp-config':
        wireClient({
          client: fileClientFor(operation.client), apiKey: secret.apiKey,
          serverUrl: secret.apiUrl, library: '00000000-0000-0000-0000-000000000002',
        }, { path: operation.path, backup: false });
        break;
      case 'plugin':
        installPlugin(operation.path, templateDir, secret.apiKey, secret.apiUrl);
        break;
      case 'marketplace':
        writeMarketplace(operation.path);
        break;
      case 'cli-config':
        writeCliConfig(operation.path, secret.apiKey, secret.apiUrl);
        break;
    }
    ledger.entries.push({
      client: operation.client,
      kind: operation.kind,
      path: operation.path,
      created,
      ...(beforeSha256 ? { beforeSha256 } : {}),
      afterSha256: sha256Path(operation.path),
      ...(backupPath ? { backupPath } : {}),
    });
    writeLedger(ledger);
    changed += 1;
  }
  ledger = readIntegrationLedger(plan.aeHome);
  return { changed, ledger };
}

function removeMarketplaceEntry(path: string): void {
  if (!existsSync(path)) return;
  const root = MarketplaceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const plugins = root.plugins
    .filter((plugin) => objectValue(plugin, 'Codex marketplace plugin').name !== 'answer-engine');
  writePrivateFileAtomic(path, `${JSON.stringify({ ...root, plugins }, null, 2)}\n`, 'Codex marketplace');
}

function restoreCliOwnedKeys(path: string, backupPath?: string): void {
  if (!existsSync(path)) return;
  const current = objectValue(parseYaml(readFileSync(path, 'utf8')) ?? {}, 'Answer Engine CLI config');
  const original = backupPath && existsSync(backupPath)
    ? objectValue(parseYaml(readFileSync(backupPath, 'utf8')) ?? {}, 'Answer Engine CLI backup')
    : {};
  const next = { ...current };
  for (const key of ['api_key', 'api_url'] as const) {
    if (key in original) next[key] = original[key];
    else delete next[key];
  }
  writePrivateFileAtomic(path, stringifyYaml(next), 'Answer Engine CLI config');
}

export interface RemoveIntegrationOptions { runCommand?: CommandRunner }

export async function removeManagedIntegrations(
  aeHome: string,
  options: RemoveIntegrationOptions = {},
): Promise<{ removed: string[]; preserved: string[] }> {
  if (!existsSync(ledgerPath(aeHome))) return { removed: [], preserved: [] };
  const ledger = readIntegrationLedger(aeHome);
  const command = options.runCommand ?? defaultRunCommand;
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const entry of [...ledger.entries].reverse()) {
    if (entry.kind === 'plugin-command') {
      await command('codex', ['plugin', 'remove', 'answer-engine@personal', '--json']);
      removed.push(entry.path);
      continue;
    }
    if (!existsSync(entry.path)) continue;
    const unchanged = sha256Path(entry.path) === entry.afterSha256;
    if (!entry.created && unchanged && entry.backupPath && existsSync(entry.backupPath)) {
      rmSync(entry.path, { recursive: true, force: true });
      const backupStat = lstatSync(entry.backupPath);
      if (backupStat.isDirectory()) cpSync(entry.backupPath, entry.path, { recursive: true });
      else {
        mkdirSync(dirname(entry.path), { recursive: true });
        copyFileSync(entry.backupPath, entry.path);
      }
      removed.push(entry.path);
      continue;
    }
    if (entry.created && unchanged) {
      rmSync(entry.path, { recursive: true, force: true });
      removed.push(entry.path);
      continue;
    }
    switch (entry.kind) {
      case 'mcp-config':
        unwireClient(fileClientFor(entry.client), { path: entry.path, backup: false });
        break;
      case 'marketplace':
        removeMarketplaceEntry(entry.path);
        break;
      case 'cli-config':
        restoreCliOwnedKeys(entry.path, entry.backupPath);
        break;
      case 'plugin':
        preserved.push(entry.path);
        continue;
    }
    preserved.push(entry.path);
  }
  rmSync(join(aeHome, 'integrations'), { recursive: true, force: true });
  return { removed, preserved };
}

export function updateIntegrationVerification(
  aeHome: string,
  verification: IntegrationLedger['verification'],
): void {
  const ledger = readIntegrationLedger(aeHome);
  writeLedger({ ...ledger, verification: verification.map((entry) => VerificationSchema.parse(entry)) });
}

export function supportedClients(plan: IntegrationPlan): ClientCapability[] {
  return plan.clients.filter((client) => client.supported);
}
