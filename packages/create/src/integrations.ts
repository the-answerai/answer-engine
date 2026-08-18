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
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveClientConfigPath,
  restoreCodexToml,
  restoreJsonClientConfig,
  unwireClient,
  wireClient,
  type FileWiringClient,
  type McpStdioEntry,
  type WiringResult,
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
  'mcp-config', 'plugin', 'marketplace', 'cli-config', 'marketplace-command', 'plugin-command',
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
  selector: z.string().min(1).optional(),
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
  name: z.string().min(1),
  interface: z.record(z.unknown()).optional(),
  plugins: z.array(z.unknown()),
}).passthrough();
const ApplySecretSchema = z.object({
  apiKey: z.string().regex(/^ae_[A-Za-z0-9_-]+$/),
  apiUrl: z.string().url(),
}).strict();
const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';

export interface BuildIntegrationPlanInput {
  channel: 'stable' | 'staging';
  aeHome: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  clients: readonly AgentClientId[];
  coworkMode?: CoworkMode;
  runningInWsl?: boolean;
}

function addOperation(operations: IntegrationOperation[], operation: IntegrationOperation): void {
  if (operations.some((candidate) => candidate.kind === operation.kind && candidate.path === operation.path)) return;
  operations.push(IntegrationOperationSchema.parse(operation));
}

function codexPluginPath(homeDir: string): string {
  return join(homeDir, '.agents', 'plugins', 'plugins', 'answer-engine');
}

function claudeMarketplacePath(aeHome: string): string {
  return join(aeHome, 'client-plugins', 'claude-marketplace');
}

function codexPluginRegistryPath(homeDir: string): string {
  return join(homeDir, '.codex', 'config.toml');
}

function claudePluginRegistryPath(homeDir: string): string {
  return join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
}

function claudeMarketplaceRegistryPath(homeDir: string): string {
  return join(homeDir, '.claude', 'plugins', 'known_marketplaces.json');
}

export function buildIntegrationPlan(input: BuildIntegrationPlanInput): IntegrationPlan {
  if (input.channel !== 'stable' && input.clients.length > 0) {
    throw new Error('Staging cannot write global client integrations; select no clients.');
  }
  const homeDir = input.homeDir ?? homedir();
  const coworkMode = CoworkModeSchema.parse(input.coworkMode ?? 'unknown');
  const clients = input.clients.map((client) => capabilityForClient(
    client,
    coworkMode,
    input.runningInWsl,
  ));
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
          client: 'codex', kind: 'plugin', path: codexPluginPath(homeDir),
          description: 'Install the checksum-verified Answer Engine plugin for Codex.',
        });
        addOperation(operations, {
          client: 'codex', kind: 'plugin-command', path: codexPluginRegistryPath(homeDir),
          description: 'Ask Codex to install the registered personal plugin and update its user registry/cache.',
        });
        break;
      case 'chatgpt-desktop':
        addOperation(operations, {
          client: 'chatgpt-desktop', kind: 'marketplace',
          path: join(homeDir, '.agents', 'plugins', 'marketplace.json'),
          description: 'Register the Answer Engine plugin in the shared Personal marketplace.',
        });
        addOperation(operations, {
          client: 'chatgpt-desktop', kind: 'plugin', path: codexPluginPath(homeDir),
          description: 'Install the checksum-verified Answer Engine plugin source for ChatGPT Desktop.',
        });
        break;
      case 'claude-code':
        addOperation(operations, {
          client: 'claude-code', kind: 'plugin', path: claudeMarketplacePath(input.aeHome),
          description: 'Create a checksum-verified local Answer Engine marketplace and plugin for Claude Code.',
        });
        addOperation(operations, {
          client: 'claude-code', kind: 'marketplace-command',
          path: claudeMarketplaceRegistryPath(homeDir),
          description: `Register ${claudeMarketplacePath(input.aeHome)} with Claude Code at user scope.`,
        });
        addOperation(operations, {
          client: 'claude-code', kind: 'plugin-command', path: claudePluginRegistryPath(homeDir),
          description: 'Install the Answer Engine plugin in Claude Code at user scope and update its cache.',
        });
        break;
      case 'claude-cowork':
        break;
      case 'claude-desktop':
      case 'cursor':
        addOperation(operations, {
          client: capability.id, kind: 'mcp-config',
          path: resolveClientConfigPath(capability.id, { homeDir, platform: input.platform }),
          description: `Merge the Answer Engine stdio MCP entry into ${capability.label} config.`,
        });
        break;
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

