// The history of a Drive item: the events the server records, such as created, renamed or a card added, the shapes
// written and read, and the words a timeline row says for each. The server writes most events itself; a client may
// post only a few kinds.

import { formatChatPreview } from '../core/chat/format-preview';
import { formatFileSize } from '../core/format';
import type { DrivePathType } from './drive';
import { stripEigenExtension } from './drive';
import { parseOwnerId, UNRESOLVED_TEAM_LABEL } from './owner';

export type FileEventDetailsMap = {
    uploaded: { size: number };
    renamed: { oldName: string; newName: string };
    moved: { oldParentId: string; newParentId: string };
    copied: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };
    'acl-changed': { added: string[]; removed: string[] };
    'version-restored': { versionName: string };
    // A row may lack chatName, and then its link opens the document.
    commented: { preview: string; chatName?: string };
    'sticky-added': { card: string; toColumn: string; cardId: string };
    'sticky-moved': { card: string; toColumn: string; cardId: string };
    'sticky-removed': { card: string; cardId: string };
    // card is the card's title, named as in the sticky events.
    assigned: { assignee: string; card?: string; chatName?: string };
    resolved: { card?: string; chatName?: string };
    reopened: { card?: string; chatName?: string };
};

export type FileEventType =
    | 'created'
    | 'edited'
    | 'trashed'
    | 'restored'
    | 'deleted'
    | 'versions-deleted'
    | keyof FileEventDetailsMap;

// Only a card event names something a person can read, so a structural change, such as a slide added or a sheet row
// inserted, shows as the plain 'edited'.
const CLIENT_FILE_EVENT_TYPES = [
    'sticky-added',
    'sticky-moved',
    'sticky-removed',
] as const satisfies readonly FileEventType[];

// More than the two lines an activity row shows, so a clip is never visible. The route caps a posted detail at it.
export const CARD_TITLE_MAX_LENGTH = 200;

type ClientFileEventType = (typeof CLIENT_FILE_EVENT_TYPES)[number];

export function isClientFileEventType(type: string): type is ClientFileEventType {
    return CLIENT_FILE_EVENT_TYPES.some((clientType) => clientType === type);
}

// What a writer records: details are required exactly when the event type has them.
export type FileEventRecord = {
    [K in FileEventType]: { eventType: K } & (K extends keyof FileEventDetailsMap
        ? { details: FileEventDetailsMap[K] }
        : { details?: undefined });
}[FileEventType];

export type ClientFileEventRecord = Extract<FileEventRecord, { eventType: ClientFileEventType }>;

// What a client may post to the history route.
export type ClientFileEventInput = {
    [K in ClientFileEventType]: { eventType: K; details: FileEventDetailsMap[K] };
}[ClientFileEventType];

export type FileEventInput = FileEventRecord & { pathId: string; actor: { id: string; email: string } };

// An event as it is read. The path's name and type are read with it, so a folder's timeline can name and link the
// item inside it that the event happened on.
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

// describeFileEvent says the plain verbs straight from this table and phrases the richer ones itself. The table also
// checks a stored type (toFileEventType), and the server writes notification titles with it, so it lives here.
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
    'versions-deleted': 'deleted the version history',
    commented: 'commented',
    'sticky-added': 'added a card',
    'sticky-moved': 'moved a card',
    'sticky-removed': 'removed a card',
    assigned: 'assigned a comment',
    resolved: 'resolved a comment',
    reopened: 'reopened a comment',
};

// A stored row can hold a type this build doesn't know. It reads as 'edited', so every FileEvent has a known type
// and every row has words.
export function toFileEventType(raw: string): FileEventType {
    return Object.hasOwn(FILE_EVENT_PHRASES, raw) ? (raw as FileEventType) : 'edited';
}

export type ActivityLines = { action: string; primary?: string; secondary?: string };

const isTeamPrincipal = (id: string) => parseOwnerId(id).type === 'team';

// The teams an acl-changed row names. The row's words and every list that looks up the team names first read them
// here, so the lookup never misses a team the row shows.
export function aclPrincipalsToResolve(details: FileEvent['details'] | undefined): string[] {
    if (!details || !('added' in details)) return [];
    return [...new Set([...details.added, ...details.removed])].filter(isTeamPrincipal);
}

// The caller puts the actor in front. In 'own' the item's name is left out, because the list's title shows it. The
// details are narrowed with `in`, because the Pick loses the union.
export function describeFileEvent(
    event: Pick<FileEvent, 'eventType' | 'details' | 'pathName' | 'pathType'>,
    ctx: 'own' | 'container',
    opts?: { resolveName?: (idOrEmail: string) => string | undefined; viewerEmail?: string },
): ActivityLines {
    const name = stripEigenExtension(event.pathName);
    const container = ctx === 'container';
    const details = event.details;

    switch (event.eventType) {
        case 'renamed': {
            const d = details && 'oldName' in details ? details : null;
            return { action: 'renamed', primary: d ? `${d.oldName} → ${d.newName}` : undefined };
        }
        // A bare "created" on the item's own list reads as if a word were missing, so these two name the item.
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
                // An email reads fine as it is, but a team's id doesn't, so only a team is shown by its name.
                const label = (id: string) =>
                    isTeamPrincipal(id) ? (opts?.resolveName?.(id) ?? UNRESOLVED_TEAM_LABEL) : id;
                const added = d.added.map(label).join(', ');
                const removed = d.removed.map(label).join(', ');
                if (d.added.length && d.removed.length) secondary = `Added ${added} · removed ${removed}`;
                else if (d.added.length) secondary = `Added ${added}`;
                else if (d.removed.length) secondary = `Removed ${removed}`;
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
            // The plain verbs, such as edited, moved or trashed: the phrase, with the name as the primary line.
            return { action: FILE_EVENT_PHRASES[event.eventType], primary: container ? name : undefined };
    }
}
