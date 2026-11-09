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
        expect(body.html).toContain('9.9.9'); // version heading retained
        expect(body.html).toContain('Added'); // section retained
        expect(body.mediaGrids).toEqual([]); // changelog has no media grids
    });

    test('renders the whole input when there is no version heading', () => {
        const body = renderChangelog('# Changelog\n\nNothing yet.\n');
        expect(body.html).toContain('Nothing yet');
        expect(body.mediaGrids).toEqual([]);
    });

    describe('release headings', () => {
        const body = renderChangelog(`## [Unreleased]

### Added

- **New** — thing

## [0.4.2] - 2026-11-03

### Fixed

- **Old** — thing
`);

        test('a dated version shows its number and a day-month-year time, keeping its id and anchor', () => {
            expect(body.html).toMatch(
                /<h2 id="042---2026-11-03" class="release-head"><span class="ver">0\.4\.2<\/span><time datetime="2026-11-03">3 Nov 2026<\/time> <a class="heading-anchor"/,
            );
        });

        test('Unreleased says it is not in a release yet', () => {
            expect(body.html).toContain('<span class="ver">Unreleased</span><time>Not in a release yet</time>');
        });

        test('each version sits in its own release section', () => {
            expect(body.html.match(/<section class="release">/g)).toHaveLength(2);
            expect(body.html.match(/<\/section>/g)).toHaveLength(2);
            expect(body.html.indexOf('<section class="release"><h2')).toBeGreaterThanOrEqual(0);
        });

        test('lists the versions with a short date, none for Unreleased', () => {
            expect(body.versions).toEqual([
                { id: 'unreleased', version: 'Unreleased' },
                { id: '042---2026-11-03', version: '0.4.2', date: '3 Nov' },
            ]);
        });

        test('h3 labels carry no id and no anchor', () => {
            expect(body.html).toContain('<h3>Added</h3>');
            expect(body.html).toContain('<h3>Fixed</h3>');
        });
    });

    describe('lead titles', () => {
        const html = (entries: string) => renderChangelog(`## [1.0.0] - 2026-01-01\n\n### Added\n\n${entries}\n`).html;

        test('a bold title before a dash becomes a lead, the dash is dropped and the text starts with a capital', () => {
            expect(html('- **Title** — some text.')).toContain('<strong class="lead">Title</strong> Some text.');
        });

        test('an entry that ends without punctuation gets a final period', () => {
            expect(html('- **Title** — some text')).toContain('Some text.</li>');
            expect(html('- **Title** — some `code`')).toContain('Some <code>code</code>.</li>');
        });

        test('an entry that ends with punctuation keeps it', () => {
            expect(html('- **Title** — is it?')).toContain('Is it?</li>');
            expect(html('- **Title** — wow!')).toContain('Wow!</li>');
        });

        test('a loose entry gets the period inside its paragraph', () => {
            const out = html('- **A** — first\n\n- **B** — second\n\n  more');
            expect(out).toContain('<p><strong class="lead">A</strong> First.</p>');
            expect(out).toContain('<p><strong class="lead">B</strong> Second.</p>');
        });

        test('an entry without a lead is left alone', () => {
            expect(html('- plain text')).toContain('<li>plain text</li>');
        });
    });
});
