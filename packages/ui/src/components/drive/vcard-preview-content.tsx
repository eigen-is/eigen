import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { droppedContactsLine, remainingContactsLine } from '@workspace/lib/contacts';
import { useVCardPreview } from '@workspace/lib/drive';
import { useMailVCardPreview } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { MailPartRef } from '@workspace/lib/types/file-subject';
import type { VCardPreview } from '@workspace/lib/types/preview';
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/app/empty-state';
import { ContactDetailCard } from '../user/contact-detail-card';
import { PREVIEW_BODY_CLASS, PreviewPane } from './preview-pane';

// The served cards, whichever route served them. Drive and mail each have their own component, so exactly
// one query hook runs per render and the overlay picks by the subject it holds.
export function VCardPreviewContent({ path }: { path: DrivePath }) {
    const { data, isPending, isError } = useVCardPreview(
        path.ownerId,
        path.mountId,
        path.id,
        path.updatedAt,
        path.size,
    );
    return <VCardCards data={data} isPending={isPending} isError={isError} oversize={path.size > VCARD_MAX_BYTES} />;
}

export function MailVCardPreviewContent({ part, size }: { part: MailPartRef; size: number }) {
    const oversize = size > VCARD_MAX_BYTES;
    const { data, isPending, isError } = useMailVCardPreview(part.ownerId, part.messageId, part.index, !oversize);
    return <VCardCards data={data} isPending={isPending} isError={isError} oversize={oversize} />;
}

// Both routes serve one shape, so one renderer reads it.
function VCardCards({
    data,
    isPending,
    isError,
    oversize,
}: {
    data: VCardPreview | undefined;
    isPending: boolean;
    isError: boolean;
    oversize: boolean;
}) {
    // The cards the file holds that this preview shows no card for — the unreadable ones get their own line.
    const remaining = data ? data.total - data.dropped - data.cards.length : 0;
    // Both counts, for the empty state: a file whose every readable card failed still says how many it
    // never opened.
    const counts = [
        ...(remaining > 0 ? [remainingContactsLine(remaining)] : []),
        ...(data && data.dropped > 0 ? [droppedContactsLine(data.dropped)] : []),
    ];

    return (
        <PreviewPane oversize={oversize} maxBytes={VCARD_MAX_BYTES} isPending={isPending} unreadable={isError}>
            {data &&
                (data.cards.length === 0 ? (
                    <EmptyState message="No contacts in this file" hint={counts.join(' · ') || undefined} />
                ) : (
                    <div className={cn('max-w-3xl mx-auto flex flex-col gap-8', PREVIEW_BODY_CLASS)}>
                        {data.cards.map(({ contact, categories }, index) => (
                            <ContactDetailCard
                                key={index}
                                contact={contact}
                                labels={categories.map((name) => ({ name }))}
                                className="border-b pb-8 last:border-b-0 last:pb-0"
                            />
                        ))}
                        {remaining > 0 && (
                            <p className="text-sm text-muted-foreground">{remainingContactsLine(remaining)}</p>
                        )}
                        {data.dropped > 0 && (
                            <p className="text-sm text-muted-foreground">{droppedContactsLine(data.dropped)}</p>
                        )}
                    </div>
                ))}
        </PreviewPane>
    );
}
