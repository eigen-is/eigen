import {
  type CursorOverlayData,
  useRemoteCursorOverlayPositions,
} from '@slate-yjs/react';
import { useRef, ReactNode } from 'react';
import styles from './cursors.module.css';

interface CursorsProps {
  children: ReactNode;
}

export function Cursors({ children }: CursorsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cursors] = useRemoteCursorOverlayPositions({ containerRef });

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
  data?: CursorOverlayData;
  selectionRects: Array<{ top: number; left: number; width: number; height: number }>;
  caretPosition?: { top: number; left: number; height: number };
  clientId: string;
}

function Selection({ data, selectionRects, caretPosition }: SelectionProps) {
  if (!data) {
    return null;
  }

  const selectionStyle = {
    backgroundColor: data.color,
  };

  return (
    <>
      {selectionRects.map((position, i) => (
        <div
          style={{ ...selectionStyle, ...position }}
          className={styles.selection}
          key={i}
        />
      ))}
      {caretPosition && <Caret caretPosition={caretPosition} data={data} />}
    </>
  );
}

interface CaretProps {
  caretPosition: { top: number; left: number; height: number };
  data: CursorOverlayData;
}

function Caret({ caretPosition, data }: CaretProps) {
  const caretStyle = {
    ...caretPosition,
    background: data?.color,
  };

  return (
    <>
      <div className={styles.caretMarker} style={caretStyle} />
      <div
        className={styles.caret}
        style={{
          ...caretStyle,
          left: caretPosition.left,
          top: caretPosition.top - 16,
          background: data?.color,
        }}
      >
        {data?.name || 'Anonymous'}
      </div>
    </>
  );
}