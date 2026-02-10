import ReactDOM from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import {useAuth} from "@workspace/lib/auth";
import {EigenApp} from "@workspace/ui/components/layout/eigen-app";
import {useAddLabel, useDeleteLabel, useUpdateLabel} from '@workspace/lib/contacts';

import '@workspace/ui/globals.css';
import './../css/globals.css';
import {LabelProvider} from '@workspace/ui/components/layout/labels/label-provider';
import {Label} from '@workspace/lib/types/label';
import {useCallback} from 'react';

// Set up a Router instance
const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/contacts',
    scrollRestoration: true,
    context: {
        auth: undefined!, // This will be set after we wrap the app in an AuthProvider
    },
});

// Register things for typesafety
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

function InnerApp() {
    const auth = useAuth();

    const addLabelMutation = useAddLabel();
    const updateLabelMutation = useUpdateLabel();
    const deleteLabelMutation = useDeleteLabel();

    const onAddLabel = useCallback(async (labelData: Omit<Label, 'id'>) => {
        await addLabelMutation.mutateAsync(labelData);
    }, [addLabelMutation]);

    const onUpdateLabel = useCallback(async (label: Label) => {
        await updateLabelMutation.mutateAsync(label);
    }, [updateLabelMutation]);

    const onDeleteLabel = useCallback(async (labelId: string) => {
        await deleteLabelMutation.mutateAsync(labelId);
    }, [deleteLabelMutation]);

    return (
        <LabelProvider
            onAddLabel={onAddLabel}
            onUpdateLabel={onUpdateLabel}
            onDeleteLabel={onDeleteLabel}
        >
            <RouterProvider router={router} context={{auth}}/>
        </LabelProvider>
    )
}

function App() {
    return (
        <EigenApp appName="contacts">
            <InnerApp/>
        </EigenApp>
    )
}


const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App/>);
}
