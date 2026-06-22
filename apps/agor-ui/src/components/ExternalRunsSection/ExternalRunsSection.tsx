/**
 * External Runs lane — renders native-harness work (Claude Code, Codex) logged
 * back to Agor as first-class External Runs, separate from native sessions.
 * Master list → detail (event timeline + linked artefacts + KB summary).
 * See docs/internal/external-runs-design-2026-06-22.md §5.
 */

import type { AgorClient, ExternalRun, ExternalRunStatus } from '@agor-live/client';
import { Button, Empty, List, Space, Spin, Tag, Timeline, Typography } from 'antd';
import { useState } from 'react';
import { useExternalRunDetail, useExternalRuns } from '../../hooks/useExternalRuns';

const { Text, Title, Link: AntLink } = Typography;

const STATUS_COLOR: Record<ExternalRunStatus, string> = {
  running: 'processing',
  completed: 'success',
  failed: 'error',
  abandoned: 'default',
};

const EVENT_COLOR: Record<string, string> = {
  start: 'blue',
  progress: 'gray',
  checkpoint: 'green',
  link: 'cyan',
  summary: 'purple',
  complete: 'green',
  error: 'red',
};

function when(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isHttp(ref: string): boolean {
  return ref.startsWith('http://') || ref.startsWith('https://');
}

interface Props {
  client: AgorClient | null;
}

export function ExternalRunsSection({ client }: Props) {
  const { runs, loading, error } = useExternalRuns(client);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = runs.find((r) => r.run_id === selectedRunId) ?? null;

  if (error) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Failed to load: ${error}`} />;
  }

  if (selectedRun) {
    return (
      <ExternalRunDetail client={client} run={selectedRun} onBack={() => setSelectedRunId(null)} />
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '8px 4px' }}>
      {loading && runs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : runs.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No external runs yet. Native Claude Code / Codex sessions log back here."
        />
      ) : (
        <List
          size="small"
          dataSource={runs}
          renderItem={(run) => (
            <List.Item
              style={{ cursor: 'pointer', padding: '8px 12px' }}
              onClick={() => setSelectedRunId(run.run_id)}
            >
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space size={6} style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text strong ellipsis style={{ maxWidth: 200 }}>
                    {run.title}
                  </Text>
                  <Tag color={STATUS_COLOR[run.status]}>{run.status}</Tag>
                </Space>
                <Space size={6}>
                  <Tag>{run.harness}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {when(run.created_at)}
                  </Text>
                </Space>
              </Space>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

interface DetailProps {
  client: AgorClient | null;
  run: ExternalRun;
  onBack: () => void;
}

function ExternalRunDetail({ client, run, onBack }: DetailProps) {
  const { events, links, loading } = useExternalRunDetail(client, run.run_id);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '8px 12px' }}>
      <Button type="link" size="small" onClick={onBack} style={{ paddingLeft: 0 }}>
        ← All runs
      </Button>

      <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 12 }}>
        <Space size={6} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={5} style={{ margin: 0 }}>
            {run.title}
          </Title>
          <Tag color={STATUS_COLOR[run.status]}>{run.status}</Tag>
        </Space>
        <Space size={6} wrap>
          <Tag>{run.harness}</Tag>
          {run.primary_anchor_type && <Tag color="geekblue">anchor: {run.primary_anchor_type}</Tag>}
          {run.data?.git_branch && <Text type="secondary">{run.data.git_branch}</Text>}
        </Space>
        {run.summary_document_id && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Summary: <Text code>{run.summary_document_id}</Text>
          </Text>
        )}
      </Space>

      {links.length > 0 && (
        <>
          <Text strong style={{ fontSize: 12 }}>
            Linked artefacts
          </Text>
          <List
            size="small"
            dataSource={links}
            style={{ marginBottom: 12 }}
            renderItem={(link) => (
              <List.Item style={{ padding: '4px 0' }}>
                <Space size={6}>
                  <Tag color={link.relationship === 'primary' ? 'gold' : 'default'}>
                    {link.target_kind}
                  </Tag>
                  {isHttp(link.target_ref) ? (
                    <AntLink href={link.target_ref} target="_blank" style={{ fontSize: 12 }}>
                      {link.target_ref}
                    </AntLink>
                  ) : (
                    <Text style={{ fontSize: 12 }}>{link.target_ref}</Text>
                  )}
                </Space>
              </List.Item>
            )}
          />
        </>
      )}

      <Text strong style={{ fontSize: 12 }}>
        Timeline
      </Text>
      {loading && events.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 16 }}>
          <Spin size="small" />
        </div>
      ) : events.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No events" />
      ) : (
        <Timeline
          style={{ marginTop: 8 }}
          items={events.map((e) => ({
            color: EVENT_COLOR[e.event_type] ?? 'gray',
            children: (
              <Space direction="vertical" size={0}>
                <Text style={{ fontSize: 13 }}>
                  <Text type="secondary">[{e.event_type}]</Text> {e.body?.message ?? ''}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {when(e.created_at)}
                </Text>
              </Space>
            ),
          }))}
        />
      )}
    </div>
  );
}

export default ExternalRunsSection;
