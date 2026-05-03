import { formatInputDate } from '@workspace/lib/date';
import { usePublicConfig } from '@workspace/lib/public';
import { Button } from '../../button.tsx';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../dialog.tsx';

type AboutDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
    const { data: config } = usePublicConfig();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader className="items-center">
                    <DialogTitle className="sr-only">About Eigen</DialogTitle>
                    <div className="text-3xl font-bold select-none" style={{ color: 'var(--app-space-color)' }}>
                        eigen
                    </div>
                    <p className="text-sm text-muted-foreground text-center">
                        Your personal workspace in the cloud.
                        <br />
                        Simple and secure. You control your own data.
                    </p>
                </DialogHeader>

                <div className="space-y-4 text-sm">
                    <div className="text-center text-xs text-muted-foreground">
                        Version {config?.version ?? '—'}
                        {config?.commit && (
                            <>
                                {' · '}
                                {config.commit}
                                {config.builtAt && ` · ${formatInputDate(config.builtAt)}`}
                            </>
                        )}
                    </div>

                    <p className="text-muted-foreground">
                        Not a launch, not a beta. Eigen is in a testing phase: a few weeks of real use by real people to
                        find bugs, fix what's broken and figure out what to build next.{' '}
                        <a
                            href="https://eigen.is/blog/eigen-six-months-later"
                            className="underline text-foreground"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Read more
                        </a>
                        .
                    </p>
                </div>

                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>OK</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
