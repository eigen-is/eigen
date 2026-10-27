import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECLINED, ROOT } from '../../cli/install';
import { SWAP_MARKER } from '../../cli/restore';
import { RESTORING_DIR } from '../../lib/backup/restore-server';
import { PIN_KEYS } from '../../lib/config/release';

// The launcher is POSIX sh and cannot import the CLI, so each fact both need is spelled twice. These pin the copies.
const launcher = readFileSync(join(ROOT, 'eigen'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

const launcherValue = (name: string): string | undefined =>
    new RegExp(`^${name}=(['"]?)(.*)\\1$`, 'm').exec(launcher)?.[2];

const imageKeys = PIN_KEYS.filter((key) => key.endsWith('_IMAGE'));

describe('the constants the launcher shares with the CLI', () => {
    test('IMAGES names every image the release pins', () => {
        const images = (launcherValue('IMAGES') ?? '').split(/\s+/).filter(Boolean);
        const keys = images.map((name) => `EIGEN_${name.toUpperCase()}_IMAGE`);
        expect(new Set(keys)).toEqual(new Set(imageKeys));
        expect(keys.length).toBe(imageKeys.length);
    });

    test('docker-compose.yml runs every pinned image, and only those', () => {
        const lines = [...compose.matchAll(/^\s*image:\s*(.*)$/gm)].map((match) => match[1] ?? '');
        const used = new Set<string>();
        for (const line of lines) {
            const key = /^(?:&[\w-]+\s+)?\$\{(EIGEN_[A-Z0-9_]+_IMAGE)[:}-]/.exec(line)?.[1];
            if (key) used.add(key);
            else expect(line).toMatch(/^\*[\w-]+$/);
        }
        expect([...used].sort()).toEqual([...imageKeys].sort());
    });

    test('RESTORING_DIR is the folder the launcher unstages', () => {
        expect(launcherValue('UNSTAGE')).toContain(`data/${RESTORING_DIR}`);
    });

    test('DECLINED is the exit code of a question answered no', () => {
        expect(launcherValue('DECLINED')).toBe(String(DECLINED));
    });

    test("SWAP_MARKER is the marker the restore's swap writes", () => {
        expect(launcherValue('SWAP_MARKER')).toBe(SWAP_MARKER);
    });
});
