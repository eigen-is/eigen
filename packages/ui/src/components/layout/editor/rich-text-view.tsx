import { cn } from '@workspace/ui/lib/utils';

type RichTextViewProps = {
    html: string;
    // Fires when a task-item checkbox toggle changes the rendered HTML — the
    // updated string is computed from the live DOM after the browser's
    // checkbox toggle, so callers can persist it (e.g. into a Y.Doc field).
    onChange?: (html: string) => void;
    className?: string;
};

export function RichTextView({ html, onChange, className }: RichTextViewProps) {
    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!onChange) return;
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
        const input = target as HTMLInputElement;
        const li = input.closest('li[data-checked]');
        if (!li) return;
        li.setAttribute('data-checked', input.checked ? 'true' : 'false');
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
        onChange(e.currentTarget.innerHTML);
    };

    return (
        <div
            className={cn(className)}
            onClick={handleClick}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: TipTap-serialised HTML from Y.Doc
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
