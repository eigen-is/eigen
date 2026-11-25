// The S3 card's bucket safety dialog asks how many days old versions are kept, starting from the card's days. Enable,
// Update or Enter hardens the bucket with the days typed there, and the card keeps them. Cancel throws an edited value
// away. The days stay whole and between 1 and the maximum. A bucket that is safe already gets "Change retention", and a
// refused harden still closes the dialog and shows its message. Enter in the days field never submits a form around the
// card, such as the mount dialog's. Once Save was pressed, each required field left empty says so under itself, a saved
// secret excepted, and the form focuses the first.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { S3_NONCURRENT_DAYS_MAX } from '@workspace/lib/constants/s3';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { S3ConfigCard } = await import('../../../components/mount/s3-config-card');
const { FormShell } = await import('../../../components/form-shell');

const bucket: S3Config = {
    endpoint: 'https://s3.example.org',
    bucket: 'team-files',
    prefix: '',
    accessKeyId: 'AKIA1',
    secretAccessKey: 'secret',
};
const unsafe: S3CheckResult = { ok: true, message: 'Connected', versioning: 'disabled', lifecycle: 'none' };
const safe: S3CheckResult = {
    ok: true,
    message: 'Connected',
    versioning: 'enabled',
    lifecycle: { noncurrentDays: 45 },
};

const onCheck = mock(async (_config: S3Config) => unsafe);
const hardened = async (_config: S3Config, noncurrentDays: number): Promise<S3HardenResult> => ({
    ok: true,
    message: 'Bucket is safe',
    versioning: 'enabled',
    lifecycle: { noncurrentDays },
    applied: { versioning: true, lifecycle: true },
});
const onHarden = mock(hardened);
const outerSubmit = mock(() => {});

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    onCheck.mockReset();
    onCheck.mockImplementation(async () => unsafe);
    onHarden.mockReset();
    onHarden.mockImplementation(hardened);
    outerSubmit.mockClear();
});

// The card inside a form of its own, as the mount dialog holds it, with the parent owning the config.
function Harness() {
    const [value, setValue] = useState(bucket);
    return createElement(
        'form',
        {
            onSubmit: (event: { preventDefault: () => void }) => {
                event.preventDefault();
                outerSubmit();
            },
        },
        createElement(S3ConfigCard, { value, onChange: setValue, onCheck, onHarden }),
    );
}

const dialog = () => document.querySelector('[role="dialog"]');
const title = () => dialog()?.querySelector('h2')?.textContent;
const findButton = (root: ParentNode | null | undefined, label: string) =>
    [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);
