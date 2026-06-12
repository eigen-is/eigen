import type { DrivePathType } from './drive';

export type FileEventDetailsMap = {
    uploaded: { size: number };
    renamed: { oldName: string; newName: string };
    moved: { oldParentId: string; newParentId: string };
    copied: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };
    'acl-changed': { added: string[]; removed: string[] };
    'version-restored': { versionName: string };
    commented: { preview: string };
    'sticky-added': { stickyId: string; column: string };
    'sticky-moved': { stickyId: string; oldColumn: string; newColumn: string };
    'sticky-removed': { stickyId: string; column: string };
    'slide-added': { slideId: string };
    'slide-removed': { slideId: string };
    'slide-reordered': { slideId: string; newIndex: number };
};

export type FileEventType = 'created' | 'edited' | 'trashed' | 'restored' | 'deleted' | keyof FileEventDetailsMap;

// Client-postable subset; everything else is server-only (the POST route rejects the rest).
// v1 ships only the two types that have real emitters (no-placeholders rule); the
// sticky/slide add/remove vocabulary stays in FileEventType for the wire format and
// joins this list when an emitter lands.
export const CLIENT_FILE_EVENT_TYPES = ['sticky-moved', 'slide-reordered'] as const satisfies readonly FileEventType[];

export type ClientFileEventType = (typeof CLIENT_FILE_EVENT_TYPES)[number];

export function isClientFileEventType(t: string): t is ClientFileEventType {
    return (CLIENT_FILE_EVENT_TYPES as readonly string[]).includes(t);
}

// Discriminated write input: details required exactly when the event type has them.
export type FileEventInput = {
    [K in FileEventType]: {
        pathId: string;
        eventType: K;
        actor: { id: string; email: string };
    } & (K extends keyof FileEventDetailsMap ? { details: FileEventDetailsMap[K] } : { details?: undefined });
}[FileEventType];

// Discriminated read shape. pathName/pathType are resolved at read time so folder
// timelines can name and link the descendant the event happened on.
export type FileEvent = {
    id: string;
    pathId: string;
    pathName: string;
    pathType: DrivePathType;
    actorUserId: string;
    actorEmail: string;
    createdAt: Date;
} & {
    [K in FileEventType]: {
        eventType: K;
        details: K extends keyof FileEventDetailsMap ? FileEventDetailsMap[K] | null : null;
    };
}[FileEventType];

export type PathWatchStatus = {
    direct: boolean;
    viaAncestor?: { pathId: string; name: string };
};

export type WatchedItem = {
    ownerId: string;
    mountId: string;
    pathId: string;
    name: string;
    type: DrivePathType;
    mimeType: string;
    watchedAt: Date;
    lastEventAt: Date | null;
    lastEventType: FileEventType | null;
    lastActorEmail: string | null;
};

// Third-person past-tense verb for notification titles + activity rows.
// (Lives here, not in a UI module, because the server composes notification titles
// with it — same precedent as stripEigenExtension in types/drive.ts.)
export function fileEventVerb(eventType: FileEventType): string {
    switch (eventType) {
        case 'created':
            return 'created';
        case 'uploaded':
            return 'uploaded';
        case 'edited':
            return 'edited';
        case 'renamed':
            return 'renamed';
        case 'moved':
            return 'moved';
        case 'copied':
            return 'copied';
        case 'acl-changed':
            return 'updated sharing for';
        case 'trashed':
            return 'trashed';
        case 'restored':
            return 'restored';
        case 'deleted':
            return 'deleted';
        case 'version-restored':
            return 'restored a version of';
        case 'commented':
            return 'commented on';
        case 'sticky-added':
            return 'added a card to';
        case 'sticky-moved':
            return 'moved a card in';
        case 'sticky-removed':
            return 'removed a card from';
        case 'slide-added':
            return 'added a slide to';
        case 'slide-removed':
            return 'removed a slide from';
        case 'slide-reordered':
            return 'reordered slides in';
    }
}
