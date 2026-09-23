import { chownSync, type Stats } from 'node:fs';
import { join } from 'node:path';

// The repo root in a checkout, /app in the image.
export const ROOT = join(import.meta.dir, '../../../..');
export const ENV_PATH = '.env.production';
// The exit code of a question the operator said no to, which the launcher ends as a plain exit.
export const DECLINED = 3;
export const VERSION_PATTERN = String.raw`\d+\.\d+\.\d+(?:-[\w.-]+)?`;
export const IMAGE_NAMES = ['api', 'frontend', 'postfix', 'dovecot'] as const;

// Root in a container writes files the operator must own; a run as the operator already owns them.
export function ownAs(path: string, owner: Stats): void {
    if (process.getuid?.() === 0) chownSync(path, owner.uid, owner.gid);
}
