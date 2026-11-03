// A backup row's buttons, such as Restore, show to a mouse user while the pointer is over the row, and Tab reaches and
// shows them.
import { test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { expectKeyboardReveal } from '@workspace/ui/test/hover-reveal';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { Button } = await import('@workspace/ui/components/button');
const { BackupArtifactRow } = await import('../../../components/admin/backup-artifact-row');

test("a backup row's buttons show on hover only for a mouse, and Tab reaches and shows them", async () => {
    await renderInDocument(
        createElement(BackupArtifactRow, {
            createdAt: new Date('2026-11-02T09:00:00Z'),
            detail: '12 MB',
            actions: createElement(Button, null, 'Restore'),
        }),
    );
    const restore = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Restore');
    if (!restore) throw new Error('the row drew no Restore button');
    expectKeyboardReveal(restore);
});
