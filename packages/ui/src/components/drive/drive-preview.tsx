// The picture at the top of a file's details in Drive: the image or video itself, a document's first page, or the
// cards, message or events a contact, mail or calendar file holds. Any other file gets its type's icon. Clicking
// it opens the file when the host passes a handler.

import { getDriveItemThumbnail, getDrivePreviewUrl } from '@workspace/lib/api';
import { formatEventWhen, viewerTimeZone } from '@workspace/lib/calendar';
import type { TextPreviewMode } from '@workspace/lib/constants';
import { CANVAS_PREVIEW_HEIGHT, CANVAS_PREVIEW_WIDTH, getTextPreviewMode } from '@workspace/lib/constants';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { contactFullName } from '@workspace/lib/contacts';
import { formatDateTime } from '@workspace/lib/date';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    DEFAULT_PAGE_SETUP,
    DOC_PROSE_CLASS,
    normalStyleProperties,
    pageBoxStyle,
    pagePx,
} from '@workspace/lib/docs/eigendoc';
import { useEmlPreview, useIcsPreview, useTextPreview, useVCardPreview } from '@workspace/lib/drive';
import { NO_SUBJECT } from '@workspace/lib/mail';
import type { Contact } from '@workspace/lib/types/contact';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isEmlFile, isIcsFile, isVCardFile } from '@workspace/lib/types/file-kinds';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useElementSize } from '../../hooks/use-element-size';
import { cn, IMAGE_CHECKERBOARD_STYLE } from '../../lib/utils';
import { UserAvatar } from '../user/user-avatar';
import { getFilePresentation } from './file-presentation';
import { PreviewCounts } from './preview-pane';

type DrivePreviewProps = {
    path: DrivePath;
    onActivate?: () => void;
    className?: string;
};

// The image types that may be animated. Their thumbnail is a still, so the hero shows their preview, which plays.
const ANIMATABLE_MIME_TYPES = new Set(['image/gif', 'image/webp']);

// The fixed 16:9 box keeps the panel's height steady as the user clicks through files.
export function DrivePreview({ path, onActivate, className }: DrivePreviewProps) {
    const presentation = getFilePresentation(path.mimeType, path.type, path.name);
    const hasTextPreview = getTextPreviewMode(path.mimeType, path.name) !== null;
    // Same guard as the quick look: a file an import would refuse never gets a preview either.
    const hasVCardPreview = isVCardFile(path.mimeType, path.name) && path.size <= VCARD_MAX_BYTES;
    const hasEmlPreview = isEmlFile(path.mimeType, path.name) && path.size <= EML_MAX_BYTES;
    const hasIcsPreview = isIcsFile(path.mimeType, path.name) && path.size <= ICS_MAX_BYTES;
    const { showThumbnail, thumbnailUrl } = getDriveItemThumbnail(path);
    const heroUrl = ANIMATABLE_MIME_TYPES.has(path.mimeType)
        ? getDrivePreviewUrl(path.ownerId, path.mountId, path.id, path.updatedAt)
        : thumbnailUrl;

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
                    <img src={heroUrl} alt={path.name} className="absolute inset-0 w-full h-full object-contain" />
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

// The body every format that reads its file composes into: rows centred under the format badge, on the
// app tint the wrapper already paints.
function HeroBody({ children }: { children: ReactNode }) {
    return (
        <div className="absolute inset-0 flex flex-col justify-center gap-2 overflow-hidden px-4 pt-8 pb-3">
            {children}
        </div>
    );
}

// The quick look shows a column of full cards, and the hero the first three as compact rows. Both read the same
// query, which is why a .vcf never asks for its text preview here.
function VCardHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useVCardPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    const contacts = data?.cards.slice(0, HERO_CARD_LIMIT) ?? [];

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data || contacts.length === 0) return <IconFallback icon={icon} color={color} />;

    // The cards the file holds that the hero shows no row for. The unreadable ones get a line of their own.
    const remaining = data.total - data.dropped - contacts.length;

    return (
        <HeroBody>
            {contacts.map(({ contact }, index) => (
                <VCardRow key={index} contact={contact} />
            ))}
            <PreviewCounts remaining={remaining} dropped={data.dropped} noun="contact" className="truncate text-xs" />
        </HeroBody>
    );
}

// The quick look shows the whole message, and the hero what a row of the mail list shows, from the same query.
function EmlHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useEmlPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data) return <IconFallback icon={icon} color={color} />;

    const sender = data.from?.value[0];
    const senderName = sender?.name || sender?.address || 'Unknown';

    return (
        <HeroBody>
            <div className="flex min-w-0 items-center gap-3">
                <UserAvatar name={senderName} email={sender?.address ?? ''} />
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{senderName}</p>
                    {data.date && <p className="truncate text-xs text-muted-foreground">{formatDateTime(data.date)}</p>}
                </div>
            </div>
            <p className="truncate text-sm text-foreground">{data.subject || NO_SUBJECT}</p>
            {data.text && <p className="line-clamp-2 text-xs text-muted-foreground">{data.text}</p>}
        </HeroBody>
    );
}

