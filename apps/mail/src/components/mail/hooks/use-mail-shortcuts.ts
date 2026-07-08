import { useHotkey, useHotkeySequence } from '@tanstack/react-hotkeys';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';
import { useEffect, useRef, useState } from 'react';

// `g`-jump chords go through useHotkeySequence (plain letters, no single-key conflict). The `*`-select
// chords do NOT — a '*' press emits a Shift keydown first, which the sequence matcher trips over, so
// they run in one capture-phase listener below (§ `*` select chords).
type MailSequence = Parameters<typeof useHotkeySequence>[0];
const SEQ_JUMP_INBOX: MailSequence = ['G', 'I'];
const SEQ_JUMP_SENT: MailSequence = ['G', 'T'];
const SEQ_JUMP_DRAFTS: MailSequence = ['G', 'D'];
// The window in which a '*' arms the next key as a select-chord tail.
const CHORD_TIMEOUT_MS = 1000;

// Mirror of the hotkey lib's own input check. Sequences (unlike single keys) have no built-in input
// guard, so we suppress the chords while the user is typing in a field.
function isEditableTarget(el: Element | null): boolean {
    if (el instanceof HTMLInputElement) {
        const type = el.type.toLowerCase();
        return type !== 'button' && type !== 'submit' && type !== 'reset';
    }
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    return el instanceof HTMLElement && el.isContentEditable;
}

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
    navigateToMailbox: (filterId: string) => void;
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
    setReadByIds: (items: { id: string; currentIsRead: boolean }[], isRead: boolean) => void | Promise<void>;
    setFlaggedByIds: (items: { id: string; currentFlagged: boolean }[], flagged: boolean) => void | Promise<void>;
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
    navigateToMailbox,
    onCompose,
    focusSearch,
    openHelp,
    actOnOpenEmail,
    requestDeleteById,
    moveEmailByIdOnly,
    setReadById,
    setFlaggedById,
    setReadByIds,
    setFlaggedByIds,
    archiveEmailsByIds,
    reportSpamByIds,
    deleteEmailsByIds,
    onReply,
    onReplyAll,
    onForward,
    undoLast,
}: UseMailShortcutsOptions): void {
    const enabled = shortcutsEnabled && !isComposing && !helpOpen;

    // The sequence matcher (unlike the single-key one) fires even inside inputs, so gate the chords
    // off while a field is focused — otherwise typing e.g. "git" in search would trigger `g i`.
    const [inputFocused, setInputFocused] = useState(false);
    useEffect(() => {
        if (!enabled) return;
        const sync = () => setInputFocused(isEditableTarget(document.activeElement));
        sync();
        document.addEventListener('focusin', sync);
        document.addEventListener('focusout', sync);
        return () => {
            document.removeEventListener('focusin', sync);
            document.removeEventListener('focusout', sync);
        };
    }, [enabled]);
    const chordsEnabled = enabled && !inputFocused;

    // `*` select chords in one capture-phase listener: `*` arms, and the key right after it (within
    // CHORD_TIMEOUT_MS) SETS the selection to a subset (Gmail's * a/n/r/u/s/t). The same tail flag lets
    // the single keys it shadows (a/r/u/s) bow out below — n/t aren't single keys so never conflict.
    // Refs feed the listener the current rows/selection without re-registering it every render.
    const orderedRef = useRef(orderedEmails);
    orderedRef.current = orderedEmails;
    const selectionRef = useRef(selection);
    selectionRef.current = selection;
    const starTail = useRef(false);
    const lastStarAt = useRef(0);
    useEffect(() => {
        if (!chordsEnabled) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === '*') {
                lastStarAt.current = Date.now();
                starTail.current = false;
                return;
            }
            starTail.current = Date.now() - lastStarAt.current <= CHORD_TIMEOUT_MS;
            lastStarAt.current = 0; // only the key immediately after a `*` is a tail
            if (!starTail.current) return;
            const sel = selectionRef.current;
            const rows = orderedRef.current;
            switch (e.key.toLowerCase()) {
                case 'a':
                    sel.setSelection(rows.map((m) => m.id));
                    break;
                case 'n':
                    sel.clearSelection();
                    break;
                case 'r':
                    sel.setSelection(rows.filter((m) => m.isRead).map((m) => m.id));
                    break;
                case 'u':
                    sel.setSelection(rows.filter((m) => !m.isRead).map((m) => m.id));
                    break;
                case 's':
                    sel.setSelection(rows.filter((m) => m.isFlagged).map((m) => m.id));
                    break;
                case 't':
                    sel.setSelection(rows.filter((m) => !m.isFlagged).map((m) => m.id));
                    break;
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [chordsEnabled]);

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
    // u — back to the list from an open conversation. Bows out when it's a `* u` chord tail.
    useHotkey(
        'U',
        () => {
            if (starTail.current) return;
            navigateToList();
        },
        { enabled },
    );
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
            // idx<0 (open email not in the list) would make orderedEmails[idx+1]=[0] land on the top
            // row for 'older'/[ — guard it so the neighbour is undefined and we fall back to the list.
            const neighbourId = idx < 0 ? undefined : orderedEmails[idx + delta]?.id;
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
            // Collapse the toggle to a single direction so ONE Undoable covers the whole batch: flag
            // all if any is unflagged, otherwise unflag all (matches the all-same cases exactly).
            const flagged = selection.selectedItems.some((e) => !e.isFlagged);
            void setFlaggedByIds(
                selection.selectedItems.map((e) => ({ id: e.id, currentFlagged: e.isFlagged })),
                flagged,
            );
            return;
        }
        if (cursorId) {
            const s = orderedEmails.find((e) => e.id === cursorId);
            if (s) setFlaggedById(cursorId, !s.isFlagged, s.isFlagged);
        }
    };
    // Bows out when it's a `* s` chord tail (select starred).
    useHotkey(
        'S',
        () => {
            if (starTail.current) return;
            toggleFlag();
        },
        { enabled },
    );

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
            void setReadByIds(
                selection.selectedItems.map((e) => ({ id: e.id, currentIsRead: e.isRead })),
                isRead,
            );
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
    // r and a bow out when they're a `* r`/`* a` chord tail; f has no chord so it never conflicts.
    useHotkey(
        'R',
        () => {
            if (starTail.current) return;
            reply(onReply);
        },
        { enabled },
    );
    useHotkey(
        'A',
        () => {
            if (starTail.current) return;
            reply(onReplyAll);
        },
        { enabled },
    );
    useHotkey('F', () => reply(onForward), { enabled });

    // Jump chords — `g` then i/t/d navigate to a mailbox (no single-key i/t/d, so no tail conflict).
    useHotkeySequence(SEQ_JUMP_INBOX, () => navigateToMailbox('inbox'), {
        enabled: chordsEnabled,
        timeout: CHORD_TIMEOUT_MS,
    });
    useHotkeySequence(SEQ_JUMP_SENT, () => navigateToMailbox('sent'), {
        enabled: chordsEnabled,
        timeout: CHORD_TIMEOUT_MS,
    });
    useHotkeySequence(SEQ_JUMP_DRAFTS, () => navigateToMailbox('drafts'), {
        enabled: chordsEnabled,
        timeout: CHORD_TIMEOUT_MS,
    });
}
