// What Eigen stands for, as three short blocks across the landing page, and under them, when the server's admin
// turned it on, the one line that installs Eigen with a button to copy it.

import { CopyInput } from '@workspace/ui';

const INSTALL_COMMAND = 'curl -fsSL https://eigen.is/install | sh';

const BLOCKS = [
    {
        title: 'Native sync',
        text: 'Works seamlessly with the devices and apps you already use. No vendor lock-in.',
    },
    {
        title: 'Office compatible',
        text: 'Bring the documents you have, and take them with you when you leave.',
    },
    {
        title: 'Built for data sovereignty',
        text: 'Runs on your own hardware, and the code is MIT licensed. Mail, contacts and calendars stay in standard .eml, .vcf and .ics.',
    },
];

const TITLE = 'text-xl font-medium';

type LandingBlocksProps = {
    showInstall: boolean;
};

export function LandingBlocks({ showInstall }: LandingBlocksProps) {
    return (
        <div className="site-wide pb-10">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-10">
                {BLOCKS.map((block) => (
                    <div key={block.title}>
                        <h2 className={TITLE}>{block.title}</h2>
                        <p className="mt-2 text-sm text-pretty text-muted-foreground">{block.text}</p>
                    </div>
                ))}
            </div>
            {showInstall && (
                <div className="mt-10 grid items-center gap-4 md:grid-cols-2 md:gap-10">
                    <div>
                        <h2 className={TITLE}>Install Eigen in one line</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Eigen is pre-1.0. Expect rough edges, and breaking changes until 1.0.
                        </p>
                    </div>
                    <CopyInput value={INSTALL_COMMAND} />
                </div>
            )}
        </div>
    );
}
