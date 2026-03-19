import {createFileRoute} from '@tanstack/react-router';
import {DownloadHome} from '../components/space/download-home';

export const Route = createFileRoute('/_auth/data')({
    component: DataExportComponent
})

function DataExportComponent() {
    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Data Export</h1>
                <DownloadHome/>
            </div>
        </div>
    );
}
