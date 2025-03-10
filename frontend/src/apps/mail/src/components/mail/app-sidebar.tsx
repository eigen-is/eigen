import {AlertCircle, Archive, File, Inbox, Plus, Send, Settings, Star, Tag, Trash2} from "lucide-react";
import {cn} from "@/lib/utils";
import {Button} from "@/components/ui/button";
import {Link} from '@tanstack/react-router'

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
        title: "Important",
        icon: AlertCircle,
        href: "/important",
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
        icon: Trash2,
        href: "/trash",
    },
]

// Labels for the sidebar
const labels = [
    {
        name: "Personal",
        color: "bg-blue-500",
    },
    {
        name: "Work",
        color: "bg-green-500",
    },
    {
        name: "Finance",
        color: "bg-yellow-500",
    },
    {
        name: "Social",
        color: "bg-purple-500",
    },
]

export function AppSidebar() {
    return (
        <div className="w-64 border-r h-full flex flex-col bg-background">
            <div className="p-4">
                <Button className="w-full justify-start gap-2" size="lg">
                    <Plus className="h-4 w-4"/>
                    Compose
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <div className="px-3 py-2">
                    <nav className="space-y-1">
                        {sidebarItems.map((item) => {
                            return (
                                <Link
                                    to={item.href}
                                    className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'

                                    activeProps={{
                                        className: 'bg-primary/10 text-primary',
                                    }}
                                    inactiveProps={{
                                        className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                    }}
                                    activeOptions={{exact: true}}
                                >
                                    <item.icon className="h-4 w-4"/>
                                    <span>{item.title}</span>
                                </Link>
                            )
                        })}
                    </nav>
                </div>

                <div className="px-6 py-2">
                    <h3 className="text-xs font-semibold text-muted-foreground mb-2 px-3">Labels</h3>
                    <div className="space-y-1">
                        {labels.map((label) => (
                            <Link
                                key={label.name}
                                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                                to={`/label/${label.name.toLowerCase()}`}
                            >
                                <span className={cn("h-2 w-2 rounded-full", label.color)}/>
                                <span>{label.name}</span>
                            </Link>
                        ))}
                        <Link
                            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                            to='/labels'
                        >
                            <Tag className="h-4 w-4"/>
                            <span>Manage Labels</span>
                        </Link>
                    </div>
                </div>
            </div>

            <div className="border-t p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div
                            className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            U
                        </div>
                        <div>
                            <p className="text-xs font-medium">User Name</p>
                            <p className="text-xs text-muted-foreground">user@example.com</p>
                        </div>
                    </div>
                    <Button variant="ghost" size="icon">
                        <Settings className="h-4 w-4"/>
                    </Button>
                </div>
            </div>
        </div>
    )
}
