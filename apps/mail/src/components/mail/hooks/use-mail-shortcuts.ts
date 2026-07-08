import { useHotkey } from '@tanstack/react-hotkeys';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';

type UseMailShortcutsOptions = {
    orderedEmails: EmailSummary[];
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    selection: UseListSelectionReturn<EmailSummary>;
    // The open conversation — part of the list context the bag carries; no Phase 2 key reads it.
    openEmailId?: string;
    isComposing: boolean;
    shortcutsEnabled: boolean;
    onRowClick: (emailId: string) => void;
    navigateToList: () => void;
    onCompose: () => void;
    focusSearch: () => void;
    openHelp: () => void;
};

// The Gmail keyboard layer for mail. Pure registration (renders nothing), called from MailRoute so
// every key acts on the same ordered rows/cursor/selection the list renders. The whole map is inert
// unless the user opted in AND the composer is closed. @tanstack/react-hotkeys auto-suppresses single
// keys (and Shift combos) while an input/contenteditable is focused, so no manual target guards.
// Destructive/reply/auto-advance keys are Phase 3; Enter and Escape stay on the EmailList container.
export function useMailShortcuts({
    orderedEmails,
    cursorIndex,
    setCursorIndex,
    selection,
    isComposing,
    shortcutsEnabled,
    onRowClick,
    navigateToList,
    onCompose,
    focusSearch,
    openHelp,
}: UseMailShortcutsOptions): void {
    const enabled = shortcutsEnabled && !isComposing;

    // Letters are registered uppercase — the lib's typed Key union is A–Z and its matcher is
    // case-insensitive, so 'J' fires on a lowercase j (and NOT on Shift+J).

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
    // / — focus the list search input. preventDefault so the slash isn't typed into it.
    useHotkey(
        '/',
        (e) => {
            e.preventDefault();
            focusSearch();
        },
        { enabled },
    );
    // ? — toggle the help overlay. A RawHotkey: '?' is Shift+/ on a US layout, and the lib's typed
    // string union excludes Shift+punctuation as layout-dependent, so the matcher needs key '?' + shift.
    useHotkey({ key: '?', shift: true }, () => openHelp(), { enabled });
}
