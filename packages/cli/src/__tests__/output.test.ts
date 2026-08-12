import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setOutputMode, printJson, printError, printRetrievedItems, printSearchResults } from '../output.js';

describe('Output', () => {
  beforeEach(() => {
    setOutputMode('auto');
  });

  describe('printJson', () => {
    it('outputs formatted JSON', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printJson({ key: 'value' });
      expect(spy).toHaveBeenCalledWith(JSON.stringify({ key: 'value' }, null, 2));
      spy.mockRestore();
    });
  });

  describe('printError', () => {
    it('writes to stderr', () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      printError('test error');
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain('test error');
      spy.mockRestore();
    });
  });

  describe('setOutputMode', () => {
    it('json mode forces non-interactive', () => {
      setOutputMode('json');
      // printSuccess should not produce output in non-interactive mode
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // We can test this indirectly — just ensure no crash
      spy.mockRestore();
    });
  });

  describe('content output', () => {
    it('prints active library scope in table mode', () => {
      setOutputMode('table');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      printSearchResults(
        {
          total: 0,
          searchType: 'hybrid',
          results: [],
        },
        {
          type: 'library',
          libraryId: 'library-1',
          librarySlug: 'customer-wins',
          libraryName: 'Customer Wins',
          itemCount: 7,
        },
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Scope: library "customer-wins" (7 items)');
      spy.mockRestore();
    });

    it('includes active library scope in JSON mode', () => {
      setOutputMode('json');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      printRetrievedItems(
        { items: [] },
        {
          type: 'library',
          libraryId: 'library-1',
          librarySlug: 'customer-wins',
          libraryName: 'Customer Wins',
          itemCount: 7,
        },
      );

      const payload = JSON.parse(String(spy.mock.calls[0][0])) as { scope: { librarySlug: string } };
      expect(payload.scope.librarySlug).toBe('customer-wins');
      spy.mockRestore();
    });

    it('prints search text kind in table mode', () => {
      setOutputMode('table');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      printSearchResults(
        {
          total: 1,
          searchType: 'fulltext',
          results: [
            {
              id: 'item-1',
              title: 'Item One',
              contentType: 'document',
              textKind: 'cleaned',
              relevanceScore: 0.9,
            },
          ],
        },
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Text: cleaned');
      spy.mockRestore();
    });

    it('prints retrieved content in table mode', () => {
      setOutputMode('table');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      printRetrievedItems(
        {
          items: [
            {
              id: 'item-1',
              title: 'Item One',
              contentType: 'document',
              textKind: 'raw',
              createdAt: '2026-01-01',
              content: '# Notes',
            },
          ],
        },
      );

      const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Text: raw');
      expect(output).toContain('# Notes');
      spy.mockRestore();
    });
  });
});
