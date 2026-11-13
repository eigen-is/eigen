// What Eigen stands for, as three short blocks along the bottom of the landing page, each a plain sentence over tags
// that name the protocols or formats behind it. Under them on the right, when the server's admin turned it on, a small
// line installs Eigen, with a button to copy it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { Badge } from '@workspace/ui/components/badge';
import { CodeBlock, CodeBlockContent } from '@workspace/ui/components/code-block';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Copy } from 'lucide-react';

const INSTALL_COMMAND = 'curl -fsSL https://eigen.is/install | sh';

const BLOCKS = [
    {
        title: 'Use your favorite apps',
        text: 'Works with the mail, calendar, contacts and file apps on your phone, Mac or PC.',
        tags: ['IMAP', 'SMTP', 'CalDAV', 'CardDAV', 'WebDAV'],
    },
    {
        title: 'Office compatible',
        text: 'Create and edit documents, spreadsheets and slides in your browser. Bring the files you have, and take them with you when you leave.',
        tags: ['.docx', '.xlsx', '.pptx'],
    },
    {
        title: 'Built for data sovereignty',
        text: 'MIT-licensed code running on your own server. Your mail, contacts and calendars stay in open formats, so there is no lock-in.',
        tags: ['.eml', '.vcf', '.ics'],
    },
];

type LandingBlocksProps = {
    showInstall: boolean;
};

export function LandingBlocks({ showInstall }: LandingBlocksProps) {
    return (
        <div className="site-wide mt-auto pb-10">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-10">
                {BLOCKS.map((block) => (
                    <div key={block.title} className="site-panel flex flex-col">
                        <h2 className="text-lg font-medium">{block.title}</h2>
                        <p className="mt-2 text-sm text-pretty text-muted-foreground">{block.text}</p>
                        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                            {block.tags.map((tag) => (
                                <Badge key={tag} variant="outline">
                                    {tag}
                                </Badge>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            {showInstall && (
                <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                    <span className="shrink-0">Install in one line</span>
                    <CodeBlock size="sm" className="w-auto min-w-0">
                        <CodeBlockContent>{INSTALL_COMMAND}</CodeBlockContent>
                    </CodeBlock>
                    <TooltipButton
                        icon={Copy}
                        tooltipText="Copy to clipboard"
                        className="shrink-0"
                        onClick={() => copyToClipboard(INSTALL_COMMAND)}
                    />
                </div>
            )}
        </div>
    );
}
