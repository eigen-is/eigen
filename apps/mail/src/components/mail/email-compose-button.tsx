// The sidebar's Compose: it opens a blank composer in the mailbox on screen, the way the C key does.

import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { MailPlus } from 'lucide-react';
import { useMailDetail } from './hooks/use-mail-detail';

type EmailComposeButtonProps = {
    condensed: boolean;
};

export function EmailComposeButton({ condensed }: EmailComposeButtonProps) {
    const detail = useMailDetail();
    return (
        <SidebarPrimaryButton icon={MailPlus} label="Compose" condensed={condensed} onClick={() => detail.open({})} />
    );
}
