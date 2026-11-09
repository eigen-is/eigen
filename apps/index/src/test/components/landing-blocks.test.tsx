// The landing page's three blocks are always on the page, so the prerender has them. The install line under them
// appears only when the server's admin turned it on.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingBlocks } from '../../components/landing-blocks';

describe('LandingBlocks', () => {
    test('draws the three blocks', () => {
        const html = renderToStaticMarkup(<LandingBlocks showInstall={false} />);
        expect(html).toContain('Native Sync');
        expect(html).toContain('Office Compatible');
        expect(html).toContain('Built for Data Sovereignty');
    });

    test('shows the install line only when the setting is on', () => {
        expect(renderToStaticMarkup(<LandingBlocks showInstall={false} />)).not.toContain('curl');
        const on = renderToStaticMarkup(<LandingBlocks showInstall />);
        expect(on).toContain('Install Eigen in one line');
        expect(on).toContain('curl -fsSL https://eigen.is/install | sh');
    });
});