const daysField = () => {
    const input = dialog()?.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('the dialog has no days field');
    return input;
};
const typeDays = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(daysField(), value);
        daysField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const click = (target: HTMLElement | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function checkBucket(result: S3CheckResult) {
    onCheck.mockImplementation(async () => result);
    ({ unmount } = await renderInDocument(createElement(Harness)));
    await click(findButton(document, 'Test connection'));
    await settle();
}

const openSafeDefaults = () => click(findButton(document, 'Enable safe defaults'));

test('Make this bucket safe starts from the default days and enables with the days typed there', async () => {
    await checkBucket(unsafe);
    await openSafeDefaults();
    expect(title()).toBe('Make this bucket safe for Eigen');
    expect(dialog()?.textContent).toContain('Turns on bucket versioning');
    expect(daysField().value).toBe('30');
    expect(findButton(dialog(), 'Cancel')).toBeDefined();
    await typeDays('60');
    await click(findButton(dialog(), 'Enable'));
    await settle();
    expect(onHarden.mock.calls).toEqual([[bucket, 60]]);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain('Bucket is safe');
    expect(document.body.textContent).toContain('expires versions after 60 days');
});

test('Enter in the days field hardens the bucket, and never submits the form around the card', async () => {
    await checkBucket(unsafe);
    await openSafeDefaults();
    await typeDays('14');
    await act(async () => pressEnter(daysField()));
    await settle();
    expect(onHarden.mock.calls).toEqual([[bucket, 14]]);
    expect(outerSubmit).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
});

test('Cancel throws the edited days away, and the next opening starts from the old ones', async () => {
    await checkBucket(unsafe);
    await openSafeDefaults();
    await typeDays('90');
    await click(findButton(dialog(), 'Cancel'));
    expect(dialog()).toBeNull();
    await openSafeDefaults();
    expect(daysField().value).toBe('30');
    expect(onHarden).not.toHaveBeenCalled();
});

test('the days stay whole and between 1 and the maximum', async () => {
    await checkBucket(unsafe);
    await openSafeDefaults();
    await typeDays('0');
    expect(daysField().value).toBe('1');
    await typeDays('99999');
    expect(daysField().value).toBe(String(S3_NONCURRENT_DAYS_MAX));
    await typeDays('7.6');
    expect(daysField().value).toBe('8');
});

test("a safe bucket's Change opens Change retention on its own days, and Update saves them", async () => {
    await checkBucket(safe);
    expect(findButton(document, 'Enable safe defaults')).toBeUndefined();
    await click(findButton(document, 'Change'));
    expect(title()).toBe('Change retention');
    expect(dialog()?.textContent).not.toContain('Turns on bucket versioning');
    expect(daysField().value).toBe('45');
    await typeDays('120');
    await click(findButton(dialog(), 'Update'));
    await settle();
    expect(onHarden.mock.calls).toEqual([[bucket, 120]]);
    expect(dialog()).toBeNull();
});

test('a refused harden closes the dialog, shows its message, and the manual steps use the typed days', async () => {
    onHarden.mockImplementation(async () => ({
        ok: false,
        message: 'This key may not change bucket settings',
        versioning: 'disabled',
        lifecycle: 'none',
        applied: { versioning: false, lifecycle: false },
        reason: 'access-denied',
    }));
    await checkBucket(unsafe);
    await openSafeDefaults();
    await typeDays('21');
    await click(findButton(dialog(), 'Enable'));
    await settle();
    expect(onHarden.mock.calls).toEqual([[bucket, 21]]);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain('This key may not change bucket settings');
    expect(document.querySelector('[data-slot="code-block-content"]')?.textContent).toContain('"NoncurrentDays":21');
});

// The card on a form whose save refuses a config the card marks, as Server settings holds it.
function RefusingForm({ initial, secretSaved }: { initial: S3Config; secretSaved?: boolean }) {
    const [value, setValue] = useState(initial);
    return createElement(
        FormShell,
        { onSubmit: () => false },
        createElement(S3ConfigCard, { value, onChange: setValue, onCheck, secretSaved }),
        createElement('button', { type: 'submit' }, 'Save'),
    );
}

const input = (label: string) => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const field = tag && document.getElementById(tag.htmlFor);
    if (!(field instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return field;
};
const message = (label: string) => document.getElementById(input(label).getAttribute('aria-describedby') ?? '');

test('a refused save marks each missing field under itself and focuses the first', async () => {
    const blank = { endpoint: '', bucket: 'team-files', prefix: '', accessKeyId: '', secretAccessKey: '' };
    ({ unmount } = await renderInDocument(createElement(RefusingForm, { initial: blank })));
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(document.querySelector('[data-slot="field-error"]')).toBeNull();

    await click(findButton(document, 'Save'));
    await settle();
    expect(document.activeElement).toBe(input('Endpoint'));
    expect(message('Endpoint')?.textContent).toBe('Add an endpoint');
    expect(message('Access key ID')?.textContent).toBe('Add an access key ID');
    expect(message('Secret access key')?.textContent).toBe('Add the secret access key');
    for (const label of ['Bucket', 'Prefix', 'Region']) {
        expect(input(label).getAttribute('aria-invalid')).toBeNull();
    }
});

test('a saved secret may stay empty', async () => {
    ({ unmount } = await renderInDocument(
        createElement(RefusingForm, { initial: { ...bucket, secretAccessKey: '' }, secretSaved: true }),
    ));
    await click(findButton(document, 'Save'));
    await settle();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
});
