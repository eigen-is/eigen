import {useRemoteCursorOverlayPositions,} from '@slate-yjs/react';
import {ReactNode, useRef, useState} from 'react';
import styles from './cursors.module.css';
import {UserAvatar} from '@workspace/ui';
import {cn} from '@workspace/ui/lib/utils';

// Define the structure of cursor data
interface CursorData {
    name: string;
    email?: string;
    color: string;
}

interface CursorsProps {
    children: ReactNode;
}

export function Cursors({children}: CursorsProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [cursors] = useRemoteCursorOverlayPositions({containerRef});

    return (
        <div className={styles.cursors} ref={containerRef}>
            {children}
            {cursors.map((cursor) => (
                <Selection key={cursor.clientId} {...cursor} />
            ))}
        </div>
    );
}

interface SelectionProps {
    data?: Record<string, unknown>;
    selectionRects: Array<{ top: number; left: number; width: number; height: number }>;
    caretPosition?: { top: number; left: number; height: number };
    clientId: string | number;
}

function Selection({data, selectionRects, caretPosition}: SelectionProps) {
    if (!data) {
        return null;
    }

    const cursorData = data as unknown as CursorData;

    const selectionStyle = {
        backgroundColor: cursorData.color,
    };

    return (
        <>
            {selectionRects.map((position, i) => (
                <div
                    style={{...selectionStyle, ...position}}
                    className={styles.selection}
                    key={i}
                />
            ))}
            {caretPosition && <Caret caretPosition={caretPosition} data={cursorData}/>}
        </>
    );
}

interface CaretProps {
    caretPosition: { top: number; left: number; height: number };
    data: CursorData;
}

function Caret({caretPosition, data}: CaretProps) {
    const [expanded, setExpanded] = useState(false);

    const caretStyle = {
        ...caretPosition,
        background: data.color,
    };

    const toggleExpanded = () => {
        setExpanded(!expanded);
    };

    return (
        <>
            <div className={styles.caretMarker} style={caretStyle}/>
            <div
                className={cn(
                    styles.caret,
                    'flex items-center rounded-full p-0.5 opacity-75 hover:opacity-100 cursor-pointer transition-all duration-200',
                    expanded ? 'pl-0.5 pr-3' : 'h-7'
                )}
                style={{
                    left: caretPosition.left - 14,
                    top: caretPosition.top - 28,
                    background: data.color,
                }}
                onClick={toggleExpanded}
            >
                <UserAvatar
                    name={data.name || 'Anonymous'}
                    email={data.email}
                    size="sm"
                />
                {expanded && (
                    <span className="ml-2 text-white text-xs font-medium whitespace-nowrap select-none">
            {data.name || 'Anonymous'}
          </span>
                )}
            </div>
        </>
    );
}