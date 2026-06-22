/**
 * React hooks for External Runs — native-harness work logged back to Agor.
 * Mirrors useMessages: fetch via the client service + subscribe to socket
 * events for live updates. See docs/internal/external-runs-design-2026-06-22.md.
 */

import type { AgorClient, ExternalRun, ExternalRunEvent, ExternalRunLink } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';

interface UseExternalRunsResult {
  runs: ExternalRun[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch + subscribe to the list of external runs.
 * ponytail: lists all runs (not board-scoped) — runs anchor to branches, not
 * boards, and the volume is low. Add a board filter if it grows noisy.
 */
export function useExternalRuns(client: AgorClient | null): UseExternalRunsResult {
  const [runs, setRuns] = useState<ExternalRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!client) {
      setRuns([]);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      // external-runs isn't in the client's typed ServiceTypes map, so the
      // generic service returns unknown[] — cast at this boundary.
      const list = (await client.service('external-runs').findAll({
        query: { $sort: { created_at: -1 }, $limit: 100 },
      })) as ExternalRun[];
      setRuns(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch external runs');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    fetchRuns();
    const service = client.service('external-runs');

    const upsert = (run: ExternalRun) =>
      setRuns((prev) => {
        const next = prev.some((r) => r.run_id === run.run_id)
          ? prev.map((r) => (r.run_id === run.run_id ? run : r))
          : [run, ...prev];
        return [...next].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      });
    const remove = (run: ExternalRun) =>
      setRuns((prev) => prev.filter((r) => r.run_id !== run.run_id));

    service.on('created', upsert);
    service.on('patched', upsert);
    service.on('updated', upsert);
    service.on('removed', remove);
    return () => {
      service.removeListener('created', upsert);
      service.removeListener('patched', upsert);
      service.removeListener('updated', upsert);
      service.removeListener('removed', remove);
    };
  }, [client, fetchRuns]);

  return { runs, loading, error, refetch: fetchRuns };
}

interface UseExternalRunDetailResult {
  events: ExternalRunEvent[];
  links: ExternalRunLink[];
  loading: boolean;
}

/** Fetch + subscribe to one run's event timeline and artefact links. */
export function useExternalRunDetail(
  client: AgorClient | null,
  runId: string | null
): UseExternalRunDetailResult {
  const [events, setEvents] = useState<ExternalRunEvent[]>([]);
  const [links, setLinks] = useState<ExternalRunLink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client || !runId) {
      setEvents([]);
      setLinks([]);
      return;
    }
    let active = true;
    setLoading(true);
    Promise.all([
      client
        .service('external-run-events')
        .findAll({ query: { run_id: runId, $sort: { created_at: 1 }, $limit: 1000 } }),
      client.service('external-run-links').findAll({ query: { run_id: runId, $limit: 1000 } }),
    ])
      .then(([ev, lk]) => {
        if (!active) return;
        // Untyped generic services — cast at the boundary.
        setEvents(ev as ExternalRunEvent[]);
        setLinks(lk as ExternalRunLink[]);
      })
      .finally(() => active && setLoading(false));

    const eventsService = client.service('external-run-events');
    const linksService = client.service('external-run-links');
    const onEvent = (e: ExternalRunEvent) => {
      if (e.run_id !== runId) return;
      setEvents((prev) =>
        prev.some((x) => x.event_id === e.event_id)
          ? prev
          : [...prev, e].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      );
    };
    const onLink = (l: ExternalRunLink) => {
      if (l.run_id !== runId) return;
      setLinks((prev) => (prev.some((x) => x.link_id === l.link_id) ? prev : [...prev, l]));
    };
    eventsService.on('created', onEvent);
    linksService.on('created', onLink);
    return () => {
      active = false;
      eventsService.removeListener('created', onEvent);
      linksService.removeListener('created', onLink);
    };
  }, [client, runId]);

  return { events, links, loading };
}
