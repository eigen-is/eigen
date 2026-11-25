// A people field says whether it holds typed text, so its form counts that text as a change, and commits that text on
// the form's Save: the person added is returned, so the form saves them in the same submit, or the reason they are
// refused is returned and shown. A person already in the
// list is refused the same way in every field, with no host of its own deciding.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useContacts: () => ({ data: [] }) }));

const { act, createElement } = await import('react');
const { useContactInput } = await import('../../../components/contacts/use-contact-input');

let unmount = async () => {};
afterEach(() => unmount());

const onAdd = mock((_contact: { email: string; displayName?: string }) => undefined);

async function mount(listed: readonly string[] = []) {
    onAdd.mockClear();
    const hook: { current?: ReturnType<typeof useContactInput> } = {};
    function Harness() {
        hook.current = useContactInput({ listed, onAdd });
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    const current = () => {
        if (!hook.current) throw new Error('hook has not rendered');
        return hook.current;
    };
    return {
        current,
        type: (value: string) => act(async () => current().handleChange(value)),
        commit: async () => {
            let committed: ReturnType<ReturnType<typeof useContactInput>['commitTyped']> | undefined;
            await act(async () => {
                committed = current().commitTyped();
            });
            return committed;
        },
    };
}

test('hasText says whether the field holds typed text', async () => {
    const field = await mount();
    expect(field.current().hasText).toBe(false);
    await field.type('  ');
    expect(field.current().hasText).toBe(false);
    await field.type('ada@');
    expect(field.current().hasText).toBe(true);
});

test('commitTyped adds the typed person, returns them and empties the field', async () => {
    const field = await mount();
    await field.type('Ada@Example.org');
    expect(await field.commit()).toEqual({ added: { email: 'ada@example.org', displayName: undefined } });
    expect(onAdd.mock.calls).toEqual([[{ email: 'ada@example.org', displayName: undefined }]]);
    expect([field.current().value, field.current().hasText, field.current().error]).toEqual(['', false, undefined]);
});

test('commitTyped on an empty field adds nobody and refuses nothing', async () => {
    const field = await mount();
    expect(await field.commit()).toEqual({});
    expect(onAdd).not.toHaveBeenCalled();
});

test('commitTyped returns and shows the reason it refuses, and keeps the text', async () => {
    const field = await mount();
    await field.type('ada@');
    expect(await field.commit()).toEqual({ refused: 'Enter a valid email address' });
    expect([field.current().value, field.current().error]).toEqual(['ada@', 'Enter a valid email address']);
});

test('a person already in the list is refused with their address, whatever its case', async () => {
    const field = await mount(['Ada@example.org']);
    await field.type('ada@example.org');
    expect(await field.commit()).toEqual({ refused: 'ada@example.org is already in the list' });
    expect(field.current().error).toBe('ada@example.org is already in the list');
    expect(onAdd).not.toHaveBeenCalled();
});
