import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Separator } from '@workspace/ui/components/separator';
import { MailPrefsSection } from '../components/space/mail-prefs-section';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar" toolbar={<ToolbarTitle>Mail</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl app-gutter space-y-8">
                        <SignatureSection />
                        <Separator />
                        <MailPrefsSection />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
