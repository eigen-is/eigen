// What Eigen stands for, as three short blocks along the bottom of the landing page and on the About overview, each a
// plain sentence over tags that name the protocols or formats behind it, taken from the apps the block names.
// Under them on the landing page, when the server's admin turned it on, the two lines that install Eigen, with a
// button to copy them.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { Badge } from '@workspace/ui/components/badge';
import { CodeBlock, CodeBlockContent } from '@workspace/ui/components/code-block';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { cn } from '@workspace/ui/lib/utils';
import { Copy } from 'lucide-react';
import type { Principle } from '../content/about-apps';
import { appPrinciples } from '../content/about-apps';

const INSTALL_COMMAND = 'mkdir -p /opt/eigen && cd /opt/eigen\ncurl -fsSL https://eigen.is/install | sh';

const BLOCKS: { principle: Principle; text: string; apps: readonly (keyof typeof appPrinciples)[] }[] = [
    {
        principle: 'Use your favorite apps',
        text: 'Works with the mail, calendar, contacts and file apps on your phone, Mac or PC.',
        apps: ['mail', 'calendar', 'contacts', 'drive'],
    },
    {
        principle: 'Office compatible',
        text: 'Create and edit documents, spreadsheets and slides in your browser. Bring the files you have, and take them with you when you leave.',
        apps: ['docs', 'sheets', 'slides'],
    },
    {
        principle: 'Built for data sovereignty',
        text: 'MIT-licensed code running on your own server. Your mail, contacts and calendars stay in open formats, so there is no lock-in.',
        apps: ['mail', 'contacts', 'calendar'],
    },
];

type LandingBlocksProps = {
    showInstall: boolean;
};

export function LandingBlocks({ showInstall }: LandingBlocksProps) {
    return (
        <div className="site-wide mt-auto pb-10">
            <PrincipleBlocks />
            {showInstall && (
                <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                    <span className="shrink-0">Install in two lines</span>
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

// The three blocks alone, three across from a tablet up, placed by the caller.
export function PrincipleBlocks({ className }: { className?: string }) {
    return (
        <div className={cn('grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-10', className)}>
            {BLOCKS.map((block) => (
                <div key={block.principle} className="site-panel flex flex-col">
                    <h2 className="text-lg font-medium">{block.principle}</h2>
                    <p className="mt-2 text-sm text-pretty text-muted-foreground">{block.text}</p>
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                        {principleTags(block.principle, block.apps).map((tag) => (
                            <Badge key={tag} variant="outline">
                                {tag}
                            </Badge>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

// The tags of one principle across the block's apps, in the block's order, such as Mail's IMAP and SMTP first.
function principleTags(principle: Principle, apps: readonly (keyof typeof appPrinciples)[]) {
    return apps.flatMap((app) =>
        appPrinciples[app].flatMap((entry) => (entry.principle === principle ? entry.tags : [])),
    );
}
