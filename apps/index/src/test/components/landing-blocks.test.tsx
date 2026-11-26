// The landing page's three blocks are always on the page, so the prerender has them. The install lines under them
// appear only when the server's admin turned them on.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingBlocks } from '../../components/landing-blocks';

describe('LandingBlocks', () => {
    test('draws the three blocks', () => {
        const html = renderToStaticMarkup(<LandingBlocks showInstall={false} />);
        expect(html).toContain('Use your favorite apps');
        expect(html).toContain('Office compatible');
        expect(html).toContain('Built for data sovereignty');
        expect(html).toContain('class="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-10"');
    });

    test('tags each block with the protocols and formats behind it', () => {
        const html = renderToStaticMarkup(<LandingBlocks showInstall={false} />);
        const tags = Array.from(html.matchAll(/data-slot="badge"[^>]*>([^<]+)</g), ([, tag]) => tag);
        expect(tags).toEqual([
            'IMAP',
            'SMTP',
            'CalDAV',
            'CardDAV',
            'WebDAV',
            '.docx',
            '.xlsx',
            '.pptx',
            '.eml',
            '.vcf',
            '.ics',
        ]);
    });

    test('shows the install lines only when the setting is on', () => {
        expect(renderToStaticMarkup(<LandingBlocks showInstall={false} />)).not.toContain('curl');
        const on = renderToStaticMarkup(<LandingBlocks showInstall />);
        expect(on).toContain('Install in two lines');
        expect(on).toContain('mkdir -p /opt/eigen &amp;&amp; cd /opt/eigen\ncurl -fsSL https://eigen.is/install | sh');
    });
});
