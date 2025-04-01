import {Users, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem} from "@workspace/ui";


interface SpaceSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function SpaceSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,

                             }: SpaceSidebarProps) {

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="drive"/>
                </div>
            )}


            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<Users className="h-4 w-4" />}
                    label="Home"
                    to='/' params={{}}  />
                <SidebarItem
                    icon={<Users className="h-4 w-4" />}
                    label="Change password"
                    to='/password' params={{}}  />
            </SidebarSection>
        </div>
    );
}
