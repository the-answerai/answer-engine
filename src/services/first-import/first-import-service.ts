import type { PoolClient } from 'pg';
import type { Database } from '../../config/database.js';
import type { Principal } from '../../types/api.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import {
  assertFirstImportTransition,
  reconcileFirstImportCounts,
  type FirstImportApproval,
  type FirstImportDiscovery,
  type FirstImportEvent,
  type FirstImportStatus,
} from './first-import-schemas.js';

interface SessionRow {
  id: string;
  status: FirstImportStatus;
  manifest_path: string;
  selected_source_ids: string[];
  approved_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SourceRow {
  source_id: 'claude-code' | 'codex' | 'cowork';
  label: string;
  paths: string[];
  estimated_count: number;
  estimated_bytes: string | number;
  privacy_posture: string;
  exclusions: string[];
  availability: 'available' | 'not_found' | 'unsupported_platform' | 'unavailable';
  availability_note: string;
  status: string;
  error_code: string | null;
  recovery_action: string | null;
}

interface ItemRow {
  source_id: 'claude-code' | 'codex' | 'cowork';
  fingerprint: string;
  source_path: string;
  byte_size: string | number;
  modified_at: Date | string;
  outcome: 'pending' | 'imported' | 'duplicate' | 'failed' | 'skipped';
  content_ids: string[];
  archive_manifest_path: string | null;
  error_code: string | null;
  recovery_action: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class FirstImportService {
  constructor(private readonly database: Database) {}

  private async audit(
    principal: Principal,
    action: string,
    sessionId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_log (
         tenant_id,api_key_id,action,resource_type,resource_id,details
       ) VALUES ($1,$2,$3,'first_import',$4,$5)`,
      [principal.tenantId, principal.apiKeyId, action, sessionId, details],
    );
  }

  async registerDiscovery(principal: Principal, discovery: FirstImportDiscovery) {
    const client = await this.database.connect();
    let sessionId: string;
    try {
      await client.query('BEGIN');
      const session = await client.query<{ id: string }>(
        `INSERT INTO first_import_sessions (tenant_id,manifest_path)
         VALUES ($1,$2) RETURNING id`,
        [principal.tenantId, discovery.manifestPath],
      );
      sessionId = session.rows[0]?.id ?? '';
      if (!sessionId) throw new Error('First import registration returned no session ID');
      for (const source of discovery.sources) {
        await client.query(
          `INSERT INTO first_import_sources (
             tenant_id,session_id,source_id,label,paths,estimated_count,estimated_bytes,
             privacy_posture,exclusions,availability,availability_note
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            principal.tenantId, sessionId, source.sourceId, source.label, JSON.stringify(source.paths),
            source.estimatedCount, source.estimatedBytes, source.privacyPosture, JSON.stringify(source.exclusions),
            source.availability, source.availabilityNote,
          ],
        );
        if (source.items.length > 0) {
          await client.query(
            `INSERT INTO first_import_items (
               tenant_id,session_id,source_id,fingerprint,source_path,byte_size,modified_at
             )
             SELECT $1,$2,$3,item.fingerprint,item.source_path,item.byte_size,item.modified_at
             FROM UNNEST($4::text[],$5::text[],$6::bigint[],$7::timestamptz[])
               AS item(fingerprint,source_path,byte_size,modified_at)`,
            [
              principal.tenantId, sessionId, source.sourceId,
              source.items.map((item) => item.fingerprint),
              source.items.map((item) => item.sourcePath),
              source.items.map((item) => item.byteSize),
              source.items.map((item) => item.modifiedAt),
            ],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.audit(principal, 'first_import.discover', sessionId, {
      sourceIds: discovery.sources.map((source) => source.sourceId),
      discovered: discovery.sources.reduce((total, source) => total + source.items.length, 0),
    });
    return this.get(principal, sessionId);
  }

  async latest(principal: Principal) {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM first_import_sessions
       WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [principal.tenantId],
    );
    return result.rows[0] ? this.get(principal, result.rows[0].id) : null;
  }

  async get(principal: Principal, sessionId: string) {
    const [sessionResult, sourceResult, itemResult] = await Promise.all([
      this.database.query<SessionRow>(
        `SELECT id,status,manifest_path,selected_source_ids,approved_at,started_at,
                completed_at,created_at,updated_at
         FROM first_import_sessions WHERE tenant_id=$1 AND id=$2`,
        [principal.tenantId, sessionId],
      ),
      this.database.query<SourceRow>(
        `SELECT source_id,label,paths,estimated_count,estimated_bytes,privacy_posture,
                exclusions,availability,availability_note,status,error_code,recovery_action
         FROM first_import_sources WHERE tenant_id=$1 AND session_id=$2 ORDER BY source_id`,
        [principal.tenantId, sessionId],
      ),
      this.database.query<ItemRow>(
        `SELECT source_id,fingerprint,source_path,byte_size,modified_at,outcome,content_ids,
                archive_manifest_path,error_code,recovery_action
         FROM first_import_items
         WHERE tenant_id=$1 AND session_id=$2 ORDER BY source_id,source_path`,
        [principal.tenantId, sessionId],
      ),
    ]);
    const session = sessionResult.rows[0];
    if (!session) throw new NotFoundError('First import session not found');
    const counts = itemResult.rows.reduce((value, item) => {
      if (item.outcome !== 'pending') value[item.outcome] += 1;
      return value;
    }, { imported: 0, duplicate: 0, failed: 0, skipped: 0 });
    return {
      id: session.id,
      status: session.status,
      manifestPath: session.manifest_path,
      selectedSourceIds: session.selected_source_ids,
      approvedAt: iso(session.approved_at),
      startedAt: iso(session.started_at),
      completedAt: iso(session.completed_at),
      createdAt: iso(session.created_at),
      updatedAt: iso(session.updated_at),
      counts: { ...reconcileFirstImportCounts(counts), discovered: itemResult.rows.length },
      pending: itemResult.rows.filter((item) => item.outcome === 'pending').length,
      sources: sourceResult.rows.map((source) => ({
        sourceId: source.source_id,
        label: source.label,
        paths: source.paths,
        estimatedCount: source.estimated_count,
        estimatedBytes: Number(source.estimated_bytes),
        privacyPosture: source.privacy_posture,
        exclusions: source.exclusions,
        availability: source.availability,
        availabilityNote: source.availability_note,
        status: source.status,
        errorCode: source.error_code,
        recoveryAction: source.recovery_action,
      })),
      items: itemResult.rows.map((item) => ({
        sourceId: item.source_id,
        fingerprint: item.fingerprint,
        sourcePath: item.source_path,
        byteSize: Number(item.byte_size),
        modifiedAt: iso(item.modified_at),
        outcome: item.outcome,
        contentIds: item.content_ids,
        archiveManifestPath: item.archive_manifest_path,
        errorCode: item.error_code,
        recoveryAction: item.recovery_action,
      })),
    };
  }

  private async lockedSession(client: PoolClient, tenantId: string, sessionId: string): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      `SELECT id,status,manifest_path,selected_source_ids,approved_at,started_at,
              completed_at,created_at,updated_at
       FROM first_import_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, sessionId],
    );
    if (!result.rows[0]) throw new NotFoundError('First import session not found');
    return result.rows[0];
  }

  async approve(principal: Principal, sessionId: string, approval: FirstImportApproval) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const session = await this.lockedSession(client, principal.tenantId, sessionId);
      assertFirstImportTransition(session.status, 'approved');
      const discovered = await client.query<{ source_id: string; availability: string }>(
        `SELECT source_id,availability FROM first_import_sources WHERE tenant_id=$1 AND session_id=$2`,
        [principal.tenantId, sessionId],
      );
      const available = new Set(discovered.rows
        .filter((row) => row.availability === 'available')
        .map((row) => row.source_id));
      if (approval.sourceIds.some((sourceId) => !available.has(sourceId))) {
        throw new ConflictError('Approval includes a source that was not discovered');
      }
      await client.query(
        `UPDATE first_import_sessions
         SET status='approved',selected_source_ids=$3,approved_at=NOW(),completed_at=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [principal.tenantId, sessionId, approval.sourceIds],
      );
      await client.query(
        `UPDATE first_import_sources SET status=CASE WHEN source_id=ANY($3::text[]) THEN 'approved' ELSE 'skipped' END,
                error_code=NULL,recovery_action=NULL
         WHERE tenant_id=$1 AND session_id=$2`,
        [principal.tenantId, sessionId, approval.sourceIds],
      );
      await client.query(
        `UPDATE first_import_items SET outcome='skipped',completed_at=NOW()
         WHERE tenant_id=$1 AND session_id=$2 AND NOT (source_id=ANY($3::text[]))`,
        [principal.tenantId, sessionId, approval.sourceIds],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof Error && error.message.startsWith('Cannot move first import')) {
        throw new ConflictError(error.message);
      }
      throw error;
    } finally { client.release(); }
    await this.audit(principal, 'first_import.approve', sessionId, { sourceIds: approval.sourceIds });
    return this.get(principal, sessionId);
  }

  async start(principal: Principal, sessionId: string) {
    const current = await this.get(principal, sessionId);
    if (current.status === 'running') return current;
    try { assertFirstImportTransition(current.status, 'running'); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    const started = await this.database.query(
      `UPDATE first_import_sessions SET status='running',started_at=COALESCE(started_at,NOW())
       WHERE tenant_id=$1 AND id=$2 AND status='approved' AND approved_at IS NOT NULL`,
      [principal.tenantId, sessionId],
    );
    if ((started.rowCount ?? 0) === 0) {
      const latest = await this.get(principal, sessionId);
      if (latest.status === 'running') return latest;
      throw new ConflictError(`Cannot start first import from ${latest.status}`);
    }
    await this.database.query(
      `UPDATE first_import_sources SET status='running'
       WHERE tenant_id=$1 AND session_id=$2 AND source_id=ANY($3::text[]) AND status='approved'`,
      [principal.tenantId, sessionId, current.selectedSourceIds],
    );
    await this.audit(principal, 'first_import.start', sessionId);
    return this.get(principal, sessionId);
  }

  async recordEvent(principal: Principal, sessionId: string, event: FirstImportEvent) {
    const current = await this.get(principal, sessionId);
    if (!current.approvedAt || !['running', 'cancel_requested'].includes(current.status)) {
      throw new ConflictError('First import progress is rejected until the selected sources are approved and running');
    }
    if (!current.selectedSourceIds.includes(event.sourceId)) {
      throw new ConflictError('First import progress is rejected for an unapproved source');
    }
    if (event.outcome === 'imported') {
      const integrity = await this.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM content_items
         WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND content_type='chat'
           AND NULLIF(BTRIM(summary),'') IS NOT NULL
           AND raw_archive_manifest->>'manifest_path'=$3`,
        [principal.tenantId, event.contentIds, event.archiveManifestPath],
      );
      if (Number(integrity.rows[0]?.count ?? 0) !== event.contentIds?.length) {
        throw new ConflictError('Imported histories do not have matching summary and raw-manifest integrity');
      }
    }
    const updated = await this.database.query(
      `UPDATE first_import_items SET outcome=$5,content_ids=$6,archive_manifest_path=$7,
              error_code=$8,recovery_action=$9,completed_at=NOW()
       WHERE tenant_id=$1 AND session_id=$2 AND source_id=$3 AND fingerprint=$4
         AND outcome IN ('pending','failed')`,
      [
        principal.tenantId, sessionId, event.sourceId, event.fingerprint, event.outcome,
        event.contentIds ?? [], event.archiveManifestPath ?? null,
        event.errorCode ?? null, event.recoveryAction ?? null,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const existing = current.items.find((item) => item.sourceId === event.sourceId && item.fingerprint === event.fingerprint);
      if (!existing) throw new NotFoundError('Discovered first import item not found');
      if (existing.outcome !== event.outcome) {
        throw new ConflictError(`First import item is already reconciled as ${existing.outcome}`);
      }
    }
    await this.database.query(
      `UPDATE first_import_sources SET error_code=$4,recovery_action=$5,
              status=CASE WHEN $3='failed' THEN 'failed' ELSE status END
       WHERE tenant_id=$1 AND session_id=$2 AND source_id=$6`,
      [principal.tenantId, sessionId, event.outcome, event.errorCode ?? null, event.recoveryAction ?? null, event.sourceId],
    );
    await this.audit(principal, 'first_import.progress', sessionId, {
      sourceId: event.sourceId, fingerprint: event.fingerprint, outcome: event.outcome,
    });
    return this.get(principal, sessionId);
  }

  async cancel(principal: Principal, sessionId: string) {
    const current = await this.get(principal, sessionId);
    const next: FirstImportStatus = current.status === 'running' ? 'cancel_requested' : 'canceled';
    try { assertFirstImportTransition(current.status, next); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    await this.database.query(
      `UPDATE first_import_sessions SET status=$3,completed_at=CASE WHEN $3='canceled' THEN NOW() ELSE completed_at END
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sessionId, next],
    );
    if (next === 'canceled') await this.finishCancellation(principal, sessionId);
    await this.audit(principal, 'first_import.cancel', sessionId, { status: next });
    return this.get(principal, sessionId);
  }

  private async finishCancellation(principal: Principal, sessionId: string): Promise<void> {
    await this.database.query(
      `UPDATE first_import_items SET outcome='skipped',completed_at=NOW()
       WHERE tenant_id=$1 AND session_id=$2 AND outcome='pending'`,
      [principal.tenantId, sessionId],
    );
    await this.database.query(
      `UPDATE first_import_sources SET status='canceled'
       WHERE tenant_id=$1 AND session_id=$2 AND status IN ('approved','running')`,
      [principal.tenantId, sessionId],
    );
  }

  async retry(principal: Principal, sessionId: string) {
    const current = await this.get(principal, sessionId);
    if (!current.approvedAt || current.selectedSourceIds.length === 0) {
      throw new ConflictError('First import must be approved before failed or canceled items can be retried');
    }
    try { assertFirstImportTransition(current.status, 'approved'); }
    catch (error) { throw new ConflictError(error instanceof Error ? error.message : String(error)); }
    await this.database.query(
      `UPDATE first_import_sessions SET status='approved',completed_at=NULL
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sessionId],
    );
    await this.database.query(
      `UPDATE first_import_items SET outcome='pending',content_ids='{}',archive_manifest_path=NULL,
              error_code=NULL,recovery_action=NULL,completed_at=NULL
       WHERE tenant_id=$1 AND session_id=$2 AND source_id=ANY($3::text[])
         AND outcome IN ('failed','skipped')`,
      [principal.tenantId, sessionId, current.selectedSourceIds],
    );
    await this.database.query(
      `UPDATE first_import_sources SET status='approved',error_code=NULL,recovery_action=NULL
       WHERE tenant_id=$1 AND session_id=$2 AND source_id=ANY($3::text[])`,
      [principal.tenantId, sessionId, current.selectedSourceIds],
    );
    await this.audit(principal, 'first_import.retry', sessionId);
    return this.get(principal, sessionId);
  }

  async complete(principal: Principal, sessionId: string) {
    const current = await this.get(principal, sessionId);
    if (!['running', 'cancel_requested'].includes(current.status)) {
      throw new ConflictError(`Cannot complete first import from ${current.status}`);
    }
    if (current.pending > 0) {
      throw new ConflictError('First import cannot complete until every discovered item is reconciled');
    }
    const next: FirstImportStatus = current.status === 'cancel_requested'
      ? 'canceled'
      : current.counts.failed > 0 ? 'failed' : 'completed';
    await this.database.query(
      `UPDATE first_import_sessions SET status=$3,completed_at=NOW()
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, sessionId, next],
    );
    await this.database.query(
      `UPDATE first_import_sources source SET status=CASE
         WHEN source.status='skipped' THEN 'skipped'
         WHEN EXISTS (SELECT 1 FROM first_import_items item
                      WHERE item.tenant_id=source.tenant_id AND item.session_id=source.session_id
                        AND item.source_id=source.source_id AND item.outcome='failed') THEN 'failed'
         WHEN $3='canceled' THEN 'canceled' ELSE 'completed' END
       WHERE source.tenant_id=$1 AND source.session_id=$2`,
      [principal.tenantId, sessionId, next],
    );
    await this.audit(principal, 'first_import.complete', sessionId, { status: next, counts: current.counts });
    return this.get(principal, sessionId);
  }
}
