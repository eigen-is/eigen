// A text file saves only what changed, against the version it was opened at: a save sends that version's
// etag, and the next save the one the server answered. A file someone else changed meanwhile opens the conflict
// dialog instead of being overwritten, unless the user forces it. A failed save stays unsaved, and an
// unsaved file asks before its Cancel closes it.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { EditorSaveResult } from '@workspace/lib/types/file-kinds';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type SaveParams = { content: string; frontmatter?: string; expectedEtag: string; force: boolean };
const openedEtag = '"opened"';
const savedEtag = '"saved"';
const answers: (EditorSaveResult | Error)[] = [];
let held: Promise<void> | undefined;
// One object, so the hook's save callback keeps its identity across renders.
const fileSave = {
    mutateAsync: mock(async (_params: SaveParams): Promise<EditorSaveResult> => {
        await held;
        const answer = answers.shift() ?? { conflict: false, etag: savedEtag };
        if (answer instanceof Error) throw answer;
        return answer;
    }),
};
// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realEditor = { ...(await import('@workspace/lib/editor')) };
mock.module('@workspace/lib/editor', () => ({ ...realEditor, useFileSave: () => fileSave }));
afterAll(() => {
    mock.module('@workspace/lib/editor', () => realEditor);
});

const { act, createElement } = await import('react');
const { useEditorSave } = await import('../../../components/editor/use-editor-save');

let content = 'first draft';
const close = mock(() => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    content = 'first draft';
    answers.length = 0;
    held = undefined;
    fileSave.mutateAsync.mockClear();
    close.mockClear();
});

async function renderSave() {
    const current: { save?: ReturnType<typeof useEditorSave> } = {};
    function Probe() {
        current.save = useEditorSave({
            ownerId: 'owner-1',
            mountId: 'mount-1',
            pathId: 'file-1',
            etag: openedEtag,
            getContent: () => content,
            getFrontmatter: () => 'title: Notes',
            onCancel: close,
        });
        return current.save.discardDialog;
    }
    ({ unmount } = await renderInDocument(createElement(Probe)));
    const save = () => {
        if (!current.save) throw new Error('the hook never rendered');
        return current.save;
    };
    return save;
}

const asking = () => document.body.textContent?.includes('Discard changes?') ?? false;
const click = (name: string) =>
    act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === name)?.click());

test('a file with no change saves nothing', async () => {
    const save = await renderSave();
    let saved = false;
    await act(async () => {
        saved = await save().doSave();
    });
    expect(saved).toBe(true);
    expect(fileSave.mutateAsync).not.toHaveBeenCalled();
    expect(save().saveState).toBe('saved');
});

test('a change saves against the opened version, and the next save against the saved one', async () => {
    const save = await renderSave();
    await act(async () => save().markDirty());
    expect(save().saveState).toBe('unsaved');
    await act(async () => {
        await save().doSave();
    });
    expect(save().saveState).toBe('saved');

    content = 'second draft';
    await act(async () => save().markDirty());
    await act(async () => {
        await save().doSave();
    });
    expect(fileSave.mutateAsync.mock.calls).toEqual([
        [{ content: 'first draft', frontmatter: 'title: Notes', expectedEtag: openedEtag, force: false }],
        [{ content: 'second draft', frontmatter: 'title: Notes', expectedEtag: savedEtag, force: false }],
    ]);
});

test('a file changed elsewhere opens the conflict dialog and stays unsaved', async () => {
    answers.push({ conflict: true, currentEtag: '"theirs"' });
    const save = await renderSave();
    await act(async () => save().markDirty());
    let saved = true;
    await act(async () => {
        saved = await save().doSave();
    });
    expect(saved).toBe(false);
    expect(save().saveState).toBe('conflict');
    expect(save().showConflict).toBe(true);

    // Overwrite forces the same edit through, against the version the editor still holds.
    await act(async () => {
        saved = await save().doSave(true);
    });
    expect(saved).toBe(true);
    expect(fileSave.mutateAsync.mock.calls[1]).toEqual([
        { content: 'first draft', frontmatter: 'title: Notes', expectedEtag: openedEtag, force: true },
    ]);
});

test('a save that fails stays unsaved, so the next try sends it again', async () => {
    answers.push(new Error('offline'));
    const save = await renderSave();
    await act(async () => save().markDirty());
    await act(async () => {
        await save().doSave();
    });
    expect(save().saveState).toBe('unsaved');
    await act(async () => {
        await save().doSave();
    });
    expect(fileSave.mutateAsync).toHaveBeenCalledTimes(2);
    expect(save().saveState).toBe('saved');
});

test('Cancel on a clean file closes at once, and on an unsaved one asks first', async () => {
    const save = await renderSave();
    await act(async () => save().cancel());
    expect(close).toHaveBeenCalledTimes(1);

    await act(async () => save().markDirty());
    await act(async () => save().cancel());
    expect(close).toHaveBeenCalledTimes(1);
    expect(asking()).toBe(true);

    await click('Keep editing');
    expect(asking()).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    await act(async () => save().cancel());
    await click('Discard');
    expect(close).toHaveBeenCalledTimes(2);
});

test('an edit typed while a save is in flight stays unsaved after it lands', async () => {
    let release = () => {};
    held = new Promise((resolve) => {
        release = resolve;
    });
    const save = await renderSave();
    await act(async () => save().markDirty());
    let saving: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
        saving = save().doSave();
    });
    expect(save().saveState).toBe('saving');

    content = 'second draft';
    await act(async () => save().markDirty());
    let saved = true;
    await act(async () => {
        release();
        saved = await saving;
    });
    expect(saved).toBe(false);
    expect(save().saveState).toBe('unsaved');

    await act(async () => save().cancel());
    expect(close).not.toHaveBeenCalled();
    expect(asking()).toBe(true);
});

test('Cancel while a save is in flight asks first, since that save may still fail', async () => {
    held = new Promise(() => {});
    const save = await renderSave();
    await act(async () => save().markDirty());
    await act(async () => {
        save().doSave();
    });
    expect(save().saveState).toBe('saving');

    await act(async () => save().cancel());
    expect(close).not.toHaveBeenCalled();
    expect(asking()).toBe(true);
});
