import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants';

const DRIVE_ROOT = 'mounts';
const MAIL_ROOT = 'eigen.mail';
const CONTACTS_ROOT = 'eigen.contacts';
const CALENDAR_ROOT = 'eigen.calendar';

export const PATHS = {
    // The home's own settings file, at the root of every home folder — and so of every archive and
    // safety copy of one.
    SETTINGS: 'settings.json',
    DRIVE: {
        ROOT: DRIVE_ROOT,
        DEFAULT_MOUNT: 'default',
        SHARED_DB: `${DRIVE_ROOT}/shared.db`,
        METADATA_DB: 'metadata.db',
        DATA_DIR: 'data',
        THUMBS_DIR: 'thumbs',
        TMP_DIR: 'tmp',
        STAGING_DIR: 'staging',
        PREVIEWS_DIR: 'previews',
        DOCS_DIR: 'docs',
    },
    MAIL: {
        ROOT: MAIL_ROOT,
        MAILDIR: 'Maildir',
        DB: `${MAIL_ROOT}/mail.db`,
        CUR: 'cur',
        NEW: 'new',
        TMP: 'tmp',
    },
    CONTACTS: {
        ROOT: CONTACTS_ROOT,
        DB: `${CONTACTS_ROOT}/contacts.db`,
        AVATARS: 'avatars',
    },
    CALENDAR: {
        ROOT: CALENDAR_ROOT,
        DB: `${CALENDAR_ROOT}/calendar.db`,
    },
    NOTIFICATIONS: {
        DB: 'eigen.notifications/notifications.db',
    },
} as const;

// '' is the inbox: Maildir's root folder has no name.
export const STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'] as const;

export const DEFAULT_LABELS = [
    { name: 'Family', color: EIGEN_ACCENT_COLORS_SHUFFLED[0].value },
    { name: 'Friends', color: EIGEN_ACCENT_COLORS_SHUFFLED[1].value },
    { name: 'Work', color: EIGEN_ACCENT_COLORS_SHUFFLED[2].value },
    { name: 'Important', color: EIGEN_ACCENT_COLORS_SHUFFLED[3].value },
] as const;
