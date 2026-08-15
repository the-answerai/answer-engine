import type { PoolClient } from 'pg';
import type { Database } from '../../config/database.js';
import type { Principal } from '../../types/api.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import {
  assertFolderRunTransition,
  reconcileFolderInventory,
  type FolderIngestionEvent,
  type FolderRefreshDiscovery,
  type FolderRemoval,
  type FolderRemovalComplete,
  type FolderRunStatus,
  type FolderSourceDiscovery,
} from './folder-ingestion-schemas.js';

interface SourceRow {
  id: string; library_id: string | null; root_path: string; include_patterns: string[];
  exclude_patterns: string[]; max_file_bytes: string | number; max_total_bytes: string | number;
  symlink_policy: 'no_follow'; manifest_path: string; status: string; retention: 'keep' | 'delete' | null;
  approved_at: Date | string | null; removed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
}
interface RunRow {
  id: string; source_id: string; kind: 'initial' | 'refresh' | 'removal'; status: FolderRunStatus;
  manifest_path: string; inventory_counts: Record<string, number>; approved_at: Date | string | null;
  started_at: Date | string | null; completed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
}
interface ItemRow {
  source_path: string; relative_path: string; file_type: string | null; byte_size: string | number;
  modified_at: Date | string | null; disposition: string; reason: string; change_kind: string | null; metadata_fingerprint: string | null;
  outcome: 'pending' | 'imported' | 'updated' | 'duplicate' | 'excluded' | 'changed' | 'failed' | 'skipped' | 'missing';
  applied_sha256: string | null; content_id: string | null; archive_manifest_path: string | null;
  error_code: string | null; recovery_action: string | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function initialOutcome(disposition: string): ItemRow['outcome'] {
  if (disposition === 'candidate') return 'pending';
  if (disposition === 'missing') return 'missing';
  return 'excluded';
}

export class FolderIngestionService {
  constructor(private readonly database: Database) {}

  private async audit(
    principal: Principal,
    action: string,
    sourceId: string,
    details: Record<string, unknown> = {},
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_log (
         tenant_id,library_id,api_key_id,action,resource_type,resource_id,outcome,details
       ) VALUES ($1,$2,$3,$4,'folder_source',$5,$6,$7)`,
      [principal.tenantId, principal.libraryId ?? null, principal.apiKeyId, action, sourceId, outcome, details],
    );
  }

  private async insertInventory(
    client: PoolClient,
    tenantId: string,
    sourceId: string,
    runId: string,
    inventory: FolderSourceDiscovery['inventory'],
  ): Promise<void> {
    for (const item of inventory) {
      await client.query(
        `INSERT INTO folder_ingestion_items (
           tenant_id,run_id,source_id,source_path,relative_path,file_type,byte_size,modified_at,
           disposition,reason,change_kind,metadata_fingerprint,outcome,completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           CASE WHEN $13='pending' THEN NULL ELSE NOW() END)`,
        [tenantId, runId, sourceId, item.sourcePath, item.relativePath, item.fileType ?? null,
          item.byteSize, item.modifiedAt ?? null, item.disposition, item.reason, item.change ?? null,
          item.metadataFingerprint ?? null, initialOutcome(item.disposition)],
      );
    }
  }

  async register(principal: Principal, discovery: FolderSourceDiscovery) {
    const client = await this.database.connect();
    let sourceId = '';
    let runId = '';
    try {
      await client.query('BEGIN');
      const source = await client.query<{ id: string }>(
        `INSERT INTO folder_sources (
           tenant_id,library_id,root_path,include_patterns,exclude_patterns,max_file_bytes,
           max_total_bytes,symlink_policy,manifest_path
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [principal.tenantId, discovery.libraryId ?? principal.libraryId ?? null, discovery.rootPath,
          discovery.includePatterns, discovery.excludePatterns, discovery.maxFileBytes,
          discovery.maxTotalBytes, discovery.symlinkPolicy, discovery.manifestPath],
      );
      sourceId = source.rows[0]?.id ?? '';
      if (!sourceId) throw new Error('Folder registration returned no source ID');
      const run = await client.query<{ id: string }>(
        `INSERT INTO folder_ingestion_runs (tenant_id,source_id,kind,manifest_path,inventory_counts)
         VALUES ($1,$2,'initial',$3,$4) RETURNING id`,
        [principal.tenantId, sourceId, discovery.manifestPath, this.previewCounts(discovery.inventory)],
      );
      runId = run.rows[0]?.id ?? '';
      if (!runId) throw new Error('Folder registration returned no run ID');
      await this.insertInventory(client, principal.tenantId, sourceId, runId, discovery.inventory);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await this.audit(principal, 'folder.preview', sourceId, { runId, counts: this.previewCounts(discovery.inventory) });
    return this.get(principal, sourceId);
  }

