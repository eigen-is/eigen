import type {DrivePath} from '@workspace/lib/types/drive';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type DriveEventType = typeof SSEventType[keyof typeof SSEventType] & `drive:${string}`;

type EventTemplate = {
    title: string;
    body: (path: DrivePath, extra?: string) => string;
};

const templates: Record<DriveEventType, EventTemplate> = {
    [SSEventType.DRIVE_FOLDER_CREATED]: {
        title: 'Folder created',
        body: (p) => `Folder "${p.name}" created`
    },
    [SSEventType.DRIVE_FOLDER_DELETED]: {
        title: 'Folder deleted',
        body: (p) => `Folder "${p.name}" deleted`
    },
    [SSEventType.DRIVE_FILE_UPLOADED]: {
        title: 'File uploaded',
        body: (p) => `File "${p.name}" uploaded`
    },
    [SSEventType.DRIVE_FILE_CREATED]: {
        title: 'File created',
        body: (p) => `File "${p.name}" created`
    },
    [SSEventType.DRIVE_FILE_DELETED]: {
        title: 'File deleted',
        body: (p) => `File "${p.name}" deleted`
    },
    [SSEventType.DRIVE_PATH_RENAMED]: {
        title: 'Item renamed',
        body: (_, extra) => `Renamed to "${extra}"`
    },
    [SSEventType.DRIVE_PATH_MOVED]: {
        title: 'Item moved',
        body: (p) => `"${p.name}" moved`
    },
    [SSEventType.DRIVE_ACL_UPDATED]: {
        title: 'Sharing updated',
        body: (p) => `Sharing updated for "${p.name}"`
    },
    [SSEventType.DRIVE_ACL_SHARED]: {
        title: 'Item shared with you',
        body: (p) => `"${p.name}" was shared with you`
    },
    [SSEventType.DRIVE_ACL_UNSHARED]: {
        title: 'Item unshared',
        body: (p) => `"${p.name}" is no longer shared with you`
    },
};

type DriveEventOptions = {
    tag?: string;
    link?: string;
    extra?: string;
    oldParentId?: string;
};

export function buildDriveEvent(type: DriveEventType, path: DrivePath, options?: DriveEventOptions): SSEvent {
    const template = templates[type];
    const drive = options?.oldParentId ? {oldParentId: options.oldParentId} : undefined;
    return {
        type,
        title: template.title,
        body: template.body(path, options?.extra),
        path,
        ...(options?.tag && {tag: options.tag}),
        ...(options?.link && {link: options.link}),
        ...(drive && {drive}),
    } as SSEvent;
}
