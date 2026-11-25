// First-run setup keeps the page contract and completes with the trimmed organization name and the lowercase
// username. Complete setup with fields missing names each under its field and sends nothing, and the success card
// follows a completed setup.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const completeSetup = mock(async (_input: object) => ({}));
const mutation = { mutateAsync: async () => ({}), isPending: false };
afterEach(() => completeSetup.mockClear());

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useCompleteSetup: () => ({ mutateAsync: completeSetup, isPending: false }),
    useCheckSetupS3: () => mutation,
    useHardenSetupS3: () => mutation,
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement } = await import('react');
const { SetupWizard } = await import('../../../components/admin/setup-wizard');

const wizard = () =>
    createElement(SetupWizard, { status: { setupRequired: true, mailDomain: 'acme.test' }, setupToken: 'token' });

let unmount = async () => {};
afterEach(() => unmount());

const field = (label: string) => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const type = (label: string, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(label), value);
        field(label).dispatchEvent(new Event('input', { bubbles: true }));
    });
const fill = async (name = 'Acme') => {
    await type('Organization name', name);
    await type('Full name', 'Jane Doe');
    await type('Username', 'Jane');
    await type('Password', 'correct horse');
};
const messageUnder = (label: string) => {
    const input = field(label);
    if (input.getAttribute('aria-invalid') !== 'true') return undefined;
    return document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent;
};
const completeButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Complete setup');

test('First-run setup keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: wizard,
        submitLabel: 'Complete setup',
        firstField: 'Organization name',
        onSubmit: completeSetup,
        makeChanged: () => fill(),
        makeInvalid: () => type('Organization name', ''),
        invalidField: 'Organization name',
        except: {
            leaveGuard:
                'the wizard replaces the whole app, so there is no page to leave to, and a reload starts it again',
        },
    });
});

test('Complete setup sends the trimmed organization name and the lowercase username, then shows the success card', async () => {
    ({ unmount } = await renderInDocument(wizard()));
    await fill('Acme ');
    await act(async () => completeButton()?.click());
    expect(completeSetup.mock.calls).toEqual([
        [
            {
                orgName: 'Acme',
                senderName: '',
                senderAddress: 'noreply@acme.test',
                storageType: 'local-fullnames',
                adminUsername: 'jane',
                adminPassword: 'correct horse',
                adminName: 'Jane Doe',
            },
        ],
    ]);
    expect(document.body.textContent).toContain('Setup complete!');
});

test('Complete setup with fields missing names each under its field and sends nothing', async () => {
    ({ unmount } = await renderInDocument(wizard()));
    expect(messageUnder('Organization name')).toBeUndefined();
    await act(async () => completeButton()?.click());
    expect(completeSetup).not.toHaveBeenCalled();
    expect(messageUnder('Organization name')).toBe('Add a name');
    expect(messageUnder('Full name')).toBe('Add your name');
    expect(messageUnder('Username')).toBe('Add a username');
    expect(messageUnder('Password')).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(document.activeElement).toBe(field('Organization name'));
});

test('a username the rules refuse and a wrong sender say so as they are typed', async () => {
    ({ unmount } = await renderInDocument(wizard()));
    await type('Username', 'a');
    expect(messageUnder('Username')).toBe('Username must be 2-30 characters');
    await type('Sender address', 'nobody');
    expect(messageUnder('Sender address')).toBe('This is not an email address');
});
