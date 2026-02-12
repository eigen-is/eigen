import {ArrowLeft} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {useLayout} from './layout-context';

export function SecondaryToolbar() {
    const {
        isMobile,
        activeColumn,
        toolbars,
        secondaryToolbars,
        goBack,
        columnHistory,
    } = useLayout();

    if (isMobile) {
        const activeToolbar = toolbars.find(t => t.columnId === activeColumn);
        const activeSecondary = secondaryToolbars.find(t => t.columnId === activeColumn);
        const content = activeSecondary?.content ?? activeToolbar?.content;
        const showBack = columnHistory.length > 1;

        if (!content && !showBack) return null;

        return (
            <div className="bg-white h-12 flex items-center px-4 border-b shrink-0">
                {showBack && (
                    <>
                        <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={goBack}>
                            <ArrowLeft className="h-4 w-4"/>
                        </Button>
                        <div className="h-6 w-[1px] bg-border mx-1"/>
                    </>
                )}
                <div className="flex items-center gap-1 flex-1 min-w-0">
                    {content}
                </div>
            </div>
        );
    }

    const hasSecondary = secondaryToolbars.length > 0;
    if (!hasSecondary) return null;

    const secondaryContent = secondaryToolbars[0]?.content;
    if (!secondaryContent) return null;

    return (
        <div className="bg-white h-12 flex items-center px-4 border-b shrink-0">
            {secondaryContent}
        </div>
    );
}