  private previewCounts(inventory: FolderSourceDiscovery['inventory']): Record<string, number> {
    const counts: Record<string, number> = { total: inventory.length, bytes: 0 };
    for (const item of inventory) {
      counts[item.disposition] = (counts[item.disposition] ?? 0) + 1;
      if (item.disposition === 'candidate') counts.bytes = (counts.bytes ?? 0) + item.byteSize;
      if (item.change) counts[item.change] = (counts[item.change] ?? 0) + 1;
    }
    return counts;
  }

  async list(principal: Principal) {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM folder_sources WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC`,
      [principal.tenantId],
    );
    return Promise.all(result.rows.map((row) => this.get(principal, row.id)));
  }

  async latest(principal: Principal) {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM folder_sources WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [principal.tenantId],
    );
    return result.rows[0] ? this.get(principal, result.rows[0].id) : null;
  }

  async get(principal: Principal, sourceId: string) {
    const sourceResult = await this.database.query<SourceRow>(
      `SELECT id,library_id,root_path,include_patterns,exclude_patterns,max_file_bytes,max_total_bytes,
              symlink_policy,manifest_path,status,retention,approved_at,removed_at,created_at,updated_at
       FROM folder_sources WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sourceId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new NotFoundError('Folder source not found');
    const runResult = await this.database.query<RunRow>(
      `SELECT id,source_id,kind,status,manifest_path,inventory_counts,approved_at,started_at,
              completed_at,created_at,updated_at
       FROM folder_ingestion_runs WHERE tenant_id=$1 AND source_id=$2
       ORDER BY created_at DESC,id DESC`,
      [principal.tenantId, sourceId],
    );
    const runs = [];
    for (const run of runResult.rows) runs.push(await this.hydrateRun(principal.tenantId, run));
    return {
      id: source.id, libraryId: source.library_id, rootPath: source.root_path,
      includePatterns: source.include_patterns, excludePatterns: source.exclude_patterns,
      maxFileBytes: Number(source.max_file_bytes), maxTotalBytes: Number(source.max_total_bytes),
      symlinkPolicy: source.symlink_policy, manifestPath: source.manifest_path,
      status: source.status, retention: source.retention, approvedAt: iso(source.approved_at),
      removedAt: iso(source.removed_at), createdAt: iso(source.created_at), updatedAt: iso(source.updated_at),
      runs, latestRun: runs[0] ?? null,
    };
  }

  private async hydrateRun(tenantId: string, run: RunRow) {
    const result = await this.database.query<ItemRow>(
      `SELECT source_path,relative_path,file_type,byte_size,modified_at,disposition,reason,
              change_kind,metadata_fingerprint,outcome,applied_sha256,content_id,archive_manifest_path,
              error_code,recovery_action
       FROM folder_ingestion_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY relative_path`,
      [tenantId, run.id],
    );
    const items = result.rows.map((item) => ({
      sourcePath: item.source_path, relativePath: item.relative_path, fileType: item.file_type,
      byteSize: Number(item.byte_size), modifiedAt: iso(item.modified_at), disposition: item.disposition,
      reason: item.reason, change: item.change_kind, metadataFingerprint: item.metadata_fingerprint, outcome: item.outcome,
      appliedSha256: item.applied_sha256, contentId: item.content_id,
      archiveManifestPath: item.archive_manifest_path, errorCode: item.error_code,
      recoveryAction: item.recovery_action,
    }));
    return {
      id: run.id, sourceId: run.source_id, kind: run.kind, status: run.status,
      manifestPath: run.manifest_path, inventoryCounts: run.inventory_counts,
      approvedAt: iso(run.approved_at), startedAt: iso(run.started_at), completedAt: iso(run.completed_at),
      createdAt: iso(run.created_at), updatedAt: iso(run.updated_at),
      counts: reconcileFolderInventory(items), items,
    };
  }

