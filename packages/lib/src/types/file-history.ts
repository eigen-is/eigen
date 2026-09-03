import { formatChatPreview } from '../core/chat/format-preview';
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
    // card = the client-posted card title, matching the sticky-* naming.
    assigned: { assignee: string; card?: string; chatName?: string };
    resolved: { card?: string; chatName?: string };
    reopened: { card?: string; chatName?: string };
};

export type FileEventType = 'created' | 'edited' | 'trashed' | 'restored' | 'deleted' | keyof FileEventDetailsMap;

// Client-postable subset; everything else is server-only (the POST route rejects the rest).
// Only types with a real emitter AND human-meaningful content (a card name) live here.
// Lower-signal structural verbs (slide reorder/add/remove, sheet row/col ops, doc edits)
// are deferred to the in-doc history feature that consumes them — see
// docs/FILE-HISTORY.md. Until then those changes surface as the generic 'edited'.
export const CLIENT_FILE_EVENT_TYPES = [
    'sticky-added',
    'sticky-moved',
    'sticky-removed',
] as const satisfies readonly FileEventType[];

export type ClientFileEventType = (typeof CLIENT_FILE_EVENT_TYPES)[number];

export function isClientFileEventType(t: string): t is ClientFileEventType {
    return CLIENT_FILE_EVENT_TYPES.some((x) => x === t);
}

// Discriminated write payload: details required exactly when the event type has them.
export type FileEventRecord = {
    [K in FileEventType]: { eventType: K } & (K extends keyof FileEventDetailsMap
        ? { details: FileEventDetailsMap[K] }
        : { details?: undefined });
}[FileEventType];

export type ClientFileEventRecord = Extract<FileEventRecord, { eventType: ClientFileEventType }>;

export type FileEventInput = FileEventRecord & { pathId: string; actor: { id: string; email: string } };

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

// Bare third-person past-tense verb per event type. describeFileEvent renders the plain
// drive verbs (created/edited/…) straight from this table and phrases the richer types in
// its switch, so those entries exist mainly to complete the registry toFileEventType
// validates against. (Lives here, not a UI module, because the server composes notification
// titles from it — same precedent as stripEigenExtension in types/drive.ts.)
const FILE_EVENT_PHRASES: Record<FileEventType, string> = {
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
    assigned: 'assigned a comment',
    resolved: 'resolved a comment',
    reopened: 'reopened a comment',
};

// Persisted rows can hold an eventType outside today's union — older builds, or the
// deferred slide/sheet structural verbs that (per CLIENT_FILE_EVENT_TYPES) surface as
// the generic 'edited' until the in-doc history feature consumes them. Coerce unknowns
// to 'edited' here, at the read seam (history.ts reads file_events), so every typed
// FileEvent stays honest and the phrasing helpers stay total over the union.
export function toFileEventType(raw: string): FileEventType {
    return Object.hasOwn(FILE_EVENT_PHRASES, raw) ? (raw as FileEventType) : 'edited';
}

export type ActivityLines = { action: string; primary?: string; secondary?: string };

// One phrasing layer for the activity panel and file-event notifications; callers prepend
// the actor ("You" / <UserNameCard/> / `${actor.name}`). ctx 'own' omits the item name (the
// panel title shows it); 'container' names it. Details are read via `in`-narrowing since
// Pick<FileEvent> flattens the discriminated union. Spec Inventory B is normative.
export function describeFileEvent(
    event: Pick<FileEvent, 'eventType' | 'details' | 'pathName' | 'pathType'>,
    ctx: 'own' | 'container',
    opts?: { resolveName?: (email: string) => string | undefined; viewerEmail?: string },
): ActivityLines {
    const name = stripEigenExtension(event.pathName);
    const container = ctx === 'container';
    const details = event.details;

    switch (event.eventType) {
        case 'renamed': {
            const d = details && 'oldName' in details ? details : null;
            return { action: 'renamed', primary: d ? `${d.oldName} → ${d.newName}` : undefined };
        }
        // created/uploaded name the item in the own-ctx action line — a bare "created" row on the
        // item's own panel reads dangling; the other drive verbs read fine bare.
        case 'created':
            return { action: container ? 'created' : `created "${name}"`, primary: container ? name : undefined };
        case 'uploaded': {
            const d = details && 'size' in details ? details : null;
            return {
                action: container ? 'uploaded' : `uploaded "${name}"`,
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
                primary: d ? `“${formatChatPreview(d.preview, opts)}”` : undefined,
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
        case 'assigned': {
            const d = details && 'assignee' in details ? details : null;
            const who = d
                ? d.assignee === opts?.viewerEmail?.toLowerCase()
                    ? 'you'
                    : (opts?.resolveName?.(d.assignee) ?? d.assignee.split('@')[0])
                : undefined;
            return {
                action: container ? `assigned a comment in "${name}"` : 'assigned a comment',
                primary: d?.card ?? (who ? `to ${who}` : undefined),
                secondary: d?.card && who ? `to ${who}` : undefined,
            };
        }
        case 'resolved':
        case 'reopened': {
            const d = details && 'chatName' in details ? details : null;
            return {
                action: container
                    ? `${FILE_EVENT_PHRASES[event.eventType]} in "${name}"`
                    : FILE_EVENT_PHRASES[event.eventType],
                primary: d && 'card' in d ? d.card : undefined,
            };
        }
        default:
            // edited/moved/copied/trashed/restored/deleted: bare verb; name is the primary line.
            return { action: FILE_EVENT_PHRASES[event.eventType], primary: container ? name : undefined };
    }
}
