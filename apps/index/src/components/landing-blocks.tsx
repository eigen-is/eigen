// What Eigen stands for, as three short blocks across the landing page, and under them, when the server's admin
// turned it on, the one line that installs Eigen with a button to copy it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Copy } from 'lucide-react';

const INSTALL_COMMAND = 'curl -fsSL https://eigen.is/install | sh';

const BLOCKS = [
    {
        title: 'Native Sync',
        text: 'Works seamlessly with the devices and apps you already use. No vendor lock-in.',
    },
    {
        title: 'Office Compatible',
        text: 'Bring the documents you have, and take them with you when you leave.',
    },
    {
        title: 'Built for Data Sovereignty',
        text: 'Runs on your own hardware, and the code is MIT licensed. Mail, contacts and calendars stay in standard .eml, .vcf and .ics.',
    },
];

const TITLE = 'text-xl leading-[1.3] font-medium tracking-[-0.01em]';

type LandingBlocksProps = {
    showInstall: boolean;
};

export function LandingBlocks({ showInstall }: LandingBlocksProps) {
    return (
        <div className="site-wide pb-10">
            <div className="grid grid-cols-1 gap-6 min-[56rem]:grid-cols-3 min-[56rem]:gap-10">
                {BLOCKS.map((block) => (
                    <div key={block.title}>
                        <h2 className={TITLE}>{block.title}</h2>
                        <p className="mt-2 text-[0.9375rem] leading-[1.6] text-pretty text-muted-foreground">
                            {block.text}
                        </p>
                    </div>
                ))}
            </div>
            {showInstall && (
                <div className="mt-10 grid items-center gap-4 min-[56rem]:grid-cols-2 min-[56rem]:gap-10">
                    <div>
                        <h2 className={TITLE}>Install Eigen in one line</h2>
                        <p className="mt-1 text-[0.9375rem] text-muted-foreground">
                            Eigen is pre-1.0. Expect rough edges, and breaking changes until 1.0.
                        </p>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border bg-background py-2.5 pr-2.5 pl-4">
                        <code className="min-w-0 overflow-x-auto font-mono text-sm whitespace-nowrap">
                            {INSTALL_COMMAND}
                        </code>
                        <TooltipButton
                            icon={Copy}
                            tooltipText="Copy to clipboard"
                            className="shrink-0"
                            onClick={() => copyToClipboard(INSTALL_COMMAND)}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
