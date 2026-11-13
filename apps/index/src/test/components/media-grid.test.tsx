// A caption that names an app sets the name in the class the site's prose gives app names, the same as the Markdown.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaGrid } from '../../components/media-grid';

describe('MediaGrid', () => {
    test('sets an app name in a caption apart and keeps the alt text plain', () => {
        const html = renderToStaticMarkup(
            <MediaGrid
                columns="2"
                items={[{ src: '/mail.png', type: 'image', caption: 'The inbox of eigen|mail⟩' }]}
            />,
        );
        expect(html).toContain('The inbox of <span class="ket-name">eigen|mail⟩</span>');
        expect(html).toContain('alt="The inbox of eigen|mail⟩"');
    });

    test('leaves a caption without a name as text', () => {
        const html = renderToStaticMarkup(<MediaGrid items={[{ src: '/a.png', type: 'image', caption: 'A chart' }]} />);
        expect(html).toContain('>A chart</p>');
        expect(html).not.toContain('ket-name');
    });
});
