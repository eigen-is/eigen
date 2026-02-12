import {ReactNode, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useLayout} from './layout-context';

type ColumnProps = {
    id: string;
    width: string;
    toolbar?: ReactNode;
    secondaryToolbar?: ReactNode;
    backTo?: string;
    onBack?: () => void;
    children: ReactNode;
}

function ToolbarPortal({columnId, children}: {columnId: string; children: ReactNode}) {
    const {isMobile, activeColumn, getToolbarPortalNode, getSecondaryToolbarPortalNode} = useLayout();
    const [node, setNode] = useState<HTMLElement | null>(null);

    useEffect(() => {
        const findNode = () => {
            if (isMobile) {
                if (activeColumn === columnId) {
                    return getSecondaryToolbarPortalNode();
                }
                return null;
            }
            return getToolbarPortalNode(columnId);
        };

        const target = findNode();
        setNode(target);

        if (!target) {
            const timer = requestAnimationFrame(() => setNode(findNode()));
            return () => cancelAnimationFrame(timer);
        }
    }, [columnId, isMobile, activeColumn, getToolbarPortalNode, getSecondaryToolbarPortalNode]);

    if (!node || !children) return null;
    return createPortal(children, node);
}

function Column({id, width, toolbar, onBack, children}: ColumnProps) {
    const {
        isMobile,
        activeColumn,
        registerToolbar,
        unregisterToolbar,
        registerOnBack,
        unregisterOnBack,
    } = useLayout();

    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;

    useEffect(() => {
        if (toolbar !== undefined) {
            registerToolbar(id, width);
        }
        if (onBack) {
            registerOnBack(id, () => onBackRef.current?.());
        }
        return () => {
            unregisterToolbar(id);
            unregisterOnBack(id);
        };
    }, [id, width]);

    if (isMobile && activeColumn !== id) return null;

    const style = isMobile
        ? {width: '100%', flex: '1 1 auto'}
        : width === 'flex'
            ? {flex: '1 1 auto', minWidth: 0}
            : {width, flexShrink: 0};

    return (
        <>
            <ToolbarPortal columnId={id}>{toolbar}</ToolbarPortal>
            <div className="h-full overflow-hidden" style={style}>
                {children}
            </div>
        </>
    );
}

type ColumnLayoutProps = {
    children: ReactNode;
}

function ColumnLayout({children}: ColumnLayoutProps) {
    return (
        <div className="flex flex-1 h-full overflow-hidden">
            {children}
        </div>
    );
}

export {ColumnLayout, Column};
export type {ColumnProps};
