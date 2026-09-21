import { getMailComposeUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { flattenAddresses, NO_SUBJECT } from '@workspace/lib/mail';
import type { AddressObject } from '@workspace/lib/types/mail';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { ABOVE_PREVIEW_Z } from '../dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { Separator } from '../separator';
import { ShadowContent } from '../shadow-content';
import { UserAvatar } from '../user/user-avatar';

// A header field as either source carries it: the reader reads a stored `Email`, whose ParsedMail fields
// may be a list, and the quick look reads an `EmlPreview`, whose fields are one object or null.
type AddressField = AddressObject | AddressObject[] | null | undefined;

type MessageViewProps = {
    subject?: string | undefined;
    from?: AddressField;
    replyTo?: AddressField;
    to?: AddressField;
    cc?: AddressField;
    bcc?: AddressField;
    // A stored message dates as a Date, a served preview as the ISO string its payload declares.
    date?: Date | string | null | undefined;
    html?: string | null | undefined;
    // What the parser derived from a text-only body; a preview carries none, so its `text` shows as text.
    textAsHtml?: string | null | undefined;
    text?: string | null | undefined;
    // A message the viewer sent reads as its recipients: the primary line names who it went to.
    isSent?: boolean;
    // A ?q= landing term, highlighted in the rendered body.
    highlightTerm?: string;
    // The chips under the header: the reader's own, with their actions, or the preview's plain ones.
    attachments?: ReactNode;
    // What the host draws after the body, inside the message's own spacing — the reader's invite widgets.
    footer?: ReactNode;
};

// One message, drawn the same way wherever its fields came from: the mail reader's stored message and the
// `.eml` quick look's served payload (docs/MAIL.md). Data in; it fetches nothing and acts on nothing.
export function MessageView({
    subject,
    from,
    replyTo,
    to,
    cc,
    bcc,
    date,
    html,
    textAsHtml,
    text,
    isSent,
    highlightTerm,
    attachments,
    footer,
}: MessageViewProps) {
    const formattedDate = date ? formatDateTime(date) : 'Unknown date';
    const body = html || textAsHtml || text || '';
    const header: HeaderFields = { subject, from, replyTo, to, cc, bcc, formattedDate };

    return (
        <div className="space-y-4 mb-6">
            <div>
                <h1 className="text-xl font-medium mb-4">{subject || NO_SUBJECT}</h1>

                <MailHeader header={header} isSent={isSent} />
            </div>

            <Separator />

            {attachments}

            {/* Email body — left-aligned with the header, capped at the document reading
                width (max-w-4xl, same as drive's editor and eigendoc preview) */}
            <div className="prose prose-sm max-w-4xl">
                {html || textAsHtml ? (
                    <ShadowContent
                        content={body}
                        contentType="html"
                        scheme={html ? 'light' : 'theme'}
                        className="w-full"
                        highlightTerm={highlightTerm}
                    />
                ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{body}</div>
                )}
            </div>

            {footer}
        </div>
    );
}

// A composer link, so a header address is one click from a reply. The URL is the shared cross-app one,
// which is why this header needs nothing from the app that draws it.
function MailLink({ email, name }: { email: string; name: string }) {
    return (
        <span className="text-xs text-muted-foreground">
            <a className="hover:underline" href={getMailComposeUrl(email)} title={email}>
                {name ? (
                    <>
                        {name} &lt;{email}&gt;
                    </>
                ) : (
                    email
                )}
            </a>
        </span>
    );
}

// Normalize the ParsedMail AddressObject | AddressObject[] container of one header field.
function addressObjects(field: AddressField): AddressObject[] {
    return Array.isArray(field) ? field : field ? [field] : [];
}

// The leaf addresses of a header field: RFC 2822 groups expand through the shared send-path helper,
// so group members appear here too.
function collectAddresses(field: AddressField): { name: string; address: string }[] {
    return addressObjects(field).flatMap((obj) => flattenAddresses(obj.value));
}

function formatContactObjects(field: AddressField) {
    const addresses = collectAddresses(field);
    return addresses.map(({ name, address }, idx) => (
        <span key={address}>
            <MailLink email={address} name={name} />
            {idx < addresses.length - 1 ? ', ' : ''}
        </span>
    ));
}

type HeaderFields = Pick<MessageViewProps, 'subject' | 'from' | 'replyTo' | 'to' | 'cc' | 'bcc'> & {
    formattedDate: string;
};

function MailHeaderDetails({ header }: { header: HeaderFields }) {
    const rows: { label: string; node: ReactNode }[] = [];
    if (header.from) rows.push({ label: 'from', node: formatContactObjects(header.from) });
    if (header.replyTo) rows.push({ label: 'reply-to', node: formatContactObjects(header.replyTo) });
    if (header.to) rows.push({ label: 'to', node: formatContactObjects(header.to) });
    if (header.cc) rows.push({ label: 'cc', node: formatContactObjects(header.cc) });
    if (header.bcc) rows.push({ label: 'bcc', node: formatContactObjects(header.bcc) });
    rows.push({ label: 'date', node: <span className="text-foreground">{header.formattedDate}</span> });
    if (header.subject)
        rows.push({ label: 'subject', node: <span className="text-foreground">{header.subject}</span> });

    return (
        <div className="text-sm">
            {rows.map((r) => (
                <div key={r.label} className="grid grid-cols-[80px_1fr] gap-2 py-1">
                    <span className="text-muted-foreground">{r.label}:</span>
                    <span className="break-words">{r.node}</span>
                </div>
            ))}
        </div>
    );
}

function MailHeader({ header, isSent }: { header: HeaderFields; isSent?: boolean }) {
    // Drawn inside the full-screen quick look (z-100), the details popover has to clear it the way a
    // dialog does (LAYOUT.md § Z-Index / Layering); the reader draws it under no overlay at all.
    const preview = useOptionalPreview();
    const recipients = [
        ...collectAddresses(header.to),
        ...collectAddresses(header.cc),
        ...collectAddresses(header.bcc),
    ];
    const primary = isSent ? recipients[0] : addressObjects(header.from)[0]?.value[0];
    const primaryName = primary?.name || primary?.address || 'Unknown';
    const primaryEmail = primary?.address || '';

    const summaryNames = recipients.map((a) => a.name || a.address);

    return (
        <div className="flex items-center">
            <UserAvatar name={primaryName} email={primaryEmail} />
            <div className="ml-3 flex-1 min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{primaryName}</span>
                    {primaryEmail && primaryEmail !== primaryName && (
                        <span className="text-xs text-muted-foreground truncate">&lt;{primaryEmail}&gt;</span>
                    )}
                </div>
                <div className="flex justify-between items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                    {summaryNames.length > 0 ? (
                        <Popover>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    className="flex items-center gap-1 min-w-0 hover:text-foreground rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span className="truncate">to: {summaryNames.join(', ')}</span>
                                    <ChevronDown className="h-3 w-3 shrink-0" />
                                </button>
                            </PopoverTrigger>
                            <PopoverContent
                                align="start"
                                collisionPadding={8}
                                className={cn(
                                    'w-[28rem] max-w-[calc(100vw-2rem)]',
                                    preview?.isPreviewOpen && ABOVE_PREVIEW_Z,
                                )}
                            >
                                <MailHeaderDetails header={header} />
                            </PopoverContent>
                        </Popover>
                    ) : (
                        <span />
                    )}
                    <span className="ml-auto shrink-0">{header.formattedDate}</span>
                </div>
            </div>
        </div>
    );
}
