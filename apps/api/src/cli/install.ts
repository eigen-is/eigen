import { chownSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../../../package.json' with { type: 'json' };

// The repo root in a checkout, /app in the image.
export const ROOT = join(import.meta.dir, '../../../..');
export const ENV_PATH = '.env.production';
export const DATA = 'data';
export const VERSION = pkg.version;
// The exit code of a question the operator said no to, which the launcher ends as a plain exit; DECLINED in ./eigen.
export const DECLINED = 3;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
// IMAGES in ./eigen.
export const IMAGE_NAMES = ['api', 'frontend', 'postfix', 'dovecot', 'unbound'] as const;
// The keys of the pins the launcher resolves on the host, where the Docker socket is; PINS in ./eigen holds them as
// key=value lines.
export const PIN_KEYS = [
    'EIGEN_REGISTRY',
    'EIGEN_VERSION',
    ...IMAGE_NAMES.map((name) => `EIGEN_${name.toUpperCase()}_IMAGE`),
];

type Owner = { uid: number; gid: number };

// Root in a container writes files the operator must own; a run as the operator already owns them.
export function ownAs(path: string, owner: Owner): void {
    if (process.getuid?.() === 0) chownSync(path, owner.uid, owner.gid);
}

// The install folder's owner as the launcher sees it, else `path`'s: via Docker Desktop's file share, root sees root.
export function installOwner(path: string): Owner {
    const passed = /^(\d+):(\d+)$/.exec(process.env['EIGEN_OWNER'] ?? '');
    return passed ? { uid: Number(passed[1]), gid: Number(passed[2]) } : statSync(path);
}
