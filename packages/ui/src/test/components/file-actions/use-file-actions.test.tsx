// The one place the user reaches the registry: an import route refuses a guest (requireNonGuest), and
// `applies` is handed the file, never who is asking — so the hook every menu and the quick-look footer
// read their rows from is where the guest rule lives.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const guest = { is: false };
mock.module('@workspace/lib/auth', () => ({ useIsGuest: () => guest.is }));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useFileActions } = await import('../../../components/file-actions/use-file-actions');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/vcard',
    filename: 'team.vcf',
    size: 2048,
});
const message = subjectFromMailAttachment('owner-1', 'message-1', 1, {
    contentType: 'application/octet-stream',
    filename: 'fwd.eml',
    size: 2048,
});

async function idsFor(...args: Parameters<typeof useFileActions>): Promise<string[]> {
    const seen: { ids: string[] } = { ids: [] };
    function Harness() {
        seen.ids = useFileActions(...args).map((action) => action.id);
        return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(Harness, null));
    });
    await act(() => root.unmount());
    return seen.ids;
}

test('a signed-in user gets every row the registry approves', async () => {
    guest.is = false;
    expect(await idsFor(subject)).toEqual(['quick-look', 'download', 'save-to-drive', 'import-contacts']);
    expect(await idsFor(message)).toEqual(['quick-look', 'download', 'save-to-drive', 'import-mail']);
});

test('a guest gets no import row, on either format', async () => {
    guest.is = true;
    expect(await idsFor(subject)).toEqual(['quick-look', 'download', 'save-to-drive']);
    expect(await idsFor(message)).toEqual(['quick-look', 'download', 'save-to-drive']);
});

test('the host’s own exclusions still apply, guest or not', async () => {
    guest.is = false;
    expect(await idsFor(subject, ['quick-look'])).toEqual(['download', 'save-to-drive', 'import-contacts']);
    guest.is = true;
    expect(await idsFor(subject, ['quick-look'])).toEqual(['download', 'save-to-drive']);
});

// A host whose subject is state (the right-clicked chip) mounts the hook before anything is picked.
test('no subject, no rows', async () => {
    guest.is = false;
    expect(await idsFor(null)).toEqual([]);
});
