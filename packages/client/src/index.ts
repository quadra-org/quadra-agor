/**
 * @agor-live/client — TypeScript client for connecting to the Agor daemon
 *
 * Usage:
 *   import { createClient } from '@agor-live/client';
 *   const client = createClient('http://localhost:3030');
 */

export type {
  AgorClient,
  AgorService,
  BoardsService,
  MessagesService,
  ReposLocalService,
  ReposService,
  ServiceTypes,
  SessionsService,
  TasksService,
  WorktreesService,
} from '../../core/src/api/index';
// API client: createClient, createRestClient, isDaemonRunning, all service interfaces
export {
  createClient,
  createRestClient,
  isDaemonRunning,
} from '../../core/src/api/index';

// Core types that consumers need for working with the API
export type {
  Artifact,
  AuthenticationResult,
  Board,
  BoardExportBlob,
  CardType,
  CardWithType,
  ContextFileDetail,
  ContextFileListItem,
  MCPServer,
  Message,
  Repo,
  Session,
  Task,
  User,
  Worktree,
} from '../../core/src/types/index';
