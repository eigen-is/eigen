import { mailboxRouteSegment, SIDEBAR_MAILBOXES, specialMailboxFromFlags } from '@workspace/lib/constants/mailboxes';
import { MAILBOX_ICONS } from '@workspace/lib/mailbox-icons';
import type { MaildirMailbox } from '@workspace/lib/types/mail';
import { SidebarBody, SidebarItem, SidebarSection } from '@workspace/ui';
import { StorageUsage } from '@workspace/ui/components/home';
import { DroppableSidebarItem } from '@workspace/ui/components/layout/sidebar/droppable-sidebar-item';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { EmailComposeButton } from './email-compose-button';

type SidebarMailbox = {
    path: string;
    name: string;
    icon: React.ReactNode;
    href: string;
    unread: number;
};

const mailboxHref = (path: string) => `/box/${mailboxRouteSegment(path)}`;

const renderIcon = (Icon: LucideIcon) => <Icon className="h-4 w-4" />;

// Shown while the mailbox list is still loading or after it failed.
const defaultMailboxes: SidebarMailbox[] = SIDEBAR_MAILBOXES.map((box) => ({
    path: box.path,
    name: box.label,
    icon: renderIcon(MAILBOX_ICONS[box.path]),
    href: mailboxHref(box.path),
    unread: 0,
}));

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
    // The special mailboxes in sidebar order, or the defaults while the list is loading or failed.
    const standardMailboxList = useMemo(() => {
        if (isLoading || error) return defaultMailboxes;
        const bySpecialPath = new Map<string, SidebarMailbox>();
        for (const mailbox of mailboxes) {
            const special = specialMailboxFromFlags(mailbox.flags);
            if (!special) continue;
            bySpecialPath.set(special.path, {
                path: mailbox.path,
                name: special.label,
                icon: renderIcon(MAILBOX_ICONS[special.path]),
                href: mailboxHref(mailbox.path),
                unread: mailbox.unread,
            });
        }
        return SIDEBAR_MAILBOXES.flatMap((box) => bySpecialPath.get(box.path) ?? []);
    }, [mailboxes, isLoading, error]);

    return (
        <SidebarBody>
            <EmailComposeButton condensed={condensed} />

            <SidebarSection condensed={condensed} loading={isLoading}>
                {standardMailboxList.map((item) => {
                    if (onMoveToFolder) {
                        return (
                            <DroppableSidebarItem
                                key={item.path || item.name}
                                icon={item.icon}
                                label={item.unread > 0 ? `${item.name} (${item.unread})` : item.name}
                                to={item.href}
                                condensed={condensed}
                                acceptTypes={['email']}
                                onDrop={(data) => onMoveToFolder(data.ids, item.path)}
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
