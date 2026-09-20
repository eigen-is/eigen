import { getDriveItemThumbnail } from '@workspace/lib/api';
import { formatEventWhen, remainingEventsLine, viewerTimeZone } from '@workspace/lib/calendar';
import { CANVAS_PREVIEW_WIDTH, getTextPreviewMode, type TextPreviewMode } from '@workspace/lib/constants';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { IMPORT_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { droppedLine, remainingLine } from '@workspace/lib/contacts';
import { formatDateTime } from '@workspace/lib/date';
import { A4_WIDTH_PX } from '@workspace/lib/docs/eigendoc';
import { useEmlPreview, useIcsPreview, useTextPreview, useVCardPreview } from '@workspace/lib/drive';
import { NO_SUBJECT } from '@workspace/lib/mail';
import type { Contact } from '@workspace/lib/types/contact';
import { type DrivePath, isEmlFile, isIcsFile, isVCardFile } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useElementSize } from '../../hooks/use-element-size';
import { cn, IMAGE_CHECKERBOARD_STYLE } from '../../lib/utils';
import { UserAvatar } from '../user/user-avatar';
import { getFilePresentation } from './file-presentation';

type DrivePreviewProps = {
    path: DrivePath;
    onActivate?: () => void;
    className?: string;
};

// Fixed 16:9 aspect keeps the panel height stable as the user clicks through files.
export function DrivePreview({ path, onActivate, className }: DrivePreviewProps) {
    const presentation = getFilePresentation(path.mimeType, path.type, path.name);
    const hasTextPreview = getTextPreviewMode(path.mimeType, path.name) !== null;
    // Same guard as the quick look: a file an import would refuse never gets a preview either.
    const hasVCardPreview = isVCardFile(path.mimeType, path.name) && path.size <= IMPORT_MAX_BYTES;
    const hasEmlPreview = isEmlFile(path.mimeType, path.name) && path.size <= EML_MAX_BYTES;
    const hasIcsPreview = isIcsFile(path.mimeType, path.name) && path.size <= ICS_MAX_BYTES;
    const { showThumbnail, thumbnailUrl } = getDriveItemThumbnail(path);

    const interactive = !!onActivate;
    const Wrapper = interactive ? 'button' : 'div';

    return (
        <Wrapper
            type={interactive ? 'button' : undefined}
            onClick={onActivate}
            className={cn(
                'relative w-full aspect-[16/9] overflow-hidden rounded-lg block text-left',
                interactive && 'cursor-pointer hover:ring-2 hover:ring-ring transition-shadow',
                className,
            )}
            // An image sits on the transparency checkerboard, under its blurred backdrop.
            style={
                showThumbnail && thumbnailUrl
                    ? IMAGE_CHECKERBOARD_STYLE
                    : { backgroundColor: presentation.softColorVar }
            }
        >
            <span
                className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full bg-background text-[10px] font-medium uppercase tracking-wider"
                style={{ color: presentation.colorVar }}
            >
                {presentation.label}
            </span>

            {showThumbnail && thumbnailUrl ? (
                <>
                    <img
                        src={thumbnailUrl}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-70"
                    />
                    <img src={thumbnailUrl} alt={path.name} className="absolute inset-0 w-full h-full object-contain" />
                </>
            ) : hasVCardPreview ? (
                <VCardHero path={path} icon={presentation.icon} color={presentation.colorVar} />
            ) : hasEmlPreview ? (
                <EmlHero path={path} icon={presentation.icon} color={presentation.colorVar} />
            ) : hasIcsPreview ? (
                <IcsHero path={path} icon={presentation.icon} color={presentation.colorVar} />
            ) : hasTextPreview ? (
                <HtmlPreview path={path} tintColor={presentation.colorVar} />
            ) : (
                <IconFallback icon={presentation.icon} color={presentation.colorVar} />
            )}
        </Wrapper>
    );
}

function IconFallback({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center">
            <Icon className="size-16" style={{ color }} strokeWidth={1.5} />
        </div>
    );
}

// What fits the 16:9 box at reading size, badge and counted lines included.
const HERO_CARD_LIMIT = 3;

// The quick look reads a column of full cards; the hero shows the first three as compact rows, off the
// same query — which is why a .vcf never asks for its text preview here.
function VCardHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useVCardPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    const contacts = data?.cards.slice(0, HERO_CARD_LIMIT) ?? [];

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data || contacts.length === 0) return <IconFallback icon={icon} color={color} />;

    // The cards the file holds that this hero shows no row for — the unreadable ones get their own line.
    const remaining = data.total - data.dropped - contacts.length;

    return (
        <div className="absolute inset-0 flex flex-col justify-center gap-2 overflow-hidden px-4 pt-8 pb-3">
            {contacts.map(({ contact }, index) => (
                <VCardRow key={index} contact={contact} />
            ))}
            {remaining > 0 && <p className="truncate text-xs text-muted-foreground">{remainingLine(remaining)}</p>}
            {data.dropped > 0 && <p className="truncate text-xs text-muted-foreground">{droppedLine(data.dropped)}</p>}
        </div>
    );
}

