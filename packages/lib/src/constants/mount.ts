import type { MountSettings } from '../types/settings';

// What a storage backend is called on screen: the three the mount form offers, and the one a mount
// row in the admin pane reads back. One spelling, so the pane and the form can never disagree about
// what a mount is.
export const STORAGE_TYPE_LABELS: Record<MountSettings['storageType'], string> = {
    local: 'Local (full names)',
    'local-key': 'Local (ID-based)',
    s3: 'S3 bucket',
};

// One line on each backend for the pickers: what it means for the files on the server.
export const STORAGE_TYPE_HINTS: Record<MountSettings['storageType'], string> = {
    local: 'Files keep their names, so the folders on the server mirror Drive.',
    'local-key': 'Files are stored flat by id, so a rename or move only changes the database.',
    s3: 'Files are stored by id in your bucket, so a rename or move only changes the database.',
};

export function isStorageType(value: string): value is MountSettings['storageType'] {
    return Object.hasOwn(STORAGE_TYPE_LABELS, value);
}
