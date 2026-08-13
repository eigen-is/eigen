import { EigenLoader } from '../../braket/eigen-loader';

export function LoadingState() {
    return (
        <div className="flex items-center justify-center h-full w-full">
            <EigenLoader />
        </div>
    );
}
