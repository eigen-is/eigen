import { describe, expect, test } from 'bun:test';
import { renderChangelog } from '../../../scripts/build-changelog';

describe('renderChangelog', () => {
    const sample = `# Changelog

All notable user-visible changes are documented here.

## [9.9.9] - 2026-01-01

### Added

- **Thing** — did a thing
`;

    test('drops the leading H1 + intro and renders from the first version heading', () => {
        const body = renderChangelog(sample);
        expect(body.html).not.toContain('<h1'); // "# Changelog" stripped
        expect(body.html).not.toContain('All notable'); // intro stripped
        expect(body.html).toContain('<h2'); // versions render as h2
        expect(body.html).toContain('[9.9.9]'); // version heading retained
        expect(body.html).toContain('Added'); // section retained
        expect(body.mediaGrids).toEqual([]); // changelog has no media grids
    });

    test('renders the whole input when there is no version heading', () => {
        const body = renderChangelog('# Changelog\n\nNothing yet.\n');
        expect(body.html).toContain('Nothing yet');
        expect(body.mediaGrids).toEqual([]);
    });
});