// The quick look reads the whole message; the hero shows what a mail list row shows, off the same query.
function EmlHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useEmlPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data) return <IconFallback icon={icon} color={color} />;

    const sender = data.from?.value[0];
    const senderName = sender?.name || sender?.address || 'Unknown';

    return (
        <div className="absolute inset-0 flex flex-col justify-center gap-2 overflow-hidden px-4 pt-8 pb-3">
            <div className="flex min-w-0 items-center gap-3">
                <UserAvatar name={senderName} email={sender?.address ?? ''} />
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{senderName}</p>
                    {data.date && <p className="truncate text-xs text-muted-foreground">{formatDateTime(data.date)}</p>}
                </div>
            </div>
            <p className="truncate text-sm text-foreground">{data.subject || NO_SUBJECT}</p>
            {data.text && <p className="line-clamp-2 text-xs text-muted-foreground">{data.text}</p>}
        </div>
    );
}

// The quick look reads every event as a card; the hero shows the first three as one line each — the
// title and when it happens — off the same query.
function IcsHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useIcsPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    const events = data?.events.slice(0, HERO_CARD_LIMIT) ?? [];

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data || events.length === 0) return <IconFallback icon={icon} color={color} />;

    const remaining = data.total - events.length;

    return (
        <div className="absolute inset-0 flex flex-col justify-center gap-2 overflow-hidden px-4 pt-8 pb-3">
            {events.map((event, index) => (
                <div key={index} className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{event.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                        {formatEventWhen(
                            new Date(event.start),
                            new Date(event.end),
                            event.allDay,
                            event.timezone,
                            viewerTimeZone(),
                        )}
                    </p>
                </div>
            ))}
            {remaining > 0 && (
                <p className="truncate text-xs text-muted-foreground">{remainingEventsLine(remaining)}</p>
            )}
        </div>
    );
}

// The card's own name and email, not the address book's: this previews a file.
function VCardRow({ contact }: { contact: Contact }) {
    const email = contact.email[0];
    const title = `${contact.firstName} ${contact.lastName}`.trim() || email;

    return (
        <div className="flex min-w-0 items-center gap-3">
            <UserAvatar name={title} email={email} imageUrl={contact.avatar} />
            <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{title}</p>
                {email && email !== title && <p className="truncate text-xs text-muted-foreground">{email}</p>}
            </div>
        </div>
    );
}

// The width a mode composes at, so the hero scales by containerW / that width: text modes render
// into an A4 page, a deck and a drawing both compose at CANVAS_PREVIEW_WIDTH. Sheets vary with
// their content — null falls back to measuring the rendered body.
const INTRINSIC_WIDTH: Record<TextPreviewMode, number | null> = {
    eigendoc: A4_WIDTH_PX,
    eigenslides: CANVAS_PREVIEW_WIDTH,
    eigensheets: null,
    eigenvector: CANVAS_PREVIEW_WIDTH,
    markdown: A4_WIDTH_PX,
    plaintext: A4_WIDTH_PX,
    code: A4_WIDTH_PX,
};

// eigen-prose for rendered prose, drive-preview-code for raw <pre><code> blocks — eigen-prose's
// <pre> rule paints a dark code-block background that is wrong for a whole-file code thumbnail.
// A deck and a drawing need none: a compositor page carries its own box and its own paint.
const WRAPPER_CLASS: Record<TextPreviewMode, string> = {
    eigendoc: 'eigen-prose tiptap',
    eigenslides: '',
    eigensheets: 'eigensheets-preview',
    eigenvector: '',
    markdown: 'eigen-prose',
    plaintext: 'eigen-prose',
    code: 'drive-preview-code',
};

// Scale a server-rendered HTML preview down to fit the thumbnail panel.
function HtmlPreview({ path, tintColor }: { path: DrivePath; tintColor: string }) {
    const { data } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, true);
    const contentRef = useRef<HTMLDivElement>(null);
    const [setContainer, { width: containerW }] = useElementSize<HTMLDivElement>();
    // The body's own box is a trigger, not a measurement: a reflow means scrollWidth may have moved.
    const [setContent, contentBox] = useElementSize(contentRef);
    const [scale, setScale] = useState(1);

    const intrinsicWidth = data ? INTRINSIC_WIDTH[data.mode] : null;
    // The A4 page's own margin, so a text thumbnail is a proportional miniature of the printed page.
    const intrinsicPadding = intrinsicWidth === A4_WIDTH_PX ? '2cm' : undefined;

    useEffect(() => {
        if (containerW === 0) return;
        if (intrinsicWidth) {
            setScale(containerW / intrinsicWidth);
            return;
        }
        const contentW = contentRef.current?.scrollWidth ?? 0;
        if (contentW > 0) setScale(containerW / contentW);
    }, [containerW, contentBox, data?.body, intrinsicWidth]);

    if (!data?.body) return null;

    return (
        <div ref={setContainer} className="drive-preview-hero absolute inset-0 bg-background pointer-events-none">
            <div
                ref={setContent}
                className={WRAPPER_CLASS[data.mode]}
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    ...(intrinsicWidth ? { width: `${intrinsicWidth}px` } : null),
                    ...(intrinsicPadding ? { padding: intrinsicPadding } : null),
                }}
                dangerouslySetInnerHTML={{ __html: data.body }}
            />
            <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: `color-mix(in oklab, ${tintColor} 12%, transparent)` }}
            />
        </div>
    );
}
