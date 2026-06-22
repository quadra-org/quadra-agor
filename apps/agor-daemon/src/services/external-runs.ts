/**
 * External Runs services
 *
 * REST + WebSocket surface for external_runs / external_run_events /
 * external_run_links. Native harnesses (Claude Code, Codex) drive these over
 * MCP to log work back to the central daemon. See
 * docs/internal/external-runs-design-2026-06-22.md.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  ExternalRunEventRepository,
  ExternalRunLinkRepository,
  ExternalRunRepository,
} from '@agor/core/db';
// Custom per-run lookups are done in the MCP tools via standard find({ query }),
// which DrizzleService filters — so these services stay plain CRUD wrappers.
import type { ExternalRun, ExternalRunEvent, ExternalRunLink, QueryParams } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type ExternalRunParams = QueryParams<{
  status?: string;
  harness?: string;
  created_by?: string;
  primary_branch_id?: string;
  archived?: boolean;
}>;

export class ExternalRunsService extends DrizzleService<
  ExternalRun,
  Partial<ExternalRun>,
  ExternalRunParams
> {
  constructor(db: Database) {
    super(new ExternalRunRepository(db), {
      id: 'run_id',
      resourceType: 'ExternalRun',
      paginate: { default: PAGINATION.DEFAULT_LIMIT, max: PAGINATION.MAX_LIMIT },
    });
  }
}

export type ExternalRunEventParams = QueryParams<{ run_id?: string; event_type?: string }>;

export class ExternalRunEventsService extends DrizzleService<
  ExternalRunEvent,
  Partial<ExternalRunEvent>,
  ExternalRunEventParams
> {
  constructor(db: Database) {
    super(new ExternalRunEventRepository(db), {
      id: 'event_id',
      resourceType: 'ExternalRunEvent',
      paginate: { default: PAGINATION.DEFAULT_LIMIT, max: PAGINATION.MAX_LIMIT },
    });
  }
}

export type ExternalRunLinkParams = QueryParams<{ run_id?: string; relationship?: string }>;

export class ExternalRunLinksService extends DrizzleService<
  ExternalRunLink,
  Partial<ExternalRunLink>,
  ExternalRunLinkParams
> {
  constructor(db: Database) {
    super(new ExternalRunLinkRepository(db), {
      id: 'link_id',
      resourceType: 'ExternalRunLink',
      paginate: { default: PAGINATION.DEFAULT_LIMIT, max: PAGINATION.MAX_LIMIT },
    });
  }
}

export function createExternalRunsService(db: Database): ExternalRunsService {
  return new ExternalRunsService(db);
}
export function createExternalRunEventsService(db: Database): ExternalRunEventsService {
  return new ExternalRunEventsService(db);
}
export function createExternalRunLinksService(db: Database): ExternalRunLinksService {
  return new ExternalRunLinksService(db);
}
