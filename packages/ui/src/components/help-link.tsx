import { getHelpUrl } from '@workspace/lib/api';
import { CircleHelp } from 'lucide-react';

export function HelpLink({ section, slug, label = 'Learn more' }: { section: string; slug: string; label?: string }) {
    return (
        <a
            href={getHelpUrl(section, slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <CircleHelp className="h-3.5 w-3.5" />
            {label}
        </a>
    );
}
