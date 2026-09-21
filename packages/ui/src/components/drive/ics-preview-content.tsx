import { ICS_METHOD_LABEL } from '@workspace/lib/calendar';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { useIcsPreview } from '@workspace/lib/drive';
import { useMailIcsPreview } from '@workspace/lib/mail';
import { previewCountLines } from '@workspace/lib/transfer';
import type { ImipMethod } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { MailPartRef } from '@workspace/lib/types/file-subject';
import type { IcsPreview } from '@workspace/lib/types/preview';
import { Calendar } from 'lucide-react';
import { cn } from '../../lib/utils';
import { EventDetailCard } from '../calendar/event-detail-card';
import { EmptyState } from '../layout/app/empty-state';
import { PREVIEW_BODY_CLASS, PreviewCounts, PreviewPane, type PreviewStatus } from './preview-pane';

export function IcsPreviewContent({ path }: { path: DrivePath }) {
    const { data, status } = useIcsPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    return <IcsEvents data={data} status={status} oversize={path.size > ICS_MAX_BYTES} />;
}

export function MailIcsPreviewContent({ part, size }: { part: MailPartRef; size: number }) {
    const oversize = size > ICS_MAX_BYTES;
    const { data, status } = useMailIcsPreview(part.ownerId, part.messageId, part.index, !oversize);
    return <IcsEvents data={data} status={status} oversize={oversize} />;
}

function IcsEvents({
    data,
    status,
    oversize,
}: {
    data: IcsPreview | undefined;
    status: PreviewStatus;
    oversize: boolean;
}) {
    // The masters the file holds that this preview draws no card for — the unreadable ones get their own line.
    const remaining = data ? data.total - data.dropped - data.events.length : 0;

    return (
        <PreviewPane oversize={oversize} maxBytes={ICS_MAX_BYTES} status={status}>
            {data &&
                (data.events.length === 0 ? (
                    <EmptyState
                        message="No events in this file"
                        hint={previewCountLines(remaining, data.dropped, 'event').join(' · ') || undefined}
                    />
                ) : (
                    <div className={cn('max-w-3xl mx-auto flex flex-col gap-8', PREVIEW_BODY_CLASS)}>
                        {/* The METHOD belongs to the file, not to one of its events, so it is said once. */}
                        {data.method && <MethodBanner method={data.method} />}
                        {data.events.map((event, index) => (
                            <EventDetailCard
                                key={index}
                                title={event.title}
                                status={event.status}
                                start={new Date(event.start)}
                                end={new Date(event.end)}
                                allDay={event.allDay}
                                timezone={event.timezone}
                                rrule={event.rrule}
                                location={event.location}
                                description={event.description}
                                organizer={event.organizer}
                                attendees={event.attendees}
                                remainingAttendees={event.remainingAttendees}
                                className="border-b pb-8 last:border-b-0 last:pb-0"
                            />
                        ))}
                        <PreviewCounts remaining={remaining} dropped={data.dropped} noun="event" />
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
