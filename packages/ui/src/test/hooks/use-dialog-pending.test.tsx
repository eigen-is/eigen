// A dialog's action that returns or resolves false keeps it open, and any other result closes it. An action that throws
// an error no toast has shown, such as a bug in a synchronous submit, reaches whoever called run, and the dialog stays
// open. An error the mutation hook toasted ends there.
import { afterEach, expect, mock, test } from 'bun:test';
import type { DialogAction } from '../../hooks/use-dialog-pending';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { useDialogPending } = await import('../../hooks/use-dialog-pending');

let unmount = async () => {};
afterEach(() => unmount());

async function mount(closeOnRefusal: boolean) {
    const onOpenChange = mock((_open: boolean) => {});
    let latest: ReturnType<typeof useDialogPending> | null = null;
    function Harness() {
        latest = useDialogPending(onOpenChange, { closeOnRefusal });
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    const run = async (action: DialogAction) => {
        const pending = latest;
        if (!pending) throw new Error('hook has not rendered');
        let outcome: unknown = 'resolved';
        await act(() => pending.run(action).catch((error: unknown) => (outcome = error)));
        return outcome;
    };
    return { onOpenChange, run };
}

const refusal = () => new AppError({ error: { status: 403, value: 'No' }, status: 403 });

test('an action that returns or resolves false keeps the dialog open, and one that resolves closes it', async () => {
    const { onOpenChange, run } = await mount(false);
    await run(() => false);
    await run(() => Promise.resolve(false));
    expect(onOpenChange).not.toHaveBeenCalled();
    await run(() => Promise.resolve());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a synchronous throw reaches the caller, and the dialog stays open', async () => {
    const { onOpenChange, run } = await mount(false);
    const bug = new TypeError('editor is gone');
    expect(
        await run(() => {
            throw bug;
        }),
    ).toBe(bug);
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('a toasted failure ends in run, and the dialog stays open', async () => {
    const { onOpenChange, run } = await mount(false);
    const failure = new Error('offline');
    onMutationError(failure);
    expect(await run(() => Promise.reject(failure))).toBe('resolved');
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('with closeOnRefusal a toasted refusal closes the dialog and ends in run', async () => {
    const { onOpenChange, run } = await mount(true);
    const failure = refusal();
    onMutationError(failure);
    expect(await run(() => Promise.reject(failure))).toBe('resolved');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('with closeOnRefusal a refusal no toast showed closes the dialog and still reaches the caller', async () => {
    const { onOpenChange, run } = await mount(true);
    const failure = refusal();
    expect(await run(() => Promise.reject(failure))).toBe(failure);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
