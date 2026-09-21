// A host whose subject is state (a right-clicked chip, a right-clicked row) has none left by the time the
// picker the row opened is confirmed: choosing the row closes the menu, which nulls the item. What is
// pinned here is that the runner acts on the subject the row was run for, not on whatever the host holds
// when the dialog is confirmed.
import { expect, mock, test } from 'bun:test';
import { fileActionsFor } from '@workspace/lib/file-actions';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

type ImportCall = { calendarId: string; url?: string };
type ImportCounts = { imported: number; skipped: number; failed: number };

const calls: { imported: ImportCall[] } = { imported: [] };
const calendars = [{ id: 'cal-home', name: 'Home', color: '#222222', isDefault: true }];

const realCalendarModule = await import('@workspace/lib/calendar');
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendarModule,
    useCalendars: () => ({ data: calendars, isError: false, refetch: () => {} }),
    useCreateCalendar: () => ({ mutateAsync: async () => ({ id: 'cal-new' }) }),
    useDeleteCalendar: () => ({ mutateAsync: async () => {} }),
    useImportCalendar: () => ({
        mutateAsync: async (input: ImportCall): Promise<ImportCounts> => {
            calls.imported.push(input);
            return { imported: 1, skipped: 0, failed: 0 };
        },
    }),
}));

// One object, not a fresh literal per call: the save picker's defaults effect takes `user` as a dep.
const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({
    useAuth: () => session,
    useIsGuest: () => false,
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');
const { useFileActionRunner } = await import('../../../components/file-actions/use-file-action-runner');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/calendar; method=REQUEST',
    filename: 'Autumn market.ics',
    size: 2048,
});

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: false };

// A chip host in miniature: its subject is state, and running the row is what a menu click does.
function Host({ onDropSubject }: { onDropSubject: (drop: () => void) => void }) {
    const [held, setHeld] = useState<FileSubject | null>(subject);
    const runner = useFileActionRunner(held);
    onDropSubject(() => setHeld(null));
    const importRow = fileActionsFor(subject).find((action) => action.id === 'import-calendar');
    return createElement(
        'div',
        null,
        createElement(
            'button',
            { type: 'button', onClick: () => importRow && runner.run(importRow) },
            'Import to Calendar',
        ),
        runner.dialogs,
    );
}

async function mount() {
    calls.imported = [];
    let drop = () => {};
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(
                    PreviewContext.Provider,
                    { value: preview },
                    createElement(Host, {
                        onDropSubject: (next: () => void) => {
                            drop = next;
                        },
                    }),
                ),
            ),
        );
    });

    const click = async (label: string) => {
        const target = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
        if (!target) throw new Error(`no "${label}" button; saw ${document.body.textContent}`);
        await act(async () => {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { click, cleanup, dropSubject: () => act(async () => drop()) };
}

test('the calendar picker imports the subject its row was run for, not the host’s current one', async () => {
    const { click, cleanup, dropSubject } = await mount();
    await click('Import to Calendar');
    // The menu closes as the row is chosen, which nulls the host's subject.
    await dropSubject();

    await click('Import');
    expect(calls.imported).toEqual([
        {
            calendarId: 'cal-home',
            url: 'http://localhost/mail/owner-1/message/message-1/attachment/0/Autumn%20market.ics',
        },
    ]);
    await cleanup();
});
