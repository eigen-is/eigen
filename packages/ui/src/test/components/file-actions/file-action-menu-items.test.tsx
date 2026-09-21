import { expect, test } from 'bun:test';
import { fileActionsFor } from '@workspace/lib/file-actions';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import type { FileAction, FileSubject } from '@workspace/lib/types/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DropdownMenu, DropdownMenuContent } = await import('../../../components/dropdown-menu');
const { FileActionMenuItems } = await import('../../../components/file-actions/file-action-menu-items');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/vcard',
    filename: 'team.vcf',
    size: 2048,
});

async function openMenu(props: { subject: FileSubject | null }) {
    const ran: FileAction[] = [];
    const runner = {
        subject: props.subject,
        // The host's hook decides which rows a viewer gets; the menu draws what it is handed.
        actions: props.subject ? fileActionsFor(props.subject) : [],
        run: (action: FileAction) => ran.push(action),
        openPicker: () => {},
        dialogs: null,
        isDialogOpen: false,
        isPending: false,
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                DropdownMenu,
                { open: true },
                createElement(DropdownMenuContent, null, createElement(FileActionMenuItems, { runner })),
            ),
        );
    });

    const rows = [...document.querySelectorAll('[role="menuitem"]')];
    const labels = rows.map((row) => row.textContent?.trim() ?? '');
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { rows, labels, ran, cleanup };
}

test('draws every row the registry allows, in its order', async () => {
    const { labels, cleanup } = await openMenu({ subject });
    expect(labels).toEqual(['Quick preview', 'Download', 'Save to Drive…', 'Import to Contacts']);
    await cleanup();
});

// A calendar part carries no filename, so its media type is what the registry reads.
test('an invitation part offers the calendar import', async () => {
    const invite = subjectFromMailAttachment('owner-1', 'message-1', 1, {
        contentType: 'text/calendar; method=REQUEST; charset=utf-8',
        size: 2048,
    });
    const { labels, cleanup } = await openMenu({ subject: invite });
    expect(labels).toEqual(['Quick preview', 'Download', 'Save to Drive…', 'Import to Calendar']);
    await cleanup();
});

test('a clicked row runs its action', async () => {
    const { rows, ran, cleanup } = await openMenu({ subject });
    await act(async () => {
        rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(ran.map((action) => action.id)).toEqual(['quick-look']);
    await cleanup();
});

// The chip's subject is state: the host mounts the runner before anything is right-clicked.
test('draws nothing without a subject', async () => {
    const { labels, cleanup } = await openMenu({ subject: null });
    expect(labels).toEqual([]);
    await cleanup();
});
