import type { DrivePathType } from './drive';

export type FileEventDetailsMap = {
    uploaded: { size: number };
    renamed: { oldName: string; newName: string };
    moved: { oldParentId: string; newParentId: string };
    copied: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };
    'acl-changed': { added: string[]; removed: string[] };
    'version-restored': { versionName: string };
    commented: { preview: string };
    'sticky-added': { card: string; toColumn: string };
    'sticky-moved': { card: string; toColumn: string };
    'sticky-removed': { card: string };
};

export type FileEventType = 'created' | 'edited' | 'trashed' | 'restored' | 'deleted' | keyof FileEventDetailsMap;

// Client-postable subset; everything else is server-only (the POST route rejects the rest).
// Only types with a real emitter AND human-meaningful content (a card name) live here.
// Lower-signal structural verbs (slide reorder/add/remove, sheet row/col ops, doc edits)
// are deferred to the in-doc history feature that consumes them — see
// docs/PROPOSAL_FILE_HISTORY.md. Until then those changes surface as the generic 'edited'.
export const CLIENT_FILE_EVENT_TYPES = [
    'sticky-added',
    'sticky-moved',
    'sticky-removed',
] as const satisfies readonly FileEventType[];

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
};

// Third-person past-tense verb for notification titles + activity rows.
// (Lives here, not in a UI module, because the server composes notification titles
// with it — same precedent as stripEigenExtension in types/drive.ts.)
const FILE_EVENT_VERBS: Record<FileEventType, string> = {
    created: 'created',
    uploaded: 'uploaded',
    edited: 'edited',
    renamed: 'renamed',
    moved: 'moved',
    copied: 'copied',
    'acl-changed': 'updated sharing for',
    trashed: 'trashed',
    restored: 'restored',
    deleted: 'deleted',
    'version-restored': 'restored a version of',
    commented: 'commented on',
    'sticky-added': 'added a card to',
    'sticky-moved': 'moved a card in',
    'sticky-removed': 'removed a card from',
};

export function fileEventVerb(eventType: FileEventType): string {
    return FILE_EVENT_VERBS[eventType];
}

// Standalone past-tense summary that reads without a trailing object — for places
// with no room for the item name (the Watched list's "last activity" column, and
// a selected file's own events where the panel title already shows the name).
const FILE_EVENT_SUMMARIES: Record<FileEventType, string> = {
    created: 'created',
    uploaded: 'uploaded',
    edited: 'edited',
    renamed: 'renamed',
    moved: 'moved',
    copied: 'copied',
    'acl-changed': 'updated sharing',
    trashed: 'trashed',
    restored: 'restored',
    deleted: 'deleted',
    'version-restored': 'restored a version',
    commented: 'commented',
    'sticky-added': 'added a card',
    'sticky-moved': 'moved a card',
    'sticky-removed': 'removed a card',
};

export function fileEventSummary(eventType: FileEventType): string {
    return FILE_EVENT_SUMMARIES[eventType];
}
