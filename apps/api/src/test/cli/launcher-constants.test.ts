import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECLINED, ROOT } from '../../cli/install';
import { SWAP_MARKER } from '../../cli/restore';
import { PIN_KEYS } from '../../lib/config/release';

// The launcher is POSIX sh and cannot import the CLI, so each fact both need is spelled twice. These pin the copies.
const launcher = readFileSync(join(ROOT, 'eigen'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

const launcherValue = (name: string): string | undefined =>
    new RegExp(`^${name}=(['"]?)(.*)\\1$`, 'm').exec(launcher)?.[2];

const imageKeys = PIN_KEYS.filter((key) => key.endsWith('_IMAGE'));

describe('the constants the launcher shares with the CLI', () => {
    test("IMAGES names every image the release pins, in the CLI's order", () => {
        const images = (launcherValue('IMAGES') ?? '').split(' ');
        expect(images.map((name) => `EIGEN_${name.toUpperCase()}_IMAGE`)).toEqual(imageKeys);
    });

    test('docker-compose.yml runs every pinned image, and only those', () => {
        const used = new Set([...compose.matchAll(/\$\{(EIGEN_[A-Z]+_IMAGE)[:}-]/g)].map((match) => match[1]));
        expect([...used].sort()).toEqual([...imageKeys].sort());
    });

    test('DECLINED is the exit code of a question answered no', () => {
        expect(launcherValue('DECLINED')).toBe(String(DECLINED));
    });

    test("SWAP_MARKER is the marker the restore's swap writes", () => {
        expect(launcherValue('SWAP_MARKER')).toBe(SWAP_MARKER);
    });
});
