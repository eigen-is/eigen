import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileDropOverlay } from '../../components/file-drop-overlay';
import { CANVAS_PAPER_CLASS } from '../../components/vector/paper';

describe('FileDropOverlay', () => {
    test('the drop treatment follows the app theme by default', () => {
        const html = renderToStaticMarkup(<FileDropOverlay visible label="Drop files to upload" />);
        expect(html).toContain('border-primary');
        expect(html).toContain('Drop files to upload');
        expect(html).not.toContain(CANVAS_PAPER_CLASS);
    });

    test('a caller class pins it, so a canvas can dress its page instead of the app theme', () => {
        const html = renderToStaticMarkup(
            <FileDropOverlay visible label="Drop images to add" className={CANVAS_PAPER_CLASS} />,
        );
        expect(html).toContain(CANVAS_PAPER_CLASS);
        expect(html).toContain('border-primary');
    });
});
