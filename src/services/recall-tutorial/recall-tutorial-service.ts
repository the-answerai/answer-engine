import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../config/database.js';
import type { Principal } from '../../types/api.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import {
  RecallTutorialCheckSchema,
  RecallTutorialCreateSchema,
  recallClientCapabilities,
  type RecallTutorialClient,
} from './recall-tutorial-schemas.js';

interface TutorialRow {
  id: string;
  status: 'planned' | 'remembered' | 'verified';
  write_client: RecallTutorialClient;
  recall_client: RecallTutorialClient;
  marker: string;
  fact: string;
  source_identifier: string;
  content_id: string | null;
  diagnostic_code: string;
  diagnostic_details: Record<string, unknown>;
  remembered_at: Date | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const IdSchema = z.string().uuid();

function capability(id: RecallTutorialClient, environment: 'native' | 'wsl' = 'native') {
  return recallClientCapabilities(environment).find((item) => item.id === id)!;
}

function instructions(row: TutorialRow) {
  const write = capability(row.write_client);
  const recall = capability(row.recall_client);
  return {
    remember: {
      client: row.write_client,
      text: `In ${write.label}, call Answer Engine remember with title "First memory proof", content "${row.fact}", source "recall-tutorial", and sourceIdentifier "${row.source_identifier}". Report the returned content ID.`,
    },
    freshChat: {
      client: row.recall_client,
      answerBearingContextIncluded: false,
      text: `Open a genuinely fresh chat in ${recall.label}. Call Answer Engine recall for the exact marker "${row.marker}" using fulltext search. Do not guess or use prior chat text. Then call inspect_memory on the returned content ID and report its source evidence.`,
    },
  };
}

function publicTutorial(row: TutorialRow) {
  return {
    id: row.id,
    status: row.status,
    writeClient: row.write_client,
    recallClient: row.recall_client,
    sameClient: row.write_client === row.recall_client,
    marker: row.marker,
    fact: row.fact,
    sourceIdentifier: row.source_identifier,
    contentId: row.content_id,
    diagnostic: { code: row.diagnostic_code, details: row.diagnostic_details },
    instructions: instructions(row),
    rememberedAt: row.remembered_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RecallTutorialService {
  constructor(private readonly database: Database) {}

  private assertOwner(principal: Principal): void {
    if (principal.libraryId) throw new NotFoundError('Recall tutorial not found');
  }

  capabilities(environment: 'native' | 'wsl' = 'native') {
    return recallClientCapabilities(environment);
  }

  async create(principal: Principal, raw: unknown) {
    this.assertOwner(principal);
    const input = RecallTutorialCreateSchema.parse(raw);
    const write = capability(input.writeClient, input.environment);
    const recall = capability(input.recallClient, input.environment);
    const limitations = [write, recall].filter((item) => !item.supported)
      .map((item) => ({ client: item.id, limitation: item.limitation }));
    if (new Set([input.writeClient, input.recallClient]).size > 1
      && [input.writeClient, input.recallClient].every((client) => client === 'codex' || client === 'chatgpt-desktop')) {
      limitations.push({ client: input.recallClient, limitation: 'Codex and ChatGPT Desktop share one local plugin configuration, so the server cannot distinguish a cross-client proof between those two hosts.' });
    }
    if (limitations.length) {
      throw new ConflictError(`Unsupported tutorial client selection: ${limitations.map((item) => `${item.client}: ${item.limitation}`).join(' ')}`);
    }
    const marker = `ae-demo-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const fact = `For ${marker}, the harmless demo lighthouse color is cobalt.`;
    const sourceIdentifier = `recall-tutorial:${marker}`;
    const result = await this.database.query<TutorialRow>(
      `INSERT INTO recall_tutorials (
         tenant_id,write_client,recall_client,marker,fact,source_identifier,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [principal.tenantId, input.writeClient, input.recallClient, marker, fact, sourceIdentifier, principal.apiKeyId],
    );
    return publicTutorial(result.rows[0]!);
  }

  async list(principal: Principal) {
    this.assertOwner(principal);
    const result = await this.database.query<TutorialRow>(
      `SELECT * FROM recall_tutorials WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
      [principal.tenantId],
    );
    return result.rows.map(publicTutorial);
  }

  async get(principal: Principal, id: string) {
    this.assertOwner(principal);
    const result = await this.database.query<TutorialRow>(
      `SELECT * FROM recall_tutorials WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, IdSchema.parse(id)],
    );
    if (!result.rows[0]) throw new NotFoundError('Recall tutorial not found');
    return publicTutorial(result.rows[0]);
  }

  async check(principal: Principal, id: string, raw: unknown) {
    this.assertOwner(principal);
    const input = RecallTutorialCheckSchema.parse(raw);
    const current = await this.database.query<TutorialRow>(
      `SELECT * FROM recall_tutorials WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, IdSchema.parse(id)],
    );
    const tutorial = current.rows[0];
    if (!tutorial) throw new NotFoundError('Recall tutorial not found');
    if (tutorial.status === 'verified') return publicTutorial(tutorial);
    if (input.reportedFailure) {
      const failed = await this.database.query<TutorialRow>(
        `UPDATE recall_tutorials SET diagnostic_code=$3,diagnostic_details=$4
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [principal.tenantId, id, input.reportedFailure, { recovery: this.recovery(input.reportedFailure) }],
      );
      return publicTutorial(failed.rows[0]!);
    }
    const content = await this.database.query<{ id: string; created_at: Date; content: string | null }>(
      `SELECT id,created_at,content FROM content_items
        WHERE tenant_id=$1 AND source_identifier=$2 AND source='recall-tutorial' AND status='active'`,
      [principal.tenantId, tutorial.source_identifier],
    );
    const remembered = content.rows[0];
    if (!remembered) return this.updateDiagnostic(principal.tenantId, id, 'waiting_for_remember', 'No exact challenge memory has been stored yet.');
    if (remembered.content !== tutorial.fact) {
      return this.updateDiagnostic(principal.tenantId, id, 'wiring', 'The challenge idempotency key exists, but its content does not match the generated harmless fact.');
    }
    const writeSurface = capability(tutorial.write_client).surface;
    const writeAudit = await this.database.query<{ created_at: Date }>(
      `SELECT created_at FROM audit_log WHERE tenant_id=$1 AND action='content.import'
        AND created_at >= $2 AND details->>'surface'=$3
        AND details->>'client'=$4
        AND details->'contentIds' @> jsonb_build_array($5::text) ORDER BY created_at LIMIT 1`,
      [principal.tenantId, tutorial.created_at, writeSurface, tutorial.write_client, remembered.id],
    );
    if (!writeAudit.rows[0]) return this.updateDiagnostic(principal.tenantId, id, 'wiring', 'The record exists, but no matching MCP/CLI remember audit was found.');
    const rememberedAt = tutorial.remembered_at ?? writeAudit.rows[0].created_at;
    const recallSurface = capability(tutorial.recall_client).surface;
    const recalls = await this.database.query<{ created_at: Date; result_ids: unknown; surface: string }>(
      `SELECT created_at,details->'resultIds' AS result_ids,details->>'surface' AS surface
         FROM audit_log WHERE tenant_id=$1 AND action='content.query' AND created_at >= $2
          AND details->>'query'=$3 AND details->>'client'=$4 ORDER BY created_at`,
      [principal.tenantId, rememberedAt, tutorial.marker, tutorial.recall_client],
    );
    const surfaced = recalls.rows.filter((row) => row.surface === recallSurface);
    if (!recalls.rows.length) {
      return this.markRemembered(principal.tenantId, id, remembered.id, rememberedAt, 'waiting_for_fresh_chat', 'Remember passed. Open a fresh chat and run the recall instruction.');
    }
    if (!surfaced.length) return this.markRemembered(principal.tenantId, id, remembered.id, rememberedAt, 'wiring', `Recall used ${recalls.rows[0]!.surface}, not the selected ${recallSurface} integration.`);
    const cited = surfaced.find((row) => Array.isArray(row.result_ids) && row.result_ids.includes(remembered.id));
    if (!cited) return this.markRemembered(principal.tenantId, id, remembered.id, rememberedAt, 'retrieval', 'Recall ran but did not return the remembered content ID.');
    const inspected = await this.database.query<{ created_at: Date }>(
      `SELECT created_at FROM audit_log WHERE tenant_id=$1 AND action='content.lineage.read'
        AND resource_id=$2 AND created_at >= $3 AND details->>'surface'=$4
        AND details->>'client'=$5 ORDER BY created_at LIMIT 1`,
      [principal.tenantId, remembered.id, cited.created_at, recallSurface, tutorial.recall_client],
    );
    if (!inspected.rows[0]) return this.markRemembered(principal.tenantId, id, remembered.id, rememberedAt, 'source_evidence', 'Recall cited the right memory; inspect_memory still needs to verify its source.');
    const verified = await this.database.query<TutorialRow>(
      `UPDATE recall_tutorials SET status='verified',content_id=$3,remembered_at=$4,
              verified_at=$5,diagnostic_code='passed',diagnostic_details=$6
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [principal.tenantId, id, remembered.id, rememberedAt, inspected.rows[0].created_at,
        { recallAt: cited.created_at, lineageAt: inspected.rows[0].created_at, surface: recallSurface }],
    );
    return publicTutorial(verified.rows[0]!);
  }

  private recovery(code: string): string {
    const guidance: Record<string, string> = {
      runtime: 'Open the local health screen and restart only the selected Answer Engine channel.',
      wiring: 'Re-run integration verification for the selected client, then restart that client.',
      access: 'Use a non-revoked key with read and write capability in the client integration.',
      indexing: 'Confirm the memory is active and retry fulltext recall with the exact marker.',
      retrieval: 'Use exact-marker fulltext recall and remove unrelated filters or library scope.',
    };
    return guidance[code] ?? 'Retry the current tutorial step.';
  }

  private async updateDiagnostic(tenantId: string, id: string, code: string, message: string) {
    const result = await this.database.query<TutorialRow>(
      `UPDATE recall_tutorials SET diagnostic_code=$3,diagnostic_details=$4
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, code, { message, recovery: this.recovery(code) }],
    );
    return publicTutorial(result.rows[0]!);
  }

  private async markRemembered(tenantId: string, id: string, contentId: string, rememberedAt: Date, code: string, message: string) {
    const result = await this.database.query<TutorialRow>(
      `UPDATE recall_tutorials SET status='remembered',content_id=$3,remembered_at=$4,
              diagnostic_code=$5,diagnostic_details=$6 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, contentId, rememberedAt, code, { message, recovery: this.recovery(code) }],
    );
    return publicTutorial(result.rows[0]!);
  }
}
