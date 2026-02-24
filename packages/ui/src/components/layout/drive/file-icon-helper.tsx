import React from 'react';
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
    StickyNote
} from 'lucide-react';

type FileIconProps = React.ComponentProps<typeof File>;

/**
 * Returns the appropriate icon component based on the MIME type
 * @param mimeType - The MIME type of the file
 * @param type - The type of the item (file or folder)
 * @param props - Props to pass to the icon component
 */
export function getFileIcon(mimeType: string, type: string, props?: FileIconProps) {
    // Return folder icon for folders
    if (type === 'folder') {
        return <Folder {...props} />;
    }
    // Return folder icon for folders
    if (type === 'doc') {
        return <FileText {...props} />;
    }
    // Return folder icon for folders
    if (type === 'stickies') {
        return <StickyNote {...props} />;
    }
    if (type === 'chat') {
        return <MessageSquare {...props} />;
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
    if ([
        'application/zip',
        'application/x-rar-compressed',
        'application/x-tar',
        'application/gzip',
        'application/x-7z-compressed'
    ].includes(mimeType)) {
        return <FileArchive {...props} />;
    }

    // Code files
    if ([
        'text/html',
        'text/css',
        'application/javascript',
        'application/json',
        'application/xml',
        'text/xml',
        'application/x-httpd-php',
        'application/x-sh',
        'text/x-python',
        'text/x-java-source'
    ].includes(mimeType) || mimeType.includes('code')) {
        return <FileCode {...props} />;
    }

    // Text files
    if (mimeType.startsWith('text/') || mimeType === 'application/rtf') {
        return <FileText {...props} />;
    }

    // Spreadsheets
    if ([
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.oasis.opendocument.spreadsheet',
        'text/csv'
    ].includes(mimeType)) {
        return <FileText {...props} />;
    }

    // Presentations
    if ([
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.oasis.opendocument.presentation'
    ].includes(mimeType)) {
        return <Presentation {...props} />;
    }

    // Documents (Word, etc.)
    if ([
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.oasis.opendocument.text'
    ].includes(mimeType)) {
        return <FileText {...props} />;
    }

    // Executable files
    if ([
        'application/x-msdownload',
        'application/x-executable'
    ].includes(mimeType)) {
        return <FileCog {...props} />;
    }

    // Data files
    if ([
        'application/vnd.sqlite3',
        'application/x-sqlite3',
        'application/vnd.ms-access'
    ].includes(mimeType)) {
        return <FileDigit {...props} />;
    }

    // Default file icon for unknown types
    return <File {...props} />;
}
