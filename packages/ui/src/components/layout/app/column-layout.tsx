// The page shell every app screen is built from: ColumnLayout lays its Columns side by side, and on a phone shows
// only the one named mobileColumn. Each Column has a toolbar bar whose bottom border fades in once its content
// scrolls, and on a phone a back arrow that runs onBack or opens the sidebar.

import { cn } from '@workspace/ui/lib/utils';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { TooltipButton } from '../toolbar/tooltip-button';
import { useLayout } from './layout-context';

type ColumnContextType = {
    mobileColumn: string | null;
};

const ColumnContext = createContext<ColumnContextType>({ mobileColumn: null });

type ColumnProps = {
    id: string;
    width: string;
    toolbar?: ReactNode;
    // 'always' keeps the toolbar border for a column with a canvas below, such as a doc's.
    toolbarBorder?: 'auto' | 'always';
    // 'sidebar' opens the phone's sidebar, and shows no arrow where the app has no collapsible sidebar.
    onBack?: (() => void) | 'sidebar';
    children: ReactNode;
    className?: string;
};

function Column({ id, width, toolbar, toolbarBorder = 'auto', onBack, children, className }: ColumnProps) {
    const { isMobile, sidebarMode, setSidebarOpen } = useLayout();
    const { mobileColumn } = useContext(ColumnContext);
    const [scrolled, setScrolled] = useState(false);
    const cleanupRef = useRef<(() => void) | null>(null);

    // A scroll inside `children` doesn't bubble, so a capture listener catches whichever descendant scrolls. A
    // callback ref rebinds it as a phone column shows and hides.
    const contentRef = useCallback((el: HTMLDivElement | null) => {
        cleanupRef.current?.();
        cleanupRef.current = null;
        if (!el) return;
        const onScroll = (e: Event) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.scrollHeight > target.clientHeight) setScrolled(target.scrollTop > 0);
        };
        el.addEventListener('scroll', onScroll, true);
        cleanupRef.current = () => el.removeEventListener('scroll', onScroll, true);
    }, []);

    if (isMobile && mobileColumn !== null && mobileColumn !== id) return null;

    const backHandler =
        onBack === 'sidebar' ? (sidebarMode === 'collapsible' ? () => setSidebarOpen(true) : null) : (onBack ?? null);

    const style = isMobile
        ? { width: '100%', flex: '1 1 auto' }
        : width === 'flex'
          ? { flex: '1 1 auto', minWidth: 0 }
          : { width, flexShrink: 0 };

    const backButton =
        isMobile && backHandler ? (
            <TooltipButton icon={ArrowLeft} tooltipText="Back" className="mr-1" onClick={backHandler} />
        ) : null;

    return (
        <div className={cn('h-full flex flex-col overflow-hidden', className)} style={style}>
            {(toolbar || backButton) && (
                <div
                    className={cn(
                        'h-12 flex items-center app-gutter-x shrink-0 border-r border-b transition-colors duration-200',
                        toolbarBorder === 'always' || scrolled ? 'border-b-border' : 'border-b-transparent',
                    )}
                >
                    {backButton}
                    {toolbar}
                </div>
            )}
            <div ref={contentRef} className="flex-1 overflow-hidden">
                {children}
            </div>
        </div>
    );
}

type ColumnLayoutProps = {
    mobileColumn?: string;
    children: ReactNode;
};

function ColumnLayout({ mobileColumn, children }: ColumnLayoutProps) {
    const { isMobile } = useLayout();

    return (
        <ColumnContext.Provider value={{ mobileColumn: isMobile ? (mobileColumn ?? null) : null }}>
            <div className="flex flex-1 h-full overflow-hidden">{children}</div>
        </ColumnContext.Provider>
    );
}

export type { ColumnProps };
export { Column, ColumnLayout };
