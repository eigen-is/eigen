import {
    File,
    FileArchive,
    FileAudio,
    FileCode,
    FileCog,
    FileDigit,
    FileImage,
    FileText,
    FileType,
    FileVideo,
    Folder,
    type LucideIcon,
    Presentation,
} from 'lucide-react';
import { DRIVE_TYPE_FOLDER, type DrivePathType, getEigenDocInfoByMime } from '../types';
import { EIGEN_DOC_ICONS } from './eigendoc-icons';

const ARCHIVE_MIMES = new Set([
    'application/zip',
    'application/x-rar-compressed',
    'application/x-tar',
    'application/gzip',
    'application/x-7z-compressed',
]);

const CODE_MIMES = new Set([
    'text/html',
    'text/css',
    'application/javascript',
    'application/json',
    'application/xml',
    'text/xml',
    'application/x-httpd-php',
    'application/x-sh',
    'text/x-python',
    'text/x-java-source',
]);

const SPREADSHEET_MIMES = new Set([
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'text/csv',
]);

const PRESENTATION_MIMES = new Set([
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
]);

const WORD_MIMES = new Set([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
]);

const EXECUTABLE_MIMES = new Set(['application/x-msdownload', 'application/x-executable']);
const DB_MIMES = new Set(['application/vnd.sqlite3', 'application/x-sqlite3', 'application/vnd.ms-access']);

export function getFileIconComponent(mimeType: string, type: string): LucideIcon {
    if (type === DRIVE_TYPE_FOLDER) return Folder;

    const eigenInfo = getEigenDocInfoByMime(mimeType);
    if (eigenInfo) return EIGEN_DOC_ICONS[eigenInfo.type];

    if (!mimeType) return File;
    if (mimeType.startsWith('image/')) return FileImage;
    if (mimeType.startsWith('video/')) return FileVideo;
    if (mimeType.startsWith('audio/')) return FileAudio;
    if (mimeType === 'application/pdf') return FileType;
    if (ARCHIVE_MIMES.has(mimeType)) return FileArchive;
    if (CODE_MIMES.has(mimeType) || mimeType.includes('code')) return FileCode;
    if (mimeType.startsWith('text/') || mimeType === 'application/rtf') return FileText;
    if (SPREADSHEET_MIMES.has(mimeType)) return FileText;
    if (PRESENTATION_MIMES.has(mimeType)) return Presentation;
    if (WORD_MIMES.has(mimeType)) return FileText;
    if (EXECUTABLE_MIMES.has(mimeType)) return FileCog;
    if (DB_MIMES.has(mimeType)) return FileDigit;
    return File;
}

// `colorVar` / `softColorVar` come pre-wrapped in `var(...)` so callers drop
// them straight into `style={{ background: presentation.softColorVar }}`.
export type FilePresentation = {
    icon: LucideIcon;
    colorVar: string;
    softColorVar: string;
    // Soft fill for the icon interior — the same wash as a hovered list row
    // (`var(--app-*-color-soft)`) — or 'none' for generic files that stay outline-only.
    fillColorVar: string;
    label: string;
};

export function getFilePresentation(mimeType: string, type: DrivePathType): FilePresentation {
    if (type === DRIVE_TYPE_FOLDER) {
        return {
            icon: Folder,
            colorVar: 'var(--app-drive-color)',
            softColorVar: 'var(--app-drive-color-soft)',
            fillColorVar: 'var(--app-drive-color-soft)',
            label: 'Folder',
        };
    }

    const eigenInfo = getEigenDocInfoByMime(mimeType);
    if (eigenInfo) {
        return {
            icon: EIGEN_DOC_ICONS[eigenInfo.type],
            colorVar: `var(${eigenInfo.colorVar})`,
            softColorVar: `var(${eigenInfo.softColorVar})`,
            fillColorVar: `var(${eigenInfo.softColorVar})`,
            label: eigenInfo.labelPlural,
        };
    }

    return {
        icon: getFileIconComponent(mimeType, type),
        colorVar: 'var(--muted-foreground)',
        softColorVar: 'var(--muted)',
        fillColorVar: 'none',
        label: mimeType || 'File',
    };
}
