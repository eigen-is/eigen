// The dialog behind "About Eigen" in the account menu: the logo, a line on what Eigen is, the build's version
// and links to the source, the licenses and the changelog. The top bar opens it for a signed-in user or a guest.

import { getChangelogUrl, getLicensesUrl } from '@workspace/lib/api';
import { Github, Scale, ScrollText } from 'lucide-react';
import { Button } from '../../button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../dialog';
import { VersionLabel } from './version-label';

type AboutDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader className="items-center">
                    <DialogTitle className="sr-only">About Eigen</DialogTitle>
                    <div className="text-3xl font-medium select-none" style={{ color: 'var(--app-space-color)' }}>
                        eigen
                    </div>
                    <DialogDescription className="text-center">
                        A self-hosted alternative to Google Workspace.
                        <br />
                        Simple and secure. You control your data.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 text-sm">
                    <div className="text-center text-xs text-muted-foreground">
                        <a href={getChangelogUrl()} target="_blank" rel="noreferrer" className="hover:text-foreground">
                            <VersionLabel />
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href="https://github.com/eigen-is/eigen"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <Github className="size-3.5" />
                            github.com/eigen-is/eigen
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href={getLicensesUrl()}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <Scale className="size-3.5" />
                            Open-source licenses
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href={getChangelogUrl()}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <ScrollText className="size-3.5" />
                            Changelog
                        </a>
                    </div>
                </div>

                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>OK</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
