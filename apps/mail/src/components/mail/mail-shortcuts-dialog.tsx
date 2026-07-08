import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';

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
        title: 'Selection',
        shortcuts: [{ keys: ['x'], label: 'Select conversation' }],
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
};

export function MailShortcutsDialog({ open, onOpenChange }: MailShortcutsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="lg">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>Single-key shortcuts to move around Mail without the mouse.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-6 sm:grid-cols-2">
                    {SHORTCUT_GROUPS.map((group) => (
                        <div key={group.title} className="flex flex-col gap-2">
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
                                        <span className="flex gap-1">
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
            </DialogContent>
        </Dialog>
    );
}
