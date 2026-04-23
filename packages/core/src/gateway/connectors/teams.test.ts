import { beforeAll, describe, expect, it } from 'vitest';
import { parseThreadId, stripMention, TeamsConnector } from './teams';

describe('parseThreadId', () => {
  it('parses a valid thread ID', () => {
    const result = parseThreadId('19:abc123@thread.tacv2|1234567890');
    expect(result).toEqual({
      conversationId: '19:abc123@thread.tacv2',
      activityId: '1234567890',
    });
  });

  it('handles conversationId with special characters', () => {
    const result = parseThreadId('19:meeting_abc123@thread.v2|f:abc-def-123');
    expect(result).toEqual({
      conversationId: '19:meeting_abc123@thread.v2',
      activityId: 'f:abc-def-123',
    });
  });

  it('handles multiple pipes (splits on last pipe)', () => {
    const result = parseThreadId('a|b|c|d');
    expect(result).toEqual({
      conversationId: 'a|b|c',
      activityId: 'd',
    });
  });

  it('handles simple format', () => {
    const result = parseThreadId('conv123|act456');
    expect(result).toEqual({
      conversationId: 'conv123',
      activityId: 'act456',
    });
  });

  it('throws on missing pipe', () => {
    expect(() => parseThreadId('nopipehere')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty conversationId', () => {
    expect(() => parseThreadId('|activityId')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty activityId', () => {
    expect(() => parseThreadId('conversationId|')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty string', () => {
    expect(() => parseThreadId('')).toThrow('Invalid Teams thread ID format');
  });
});

describe('stripMention', () => {
  it('strips mention at the beginning', () => {
    expect(stripMention('<at>TestBot</at> hello world', 'TestBot')).toBe('hello world');
  });

  it('strips mention in the middle', () => {
    expect(stripMention('hey <at>TestBot</at> do something', 'TestBot')).toBe('hey do something');
  });

  it('strips multiple mentions', () => {
    expect(stripMention('<at>TestBot</at> hello <at>TestBot</at> world', 'TestBot')).toBe(
      'hello world'
    );
  });

  it('is case-insensitive', () => {
    expect(stripMention('<at>testbot</at> hello', 'TestBot')).toBe('hello');
    expect(stripMention('<AT>TestBot</AT> hello', 'TestBot')).toBe('hello');
  });

  it('returns original text when no mention found', () => {
    expect(stripMention('hello world', 'TestBot')).toBe('hello world');
  });

  it('handles empty text', () => {
    expect(stripMention('', 'TestBot')).toBe('');
  });

  it('handles regex special characters in bot name', () => {
    expect(stripMention('<at>Bot (Test)</at> hello', 'Bot (Test)')).toBe('hello');
  });
});

describe('TeamsConnector', () => {
  it('throws if app_id is missing', () => {
    expect(() => new TeamsConnector({ app_password: 'secret' })).toThrow(
      'Teams connector requires app_id in config'
    );
  });

  it('throws if app_password is missing', () => {
    expect(() => new TeamsConnector({ app_id: 'test-id' })).toThrow(
      'Teams connector requires app_password in config'
    );
  });

  it('creates connector with valid config', () => {
    const connector = new TeamsConnector({
      app_id: 'test-id',
      app_password: 'test-secret',
    });
    expect(connector.channelType).toBe('teams');
  });

  describe('formatMessage', () => {
    let connector: TeamsConnector;

    beforeAll(() => {
      connector = new TeamsConnector({
        app_id: 'test-id',
        app_password: 'test-secret',
      });
    });

    it('passes through standard markdown', () => {
      const input = '**bold** and _italic_ and `code`';
      expect(connector.formatMessage!(input)).toBe(input);
    });

    it('preserves code blocks', () => {
      const input = '```typescript\nconst x = 1;\n```';
      expect(connector.formatMessage!(input)).toBe(input);
    });

    it('collapses details/summary blocks', () => {
      const input =
        '<details>\n<summary>Click to expand</summary>\nHidden content here\n</details>';
      const output = connector.formatMessage!(input);
      expect(output).toContain('**Click to expand**');
      expect(output).toContain('Hidden content here');
      expect(output).not.toContain('<details>');
      expect(output).not.toContain('<summary>');
    });

    it('strips HTML tags', () => {
      const input = '<p>Hello</p> <b>World</b>';
      expect(connector.formatMessage!(input)).toBe('Hello World');
    });

    it('handles empty input', () => {
      expect(connector.formatMessage!('')).toBe('');
    });

    it('handles a realistic agent response', () => {
      const input = [
        '## Summary',
        '',
        'I made the following changes:',
        '',
        '- **Fixed** the login bug in `auth.ts`',
        '- Updated the documentation',
        '',
        '```typescript',
        'const user = await authenticate(token);',
        '```',
        '',
        '<details>',
        '<summary>Full diff</summary>',
        '+ added line',
        '- removed line',
        '</details>',
      ].join('\n');

      const output = connector.formatMessage!(input);

      // Markdown preserved
      expect(output).toContain('## Summary');
      expect(output).toContain('**Fixed**');
      expect(output).toContain('`auth.ts`');

      // Code block preserved
      expect(output).toContain('```typescript');

      // Details collapsed
      expect(output).toContain('**Full diff**');
      expect(output).not.toContain('<details>');
    });
  });
});