export function integrationLedgerIsCurrent(aeHome: string): boolean {
  const path = ledgerPath(aeHome);
  if (!existsSync(path)) return true;
  try {
    const ledger = readIntegrationLedger(aeHome);
    return ledger.entries.every((entry) => {
      // Host plugin registries live outside installer-managed files. Re-enter
      // the idempotent apply-and-verify flow instead of treating their ledger
      // receipt as proof that the plugin is still registered.
      if (entry.kind === 'plugin-command' || entry.kind === 'marketplace-command') return false;
      return existsSync(entry.path) && sha256Path(entry.path) === entry.afterSha256;
    });
  } catch {
    return false;
  }
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

export function resolveDockerExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = platform === 'win32' ? 'docker.exe' : 'docker';
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  if (platform === 'darwin') {
    const applicationCli = '/Applications/Docker.app/Contents/Resources/bin/docker';
    if (existsSync(applicationCli)) return applicationCli;
  }
  throw new Error('Docker executable path could not be resolved for client MCP configuration.');
}

function managedMcpEntry(aeHome: string, dockerCommand: string, client: AgentClientId): McpStdioEntry {
  return {
    command: dockerCommand,
    args: [
      'compose',
      '--project-directory', aeHome,
      '--env-file', join(aeHome, '.env.compose'),
      '--file', join(aeHome, 'docker-compose.yml'),
      'exec', '-T',
      '-e', 'ANSWER_ENGINE_API_URL=http://127.0.0.1:5000',
      '-e', `ANSWER_ENGINE_CLIENT_ID=${client}`,
      '-e', `ANSWER_ENGINE_LIBRARY=${LOCAL_LIBRARY_ID}`,
      'api', 'node', '/app/packages/mcp-server/dist/index.js',
    ],
    env: {},
  };
}

export interface MigrateLegacyMcpCredentialsInput {
  aeHome: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  clients: readonly FileWiringClient[];
  dockerCommand?: string;
}

export function migrateLegacyMcpCredentials(
  input: MigrateLegacyMcpCredentialsInput,
): WiringResult[] {
  const dockerCommand = input.dockerCommand ?? resolveDockerExecutable();
  return input.clients.map((client) => wireClient({
    client,
    apiKey: '',
    serverUrl: 'http://127.0.0.1:5050',
    library: LOCAL_LIBRARY_ID,
    mcpEntry: managedMcpEntry(input.aeHome, dockerCommand, client),
  }, {
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
  }));
}

function configurePluginMcp(path: string, entry: McpStdioEntry): void {
  const mcpPath = join(path, '.mcp.json');
  const mcp = objectValue(JSON.parse(readFileSync(mcpPath, 'utf8')), 'Answer Engine plugin MCP config');
  const servers = objectValue(mcp.mcpServers, 'Answer Engine plugin MCP servers');
  const configured = {
    ...mcp,
    mcpServers: { ...servers, 'answer-engine': entry },
  };
  writePrivateFileAtomic(mcpPath, `${JSON.stringify(configured, null, 2)}\n`, 'Installed Answer Engine plugin MCP config');
  const codexManifestPath = join(path, '.codex-plugin', 'plugin.json');
  const codexManifest = objectValue(
    JSON.parse(readFileSync(codexManifestPath, 'utf8')),
    'Answer Engine Codex plugin manifest',
  );
  writePrivateFileAtomic(
    codexManifestPath,
    `${JSON.stringify({ ...codexManifest, mcpServers: { 'answer-engine': entry } }, null, 2)}\n`,
    'Installed Answer Engine Codex plugin manifest',
  );
}

function installPlugin(path: string, templateDir: string, mcpEntry: McpStdioEntry): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  cpSync(templateDir, path, { recursive: true, errorOnExist: true });
  configurePluginMcp(path, mcpEntry);
  secureTree(path);
}

function installClaudeMarketplace(path: string, templateDir: string, mcpEntry: McpStdioEntry): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  const plugin = join(path, 'plugins', 'answer-engine');
  mkdirSync(dirname(plugin), { recursive: true, mode: 0o700 });
  cpSync(templateDir, plugin, { recursive: true, errorOnExist: true });
  configurePluginMcp(plugin, mcpEntry);
  const marketplacePath = join(path, '.claude-plugin', 'marketplace.json');
  mkdirSync(dirname(marketplacePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(marketplacePath, `${JSON.stringify({
    name: 'answer-engine',
    owner: { name: 'Answer Engine contributors' },
    plugins: [{
      name: 'answer-engine',
      source: './plugins/answer-engine',
      description: 'Local-first memory for Claude work.',
    }],
  }, null, 2)}\n`, 'Claude plugin marketplace');
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
  dockerCommand?: string;
}

function commandAlreadyApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already installed|already added|already exists/i.test(message);
}

