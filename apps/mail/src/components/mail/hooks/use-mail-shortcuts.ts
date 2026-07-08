import { useHotkey } from '@tanstack/react-hotkeys';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';

type UseMailShortcutsOptions = {
    orderedEmails: EmailSummary[];
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    setCursorById: (id: string | undefined) => void;
    selection: UseListSelectionReturn<EmailSummary>;
    isComposing: boolean;
    helpOpen: boolean;
    shortcutsEnabled: boolean;
    openEmailId: string | undefined;
    onRowClick: (emailId: string) => void;
    navigateToList: () => void;
    onCompose: () => void;
    focusSearch: () => void;
    openHelp: () => void;
    // Open-conversation landing (auto-advance), owned by the route so the toolbar shares it.
    actOnOpenEmail: (action: 'archive' | 'delete' | 'spam') => void;
    // Delete-with-confirm for the cursored row: resolves true once actually deleted, false if the
    // Trash confirm dialog was opened instead (so the cursor only slides on a real delete).
    requestDeleteById: (emailId: string) => Promise<boolean>;
    moveEmailByIdOnly: (emailId: string, mailbox: string) => Promise<void>;
    setReadById: (emailId: string, isRead: boolean, currentIsRead: boolean) => void | Promise<void>;
    setFlaggedById: (emailId: string, flagged: boolean, currentFlagged: boolean) => void | Promise<void>;
    archiveEmailsByIds: (emailIds: string[]) => void | Promise<void>;
    reportSpamByIds: (emailIds: string[]) => void | Promise<void>;
    deleteEmailsByIds: (emailIds: string[]) => void | Promise<void>;
    onReply: (emailId: string) => void;
    onReplyAll: (emailId: string) => void;
    onForward: (emailId: string) => void;
    undoLast: () => void | Promise<void>;
};

