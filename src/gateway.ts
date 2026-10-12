import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore } from './store.js';
import type {
  GatewayAuditRecord,
  GatewayLedgerRecord,
  GatewayMutationContext,
  GatewayOperation,
  GatewayRequestOutcome,
  MemoryRecord,
  MemoryType,
  StoreMemoryParams,
} from './types.js';

const GATEWAY_MEMORY_TYPES: readonly MemoryType[] = ['work', 'observation'];
const DEFAULT_MAX_ACCEPTED_WRITES_PER_SESSION = 10;

export interface GatewayConfig {
  runtimeId: string;
  clientId: string;
  sessionId: string;
  allowedClients: ReadonlySet<string>;
  maxAcceptedWritesPerSession?: number;
}

export interface GatewayMemoryInput {
  context: GatewayMutationContext;
  title: string;
  tags: string;
  summary: string;
  type: MemoryType;
  artifacts?: unknown[];
  event_date?: string;
  is_static?: boolean;
  forget_after?: string;
  // Rejected explicitly if supplied at runtime; this field exists for defensive validation.
  force?: unknown;
  parent_id?: unknown;
  relation?: unknown;
}

export interface GatewayMutationResult {
  outcome: GatewayRequestOutcome;
  stored: boolean;
  id?: number;
  reason?: string;
  replayed?: boolean;
  similar_id?: number;
  similar_title?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .filter(key => input[key] !== undefined)
        .sort()
        .map(key => [key, canonicalize(input[key])]),
    );
  }
  return value;
}

function hashPayload(operation: GatewayOperation, input: GatewayMemoryInput): string {
  const { context: _context, ...payload } = input;
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ operation, payload })))
    .digest('hex');
}

function reasonFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentMemoryGateway {
  private readonly maxAcceptedWritesPerSession: number;

  constructor(
    private readonly store: MemoryStore,
    private readonly config: GatewayConfig,
  ) {
    const identity = `${config.runtimeId}:${config.clientId}`;
    if (!config.allowedClients.has(identity)) {
      throw new Error(`gateway client is not allowlisted: ${identity}`);
    }
    if (!isNonEmptyString(config.sessionId)) {
      throw new Error('gateway sessionId must be adapter-injected');
    }
    const limit = config.maxAcceptedWritesPerSession ?? DEFAULT_MAX_ACCEPTED_WRITES_PER_SESSION;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('gateway maxAcceptedWritesPerSession must be a positive integer');
    }
    this.maxAcceptedWritesPerSession = limit;
  }

  async search(params: {
    query: string;
    type?: MemoryType;
    limit?: number;
    date_from?: string;
    date_to?: string;
  }): Promise<MemoryRecord[]> {
    const limit = Math.min(Math.max(params.limit ?? 8, 1), 15);
    return this.store.searchMemory({ ...params, limit, readOnly: true });
  }

  listRecent(params: { count?: number; type?: MemoryType }): MemoryRecord[] {
    const count = Math.min(Math.max(params.count ?? 10, 1), 20);
    return this.store.listRecent({ ...params, count, readOnly: true });
  }

  async write(input: GatewayMemoryInput): Promise<GatewayMutationResult> {
    return this.mutate('memory_write', input);
  }

  async update(input: GatewayMemoryInput): Promise<GatewayMutationResult> {
    return this.mutate('memory_update', input);
  }

  private async mutate(operation: GatewayOperation, input: GatewayMemoryInput): Promise<GatewayMutationResult> {
    const audit = this.createAuditRecord(operation, input);
    const contextError = this.validateContext(input.context);
    if (contextError) {
      return this.reject(audit, contextError);
    }

    const payloadError = this.validatePayload(operation, input);
    if (payloadError) {
      return this.reject(audit, payloadError);
    }

    const existing = audit.idempotency_key
      ? this.store.getGatewayRequest(audit.client_id, audit.idempotency_key)
      : null;

    if (existing) {
      const conflict = this.idempotencyConflictReason(existing, audit);
      if (conflict) {
        return this.reject(audit, conflict);
      }
      this.store.recordGatewayReplay(audit, existing);
      return this.resultFromLedger(existing.outcome, existing.memory_id, existing.reason, true);
    }

    try {
      const result = await this.store.storeMemoryWithGatewayAudit(
        this.toStoreParams(operation, input), audit, this.maxAcceptedWritesPerSession,
      );
      if (!result.stored) {
        return this.reject(audit, result.reason ?? 'store_rejected', {
          similar_id: result.similar_id,
          similar_title: result.similar_title,
        });
      }
      return { outcome: 'accepted', stored: true, id: result.id };
    } catch (error) {
      const concurrent = audit.idempotency_key
        ? this.store.getGatewayRequest(audit.client_id, audit.idempotency_key)
        : null;
      if (concurrent) {
        const conflict = this.idempotencyConflictReason(concurrent, audit);
        if (conflict) {
          return this.reject(audit, conflict);
        }
        this.store.recordGatewayReplay(audit, concurrent);
        return this.resultFromLedger(concurrent.outcome, concurrent.memory_id, concurrent.reason, true);
      }
      const errorReason = reasonFromUnknown(error);
      const reason = errorReason === 'gateway_session_write_limit_exceeded'
        ? errorReason
        : `store_exception:${errorReason}`;
      return this.reject(audit, reason);
    }
  }

  private createAuditRecord(operation: GatewayOperation, input: GatewayMemoryInput): GatewayAuditRecord {
    const context = input.context ?? {};
    return {
      request_id: isNonEmptyString(context.request_id) ? context.request_id : null,
      runtime_id: this.config.runtimeId,
      client_id: this.config.clientId,
      session_id: this.config.sessionId,
      project_id: isNonEmptyString(context.project_id) ? context.project_id : null,
      evidence_ref: isNonEmptyString(context.evidence_ref) ? context.evidence_ref : null,
      retention_intent: context.retention_intent === 'durable' ? 'durable' : null,
      idempotency_key: isNonEmptyString(context.idempotency_key) ? context.idempotency_key : null,
      operation,
      payload_hash: hashPayload(operation, input),
    };
  }

  private validateContext(context: GatewayMutationContext | undefined): string | null {
    if (!context || !isNonEmptyString(context.request_id)) return 'missing_request_id';
    if (!isNonEmptyString(context.project_id)) return 'missing_project_id';
    if (!isNonEmptyString(context.evidence_ref)) return 'missing_evidence_ref';
    if (!isNonEmptyString(context.idempotency_key)) return 'missing_idempotency_key';
    if (context.retention_intent !== 'durable') return 'retention_intent_must_be_durable';
    if (!isValidEvidenceRef(context.evidence_ref)) return 'invalid_evidence_ref';
    return null;
  }

  private validatePayload(operation: GatewayOperation, input: GatewayMemoryInput): string | null {
    if (!GATEWAY_MEMORY_TYPES.includes(input.type)) return 'unsupported_memory_type';
    if (input.force !== undefined) return 'force_is_not_available_through_gateway';
    if (input.is_static) return 'is_static_is_not_available_through_gateway';
    if (input.forget_after !== undefined) return 'forget_after_is_not_available_through_gateway';
    if (operation === 'memory_write' && (input.parent_id !== undefined || input.relation !== undefined)) {
      return 'memory_write_does_not_accept_version_chain_fields';
    }
    if (operation === 'memory_update') {
      if (!Number.isInteger(input.parent_id) || Number(input.parent_id) <= 0) return 'memory_update_requires_parent_id';
      if (input.relation !== undefined && input.relation !== 'update') return 'memory_update_requires_update_relation';
    }
    if (input.artifacts !== undefined && !Array.isArray(input.artifacts)) return 'artifacts_must_be_an_array';
    return null;
  }

  private toStoreParams(operation: GatewayOperation, input: GatewayMemoryInput): StoreMemoryParams {
    return {
      title: input.title,
      tags: input.tags,
      summary: input.summary,
      type: input.type,
      artifacts: JSON.stringify(input.artifacts ?? []),
      event_date: input.event_date,
      forget_after: input.forget_after,
      parent_id: operation === 'memory_update' ? Number(input.parent_id) : undefined,
      relation: operation === 'memory_update' ? 'update' : undefined,
      // Gateway writes stay deterministic and never fork the embedding worker on its mutation path.
      embed: 'defer',
    };
  }

  private idempotencyConflictReason(existing: GatewayLedgerRecord, audit: GatewayAuditRecord): string | null {
    if (existing.payload_hash !== audit.payload_hash) return 'idempotency_key_reused_with_different_payload';
    if (
      existing.operation !== audit.operation ||
      existing.project_id !== audit.project_id ||
      existing.evidence_ref !== audit.evidence_ref ||
      existing.retention_intent !== audit.retention_intent
    ) {
      return 'idempotency_key_reused_with_different_provenance';
    }
    return null;
  }

  private reject(
    audit: GatewayAuditRecord,
    reason: string,
    details: Pick<GatewayMutationResult, 'similar_id' | 'similar_title'> = {},
  ): GatewayMutationResult {
    try {
      this.store.recordGatewayRejection(audit, reason);
    } catch {
      return { outcome: 'rejected', stored: false, reason: 'gateway_audit_unavailable' };
    }
    return { outcome: 'rejected', stored: false, reason, ...details };
  }

  private resultFromLedger(
    outcome: GatewayRequestOutcome,
    memoryId: number | null,
    reason: string | null,
    replayed: boolean,
  ): GatewayMutationResult {
    return outcome === 'accepted'
      ? { outcome, stored: true, id: memoryId ?? undefined, replayed }
      : { outcome, stored: false, reason: reason ?? undefined, replayed };
  }
}

function isValidEvidenceRef(value: string): boolean {
  if (/^memory:[1-9]\d*$/.test(value)) return true;
  if (/^workspace:(?!\/)(?:[^\s#][^\r\n#]*?)#L[1-9]\d*$/.test(value)) return true;
  if (!value.startsWith('url:')) return false;
  try {
    const url = new URL(value.slice(4));
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function gatewayConfigFromEnvironment(env = process.env): GatewayConfig {
  const runtimeId = env.MEMORY_GATEWAY_RUNTIME_ID?.trim();
  const clientId = env.MEMORY_GATEWAY_CLIENT_ID?.trim();
  const sessionId = env.MEMORY_GATEWAY_SESSION_ID?.trim() || randomUUID();
  const allowlist = env.MEMORY_GATEWAY_ALLOWED_CLIENTS
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean) ?? [];

  if (!runtimeId || !clientId || allowlist.length === 0) {
    throw new Error('gateway requires MEMORY_GATEWAY_RUNTIME_ID, MEMORY_GATEWAY_CLIENT_ID, and MEMORY_GATEWAY_ALLOWED_CLIENTS');
  }
  return { runtimeId, clientId, sessionId, allowedClients: new Set(allowlist) };
}