  private async lockedRun(client: PoolClient, tenantId: string, runId: string): Promise<RunRow> {
    const result = await client.query<RunRow>(
      `SELECT id,source_id,kind,status,manifest_path,inventory_counts,approved_at,started_at,
              completed_at,created_at,updated_at
       FROM folder_ingestion_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, runId],
    );
    if (!result.rows[0]) throw new NotFoundError('Folder ingestion run not found');
    return result.rows[0];
  }

  async approve(principal: Principal, runId: string) {
    const client = await this.database.connect();
    let sourceId = '';
    try {
      await client.query('BEGIN');
      const run = await this.lockedRun(client, principal.tenantId, runId);
      sourceId = run.source_id;
      try { assertFolderRunTransition(run.status, 'approved'); }
      catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
      await client.query(
        `UPDATE folder_ingestion_runs SET status='approved',approved_at=NOW(),completed_at=NULL
         WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, runId],
      );
      await client.query(
        `UPDATE folder_sources SET status='approved',approved_at=COALESCE(approved_at,NOW())
         WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, sourceId],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await this.audit(principal, 'folder.approve', sourceId, { runId });
    return this.get(principal, sourceId);
  }

  async start(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    if (run.status === 'running') return this.get(principal, run.sourceId);
    try { assertFolderRunTransition(run.status, 'running'); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    const updated = await this.database.query(
      `UPDATE folder_ingestion_runs SET status='running',started_at=COALESCE(started_at,NOW())
       WHERE tenant_id=$1 AND id=$2 AND status='approved' AND approved_at IS NOT NULL`,
      [principal.tenantId, runId],
    );
    if ((updated.rowCount ?? 0) === 0) throw new ConflictError('Folder ingestion requires approval before content can be read');
    await this.audit(principal, 'folder.start', run.sourceId, { runId });
    return this.get(principal, run.sourceId);
  }

  private async getRun(principal: Principal, runId: string) {
    const result = await this.database.query<RunRow>(
      `SELECT id,source_id,kind,status,manifest_path,inventory_counts,approved_at,started_at,
              completed_at,created_at,updated_at
       FROM folder_ingestion_runs WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, runId],
    );
    if (!result.rows[0]) throw new NotFoundError('Folder ingestion run not found');
    return this.hydrateRun(principal.tenantId, result.rows[0]);
  }

  async recordEvent(principal: Principal, runId: string, event: FolderIngestionEvent) {
    const run = await this.getRun(principal, runId);
    if (!run.approvedAt || !['running', 'cancel_requested'].includes(run.status)) {
      throw new ConflictError('Folder progress is rejected until the inventory is approved and running');
    }
    if (['imported', 'updated'].includes(event.outcome)) {
      const integrity = await this.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM content_items
         WHERE tenant_id=$1 AND id=$2 AND content_type='document' AND source='local_dir'
           AND metadata->>'folderSourceId'=$3 AND metadata->>'sourcePath'=$4
           AND metadata->>'sourceSha256'=$5
           AND raw_archive_manifest->>'manifest_path'=$6`,
        [principal.tenantId, event.contentId, run.sourceId, event.relativePath,
          event.appliedSha256, event.archiveManifestPath],
      );
      if (Number(integrity.rows[0]?.count ?? 0) !== 1) {
        throw new ConflictError('Imported document does not have matching folder, path, SHA-256, and raw-manifest lineage');
      }
    }
    const updated = await this.database.query(
      `UPDATE folder_ingestion_items SET outcome=$4,applied_sha256=$5,content_id=$6,
              archive_manifest_path=$7,error_code=$8,recovery_action=$9,completed_at=NOW()
       WHERE tenant_id=$1 AND run_id=$2 AND relative_path=$3 AND outcome IN ('pending','failed')`,
      [principal.tenantId, runId, event.relativePath, event.outcome, event.appliedSha256 ?? null,
        event.contentId ?? null, event.archiveManifestPath ?? null, event.errorCode ?? null,
        event.recoveryAction ?? null],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const existing = run.items.find((item) => item.relativePath === event.relativePath);
      if (!existing) throw new NotFoundError('Previewed folder item not found');
      if (existing.outcome !== event.outcome) throw new ConflictError(`Folder item is already reconciled as ${existing.outcome}`);
    }
    await this.audit(principal, 'folder.progress', run.sourceId, { runId, relativePath: event.relativePath, outcome: event.outcome });
    return this.get(principal, run.sourceId);
  }

  async cancel(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    const next: FolderRunStatus = run.status === 'running' ? 'cancel_requested' : 'canceled';
    try { assertFolderRunTransition(run.status, next); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    await this.database.query(
      `UPDATE folder_ingestion_runs SET status=$3,completed_at=CASE WHEN $3='canceled' THEN NOW() ELSE completed_at END
       WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, runId, next],
    );
    if (next === 'canceled') await this.finishCancellation(principal.tenantId, runId);
    await this.audit(principal, 'folder.cancel', run.sourceId, { runId, status: next });
    return this.get(principal, run.sourceId);
  }

  private async finishCancellation(tenantId: string, runId: string): Promise<void> {
    await this.database.query(
      `UPDATE folder_ingestion_items SET outcome='skipped',completed_at=NOW()
       WHERE tenant_id=$1 AND run_id=$2 AND outcome='pending'`, [tenantId, runId],
    );
  }

  async retry(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    if (!run.approvedAt) throw new ConflictError('Folder ingestion must be approved before retry');
    try { assertFolderRunTransition(run.status, 'approved'); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    await this.database.query(
      `UPDATE folder_ingestion_runs SET status='approved',completed_at=NULL WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, runId],
    );
    await this.database.query(
      `UPDATE folder_ingestion_items SET outcome='pending',applied_sha256=NULL,content_id=NULL,
              archive_manifest_path=NULL,error_code=NULL,recovery_action=NULL,completed_at=NULL
       WHERE tenant_id=$1 AND run_id=$2 AND disposition='candidate' AND outcome IN ('failed','skipped','changed')`,
      [principal.tenantId, runId],
    );
    await this.audit(principal, 'folder.retry', run.sourceId, { runId });
    return this.get(principal, run.sourceId);
  }

  async complete(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    if (!['running', 'cancel_requested'].includes(run.status)) throw new ConflictError(`Cannot complete folder ingestion from ${run.status}`);
    if (run.counts.pending > 0) throw new ConflictError('Folder ingestion cannot complete until every preview item is reconciled');
    const next: FolderRunStatus = run.status === 'cancel_requested' ? 'canceled' : run.counts.failed > 0 ? 'failed' : 'completed';
    await this.database.query(
      `UPDATE folder_ingestion_runs SET status=$3,completed_at=NOW() WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, runId, next],
    );
    await this.database.query(
      `UPDATE folder_sources SET status=CASE WHEN $3='completed' THEN 'active' ELSE 'paused' END
       WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, run.sourceId, next],
    );
    await this.audit(principal, 'folder.complete', run.sourceId, { runId, status: next, counts: run.counts });
    return this.get(principal, run.sourceId);
  }

  async refresh(principal: Principal, sourceId: string, discovery: FolderRefreshDiscovery) {
    const source = await this.get(principal, sourceId);
    if (!source.approvedAt || source.status === 'removed') throw new ConflictError('Only an approved active folder source can be refreshed');
    const client = await this.database.connect();
    let runId = '';
    try {
      await client.query('BEGIN');
      const run = await client.query<{ id: string }>(
        `INSERT INTO folder_ingestion_runs (tenant_id,source_id,kind,manifest_path,inventory_counts)
         VALUES ($1,$2,'refresh',$3,$4) RETURNING id`,
        [principal.tenantId, sourceId, discovery.manifestPath, this.previewCounts(discovery.inventory)],
      );
      runId = run.rows[0]?.id ?? '';
      await this.insertInventory(client, principal.tenantId, sourceId, runId, discovery.inventory);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await this.audit(principal, 'folder.refresh_preview', sourceId, { runId, counts: this.previewCounts(discovery.inventory) });
    return this.get(principal, sourceId);
  }

  async prepareRemoval(principal: Principal, sourceId: string, removal: FolderRemoval) {
    const source = await this.get(principal, sourceId);
    if (source.status === 'removed') throw new ConflictError('Folder source is already removed');
    if (source.runs.some((run) => ['running', 'cancel_requested'].includes(run.status))) {
      throw new ConflictError('Cancel the active folder ingestion before removing its source');
    }
    await this.database.query(
      `UPDATE folder_sources SET status='removal_pending',retention=$3 WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sourceId, removal.retention],
    );
    await this.audit(principal, 'folder.remove_prepare', sourceId, removal);
    return this.get(principal, sourceId);
  }

  async completeRemoval(principal: Principal, sourceId: string, completion: FolderRemovalComplete) {
    const source = await this.get(principal, sourceId);
    if (source.status !== 'removal_pending' || source.retention !== completion.retention) {
      throw new ConflictError('Removal completion must match the prepared keep/delete retention choice');
    }
    if (completion.failures.length > 0) {
      await this.audit(principal, 'folder.remove_complete', sourceId, completion, 'failure');
      throw new ConflictError('Folder removal has unreconciled archive failures');
    }
    const mapped = new Set(source.runs.flatMap((run) => run.items.map((item) => item.contentId).filter(Boolean)) as string[]);
    const submitted = new Set(completion.deletedContentIds);
    if (completion.retention === 'delete'
      && (submitted.size !== mapped.size || [...submitted].some((id) => !mapped.has(id)))) {
      throw new ConflictError('Delete removal must reconcile every mapped folder document exactly');
    }
    if (completion.retention === 'keep' && submitted.size > 0) {
      throw new ConflictError('Keep removal cannot report deleted content');
    }
    if (completion.retention === 'delete' && mapped.size > 0) {
      const deleted = await this.database.query(
        `DELETE FROM content_items WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
        [principal.tenantId, [...mapped]],
      );
      if ((deleted.rowCount ?? 0) !== mapped.size) throw new ConflictError('Not every mapped folder document could be deleted');
    }
    await this.database.query(
      `UPDATE folder_sources SET status='removed',removed_at=NOW() WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sourceId],
    );
    await this.audit(principal, 'folder.remove_complete', sourceId, {
      retention: completion.retention, mappedContent: mapped.size,
      deletedContent: completion.retention === 'delete' ? mapped.size : 0,
      archivesRemoved: completion.archivesRemoved,
    });
    return this.get(principal, sourceId);
  }
}
