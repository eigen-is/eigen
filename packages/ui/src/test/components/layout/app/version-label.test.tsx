// The version line reads "Version 0.4.2 · 3f2a9c1 · 2026-11-03" and draws nothing until the server's config has loaded.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

let config: { version: string; commit?: string; builtAt?: Date } | undefined;
const realPublic = await import('@workspace/lib/public');
mock.module('@workspace/lib/public', () => ({ ...realPublic, usePublicConfig: () => ({ data: config }) }));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
});

const { VersionLabel } = await import('../../../../components/layout/app/version-label');

async function label(): Promise<string> {
    const { container } = await renderInDocument(<VersionLabel />);
    return container.textContent ?? '';
}

describe('VersionLabel', () => {
    test('says the version, the commit and the build date', async () => {
        config = { version: '0.4.2', commit: '3f2a9c1', builtAt: new Date(2026, 10, 3) };
        expect(await label()).toBe('Version 0.4.2 · 3f2a9c1 · 2026-11-03');
    });

    test('says only the version when the build has no commit', async () => {
        config = { version: '0.4.2' };
        expect(await label()).toBe('Version 0.4.2');
    });

    test('draws nothing before the config has loaded', async () => {
        config = undefined;
        expect(await label()).toBe('');
    });
});
