import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SimpleAttachmentChip } = await import('../../../components/attachment/simple-attachment-chip');

async function mountChip(props: { filename: string; mimeType?: string }) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(SimpleAttachmentChip, props));
    });
    const icon = container.querySelector('svg');
    if (!icon) throw new Error('no icon');
    await act(async () => root.unmount());
    container.remove();
    return icon.getAttribute('class') ?? '';
}

// The chip shows the file the way Drive does: the icon follows the type, not a paperclip.
test('a chip with a mime type draws the Drive icon for that type', async () => {
    expect(await mountChip({ filename: 'invoice.pdf', mimeType: 'application/pdf' })).toContain('lucide-file-type');
    expect(await mountChip({ filename: 'photo.jpg', mimeType: 'image/jpeg' })).toContain('lucide-file-image');
});

test('a chip without a mime type draws the generic file icon', async () => {
    const classes = await mountChip({ filename: 'notes.bin' });
    expect(classes).toContain('lucide-file ');
    expect(classes).not.toContain('lucide-paperclip');
});

test('a chip resolves an app format from the name alone', async () => {
    expect(await mountChip({ filename: 'team.vcf' })).toContain('lucide-users-round');
});
