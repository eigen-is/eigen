import {createFileRoute} from '@tanstack/react-router'
import {getEmailById} from "@/lib/mock-data.ts";
import {EmailDetail} from "@/components/mail/email-detail.tsx";

export const Route = createFileRoute('/inbox/$mailId')({
    loader: async ({params}) => {
        return {email: getEmailById(params.mailId)}
    },
    errorComponent: ({error}) => {
        // Render an error message
        return <div>{error.message}</div>
    },
    component: PostComponent,
})

async function PostComponent() {
    const {email} = Route.useLoaderData();
    return <EmailDetail email={await email}/>
}
