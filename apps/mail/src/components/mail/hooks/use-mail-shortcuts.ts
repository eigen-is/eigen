import { useHotkey } from '@tanstack/react-hotkeys';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';

type UseMailShortcutsOptions = {
    orderedEmails: EmailSummary[];
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    selection: UseListSelectionReturn<EmailSummary>;
    isComposing: boolean;
    helpOpen: boolean;
    shortcutsEnabled: boolean;
    onRowClick: (emailId: string) => void;
    navigateToList: () => void;
    onCompose: () => void;
    focusSearch: () => void;
    openHelp: () => void;
};

// The Gmail keyboard layer for mail. Pure registration, called from MailRoute so every key acts on
// the same rows/cursor/selection the list renders. Inert unless opted in, and while composing or the
// help overlay is open. The lib auto-suppresses single keys (and Shift combos) in inputs. Enter and
// Escape stay on the EmailList container; destructive/reply/auto-advance keys are Phase 3.
export function useMailShortcuts({
    orderedEmails,
    cursorIndex,
    setCursorIndex,
    selection,
    isComposing,
    helpOpen,
    shortcutsEnabled,
    onRowClick,
    navigateToList,
    onCompose,
    focusSearch,
    openHelp,
}: UseMailShortcutsOptions): void {
    const enabled = shortcutsEnabled && !isComposing && !helpOpen;

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
}
