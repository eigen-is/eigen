import {AlertOctagon, Archive, File, Inbox, MailPlus, Send, Star, Trash2, X} from "lucide-react";

import {Button} from "@workspace/ui/components/button";
import {useContext, useState} from "react";
import {LabelManager} from "../../../../../packages/ui/src/components/layout/labels";
import {SidebarContext} from "../../routes/__root";
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';


// Menu items for the sidebar
const sidebarItems = [
    {
        title: "Inbox",
        icon: Inbox,
        href: "/box/inbox",
    },
    {
        title: "Starred",
        icon: Star,
        href: "/box/starred",
    },
    {
        title: "Sent",
        icon: Send,
        href: "/box/sent",
    },
    {
        title: "Drafts",
        icon: File,
        href: "/box/drafts",
    },
    {
        title: "Archive",
        icon: Archive,
        href: "/box/archive",
    },
    {
        title: "Spam",
        icon: AlertOctagon,
        href: "/box/spam",
    },
    {
        title: "Trash",
        icon: Trash2,
        href: "/box/trash",
    },
]

// Labels for the sidebar with added id property
interface MailLabel {
    id: string;
    name: string;
    color: string;
}

const initialLabels: MailLabel[] = [
    {
        id: "1",
        name: "Personal",
        color: "#3b82f6",  // blue
    },
    {
        id: "2",
        name: "Work",
        color: "#22c55e",  // green
    },
    {
        id: "3",
        name: "Finance",
        color: "#eab308",  // yellow
    },
    {
        id: "4",
        name: "Social",
        color: "#a855f7",  // purple
    },
]

interface AppSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function AppSidebar({ condensed = false, onClose, isMobile = false }: AppSidebarProps) {
    const [labels, setLabels] = useState<MailLabel[]>(initialLabels);
    const { setSidebarOpen } = useContext(SidebarContext);

    // Handle label operations
    const handleAddLabel = (labelData: Omit<MailLabel, 'id'>) => {
        const newLabel: MailLabel = {
            id: (labels.length + 1).toString(),
            name: labelData.name,
            color: labelData.color,
        };
        setLabels([...labels, newLabel]);
    };

    const handleEditLabel = (updatedLabel: MailLabel) => {
        setLabels(labels.map(label => 
            label.id === updatedLabel.id ? updatedLabel : label
        ));
    };

    const handleDeleteLabel = (labelId: string) => {
        setLabels(labels.filter(label => label.id !== labelId));
    };

    // Generate path for a label in the mail app
    const getLabelPath = (label: MailLabel) => `/label/${label.name.toLowerCase()}`;

    return (
        <div className="h-full flex flex-col bg-background">
            {/* Mobile Header with Close Button */}
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose ? onClose : () => setSidebarOpen(false)} className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5" />
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="mail" />
                </div>
            )}

            <div className="px-3 py-2">
                <Button variant="default" size={condensed ? "icon" : "default"} className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}>
                    <MailPlus className="h-4 w-4"/>
                    {!condensed && <span>Compose</span>}
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    {sidebarItems.map((item) => (
                        <SidebarItem
                            key={item.href}
                            icon={<item.icon className="h-4 w-4"/>}
                            label={item.title}
                            to={item.href}
                            condensed={condensed}
                        />
                    ))}
                </SidebarSection>

                {/* Horizontal separator */}
                <Separator />

                {/* Use the shared LabelManager component */}
                <LabelManager
                    labels={labels}
                    onAddLabel={handleAddLabel}
                    onEditLabel={handleEditLabel}
                    onDeleteLabel={handleDeleteLabel}
                    getLabelPath={getLabelPath}
                    className="px-3"
                    condensed={condensed}
                />
            </div>
        </div>
    )
}
