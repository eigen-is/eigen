import { ICS_METHOD_LABEL, remainingEventsLine } from '@workspace/lib/calendar';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { useIcsPreview } from '@workspace/lib/drive';
import { useMailIcsPreview } from '@workspace/lib/mail';
import type { ImipMethod } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { MailPartRef } from '@workspace/lib/types/file-subject';
import type { IcsPreview } from '@workspace/lib/types/preview';
import { Calendar } from 'lucide-react';
import { cn } from '../../lib/utils';
import { EventDetailCard } from '../calendar/event-detail-card';
import { EmptyState } from '../layout/app/empty-state';
import { PreviewPane } from './preview-pane';

// The served events, whichever route served them. Drive and mail each have their own component, so
// exactly one query hook runs per render and the overlay picks by the subject it holds.
export function IcsPreviewContent({ path }: { path: DrivePath }) {
    const { data, isLoading } = useIcsPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    return <IcsEvents data={data} isLoading={isLoading} oversize={path.size > ICS_MAX_BYTES} />;
}

export function MailIcsPreviewContent({ part, size }: { part: MailPartRef; size: number }) {
    const oversize = size > ICS_MAX_BYTES;
    const { data, isLoading } = useMailIcsPreview(part.ownerId, part.messageId, part.index, !oversize);
    return <IcsEvents data={data} isLoading={isLoading} oversize={oversize} />;
}

// Both routes serve one shape, so one renderer reads it.
function IcsEvents({
    data,
    isLoading,
    oversize,
}: {
    data: IcsPreview | undefined;
    isLoading: boolean;
    oversize: boolean;
}) {
    return (
        <PreviewPane oversize={oversize} maxBytes={ICS_MAX_BYTES} isLoading={isLoading} unreadable={!data}>
            {data &&
                (data.events.length === 0 ? (
                    <EmptyState message="No events in this file" />
                ) : (
                    <div className="max-w-3xl mx-auto flex flex-col gap-8 p-8">
                        {/* The METHOD belongs to the file, not to one of its events, so it is said once. */}
                        {data.method && <MethodBanner method={data.method} />}
                        {data.events.map((event, index) => (
                            <EventDetailCard
                                key={index}
                                title={event.title}
                                start={new Date(event.start)}
                                end={new Date(event.end)}
                                allDay={event.allDay}
                                timezone={event.timezone}
                                rrule={event.rrule}
                                location={event.location}
                                description={event.description}
                                organizer={event.organizer}
                                attendees={event.attendees}
                                className="border-b pb-8 last:border-b-0 last:pb-0"
                            />
                        ))}
                        {data.dropped > 0 && (
                            <p className="text-sm text-muted-foreground">{remainingEventsLine(data.dropped)}</p>
                        )}
                    </div>
                ))}
        </PreviewPane>
    );
}

function MethodBanner({ method }: { method: ImipMethod }) {
    const isCancelled = method === 'CANCEL';

    return (
        <div
            className={cn(
                'flex items-center gap-3 rounded-lg border p-4',
                isCancelled ? 'border-destructive/30 bg-destructive/5' : 'border-primary/30 bg-primary/5',
            )}
        >
            <Calendar className={cn('h-5 w-5 shrink-0', isCancelled ? 'text-destructive' : 'text-primary')} />
            <p className={cn('text-sm font-medium', isCancelled && 'text-destructive')}>{ICS_METHOD_LABEL[method]}</p>
        </div>
    );
}
