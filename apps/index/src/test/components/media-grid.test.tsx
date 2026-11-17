// A caption that names an app sets the name in the class the site's prose gives app names, the same as the Markdown.
import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The grid's module loads the lightbox's dialog, which reads the DOM globals as it loads and keeps what it found for
// every later test file in the process.
installHappyDom();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MediaGrid } = await import('../../components/media-grid');

describe('MediaGrid', () => {
    test('sets an app name in a caption apart, and the caption alone names the thumbnail', () => {
        const html = renderToStaticMarkup(
            <MediaGrid
                columns="2"
                onOpen={() => {}}
                items={[{ src: '/mail.png', type: 'image', caption: 'The inbox of eigen|mail⟩' }]}
            />,
        );
        expect(html).toContain('The inbox of <span class="ket-name">eigen|mail⟩</span>');
        expect(html).toContain('alt=""');
    });

    test('leaves a caption without a name as text', () => {
        const html = renderToStaticMarkup(
            <MediaGrid columns="2" items={[{ src: '/a.png', type: 'image', caption: 'A chart' }]} onOpen={() => {}} />,
        );
        expect(html).toContain('>A chart</p>');
        expect(html).not.toContain('ket-name');
    });
});
