import { formatFileSize } from '../core/format';
import { type DrivePathType, stripEigenExtension } from './drive';

export type FileEventDetailsMap = {
    uploaded: { size: number };
    renamed: { oldName: string; newName: string };
    moved: { oldParentId: string; newParentId: string };
    copied: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };
    'acl-changed': { added: string[]; removed: string[] };
    'version-restored': { versionName: string };
    // cardId/chatName are additive deep-link fields — old rows lack them and fall back to the container link.
    commented: { preview: string; chatName?: string };
    'sticky-added': { card: string; toColumn: string; cardId?: string };
    'sticky-moved': { card: string; toColumn: string; cardId?: string };
    'sticky-removed': { card: string; cardId?: string };
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

// Third-person past-tense phrasing for notification titles + activity rows.
// `verb` expects a trailing object ("created <name>"); `summary` stands alone
// ("created") for places with no room for the item name (a selected file's own
// events where the panel title already shows the name). (Lives here, not in a UI
// module, because the server composes notification titles with verb — same
// precedent as stripEigenExtension in types/drive.ts.)
const FILE_EVENT_PHRASES: Record<FileEventType, { verb: string; summary: string }> = {
    created: { verb: 'created', summary: 'created' },
    uploaded: { verb: 'uploaded', summary: 'uploaded' },
    edited: { verb: 'edited', summary: 'edited' },
    renamed: { verb: 'renamed', summary: 'renamed' },
    moved: { verb: 'moved', summary: 'moved' },
    copied: { verb: 'copied', summary: 'copied' },
    'acl-changed': { verb: 'updated sharing for', summary: 'updated sharing' },
    trashed: { verb: 'trashed', summary: 'trashed' },
    restored: { verb: 'restored', summary: 'restored' },
    deleted: { verb: 'deleted', summary: 'deleted' },
    'version-restored': { verb: 'restored a version of', summary: 'restored a version' },
    commented: { verb: 'commented on', summary: 'commented' },
    'sticky-added': { verb: 'added a card to', summary: 'added a card' },
    'sticky-moved': { verb: 'moved a card in', summary: 'moved a card' },
    'sticky-removed': { verb: 'removed a card from', summary: 'removed a card' },
};

// Persisted rows can hold an eventType outside today's union — older builds, or the
// deferred slide/sheet structural verbs that (per CLIENT_FILE_EVENT_TYPES) surface as
// the generic 'edited' until the in-doc history feature consumes them. Coerce unknowns
// to 'edited' here, at the read seam (history.ts reads file_events), so every typed
// FileEvent stays honest and the phrasing helpers stay total over the union.
export function toFileEventType(raw: string): FileEventType {
    return Object.hasOwn(FILE_EVENT_PHRASES, raw) ? (raw as FileEventType) : 'edited';
}

export function fileEventVerb(eventType: FileEventType): string {
    return FILE_EVENT_PHRASES[eventType].verb;
}

export function fileEventSummary(eventType: FileEventType): string {
    return FILE_EVENT_PHRASES[eventType].summary;
}

export type ActivityLines = { action: string; primary?: string; secondary?: string };

// One phrasing layer for the activity panel and file-event notifications; callers prepend
// the actor ("You" / <UserNameCard/> / `${actor.name}`). ctx 'own' omits the item name (the
// panel title shows it); 'container' names it. Details are read via `in`-narrowing since
// Pick<FileEvent> flattens the discriminated union. Spec Inventory B is normative.
export function describeFileEvent(
    event: Pick<FileEvent, 'eventType' | 'details' | 'pathName' | 'pathType'>,
    ctx: 'own' | 'container',
): ActivityLines {
    const name = stripEigenExtension(event.pathName);
    const container = ctx === 'container';
    const details = event.details;

    switch (event.eventType) {
        case 'renamed': {
            const d = details && 'oldName' in details ? details : null;
            return { action: 'renamed', primary: d ? `${d.oldName} → ${d.newName}` : undefined };
        }
        case 'uploaded': {
            const d = details && 'size' in details ? details : null;
            return {
                action: 'uploaded',
                primary: container ? name : undefined,
                secondary: d ? formatFileSize(d.size) : undefined,
            };
        }
        case 'acl-changed': {
            const d = details && 'added' in details ? details : null;
            let secondary: string | undefined;
            if (d) {
                if (d.added.length && d.removed.length)
                    secondary = `Added ${d.added.join(', ')} · removed ${d.removed.join(', ')}`;
                else if (d.added.length) secondary = `Added ${d.added.join(', ')}`;
                else if (d.removed.length) secondary = `Removed ${d.removed.join(', ')}`;
            }
            return { action: 'updated sharing', primary: container ? name : undefined, secondary };
        }
        case 'version-restored': {
            const d = details && 'versionName' in details ? details : null;
            return {
                action: container ? `restored a version of "${name}"` : 'restored a version',
                primary: d?.versionName,
            };
        }
        case 'commented': {
            const d = details && 'preview' in details ? details : null;
            return {
                action: container ? `commented on "${name}"` : 'commented',
                primary: d ? `“${d.preview}”` : undefined,
            };
        }
        case 'sticky-added': {
            const d = details && 'toColumn' in details ? details : null;
            return {
                action: container ? `added a card to "${name}"` : d ? `added a card to ${d.toColumn}` : 'added a card',
                primary: d?.card,
                secondary: container && d ? `in ${d.toColumn}` : undefined,
            };
        }
        case 'sticky-moved': {
            const d = details && 'toColumn' in details ? details : null;
            return {
                action: container ? `moved a card in "${name}"` : 'moved a card',
                primary: d ? `${d.card} → ${d.toColumn}` : undefined,
            };
        }
        case 'sticky-removed': {
            const d = details && 'card' in details ? details : null;
            return {
                action: container ? `removed a card from "${name}"` : 'removed a card',
                primary: d?.card,
            };
        }
        default:
            // created/edited/moved/copied/trashed/restored/deleted: bare verb; name is the primary line.
            return { action: fileEventSummary(event.eventType), primary: container ? name : undefined };
    }
}
