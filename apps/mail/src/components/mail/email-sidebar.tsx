import type { MaildirMailbox } from '@workspace/lib/types/mail';
import { StorageUsage } from '@workspace/ui';
import { DroppableSidebarItem } from '@workspace/ui/components/layout/sidebar/droppable-sidebar-item';
import { SidebarBody } from '@workspace/ui/components/layout/sidebar/sidebar-body';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { AlertOctagon, AlertTriangle, Archive, File, Inbox, Send, Trash2 } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { EmailComposeButton } from './email-compose-button';

// Map of special mailbox flags to their icons and display names
const standardMailboxes: Record<string, { icon: React.ComponentType<{ className?: string }>; name: string }> = {
    '\\Inbox': { icon: Inbox, name: 'Inbox' },
    '\\Drafts': { icon: File, name: 'Drafts' },
    '\\Sent': { icon: Send, name: 'Sent' },
    '\\Junk': { icon: AlertOctagon, name: 'Spam' },
    '\\Trash': { icon: Trash2, name: 'Trash' },
    '\\Archive': { icon: Archive, name: 'Archive' },
};

// Default mailboxes to display if API call fails
const defaultMailboxes = [
    {
        path: 'INBOX',
        name: 'Inbox',
        icon: <Inbox className="h-4 w-4" />,
        href: '/box/inbox',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Inbox'],
        isStandard: true,
    },
    {
        path: 'Drafts',
        name: 'Drafts',
        icon: <File className="h-4 w-4" />,
        href: '/box/drafts',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Drafts'],
        isStandard: true,
    },
    {
        path: 'Sent',
        name: 'Sent',
        icon: <Send className="h-4 w-4" />,
        href: '/box/sent',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Sent'],
        isStandard: true,
    },
    {
        path: 'Junk',
        name: 'Spam',
        icon: <AlertTriangle className="h-4 w-4" />,
        href: '/box/junk',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Junk'],
        isStandard: true,
    },
    {
        path: 'Trash',
        name: 'Trash',
        icon: <Trash2 className="h-4 w-4" />,
        href: '/box/trash',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Trash'],
        isStandard: true,
    },
    {
        path: 'Archive',
        name: 'Archive',
        icon: <Archive className="h-4 w-4" />,
        href: '/box/archive',
        unread: 0,
        flags: ['\\HasNoChildren', '\\Archive'],
        isStandard: true,
    },
];

// Helper function to get the standard mailbox flag
function getStandardMailboxFlag(flags: string[] = []): string | null {
    const standardFlags = Object.keys(standardMailboxes);
    return flags.find((flag) => standardFlags.includes(flag)) || null;
}

type AppSidebarProps = {
    condensed?: boolean;
    mailboxes?: MaildirMailbox[];
    isLoading?: boolean;
    error?: Error | null;
    onMoveToFolder?: (emailIds: string[], folderId: string) => void;
};

export function EmailSidebar({
    condensed = false,
    mailboxes = [],
    isLoading = false,
    error = null,
    onMoveToFolder,
}: AppSidebarProps) {
    // Memoize the processed mailboxes to avoid unnecessary recalculations
    const standardMailboxList = useMemo(() => {
        const processedMailboxes = mailboxes.map((mailbox) => {
            const path = mailbox.path || '';
            const name = mailbox.name || path;
            const flags = mailbox.flags || [];

            // Get the standard mailbox flag if it exists
            const standardFlag = getStandardMailboxFlag(flags);

            // Get icon component based on standard flag or use default
            let icon: React.ReactNode;
            if (standardFlag && standardMailboxes[standardFlag]) {
                const IconComponent = standardMailboxes[standardFlag].icon;
                icon = <IconComponent className="h-4 w-4" />;
            } else {
                icon = <File className="h-4 w-4" />;
            }

            return {
                ...mailbox,
                name: standardFlag ? standardMailboxes[standardFlag].name : name,
                href: `/box/${path.toLowerCase() || 'inbox'}`,
                icon,
                isStandard: !!standardFlag,
            };
        });

        // Use API mailboxes if available, otherwise fall back to defaults
        const displayMailboxes = isLoading || error ? defaultMailboxes : processedMailboxes;

        // Separate standard mailboxes from custom mailboxes
        const standardMailboxListFetched = displayMailboxes.filter((mailbox) => mailbox.isStandard);

        // order standard mailboxes, similar to the order of defaultMailboxes
        const standardMailboxList = defaultMailboxes.flatMap((defaultMailbox) =>
            standardMailboxListFetched.filter(
                (mailbox) => mailbox.name.toLowerCase() === defaultMailbox.name.toLowerCase(),
            ),
        );

        return standardMailboxList;
    }, [mailboxes, isLoading, error]);

    return (
        <SidebarBody>
            <EmailComposeButton condensed={condensed} />

            <SidebarSection condensed={condensed} loading={isLoading}>
                {standardMailboxList.map((item) => {
                    const folderId = item.path === '' || item.path?.toLowerCase() === 'inbox' ? '' : item.path || '';
                    if (onMoveToFolder) {
                        return (
                            <DroppableSidebarItem
                                key={item.path || item.name}
                                icon={item.icon}
                                label={item.unread > 0 ? `${item.name} (${item.unread})` : item.name}
                                to={item.href}
                                condensed={condensed}
                                acceptTypes={['email']}
                                onDrop={(data) => onMoveToFolder(data.ids, folderId)}
                            />
                        );
                    }
                    return (
                        <SidebarItem
                            key={item.path || item.name}
                            icon={item.icon}
                            label={item.unread > 0 ? `${item.name} (${item.unread})` : item.name}
                            to={item.href}
                            condensed={condensed}
                        />
                    );
                })}
            </SidebarSection>

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage className="mt-auto" condensed={condensed} />
        </SidebarBody>
    );
}
