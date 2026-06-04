import * as path from 'node:path';
import { ApiError } from './errors';

export function resolveWithinBase(baseDir: string, key: string): string {
    const resolved = path.resolve(baseDir, key);
    if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new ApiError(400, 'Invalid storage path: path traversal detected');
    }
    return resolved;
}
