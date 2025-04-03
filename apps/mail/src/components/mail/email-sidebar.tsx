import {AlertOctagon, Archive, ArchiveX, File, Inbox, Send, Trash2, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import React, {useMemo} from 'react';
import {EigenLoader} from "@workspace/ui";
import {EmailComposeButton} from "./email-compose-button";

// Map of special mailbox flags to their icons and display names
const standardMailboxes: Record<string, { icon: React.ComponentType<any>, name: string }> = {
    '\\Inbox': {icon: Inbox, name: 'Inbox'},
    '\\Drafts': {icon: File, name: 'Drafts'},
    '\\Sent': {icon: Send, name: 'Sent'},
    '\\Junk': {icon: AlertOctagon, name: 'Spam'},
    '\\Trash': {icon: Trash2, name: 'Trash'},
    '\\Archive': {icon: Archive, name: 'Archive'},
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
        path: "Drafts",
        name: "Drafts",
        icon: <File className="h-4 w-4"/>,
        href: "/box/drafts",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Drafts']
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
        path: "Spam",
        name: "Spam",
        icon: <ArchiveX className="h-4 w-4"/>,
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
    {
        path: "Archive",
        name: "Archive",
        icon: <Archive className="h-4 w-4"/>,
        href: "/box/archive",
        unread: 0,
        flags: ['\\HasNoChildren', '\\Archive']
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
    mailboxes?: any[];
    isLoading?: boolean;
    error?: any;
}

export function EmailSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,
                                 mailboxes = [],
                                 isLoading = false,
                                 error = false
                             }: AppSidebarProps) {

    // Memoize the processed mailboxes to avoid unnecessary recalculations
    const standardMailboxList = useMemo(() => {
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
        const standardMailboxListFetched = displayMailboxes.filter(mailbox => mailbox.isStandard);

        // order standard mailboxes, similar to the order of defaultMailboxes
        const standardMailboxList = defaultMailboxes.map(defaultMailbox =>
            standardMailboxListFetched.filter(mailbox => mailbox.name.toLowerCase() === defaultMailbox.name.toLowerCase())
        ).flat();


        return standardMailboxList;
    }, [mailboxes]);

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">

            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="mail"/>
                </div>
            )}

            <div className="px-3 py-2">
                <EmailComposeButton condensed={condensed}/>
            </div>

            <SidebarSection condensed={condensed}>


                {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                        <EigenLoader/>
                    </div>
                ) : (
                    standardMailboxList.map((item) => (
                        <SidebarItem
                            key={item.path || item.name}
                            icon={item.icon}
                            label={item.unread > 0 ? `${item.name} (${item.unread})` : item.name}
                            to={item.href}
                            condensed={condensed}
                        />
                    ))
                )}
            </SidebarSection>

            {/* Custom mailboxes section */}
            {/* {customMailboxes.length > 0 && (
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
                                label={item.unread > 0 ? `${item.name} (${item.unread})` : item.name}
                                to={item.href}
                                condensed={condensed}
                            />
                        ))}
                    </SidebarSection>
                </>
            )} */}

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
    );
}
