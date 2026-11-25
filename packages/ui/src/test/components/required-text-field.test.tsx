// A required field says nothing while the form is fresh, shows its message under it once Save was pressed with it
// blank, and shows a reason from elsewhere, such as a taken name, the same way.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, useState } = await import('react');
const { FormShell } = await import('../../components/form-shell');
const { RequiredTextField } = await import('../../components/required-text-field');
const { field, type } = await import('../form-contract');

let unmount = async () => {};
afterEach(() => unmount());

function Form({ error, disabled }: { error?: string; disabled?: boolean }) {
    const [name, setName] = useState('');
    return (
        <FormShell onSubmit={() => (name.trim() ? undefined : false)}>
            <RequiredTextField
                label="Name"
                value={name}
                onChange={setName}
                message="Add a name"
                error={error}
                disabled={disabled}
            />
            <button type="submit">Save</button>
        </FormShell>
    );
}

const save = () => act(async () => document.querySelector<HTMLButtonElement>('button')?.click());
const messageUnder = (label: string) => {
    const id = field(label).getAttribute('aria-describedby');
    return id ? document.getElementById(id)?.textContent : undefined;
};

test('a blank name says so only once Save was pressed, and gets the focus', async () => {
    ({ unmount } = await renderInDocument(<Form />));
    expect(field('Name').getAttribute('aria-invalid')).toBeNull();
    expect(messageUnder('Name')).toBeUndefined();

    await save();
    expect(field('Name').getAttribute('aria-invalid')).toBe('true');
    expect(messageUnder('Name')).toBe('Add a name');
    expect(document.activeElement).toBe(field('Name'));

    await type('Name', 'Plans');
    expect(messageUnder('Name')).toBeUndefined();
});

test('a reason from elsewhere shows under the field before Save', async () => {
    ({ unmount } = await renderInDocument(<Form error="A chat with this name exists" />));
    expect(field('Name').getAttribute('aria-invalid')).toBe('true');
    expect(messageUnder('Name')).toBe('A chat with this name exists');
});

test('a field the user may not change asks for nothing', async () => {
    ({ unmount } = await renderInDocument(<Form disabled />));
    await save();
    expect(field('Name').getAttribute('aria-invalid')).toBeNull();
    expect(messageUnder('Name')).toBeUndefined();
});
