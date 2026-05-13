import { createFileRoute } from '@tanstack/react-router';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Mail</h1>
                <SignatureSection />
            </div>
        </div>
    );
}
