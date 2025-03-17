import {AlertCircle, Archive, File, Inbox, MailPlus, Send, Star} from "lucide-react";

import {Link} from '@tanstack/react-router';
import {Button} from "@workspace/ui/components/button";
import { useState } from "react";
import { Label, LabelManager } from "../../../../packages/ui/src/components/layout/labels";


// Menu items for the sidebar
const sidebarItems = [
    {
        title: "Inbox",
        icon: Inbox,
        href: "/inbox",
    },
    {
        title: "Starred",
        icon: Star,
        href: "/starred",
    },
    {
        title: "Sent",
        icon: Send,
        href: "/sent",
    },
    {
        title: "Drafts",
        icon: File,
        href: "/drafts",
    },
    {
        title: "Archive",
        icon: Archive,
        href: "/archive",
    },
    {
        title: "Spam",
        icon: AlertCircle,
        href: "/spam",
    },
    {
        title: "Trash",
        icon: AlertCircle,
        href: "/trash",
    },
]

// Labels for the sidebar with added id property
const initialLabels: Label[] = [
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

export function AppSidebar() {
    const [labels, setLabels] = useState<Label[]>(initialLabels);

    // Handle label operations
    const handleAddLabel = (labelData: Omit<Label, 'id'>) => {
        const newLabel: Label = {
            id: (labels.length + 1).toString(),
            name: labelData.name,
            color: labelData.color,
        };
        setLabels([...labels, newLabel]);
    };

    const handleEditLabel = (updatedLabel: Label) => {
        setLabels(labels.map(label => 
            label.id === updatedLabel.id ? updatedLabel : label
        ));
    };

    const handleDeleteLabel = (labelId: string) => {
        setLabels(labels.filter(label => label.id !== labelId));
    };

    // Generate path for a label in the mail app
    const getLabelPath = (label: Label) => `/label/${label.name.toLowerCase()}`;

    return (
        <div className="w-64 border-r h-full flex flex-col bg-background">
            <div className="p-4">
                <Button className="w-full justify-start gap-2" size="lg">
                    <MailPlus className="h-4 w-4"/>
                    Compose
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <div className="px-3 py-2">
                    <nav className="space-y-1">
                        {sidebarItems.map((item) => {
                            return (
                                <Link
                                    key={item.href}
                                    to={item.href}
                                    className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'

                                    activeProps={{
                                        className: 'bg-primary/10 text-primary',
                                    }}
                                    inactiveProps={{
                                        className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                    }}
                                    activeOptions={{exact: false}}
                                >
                                    <item.icon className="h-4 w-4"/>
                                    <span>{item.title}</span>
                                </Link>
                            )
                        })}
                    </nav>
                </div>

                {/* Horizontal separator */}
                <div className="mx-3 my-2 border-t border-border"></div>

                {/* Use the shared LabelManager component */}
                <LabelManager
                    labels={labels}
                    onAddLabel={handleAddLabel}
                    onEditLabel={handleEditLabel}
                    onDeleteLabel={handleDeleteLabel}
                    getLabelPath={getLabelPath}
                    className="px-3"
                />
            </div>
        </div>
    )
}
