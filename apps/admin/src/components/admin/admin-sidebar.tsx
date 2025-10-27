import {Settings, Users, LayoutDashboard, X, Server} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import {Button} from "@workspace/ui/components/button";
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {StorageUsage} from "@workspace/ui";

interface AdminSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function AdminSidebar({condensed = false, onClose, isMobile = false}: AdminSidebarProps) {
    return (
        <div className="h-full flex flex-col bg-background">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="admin"/>
                </div>
            )}

            <div className="px-3 py-2">
                <Button variant="default" size={condensed ? "icon" : "default"} asChild
                        className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}>
                    <Link to="/">
                        <LayoutDashboard className="h-4 w-4"/>
                        {!condensed && <span>Dashboard</span>}
                    </Link>
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<Users className="h-4 w-4"/>}
                        label="Users"
                        to="/"
                        condensed={condensed}
                    />

                    <SidebarItem
                        icon={<Server className="h-4 w-4"/>}
                        label="System"
                        to="/"
                        condensed={condensed}
                    />

                    <SidebarItem
                        icon={<Settings className="h-4 w-4"/>}
                        label="Settings"
                        to="/"
                        condensed={condensed}
                    />
                </SidebarSection>

                <Separator/>
            </div>

            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />
        </div>
    );
}
