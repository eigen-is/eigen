import {AlertOctagon, Archive, File, Inbox, Loader2, Plus, Send, Trash2, X} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import {Button} from "@workspace/ui/components/button";
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {useMailboxes} from '../../hooks/use-mailboxes';
import React from 'react';

// Map of special mailbox flags to their icons and display names
const standardMailboxes: Record<string, { icon: React.ComponentType<any>, name: string }> = {
    '\\Inbox': {icon: Inbox, name: 'Inbox'},
    '\\Sent': {icon: Send, name: 'Sent'},
    '\\Drafts': {icon: File, name: 'Drafts'},
    '\\Archive': {icon: Archive, name: 'Archive'},
    '\\Junk': {icon: AlertOctagon, name: 'Spam'},
    '\\Trash': {icon: Trash2, name: 'Trash'},
};

// Default mailboxes to display if API call fails
const defaultMailboxes = [
    {
        path: "INBOX",
        name: "Inbox",
        icon: <Inbox className="h-4 w-4"/>,
        href: "/box/inbox",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Inbox']
    },
    {
        path: "Sent",
        name: "Sent",
        icon: <Send className="h-4 w-4"/>,
        href: "/box/sent",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Sent']
    },
    {
        path: "Drafts",
        name: "Drafts",
        icon: <File className="h-4 w-4"/>,
        href: "/box/drafts",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Drafts']
    },
    {
        path: "Archive",
        name: "Archive",
        icon: <Archive className="h-4 w-4"/>,
        href: "/box/archive",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Archive']
    },
    {
        path: "Spam",
        name: "Spam",
        icon: <AlertOctagon className="h-4 w-4"/>,
        href: "/box/spam",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Junk']
    },
    {
        path: "Trash",
        name: "Trash",
        icon: <Trash2 className="h-4 w-4"/>,
        href: "/box/trash",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Trash']
    },
];

// Helper function to get the standard mailbox flag
function getStandardMailboxFlag(flags: string[] = []): string | null {
    const standardFlags = Object.keys(standardMailboxes);
    return flags.find(flag => standardFlags.includes(flag)) || null;
}

interface AppSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function AppSidebar({condensed = false, onClose, isMobile = false}: AppSidebarProps) {
    const {data: mailboxes = [], isLoading, error} = useMailboxes();

    // Process mailboxes from API or use defaults if needed
    const processedMailboxes = mailboxes.map(mailbox => {
        const path = mailbox.path || '';
        const name = mailbox.name || path;
        const flags = mailbox.flags || [];

        // Get the standard mailbox flag if it exists
        const standardFlag = getStandardMailboxFlag(flags);

        // Get icon component based on standard flag or use default
        let icon;
        if (standardFlag && standardMailboxes[standardFlag]) {
            const IconComponent = standardMailboxes[standardFlag].icon;
            icon = <IconComponent className="h-4 w-4"/>;
        } else {
            icon = <File className="h-4 w-4"/>;
        }

        return {
            ...mailbox,
            name: standardFlag ? standardMailboxes[standardFlag].name : name,
            href: `/box/${path.toLowerCase() || 'inbox'}`,
            icon,
            isStandard: !!standardFlag
        };
    });

    // Use API mailboxes if available, otherwise fall back to defaults
    const displayMailboxes = isLoading || error ? defaultMailboxes : processedMailboxes;

    // Separate standard mailboxes from custom mailboxes
    const standardMailboxList = displayMailboxes.filter(mailbox => mailbox.isStandard);
    const customMailboxes = displayMailboxes.filter(mailbox => !mailbox.isStandard);

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {/* Mobile header */}
            {isMobile && (
                <div className="flex items-center justify-between p-4 border-b">
                    <AppLogo appName="Mail"/>
                    <Button variant="ghost" size="icon" onClick={onClose}>
                        <X className="h-5 w-5"/>
                    </Button>
                </div>
            )}

            <div className="flex-1 overflow-auto py-2">
                {/* Compose button */}
                <div className="px-3 py-2">
                    <Button variant="default" size={condensed ? "icon" : "default"} asChild
                            className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}>
                        <Link to="/">
                            <Plus className="h-4 w-4"  />
                            {!condensed && "Compose"}
                        </Link>
                    </Button>
                </div>

                <SidebarSection condensed={condensed}>


                    {isLoading ? (
                        <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground"/>
                        </div>
                    ) : (
                        standardMailboxList.map((item) => (
                            <SidebarItem
                                key={item.path || item.name}
                                icon={item.icon}
                                label={item.name}
                                to={item.href}
                                condensed={condensed}
                            />
                        ))
                    )}
                </SidebarSection>

                {/* Custom mailboxes section */}
                {customMailboxes.length > 0 && (
                    <>
                        <Separator className="my-2"/>
                        <SidebarSection
                            title="Folders"
                            condensed={condensed}
                        >
                            {customMailboxes.map((item) => (
                                <SidebarItem
                                    key={item.path || item.name}
                                    icon={item.icon}
                                    label={item.name}
                                    to={item.href}
                                    condensed={condensed}
                                />
                            ))}
                        </SidebarSection>
                    </>
                )}

                {/* Create new folder button */}
                {/*<div className="px-3 mt-4">*/}
                {/*    <Button*/}
                {/*        variant="outline"*/}
                {/*        size="sm"*/}
                {/*        className="w-full justify-start"*/}
                {/*    >*/}
                {/*        <Plus className="mr-2 h-4 w-4"/>*/}
                {/*        {!condensed && "New Folder"}*/}
                {/*    </Button>*/}
                {/*</div>*/}
            </div>
        </div>
    );
}
