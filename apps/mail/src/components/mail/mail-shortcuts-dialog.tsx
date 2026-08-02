import { getSpaceAppUrl } from '@workspace/lib/api';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';

type Shortcut = { keys: string[]; label: string };
type ShortcutGroup = { title: string; shortcuts: Shortcut[] };

// The displayed reference, grouped as in Gmail. Kept adjacent in intent to useMailShortcuts —
// a Phase 3/5 key is a one-line addition here (and its binding there).
const SHORTCUT_GROUPS: ShortcutGroup[] = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: ['j'], label: 'Older conversation' },
            { keys: ['k'], label: 'Newer conversation' },
            { keys: ['o'], label: 'Open conversation' },
            { keys: ['u'], label: 'Back to the list' },
        ],
    },
    {
        title: 'Jump',
        shortcuts: [
            { keys: ['g', 'i'], label: 'Inbox' },
            { keys: ['g', 't'], label: 'Sent' },
            { keys: ['g', 'd'], label: 'Drafts' },
        ],
    },
    {
        title: 'Selection',
        shortcuts: [{ keys: ['x'], label: 'Select conversation' }],
    },
    {
        title: 'Select',
        shortcuts: [
            { keys: ['*', 'a'], label: 'All' },
            { keys: ['*', 'n'], label: 'None' },
            { keys: ['*', 'r'], label: 'Read' },
            { keys: ['*', 'u'], label: 'Unread' },
            { keys: ['*', 's'], label: 'Starred' },
            { keys: ['*', 't'], label: 'Unstarred' },
        ],
    },
    {
        title: 'Actions',
        shortcuts: [
            { keys: ['e'], label: 'Archive' },
            { keys: ['#'], label: 'Delete' },
            { keys: ['!'], label: 'Report spam' },
            { keys: ['s'], label: 'Toggle star' },
            { keys: ['Shift', 'i'], label: 'Mark as read' },
            { keys: ['Shift', 'u'], label: 'Mark as unread' },
            { keys: [']'], label: 'Archive & newer' },
            { keys: ['['], label: 'Archive & older' },
            { keys: ['z'], label: 'Undo last action' },
        ],
    },
    {
        title: 'Conversation',
        shortcuts: [
            { keys: ['r'], label: 'Reply' },
            { keys: ['a'], label: 'Reply all' },
            { keys: ['f'], label: 'Forward' },
        ],
    },
    {
        title: 'Application',
        shortcuts: [
            { keys: ['c'], label: 'Compose' },
            { keys: ['/'], label: 'Search' },
            { keys: ['?'], label: 'Show this help' },
        ],
    },
];

type MailShortcutsDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Whether the keyboard layer is actually active (the opt-in space setting). When off, the
    // sheet is still reachable from the toolbar, so it says so rather than implying the keys work.
    enabled: boolean;
};

export function MailShortcutsDialog({ open, onOpenChange, enabled }: MailShortcutsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* flex + max-h so the header stays put and the groups scroll when they don't fit the viewport. */}
            <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>Keyboard shortcuts to move around Mail without the mouse.</DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {/* Balanced CSS columns flow the groups top-to-bottom, evenly, without the ragged
                        gaps a row-based grid leaves. break-inside-avoid keeps a group whole. */}
                    <div className="columns-1 gap-8 sm:columns-2">
                        {SHORTCUT_GROUPS.map((group) => (
                            <div key={group.title} className="mb-6 flex break-inside-avoid flex-col gap-2">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    {group.title}
                                </h3>
                                <ul className="flex flex-col gap-2">
                                    {group.shortcuts.map((shortcut) => (
                                        <li
                                            key={shortcut.label}
                                            className="flex items-center justify-between gap-4 text-sm text-foreground"
                                        >
                                            <span>{shortcut.label}</span>
                                            <span className="flex shrink-0 gap-1">
                                                {shortcut.keys.map((key) => (
                                                    <kbd
                                                        key={key}
                                                        className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-muted-foreground"
                                                    >
                                                        {key}
                                                    </kbd>
                                                ))}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
                {!enabled && (
                    <p className="text-xs text-muted-foreground">
                        Keyboard shortcuts are turned off.{' '}
                        <a href={getSpaceAppUrl('email')} className="text-link hover:underline">
                            Turn them on in Mail settings
                        </a>
                        .
                    </p>
                )}
                <DialogFooter showCloseButton />
            </DialogContent>
        </Dialog>
    );
}
