import { useFileHistory } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useRef } from 'react';
import { ActivityEventList } from './activity-event-list';

type RecentActivityProps = {
    path: DrivePath;
    highlight?: boolean;
};

export function RecentActivity({ path, highlight }: RecentActivityProps) {
    const { data: events = [] } = useFileHistory(path.ownerId, path.mountId, path.id);
    const sectionRef = useRef<HTMLDivElement>(null);

    // events.length is a dep so the scroll fires once the async history resolves
    // (the section is unmounted while the list is empty, so highlight alone misses).
    useEffect(() => {
        if (highlight && sectionRef.current) {
            sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [highlight, events.length]);

    if (events.length === 0) return null;

    return (
        <div ref={sectionRef}>
            <h3 className="eigen-section-label mt-6 mb-2">Recent activity</h3>
            {/* -mx-3 cancels the panel gutter so each row's px-3 hover fill bleeds full-width while its content stays gutter-aligned. */}
            <div className="-mx-3">
                <ActivityEventList path={path} events={events} />
            </div>
        </div>
    );
}
