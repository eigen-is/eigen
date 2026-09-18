import { useFileHistory } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ActivityEventList } from './activity-event-list';

type RecentActivityProps = {
    path: DrivePath;
};

export function RecentActivity({ path }: RecentActivityProps) {
    const { data: events = [] } = useFileHistory(path.ownerId, path.mountId, path.id);

    if (events.length === 0) return null;

    return (
        <>
            <h3 className="eigen-section-label mt-6 mb-2">Recent activity</h3>
            {/* -mx-3 cancels the panel gutter so each row's px-3 hover fill bleeds full-width while its content stays gutter-aligned. */}
            <div className="-mx-3">
                <ActivityEventList path={path} events={events} />
            </div>
        </>
    );
}
