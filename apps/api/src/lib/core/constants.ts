import {EIGEN_ACCENT_COLORS_SHUFFLED} from '@workspace/lib/constants';

export const PATHS = {
    DRIVE: {
        ROOT: 'mounts',
        DEFAULT_MOUNT: 'default',
        SHARED_DB: 'mounts/shared.db',
        METADATA_DB: 'metadata.db',
        DATA_DIR: 'data',
        THUMBS_DIR: 'thumbs',
        TMP_DIR: 'tmp',
        DOCS_DIR: 'docs'
    },
    MAIL: {
        ROOT: 'eigen.mail',
        MAILDIR: 'Maildir',
        DB: 'eigen.mail/mail.db',
        CUR: 'cur',
        NEW: 'new',
        TMP: 'tmp',
    },
    CONTACTS: {
        ROOT: 'eigen.contacts',
        DB: 'eigen.contacts/contacts.db',
        AVATARS: 'avatars'
    },
    CALENDAR: {
        ROOT: 'eigen.calendar',
        DB: 'eigen.calendar/calendar.db'
    }
} as const;

export const STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'] as const;

export const DEFAULT_LABELS = [
    {name: 'Family', color: EIGEN_ACCENT_COLORS_SHUFFLED[0].value},
    {name: 'Friends', color: EIGEN_ACCENT_COLORS_SHUFFLED[1].value},
    {name: 'Work', color: EIGEN_ACCENT_COLORS_SHUFFLED[2].value},
    {name: 'Important', color: EIGEN_ACCENT_COLORS_SHUFFLED[3].value}
] as const;
