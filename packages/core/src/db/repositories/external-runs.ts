/**
 * External Run repositories
 *
 * Type-safe CRUD for external_runs / external_run_events / external_run_links,
 * with short-ID support. See docs/internal/external-runs-design-2026-06-22.md.
 *
 * `data` (runs) and `body` (events) are json-mode columns, so Drizzle
 * (de)serializes them automatically — unlike cards.data we do NOT JSON.stringify.
 */

import type {
  BranchID,
  ExternalRun,
  ExternalRunEvent,
  ExternalRunID,
  ExternalRunLink,
  UUID,
} from '@agor/core/types';
import { and, eq, like } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type ExternalRunEventRow,
  type ExternalRunLinkRow,
  type ExternalRunRow,
  externalRunEvents,
  externalRunLinks,
  externalRuns,
} from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

function iso(value: Date | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Date(value).toISOString();
}

export class ExternalRunRepository implements BaseRepository<ExternalRun, Partial<ExternalRun>> {
  constructor(private db: Database) {}

  private rowToRun(row: ExternalRunRow): ExternalRun {
    return {
      run_id: row.run_id as ExternalRunID,
      created_by: (row.created_by as UUID) ?? undefined,
      harness: row.harness,
      title: row.title,
      status: row.status,
      capture_mode: row.capture_mode,
      primary_anchor_type: row.primary_anchor_type ?? undefined,
      primary_branch_id: (row.primary_branch_id as BranchID) ?? undefined,
      summary_document_id: (row.summary_document_id as UUID) ?? undefined,
      data: row.data ?? undefined,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at),
      completed_at: iso(row.completed_at),
      archived: Boolean(row.archived),
      archived_at: iso(row.archived_at),
    };
  }

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'ExternalRun', async (pattern) => {
      const rows = await select(this.db)
        .from(externalRuns)
        .where(like(externalRuns.run_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { run_id: string }) => r.run_id);
    });
  }

  async create(data: Partial<ExternalRun>): Promise<ExternalRun> {
    try {
      const now = new Date();
      const runId = data.run_id ?? generateId();
      await insert(this.db, externalRuns)
        .values({
          run_id: runId,
          created_by: data.created_by ?? null,
          harness: data.harness ?? 'claude-code',
          title: data.title ?? 'Untitled run',
          status: data.status ?? 'running',
          capture_mode: data.capture_mode ?? 'events-only',
          primary_anchor_type: data.primary_anchor_type ?? null,
          primary_branch_id: data.primary_branch_id ?? null,
          summary_document_id: data.summary_document_id ?? null,
          data: data.data ?? null,
          created_at: now,
          updated_at: now,
          completed_at: data.completed_at ? new Date(data.completed_at) : null,
          archived: data.archived ?? false,
          archived_at: data.archived_at ? new Date(data.archived_at) : null,
        })
        .run();
      const row = await select(this.db)
        .from(externalRuns)
        .where(eq(externalRuns.run_id, runId))
        .one();
      if (!row) throw new RepositoryError('Failed to retrieve created external run');
      return this.rowToRun(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create external run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<ExternalRun | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(externalRuns)
        .where(eq(externalRuns.run_id, fullId))
        .one();
      return row ? this.rowToRun(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find external run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findAll(): Promise<ExternalRun[]> {
    const rows = await select(this.db).from(externalRuns).all();
    return rows.map((r: ExternalRunRow) => this.rowToRun(r));
  }

  async update(id: string, updates: Partial<ExternalRun>): Promise<ExternalRun> {
    try {
      const fullId = await this.resolveId(id);
      const setData: Record<string, unknown> = { updated_at: new Date() };
      if (updates.title !== undefined) setData.title = updates.title;
      if (updates.status !== undefined) setData.status = updates.status;
      if (updates.primary_anchor_type !== undefined)
        setData.primary_anchor_type = updates.primary_anchor_type ?? null;
      if (updates.primary_branch_id !== undefined)
        setData.primary_branch_id = updates.primary_branch_id ?? null;
      if (updates.summary_document_id !== undefined)
        setData.summary_document_id = updates.summary_document_id ?? null;
      if (updates.data !== undefined) setData.data = updates.data ?? null;
      if (updates.completed_at !== undefined)
        setData.completed_at = updates.completed_at ? new Date(updates.completed_at) : null;
      if (updates.archived !== undefined) setData.archived = updates.archived;
      if (updates.archived_at !== undefined)
        setData.archived_at = updates.archived_at ? new Date(updates.archived_at) : null;

      await update(this.db, externalRuns).set(setData).where(eq(externalRuns.run_id, fullId)).run();
      const row = await select(this.db)
        .from(externalRuns)
        .where(eq(externalRuns.run_id, fullId))
        .one();
      if (!row) throw new EntityNotFoundError('ExternalRun', id);
      return this.rowToRun(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update external run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    const result = await deleteFrom(this.db, externalRuns)
      .where(eq(externalRuns.run_id, fullId))
      .run();
    if (result.rowsAffected === 0) throw new EntityNotFoundError('ExternalRun', id);
  }
}

export class ExternalRunEventRepository
  implements BaseRepository<ExternalRunEvent, Partial<ExternalRunEvent>>
{
  constructor(private db: Database) {}

  private rowToEvent(row: ExternalRunEventRow): ExternalRunEvent {
    return {
      event_id: row.event_id as UUID,
      run_id: row.run_id as ExternalRunID,
      event_type: row.event_type,
      body: row.body ?? undefined,
      created_at: iso(row.created_at)!,
    };
  }

  async create(data: Partial<ExternalRunEvent>): Promise<ExternalRunEvent> {
    const eventId = data.event_id ?? generateId();
    if (!data.run_id) throw new RepositoryError('external_run_event requires run_id');
    await insert(this.db, externalRunEvents)
      .values({
        event_id: eventId,
        run_id: data.run_id,
        event_type: data.event_type ?? 'progress',
        body: data.body ?? null,
        created_at: new Date(),
      })
      .run();
    const row = await select(this.db)
      .from(externalRunEvents)
      .where(eq(externalRunEvents.event_id, eventId))
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve created external run event');
    return this.rowToEvent(row);
  }

  async findById(id: string): Promise<ExternalRunEvent | null> {
    const row = await select(this.db)
      .from(externalRunEvents)
      .where(eq(externalRunEvents.event_id, id))
      .one();
    return row ? this.rowToEvent(row) : null;
  }

  async findAll(): Promise<ExternalRunEvent[]> {
    const rows = await select(this.db).from(externalRunEvents).all();
    return rows.map((r: ExternalRunEventRow) => this.rowToEvent(r));
  }

  /** Efficient per-run fetch for the timeline (DrizzleService.find filters
   *  findAll() client-side; tools use this to avoid scanning all events).
   *  ponytail: full-table scan in findAll is fine at MVP volume; if events grow
   *  large, push status/run filters into SQL here and in find. */
  async findByRunId(runId: string): Promise<ExternalRunEvent[]> {
    const rows = await select(this.db)
      .from(externalRunEvents)
      .where(eq(externalRunEvents.run_id, runId))
      .all();
    return rows.map((r: ExternalRunEventRow) => this.rowToEvent(r));
  }

  async update(): Promise<ExternalRunEvent> {
    // Events are an append-only log — no in-place edits.
    throw new RepositoryError('external_run_events are immutable');
  }

  async delete(id: string): Promise<void> {
    await deleteFrom(this.db, externalRunEvents).where(eq(externalRunEvents.event_id, id)).run();
  }
}

export class ExternalRunLinkRepository
  implements BaseRepository<ExternalRunLink, Partial<ExternalRunLink>>
{
  constructor(private db: Database) {}

  private rowToLink(row: ExternalRunLinkRow): ExternalRunLink {
    return {
      link_id: row.link_id as UUID,
      run_id: row.run_id as ExternalRunID,
      target_kind: row.target_kind,
      target_ref: row.target_ref,
      relationship: row.relationship,
      created_at: iso(row.created_at)!,
    };
  }

  async create(data: Partial<ExternalRunLink>): Promise<ExternalRunLink> {
    const linkId = data.link_id ?? generateId();
    if (!data.run_id) throw new RepositoryError('external_run_link requires run_id');
    if (!data.target_kind || !data.target_ref)
      throw new RepositoryError('external_run_link requires target_kind and target_ref');
    await insert(this.db, externalRunLinks)
      .values({
        link_id: linkId,
        run_id: data.run_id,
        target_kind: data.target_kind,
        target_ref: data.target_ref,
        relationship: data.relationship ?? 'secondary',
        created_at: new Date(),
      })
      .run();
    const row = await select(this.db)
      .from(externalRunLinks)
      .where(eq(externalRunLinks.link_id, linkId))
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve created external run link');
    return this.rowToLink(row);
  }

  async findById(id: string): Promise<ExternalRunLink | null> {
    const row = await select(this.db)
      .from(externalRunLinks)
      .where(eq(externalRunLinks.link_id, id))
      .one();
    return row ? this.rowToLink(row) : null;
  }

  async findAll(): Promise<ExternalRunLink[]> {
    const rows = await select(this.db).from(externalRunLinks).all();
    return rows.map((r: ExternalRunLinkRow) => this.rowToLink(r));
  }

  async findByRunId(runId: string): Promise<ExternalRunLink[]> {
    const rows = await select(this.db)
      .from(externalRunLinks)
      .where(eq(externalRunLinks.run_id, runId))
      .all();
    return rows.map((r: ExternalRunLinkRow) => this.rowToLink(r));
  }

  /** The single primary anchor link for a run, if set. */
  async findPrimary(runId: string): Promise<ExternalRunLink | null> {
    const row = await select(this.db)
      .from(externalRunLinks)
      .where(and(eq(externalRunLinks.run_id, runId), eq(externalRunLinks.relationship, 'primary')))
      .one();
    return row ? this.rowToLink(row) : null;
  }

  async update(): Promise<ExternalRunLink> {
    throw new RepositoryError('external_run_links are immutable; remove and recreate');
  }

  async delete(id: string): Promise<void> {
    await deleteFrom(this.db, externalRunLinks).where(eq(externalRunLinks.link_id, id)).run();
  }
}
