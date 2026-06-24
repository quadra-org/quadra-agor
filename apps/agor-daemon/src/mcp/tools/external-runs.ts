/**
 * External Runs MCP tools — let native harnesses (Claude Code, Codex) log work
 * back to the central daemon as a first-class External Run. Mirrors the
 * schedules.ts tool shape. See docs/internal/external-runs-design-2026-06-22.md.
 *
 * Lifecycle: start → log* → (set_anchor, link)* → publish_summary? → complete.
 * Summaries reuse the Knowledge base: call agor_kb_put to author the doc, then
 * agor_external_run_publish_summary with its documentId — we do NOT reimplement
 * KB writes here.
 */

import type { ExternalRun, ExternalRunEvent, ExternalRunLink, Paginated } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveBranchId, resolveExternalRunId } from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOptionalId,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const TARGET_KINDS = [
  'github_issue',
  'github_pr',
  'commit',
  'agor_branch',
  'agor_card',
  'agor_session',
  'kb_document',
] as const;

/** Normalize a Feathers find() result (paginated or raw array) to an array. */
function rows<T>(result: Paginated<T> | T[]): T[] {
  return Array.isArray(result) ? result : result.data;
}

export function registerExternalRunTools(server: McpServer, ctx: McpContext): void {
  // agor_external_runs_list
  server.registerTool(
    'agor_external_runs_list',
    {
      description:
        'List external runs (native-harness work logged back to Agor). Filter by status, harness, creator, or primary branch. Newest activity first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        status: z.enum(['running', 'completed', 'failed', 'abandoned']).optional(),
        harness: z.enum(['claude-code', 'codex']).optional(),
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter to runs anchored on this branch'),
        limit: mcpLimit(50).describe('Maximum number of runs to return (default: 50)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.limit) query.$limit = args.limit;
      if (args.status) query.status = args.status;
      if (args.harness) query.harness = args.harness;
      if (args.branchId) query.primary_branch_id = await resolveBranchId(ctx, args.branchId);
      const result = await ctx.app
        .service('external-runs')
        .find({ query, ...ctx.baseServiceParams });
      return textResult(result);
    }
  );

  // agor_external_run_get
  server.registerTool(
    'agor_external_run_get',
    {
      description:
        'Get a single external run with its full event timeline and all artefact links. Use to inspect or resume a run.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const run = await ctx.app.service('external-runs').get(runId, ctx.baseServiceParams);
      const events = rows<ExternalRunEvent>(
        await ctx.app
          .service('external-run-events')
          .find({ query: { run_id: runId, $limit: 1000 }, ...ctx.baseServiceParams })
      );
      const links = rows<ExternalRunLink>(
        await ctx.app
          .service('external-run-links')
          .find({ query: { run_id: runId, $limit: 1000 }, ...ctx.baseServiceParams })
      );
      return textResult({ run, events, links });
    }
  );

  // agor_external_run_start
  server.registerTool(
    'agor_external_run_start',
    {
      description:
        'Start a new external run at task kickoff. Records the harness and git context. Optionally anchor to a branch now (you can also set the anchor later). Returns the run with its run_id — keep it for subsequent calls.',
      inputSchema: z.strictObject({
        title: mcpRequiredString('title', 'Short human label for the run'),
        harness: z.enum(['claude-code', 'codex']).describe('Which native harness is running'),
        branchId: mcpOptionalId(
          'branchId',
          'Branch',
          'Primary branch anchor, if a branch already exists'
        ),
        cwd: mcpOptionalString('cwd', 'Working directory'),
        gitRepo: mcpOptionalString('gitRepo', 'Git remote / repo slug'),
        gitBranch: mcpOptionalString('gitBranch', 'Current git branch'),
        gitSha: mcpOptionalString('gitSha', 'Current git commit sha'),
        harnessVersion: mcpOptionalString('harnessVersion', 'Harness version string'),
        host: mcpOptionalString('host', 'Hostname the run executes on'),
      }),
    },
    async (args) => {
      const branchId = args.branchId ? await resolveBranchId(ctx, args.branchId) : undefined;
      const payload: Partial<ExternalRun> = {
        title: args.title,
        harness: args.harness,
        status: 'running',
        capture_mode: 'events-only',
        primary_anchor_type: branchId ? 'branch' : undefined,
        primary_branch_id: branchId,
        data: {
          cwd: args.cwd,
          git_repo: args.gitRepo,
          git_branch: args.gitBranch,
          git_sha: args.gitSha,
          harness_version: args.harnessVersion,
          host: args.host,
        },
      };
      const run = (await ctx.app
        .service('external-runs')
        .create(payload, ctx.baseServiceParams)) as ExternalRun;
      await ctx.app
        .service('external-run-events')
        .create(
          { run_id: run.run_id, event_type: 'start', body: { message: `Started: ${run.title}` } },
          ctx.baseServiceParams
        );
      return textResult(run);
    }
  );

  // agor_external_run_log
  server.registerTool(
    'agor_external_run_log',
    {
      description:
        'Append a structured event to a run. Log at MEANINGFUL checkpoints (a decision, a milestone, a blocker) — NOT every chat turn. Use type "checkpoint" for notable progress, "error" for failures.',
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
        eventType: z
          .enum(['progress', 'checkpoint', 'error'])
          .describe('Kind of event (start/link/summary/complete are emitted by their own tools)'),
        message: mcpRequiredString('message', 'Human-readable summary of what happened'),
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional structured detail object'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const event = (await ctx.app.service('external-run-events').create(
        {
          run_id: runId,
          event_type: args.eventType,
          body: { message: args.message, details: args.details },
        },
        ctx.baseServiceParams
      )) as ExternalRunEvent;
      return textResult(event);
    }
  );

  // agor_external_run_set_anchor
  server.registerTool(
    'agor_external_run_set_anchor',
    {
      description:
        "Set the run's single PRIMARY work anchor — the branch (preferred) or card the work belongs to. Call once a branch exists; promotes a card anchor to a branch anchor on a later call.",
      inputSchema: z
        .strictObject({
          runId: mcpRequiredId('runId', 'ExternalRun'),
          branchId: mcpOptionalId('branchId', 'Branch', 'Anchor to this branch (preferred)'),
          cardId: mcpOptionalId('cardId', 'Card', 'Anchor to this card when no branch exists yet'),
        })
        .refine((v) => Boolean(v.branchId) !== Boolean(v.cardId), {
          message: 'Provide exactly one of branchId or cardId',
        }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      if (args.branchId) {
        const branchId = await resolveBranchId(ctx, args.branchId);
        const run = await ctx.app
          .service('external-runs')
          .patch(
            runId,
            { primary_anchor_type: 'branch', primary_branch_id: branchId },
            ctx.baseServiceParams
          );
        return textResult(run);
      }
      // Card anchor: record on the run + a relationship='primary' link (the
      // run table only materializes a branch anchor).
      const run = await ctx.app
        .service('external-runs')
        .patch(runId, { primary_anchor_type: 'card' }, ctx.baseServiceParams);
      const existing = rows<ExternalRunLink>(
        await ctx.app
          .service('external-run-links')
          .find({ query: { run_id: runId, relationship: 'primary' }, ...ctx.baseServiceParams })
      );
      for (const link of existing) {
        await ctx.app.service('external-run-links').remove(link.link_id, ctx.baseServiceParams);
      }
      await ctx.app.service('external-run-links').create(
        {
          run_id: runId,
          target_kind: 'agor_card',
          target_ref: String(args.cardId),
          relationship: 'primary',
        },
        ctx.baseServiceParams
      );
      return textResult(run);
    }
  );

  // agor_external_run_link
  server.registerTool(
    'agor_external_run_link',
    {
      description:
        'Link a secondary artefact / work item to the run: a GitHub issue/PR/commit, an Agor branch/card/session, or a KB document. Add these as they appear (e.g. when you open a PR).',
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
        targetKind: z.enum(TARGET_KINDS).describe('What kind of thing is being linked'),
        targetRef: mcpRequiredString('targetRef', 'URL, id, or agor:// URI identifying the target'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const link = await ctx.app.service('external-run-links').create(
        {
          run_id: runId,
          target_kind: args.targetKind,
          target_ref: args.targetRef,
          relationship: 'secondary',
        },
        ctx.baseServiceParams
      );
      await ctx.app.service('external-run-events').create(
        {
          run_id: runId,
          event_type: 'link',
          body: { message: `Linked ${args.targetKind}: ${args.targetRef}` },
        },
        ctx.baseServiceParams
      );
      return textResult(link);
    }
  );

  // agor_external_run_publish_summary
  server.registerTool(
    'agor_external_run_publish_summary',
    {
      description:
        'Attach a curated Knowledge summary to the run. FIRST author the doc with agor_kb_put (outcome, artefacts, decisions, follow-ups; kind "external"), THEN pass its documentId here. Publish at completion or a major checkpoint — not every turn.',
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
        documentId: mcpRequiredId('documentId', 'knowledge document'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const run = await ctx.app
        .service('external-runs')
        .patch(runId, { summary_document_id: args.documentId }, ctx.baseServiceParams);
      await ctx.app.service('external-run-links').create(
        {
          run_id: runId,
          target_kind: 'kb_document',
          target_ref: `agor://kb/document/${args.documentId}`,
          relationship: 'secondary',
        },
        ctx.baseServiceParams
      );
      await ctx.app
        .service('external-run-events')
        .create(
          { run_id: runId, event_type: 'summary', body: { message: 'Published summary' } },
          ctx.baseServiceParams
        );
      return textResult(run);
    }
  );

  // agor_external_run_complete
  server.registerTool(
    'agor_external_run_complete',
    {
      description:
        'Finalize a run. Sets the terminal status and timestamp and emits a complete event. Use "completed" for success, "failed" for an error stop, "abandoned" if dropped.',
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
        status: z
          .enum(['completed', 'failed', 'abandoned'])
          .describe('Terminal status (default: completed)')
          .optional(),
        message: mcpOptionalString('message', 'Closing note for the timeline'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const status = args.status ?? 'completed';
      const run = await ctx.app
        .service('external-runs')
        .patch(runId, { status, completed_at: new Date().toISOString() }, ctx.baseServiceParams);
      await ctx.app.service('external-run-events').create(
        {
          run_id: runId,
          event_type: 'complete',
          body: { message: args.message ?? `Run ${status}` },
        },
        ctx.baseServiceParams
      );
      return textResult(run);
    }
  );

  // agor_external_run_reopen
  server.registerTool(
    'agor_external_run_reopen',
    {
      description:
        'Reopen a run that was completed prematurely or by mistake: sets status back to "running", clears the completed timestamp, and logs a checkpoint event so the timeline records the reversal. Use when work continued after a complete call. Does NOT remove the prior complete event (the log is append-only) — it appends a reopen marker.',
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
        message: mcpOptionalString('message', 'Why the run is being reopened'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      const run = await ctx.app
        .service('external-runs')
        .patch(runId, { status: 'running', completed_at: null }, ctx.baseServiceParams);
      await ctx.app.service('external-run-events').create(
        {
          run_id: runId,
          event_type: 'checkpoint',
          body: { message: args.message ?? 'Reopened run (was completed)' },
        },
        ctx.baseServiceParams
      );
      return textResult(run);
    }
  );

  // agor_external_run_delete
  server.registerTool(
    'agor_external_run_delete',
    {
      description:
        'PERMANENTLY delete an external run and all of its events and links. Irreversible — use only for runs created in error or test/junk runs. To merely hide a finished run, complete it (or reopen) instead; do not delete real work history.',
      annotations: { destructiveHint: true },
      inputSchema: z.strictObject({
        runId: mcpRequiredId('runId', 'ExternalRun'),
      }),
    },
    async (args) => {
      const runId = await resolveExternalRunId(ctx, args.runId);
      // Explicit child cleanup: the FK cascade only fires when SQLite FK
      // enforcement is on, so delete events/links directly to avoid orphans.
      const events = rows<ExternalRunEvent>(
        await ctx.app
          .service('external-run-events')
          .find({ query: { run_id: runId, $limit: 1000 }, ...ctx.baseServiceParams })
      );
      for (const event of events) {
        await ctx.app.service('external-run-events').remove(event.event_id, ctx.baseServiceParams);
      }
      const links = rows<ExternalRunLink>(
        await ctx.app
          .service('external-run-links')
          .find({ query: { run_id: runId, $limit: 1000 }, ...ctx.baseServiceParams })
      );
      for (const link of links) {
        await ctx.app.service('external-run-links').remove(link.link_id, ctx.baseServiceParams);
      }
      await ctx.app.service('external-runs').remove(runId, ctx.baseServiceParams);
      return textResult({
        deleted: true,
        run_id: runId,
        events: events.length,
        links: links.length,
      });
    }
  );
}
