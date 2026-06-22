import { X } from 'lucide-react';
import { Button } from '../../button';
import { AppLogo } from '../app/app-logo';

type SidebarHeaderProps = {
    appName: string;
    onClose?: () => void;
};

export function SidebarHeader({ appName, onClose }: SidebarHeaderProps) {
    return (
        <div className="flex items-center h-12 bg-background border-b px-4">
            <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="mr-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
                <X className="h-5 w-5" />
                <span className="sr-only">Close menu</span>
            </Button>
            <AppLogo appName={appName} />
        </div>
    );
}
