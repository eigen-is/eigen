import {ReactNode, useEffect} from 'react';
import {useLayout} from './layout-context';

type ColumnProps = {
    id: string;
    width: string;
    toolbar?: ReactNode;
    secondaryToolbar?: ReactNode;
    backTo?: string;
    children: ReactNode;
}

function Column({id, width, toolbar, secondaryToolbar, children}: ColumnProps) {
    const {
        isMobile,
        activeColumn,
        registerToolbar,
        unregisterToolbar,
        registerSecondaryToolbar,
        unregisterSecondaryToolbar,
    } = useLayout();

    useEffect(() => {
        if (toolbar) {
            registerToolbar(id, width, toolbar);
        }
        return () => unregisterToolbar(id);
    }, [id, width, toolbar]);

    useEffect(() => {
        if (secondaryToolbar) {
            registerSecondaryToolbar(id, secondaryToolbar);
        }
        return () => unregisterSecondaryToolbar(id);
    }, [id, secondaryToolbar]);

    if (isMobile && activeColumn !== id) return null;

    const style = isMobile
        ? {width: '100%', flex: '1 1 auto'}
        : width === 'flex'
            ? {flex: '1 1 auto', minWidth: 0}
            : {width, flexShrink: 0};

    return (
        <div className="h-full overflow-hidden" style={style}>
            {children}
        </div>
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
