// src/types/external-run.ts
//
// External Runs: first-class records of work done in a NATIVE harness
// (Claude Code, Codex) outside an Agor-spawned session. See
// docs/internal/external-runs-design-2026-06-22.md.

import type { BranchID, UUID } from './id';

export type ExternalRunID = UUID;
export type ExternalRunEventID = UUID;
export type ExternalRunLinkID = UUID;

export type ExternalRunHarness = 'claude-code' | 'codex';
export type ExternalRunStatus = 'running' | 'completed' | 'failed' | 'abandoned';
export type ExternalRunCaptureMode = 'events-only';
export type ExternalRunAnchorType = 'branch' | 'card';

export type ExternalRunEventType =
  | 'start'
  | 'progress'
  | 'checkpoint'
  | 'link'
  | 'summary'
  | 'complete'
  | 'error';

export type ExternalRunLinkTargetKind =
  | 'github_issue'
  | 'github_pr'
  | 'commit'
  | 'agor_branch'
  | 'agor_card'
  | 'agor_session'
  | 'kb_document';

export type ExternalRunLinkRelationship = 'primary' | 'secondary';

/** Git + host context captured when the run starts. */
export interface ExternalRunData {
  cwd?: string;
  git_repo?: string;
  git_branch?: string;
  git_sha?: string;
  harness_version?: string;
  host?: string;
}

export interface ExternalRun {
  run_id: ExternalRunID;
  /** The agor_sk_ key owner who started the run. */
  created_by?: UUID;
  harness: ExternalRunHarness;
  title: string;
  status: ExternalRunStatus;
  capture_mode: ExternalRunCaptureMode;
  /** Which kind of primary anchor; 'branch' materializes primary_branch_id. */
  primary_anchor_type?: ExternalRunAnchorType;
  primary_branch_id?: BranchID;
  /** Pointer to the curated KB summary document. */
  summary_document_id?: UUID;
  data?: ExternalRunData;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  archived: boolean;
  archived_at?: string;
}

export interface ExternalRunEventBody {
  message?: string;
  details?: Record<string, unknown>;
}

export interface ExternalRunEvent {
  event_id: ExternalRunEventID;
  run_id: ExternalRunID;
  event_type: ExternalRunEventType;
  body?: ExternalRunEventBody;
  created_at: string;
}

export interface ExternalRunLink {
  link_id: ExternalRunLinkID;
  run_id: ExternalRunID;
  target_kind: ExternalRunLinkTargetKind;
  /** URL, id, or agor:// URI depending on target_kind. */
  target_ref: string;
  relationship: ExternalRunLinkRelationship;
  created_at: string;
}
