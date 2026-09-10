import type { MountSettings } from '../types/settings';

// What a storage backend is called on screen: the three the mount form offers, and the one a mount
// row in the admin pane reads back. One spelling, so the pane and the form can never disagree about
// what a mount is.
export const STORAGE_TYPE_LABELS: Record<MountSettings['storageType'], string> = {
    local: 'Local (full names)',
    'local-key': 'Local (ID-based)',
    s3: 'S3 bucket',
};