// The Gmail keyboard layer for mail. Pure registration, called from MailRoute so every key acts on
// the same rows/cursor/selection the list renders. Inert unless opted in, and while composing or the
// help overlay is open. The lib auto-suppresses keys (and Shift combos) in inputs. Target priority is
// open conversation > checkbox selection > cursor; landing rules per the Phase 3 brief.
export function useMailShortcuts({
    orderedEmails,
    cursorIndex,
    setCursorIndex,
    setCursorById,
    selection,
    isComposing,
    helpOpen,
    shortcutsEnabled,
    openEmailId,
    onRowClick,
    navigateToList,
    onCompose,
    focusSearch,
    openHelp,
    actOnOpenEmail,
    requestDeleteById,
    moveEmailByIdOnly,
    setReadById,
    setFlaggedById,
    archiveEmailsByIds,
    reportSpamByIds,
    deleteEmailsByIds,
    onReply,
    onReplyAll,
    onForward,
    undoLast,
}: UseMailShortcutsOptions): void {
    const enabled = shortcutsEnabled && !isComposing && !helpOpen;

    // Target-resolution snapshot, recomputed each render (useHotkey re-syncs callbacks so no stale
    // closures). `open` gates the open-conversation branch; cursorId is the cursored row's id.
    const open = !!openEmailId && !isComposing;
    const cursorId = cursorIndex >= 0 && cursorIndex < orderedEmails.length ? orderedEmails[cursorIndex].id : undefined;

    // Letters register uppercase — the matcher is case-insensitive, so 'J' fires on lowercase j.

    // j — older/next row, cursor only (no open). The EmailList scroll effect reacts to cursorIndex.
    useHotkey(
        'J',
        () => {
            if (orderedEmails.length > 0) {
                setCursorIndex(cursorIndex < 0 ? 0 : Math.min(cursorIndex + 1, orderedEmails.length - 1));
            }
        },
        { enabled },
    );
    // k — newer/prev row, cursor only.
    useHotkey(
        'K',
        () => {
            if (orderedEmails.length > 0) setCursorIndex(cursorIndex < 0 ? 0 : Math.max(cursorIndex - 1, 0));
        },
        { enabled },
    );
    // o — open the cursored row.
    useHotkey(
        'O',
        () => {
            if (cursorIndex >= 0 && cursorIndex < orderedEmails.length) onRowClick(orderedEmails[cursorIndex].id);
        },
        { enabled },
    );
    // u — back to the list from an open conversation.
    useHotkey('U', () => navigateToList(), { enabled });
    // x — toggle the cursored row's checkbox selection.
    useHotkey(
        'X',
        () => {
            if (cursorIndex >= 0 && cursorIndex < orderedEmails.length) selection.toggle(orderedEmails[cursorIndex].id);
        },
        { enabled },
    );
    // c — compose a new message.
    useHotkey('C', () => onCompose(), { enabled });
    // / — focus the list search input (the lib preventDefaults, so the slash isn't typed).
    useHotkey('/', () => focusSearch(), { enabled });
    // ? — open the help overlay. RawHotkey because '?' is Shift+/ (layout-dependent, excluded from
    // the lib's typed string union), so the matcher needs key '?' + shift.
    useHotkey({ key: '?', shift: true }, () => openHelp(), { enabled });

    // Destructive: e archive / ! spam / # delete. Priority open > selection > cursor.
    const runDestructive = (action: 'archive' | 'spam' | 'delete') => {
        if (open) {
            actOnOpenEmail(action);
            return;
        }
        if (selection.selectedCount > 0) {
            const ids = selection.selectedItems.map((e) => e.id);
            if (action === 'archive') archiveEmailsByIds(ids);
            else if (action === 'spam') reportSpamByIds(ids);
            else deleteEmailsByIds(ids);
            selection.clearSelection();
            return;
        }
        if (cursorIndex >= 0 && cursorIndex < orderedEmails.length) {
            const id = orderedEmails[cursorIndex].id;
            // Neighbour computed BEFORE mutating; the cursor slides there once the row is gone.
            const nextId = orderedEmails[cursorIndex + 1]?.id ?? orderedEmails[cursorIndex - 1]?.id;
            if (action === 'delete') {
                void requestDeleteById(id).then((deleted) => {
                    if (deleted) setCursorById(nextId);
                });
            } else {
                setCursorById(nextId);
                void moveEmailByIdOnly(id, action === 'archive' ? 'Archive' : 'Junk');
            }
        }
    };
    // e — archive.
    useHotkey('E', () => runDestructive('archive'), { enabled });
    // # — delete (Trash mail routes through the confirm dialog). RawHotkey: '#' is Shift+3.
    useHotkey({ key: '#', shift: true }, () => runDestructive('delete'), { enabled });
    // ! — report spam. RawHotkey: '!' is Shift+1.
    useHotkey({ key: '!', shift: true }, () => runDestructive('spam'), { enabled });

    // ] archive-and-newer / [ archive-and-older — ALWAYS advance a fixed direction, ignore autoAdvance.
    const archiveAndAdvance = (direction: 'newer' | 'older') => {
        const delta = direction === 'newer' ? -1 : 1;
        if (open && openEmailId) {
            const idx = orderedEmails.findIndex((e) => e.id === openEmailId);
            const neighbourId = orderedEmails[idx + delta]?.id;
            void moveEmailByIdOnly(openEmailId, 'Archive');
            if (neighbourId) onRowClick(neighbourId);
            else navigateToList();
            return;
        }
        if (cursorIndex >= 0 && cursorIndex < orderedEmails.length) {
            const id = orderedEmails[cursorIndex].id;
            setCursorById(orderedEmails[cursorIndex + delta]?.id);
            void moveEmailByIdOnly(id, 'Archive');
        }
    };
    // ] — archive and go to the newer neighbour.
    useHotkey(']', () => archiveAndAdvance('newer'), { enabled });
    // [ — archive and go to the older neighbour.
    useHotkey('[', () => archiveAndAdvance('older'), { enabled });

    // s — toggle flag. Priority open > selection > cursor; no landing change. Pass the row's CURRENT
    // isFlagged (fresh list summary) so the mutation guards on what the user sees, not the stale detail.
    const toggleFlag = () => {
        if (open && openEmailId) {
            const s = orderedEmails.find((e) => e.id === openEmailId);
            if (s) setFlaggedById(openEmailId, !s.isFlagged, s.isFlagged);
            return;
        }
        if (selection.selectedCount > 0) {
            for (const e of selection.selectedItems) setFlaggedById(e.id, !e.isFlagged, e.isFlagged);
            return;
        }
        if (cursorId) {
            const s = orderedEmails.find((e) => e.id === cursorId);
            if (s) setFlaggedById(cursorId, !s.isFlagged, s.isFlagged);
        }
    };
    useHotkey('S', () => toggleFlag(), { enabled });

    // Shift+i mark read / Shift+u mark unread. Priority open > selection > cursor; no landing change.
    // Pass the row's CURRENT isRead (fresh list summary) so the mutation guards against what the user
    // sees, not the possibly-stale detail cache.
    const setRead = (isRead: boolean) => {
        if (open && openEmailId) {
            const s = orderedEmails.find((e) => e.id === openEmailId);
            if (s) void setReadById(openEmailId, isRead, s.isRead);
            return;
        }
        if (selection.selectedCount > 0) {
            for (const e of selection.selectedItems) void setReadById(e.id, isRead, e.isRead);
            return;
        }
        if (cursorId) {
            const s = orderedEmails.find((e) => e.id === cursorId);
            if (s) void setReadById(cursorId, isRead, s.isRead);
        }
    };
    useHotkey({ key: 'I', shift: true }, () => setRead(true), { enabled });
    useHotkey({ key: 'U', shift: true }, () => setRead(false), { enabled });

    // z — undo the last reversible action (move/read/flag). No-op when nothing is recorded.
    useHotkey('Z', () => void undoLast(), { enabled });

    // r reply / a reply-all / f forward — target the open email, else the cursored row. No batch.
    const reply = (handler: (emailId: string) => void) => {
        const id = open && openEmailId ? openEmailId : cursorId;
        if (id) handler(id);
    };
    useHotkey('R', () => reply(onReply), { enabled });
    useHotkey('A', () => reply(onReplyAll), { enabled });
    useHotkey('F', () => reply(onForward), { enabled });
}
