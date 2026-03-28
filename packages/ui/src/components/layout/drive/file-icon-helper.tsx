import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_TYPE_FOLDER,
} from '@workspace/lib/types';
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
    MessageSquare,
    Presentation,
    Sheet,
    StickyNote,
} from 'lucide-react';
import type React from 'react';

type FileIconProps = React.ComponentProps<typeof File>;

export function getFileIcon(mimeType: string, type: string, props?: FileIconProps) {
    if (type === DRIVE_TYPE_FOLDER) {
        return <Folder {...props} />;
    }

    if (mimeType === DRIVE_MIME_DOC) {
        return <FileText {...props} />;
    }
    if (mimeType === DRIVE_MIME_STICKIES) {
        return <StickyNote {...props} />;
    }
    if (mimeType === DRIVE_MIME_CHAT) {
        return <MessageSquare {...props} />;
    }
    if (mimeType === DRIVE_MIME_SLIDES) {
        return <Presentation {...props} />;
    }
    if (mimeType === DRIVE_MIME_SHEETS) {
        return <Sheet {...props} />;
    }

    // Handle different file types based on MIME type
    if (!mimeType) {
        return <File {...props} />;
    }

    // Images
    if (mimeType.startsWith('image/')) {
        return <FileImage {...props} />;
    }

    // Videos
    if (mimeType.startsWith('video/')) {
        return <FileVideo {...props} />;
    }

    // Audio
    if (mimeType.startsWith('audio/')) {
        return <FileAudio {...props} />;
    }

    // PDFs
    if (mimeType === 'application/pdf') {
        return <FileType {...props} />;
    }

    // Archives
    if (
        [
            'application/zip',
            'application/x-rar-compressed',
            'application/x-tar',
            'application/gzip',
            'application/x-7z-compressed',
        ].includes(mimeType)
    ) {
        return <FileArchive {...props} />;
    }

    // Code files
    if (
        [
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
        ].includes(mimeType) ||
        mimeType.includes('code')
    ) {
        return <FileCode {...props} />;
    }

    // Text files
    if (mimeType.startsWith('text/') || mimeType === 'application/rtf') {
        return <FileText {...props} />;
    }

    // Spreadsheets
    if (
        [
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.oasis.opendocument.spreadsheet',
            'text/csv',
        ].includes(mimeType)
    ) {
        return <FileText {...props} />;
    }

    // Presentations
    if (
        [
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.oasis.opendocument.presentation',
        ].includes(mimeType)
    ) {
        return <Presentation {...props} />;
    }

    // Documents (Word, etc.)
    if (
        [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.oasis.opendocument.text',
        ].includes(mimeType)
    ) {
        return <FileText {...props} />;
    }

    // Executable files
    if (['application/x-msdownload', 'application/x-executable'].includes(mimeType)) {
        return <FileCog {...props} />;
    }

    // Data files
    if (['application/vnd.sqlite3', 'application/x-sqlite3', 'application/vnd.ms-access'].includes(mimeType)) {
        return <FileDigit {...props} />;
    }

    // Default file icon for unknown types
    return <File {...props} />;
}
