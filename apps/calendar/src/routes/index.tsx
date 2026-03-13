import {createFileRoute, redirect} from '@tanstack/react-router'
import { getMonthRange } from 'src/components/calendar-utils';

export const Route = createFileRoute('/')({
    beforeLoad: ({context}) => {
        if (context.auth.isAuthenticated) {
            const {from, to} = getMonthRange(new Date());
            throw redirect({
                to: '/view/$mode/$from/$to',
                params: {mode: 'month', from: String(from), to: String(to)},
            } as any);
        } else {
            throw redirect({to: '/login'});
        }
    },
})
