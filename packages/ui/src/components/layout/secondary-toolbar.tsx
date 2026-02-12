import {ArrowLeft} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {useLayout} from './layout-context';

export function SecondaryToolbar() {
    const {
        isMobile,
        toolbarSlots,
        getActiveOnBack,
    } = useLayout();

    if (isMobile) {
        const onBack = getActiveOnBack();
        const hasToolbars = toolbarSlots.length > 0;

        if (!hasToolbars && !onBack) return null;

        return (
            <div className="bg-white h-12 flex items-center px-4 border-b shrink-0">
                {onBack && (
                    <>
                        <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBack}>
                            <ArrowLeft className="h-4 w-4"/>
                        </Button>
                        <div className="h-6 w-[1px] bg-border mx-1"/>
                    </>
                )}
                <div data-secondary-toolbar-slot className="flex items-center gap-1 flex-1 min-w-0"/>
            </div>
        );
    }

    return null;
}