async function applyCommandOperation(
  operation: IntegrationOperation,
  command: CommandRunner,
  claudeMarketplace: string,
  codexPluginSelector = 'answer-engine@personal',
): Promise<void> {
  try {
    if (operation.kind === 'marketplace-command') {
      await command('claude', ['plugin', 'marketplace', 'add', claudeMarketplace, '--scope', 'user']);
    } else if (operation.client === 'claude-code') {
      await command('claude', ['plugin', 'install', 'answer-engine@answer-engine', '--scope', 'user']);
    } else {
      await command('codex', ['plugin', 'add', codexPluginSelector, '--json']);
    }
  } catch (error) {
    if (!commandAlreadyApplied(error)) throw error;
  }
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
  const dockerCommand = options.dockerCommand ?? resolveDockerExecutable();
  let ledger = readLedgerIfPresent(plan);
  let changed = 0;

  for (const operation of plan.operations) {
    const prior = ledger.entries.find((entry) => entry.kind === operation.kind && entry.path === operation.path);
    if (prior) {
      if (operation.kind === 'plugin-command' || operation.kind === 'marketplace-command') {
        await applyCommandOperation(
          operation,
          command,
          claudeMarketplacePath(plan.aeHome),
          prior.selector,
        );
        continue;
      }
      if (existsSync(operation.path) && sha256Path(operation.path) === prior.afterSha256) continue;
      throw new Error(`Managed integration drift detected at ${operation.path}; remove or reconcile it before retrying.`);
    }
    if (operation.kind === 'plugin-command' || operation.kind === 'marketplace-command') {
      const selector = operation.client === 'codex'
        ? `answer-engine@${MarketplaceSchema.parse(JSON.parse(readFileSync(
          join(plan.homeDir, '.agents', 'plugins', 'marketplace.json'),
          'utf8',
        ))).name}`
        : undefined;
      const created = !existsSync(operation.path);
      const beforeSha256 = created ? undefined : sha256Path(operation.path);
      const backupPath = backupManagedPath(plan.aeHome, operation.path);
      await applyCommandOperation(operation, command, claudeMarketplacePath(plan.aeHome), selector);
      ledger.entries.push({
        client: operation.client, kind: operation.kind, path: operation.path, created,
        ...(selector ? { selector } : {}),
        ...(beforeSha256 ? { beforeSha256 } : {}),
        afterSha256: existsSync(operation.path)
          ? sha256Path(operation.path)
          : sha256Bytes(`${operation.kind}:${operation.path}`),
        ...(backupPath ? { backupPath } : {}),
      });
      writeLedger(ledger);
      changed += 1;
      continue;
    }

    const created = !existsSync(operation.path);
    const beforeSha256 = created ? undefined : sha256Path(operation.path);
    const backupPath = backupManagedPath(plan.aeHome, operation.path);
    const mcpEntry = managedMcpEntry(plan.aeHome, dockerCommand, operation.client);
    switch (operation.kind) {
      case 'mcp-config':
        wireClient({
          client: fileClientFor(operation.client), apiKey: secret.apiKey,
          serverUrl: secret.apiUrl, library: LOCAL_LIBRARY_ID, mcpEntry,
        }, { path: operation.path, backup: false });
        break;
      case 'plugin':
        if (operation.client === 'claude-code') {
          installClaudeMarketplace(operation.path, templateDir, mcpEntry);
        } else {
          installPlugin(operation.path, templateDir, mcpEntry);
        }
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

function restoreMcpOwnedEntry(
  client: AgentClientId,
  path: string,
  backupPath?: string,
): void {
  if (!backupPath || !existsSync(backupPath)) {
    unwireClient(fileClientFor(client), { path, backup: false });
    return;
  }
  const current = readFileSync(path, 'utf8');
  const original = readFileSync(backupPath, 'utf8');
  const restored = client === 'codex'
    ? restoreCodexToml(current, original)
    : restoreJsonClientConfig(current, original);
  writePrivateFileAtomic(path, restored, 'Client MCP config');
}

export interface RemoveIntegrationOptions { runCommand?: CommandRunner }

function commandAlreadyRemoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not installed|not found|unknown marketplace|no marketplace/i.test(message);
}

async function runIdempotentRemoval(
  command: CommandRunner,
  executable: string,
  args: string[],
): Promise<void> {
  try {
    await command(executable, args);
  } catch (error) {
    if (!commandAlreadyRemoved(error)) throw error;
  }
}

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
      if (entry.client === 'claude-code') {
        await runIdempotentRemoval(command, 'claude', [
          'plugin', 'uninstall', 'answer-engine@answer-engine', '--scope', 'user',
        ]);
      } else {
        await runIdempotentRemoval(command, 'codex', [
          'plugin', 'remove', entry.selector ?? 'answer-engine@personal', '--json',
        ]);
      }
      removed.push(entry.path);
      continue;
    }
    if (entry.kind === 'marketplace-command') {
      await runIdempotentRemoval(command, 'claude', [
        'plugin', 'marketplace', 'remove', 'answer-engine', '--scope', 'user',
      ]);
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
        restoreMcpOwnedEntry(entry.client, entry.path, entry.backupPath);
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
