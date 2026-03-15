import {EigenLoader} from './braket/eigen-loader';

export function LoadingCenter() {
    return (
        <div className="flex items-center justify-center h-full w-full">
            <EigenLoader/>
        </div>
    );
}