// The quick look shows every event as a card, and the hero the first three from the same query, each as its title
// and when it happens.
function IcsHero({ path, icon, color }: { path: DrivePath; icon: LucideIcon; color: string }) {
    const { data, isLoading } = useIcsPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    const events = data?.events.slice(0, HERO_CARD_LIMIT) ?? [];

    // Loading reads as the empty tinted box, the same as a text hero with no body yet.
    if (isLoading) return null;
    if (!data || events.length === 0) return <IconFallback icon={icon} color={color} />;

    // The events the file holds that the hero shows no line for. The unreadable ones get a line of their own.
    const remaining = data.total - data.dropped - events.length;

    return (
        <HeroBody>
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
            <PreviewCounts remaining={remaining} dropped={data.dropped} noun="event" className="truncate text-xs" />
        </HeroBody>
    );
}

// The card's own name and email, not the address book's: this previews a file.
function VCardRow({ contact }: { contact: Contact }) {
    const email = contact.email[0];
    const title = contactFullName(contact) || email;

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

type IntrinsicPage = { widthPx: number; padding?: string };

function docPage(setup: PageSetup): IntrinsicPage {
    return { widthPx: pagePx(setup).width, padding: pageBoxStyle(setup).padding };
}

// A text mode renders onto a docs page, margins included, so its hero is a small copy of the printed page. A doc uses
// the page it stores, and the other text modes the default page.
const DOC_PAGE = docPage(DEFAULT_PAGE_SETUP);
const CANVAS_PAGE: IntrinsicPage = { widthPx: CANVAS_PREVIEW_WIDTH };

// The page each mode composes on, whose width the hero scales to its own. A deck and a drawing both compose at
// CANVAS_PREVIEW_WIDTH. A sheet's width depends on its content, so null measures the rendered body instead.
const INTRINSIC_PAGE: Record<TextPreviewMode, IntrinsicPage | null> = {
    eigendoc: DOC_PAGE,
    eigenslides: CANVAS_PAGE,
    eigensheets: null,
    eigenvector: CANVAS_PAGE,
    markdown: DOC_PAGE,
    plaintext: DOC_PAGE,
    code: DOC_PAGE,
};

// Code takes drive-preview-code, as eigen-prose paints a <pre> as a dark block, wrong for a whole file. A deck and a
// drawing take none, as their page carries its own box and paint.
const WRAPPER_CLASS: Record<TextPreviewMode, string> = {
    eigendoc: `eigen-prose tiptap ${DOC_PROSE_CLASS}`,
    eigenslides: '',
    eigensheets: 'eigensheets-preview',
    eigenvector: '',
    markdown: 'eigen-prose',
    plaintext: 'eigen-prose',
    code: 'drive-preview-code',
};

// The server's HTML preview of a document, scaled down to fit the box.
function HtmlPreview({ path, tintColor }: { path: DrivePath; tintColor: string }) {
    const { data } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, true);
    const contentRef = useRef<HTMLDivElement>(null);
    const [setContainer, { width: containerW }] = useElementSize<HTMLDivElement>();
    // The body's own box is a trigger, not a measurement: a reflow means scrollWidth may have moved.
    const [setContent, contentBox] = useElementSize(contentRef);
    const [scale, setScale] = useState(1);

    const docSetup = data?.mode === 'eigendoc' ? data.page : undefined;
    const page = docSetup ? docPage(docSetup) : data && INTRINSIC_PAGE[data.mode];
    const pageWidthPx = page?.widthPx;

    useEffect(() => {
        if (containerW === 0) return;
        if (pageWidthPx) {
            setScale(containerW / pageWidthPx);
            return;
        }
        const contentW = contentRef.current?.scrollWidth ?? 0;
        if (contentW > 0) setScale(containerW / contentW);
    }, [containerW, contentBox, data?.body, pageWidthPx]);

    if (!data?.body) return null;

    return (
        <div
            ref={setContainer}
            className={cn(
                'drive-preview-hero absolute inset-0 bg-background pointer-events-none',
                // A doc thumbnail is its page, light like the editor's; the prose inside escapes the dark rules.
                data.mode === 'eigendoc' && 'eigen-paper',
            )}
            style={{ '--preview-h': `${CANVAS_PREVIEW_HEIGHT}px` }}
        >
            <div
                ref={setContent}
                className={WRAPPER_CLASS[data.mode]}
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    ...(page ? { width: `${page.widthPx}px`, padding: page.padding } : null),
                    // A doc's Normal, which its text draws in.
                    ...(data.style && normalStyleProperties(data.style)),
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
