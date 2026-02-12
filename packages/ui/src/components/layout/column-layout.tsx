import {createContext, ReactNode, useContext} from 'react';
import {ArrowLeft} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {useLayout} from './layout-context';

type ColumnContextType = {
    mobileColumn: string | null;
}

const ColumnContext = createContext<ColumnContextType>({mobileColumn: null});

type ColumnProps = {
    id: string;
    width: string;
    toolbar?: ReactNode;
    onBack?: () => void;
    children: ReactNode;
}

function Column({id, width, toolbar, onBack, children}: ColumnProps) {
    const {isMobile} = useLayout();
    const {mobileColumn} = useContext(ColumnContext);

    if (isMobile && mobileColumn !== null && mobileColumn !== id) return null;

    const style = isMobile
        ? {width: '100%', flex: '1 1 auto'}
        : width === 'flex'
            ? {flex: '1 1 auto', minWidth: 0}
            : {width, flexShrink: 0};

    return (
        <div className="h-full flex flex-col overflow-hidden" style={style}>
            {toolbar && (
                <div className="h-12 flex items-center px-4 border-b shrink-0">
                    {isMobile && onBack && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBack}>
                                <ArrowLeft className="h-4 w-4"/>
                            </Button>
                            <div className="h-6 w-[1px] bg-border mx-1"/>
                        </>
                    )}
                    {toolbar}
                </div>
            )}
            <div className="flex-1 overflow-hidden">
                {children}
            </div>
        </div>
    );
}

type ColumnLayoutProps = {
    mobileColumn?: string;
    children: ReactNode;
}

function ColumnLayout({mobileColumn, children}: ColumnLayoutProps) {
    const {isMobile} = useLayout();

    return (
        <ColumnContext.Provider value={{mobileColumn: isMobile ? (mobileColumn ?? null) : null}}>
            <div className="flex flex-1 h-full overflow-hidden">
                {children}
            </div>
        </ColumnContext.Provider>
    );
}

export {ColumnLayout, Column};
export type {ColumnProps};
