import type { Attendee, EventData } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';

export type ParsedEvent = {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: number;
    endTime: number;
    allDay: boolean;
    rrule: string | null;
    timezone: string | null;
    status: 'confirmed' | 'tentative' | 'cancelled';
    sequence: number;
    recurrenceDate: string | null;
    data: EventData | null;
};

export function parseIcs(icsText: string): ParsedEvent[] {
    const jcal = ICAL.parse(icsText);
    const comp = new ICAL.Component(jcal);
    const vevents = comp.getAllSubcomponents('vevent');

    return vevents.map((vevent) => {
        const event = new ICAL.Event(vevent);

        const uid = event.uid || '';
        const title = event.summary || '';

        const descriptionRaw = vevent.getFirstPropertyValue('description');
        const description = typeof descriptionRaw === 'string' ? descriptionRaw : null;
        const locationRaw = vevent.getFirstPropertyValue('location');
        const location = typeof locationRaw === 'string' ? locationRaw : null;

        const dtstart = vevent.getFirstProperty('dtstart');
        const dtend = vevent.getFirstProperty('dtend');
        const allDay = event.startDate.isDate;

        const startTime = Math.floor(event.startDate.toJSDate().getTime() / 1000);
        const endTime = dtend
            ? Math.floor(event.endDate.toJSDate().getTime() / 1000)
            : startTime + (allDay ? 86400 : 3600);

        const tzidRaw = dtstart?.getParameter('tzid') || null;
        const tzid = Array.isArray(tzidRaw) ? (tzidRaw[0] ?? null) : tzidRaw;

        const rruleProp = vevent.getFirstPropertyValue('rrule');
        const rrule = rruleProp ? rruleProp.toString() : null;

        const rawStatus = (vevent.getFirstPropertyValue('status') || 'CONFIRMED').toString().toLowerCase();
        const status = (
            ['confirmed', 'tentative', 'cancelled'].includes(rawStatus) ? rawStatus : 'confirmed'
        ) as ParsedEvent['status'];

        const sequence = Number(vevent.getFirstPropertyValue('sequence') || 0);

        const recurrenceId = vevent.getFirstProperty('recurrence-id');
        let recurrenceDate: string | null = null;
        if (recurrenceId) {
            const rid = recurrenceId.getFirstValue() as ICAL.Time | string | null;
            if (rid instanceof ICAL.Time) {
                const d = rid.toJSDate();
                recurrenceDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
            }
        }

        const attendeeProps = vevent.getAllProperties('attendee');
        const attendees: Attendee[] = attendeeProps.map((prop) => {
            const rawValue = prop.getFirstValue();
            const email = (typeof rawValue === 'string' ? rawValue : String(rawValue ?? '')).replace('mailto:', '');
            const cnRaw = prop.getParameter('cn') || email;
            const cn: string = Array.isArray(cnRaw) ? (cnRaw[0] ?? email) : cnRaw;
            const partstatRaw = prop.getParameter('partstat') || 'NEEDS-ACTION';
            const partstatStr = Array.isArray(partstatRaw) ? (partstatRaw[0] ?? 'NEEDS-ACTION') : partstatRaw;
            const partstat = partstatStr.toUpperCase();
            const roleRaw = prop.getParameter('role') || 'REQ-PARTICIPANT';
            const roleStr = Array.isArray(roleRaw) ? (roleRaw[0] ?? 'REQ-PARTICIPANT') : roleRaw;
            const role = roleStr.toUpperCase();

            const statusMap: Record<string, Attendee['status']> = {
                'NEEDS-ACTION': 'pending',
                ACCEPTED: 'accepted',
                DECLINED: 'declined',
                TENTATIVE: 'tentative',
            };
            const roleMap: Record<string, Attendee['role']> = {
                'REQ-PARTICIPANT': 'required',
                'OPT-PARTICIPANT': 'optional',
            };

            return {
                email,
                name: cn !== email ? cn : undefined,
                status: statusMap[partstat] || 'pending',
                role: roleMap[role] || 'required',
            };
        });

        const organizerProp = vevent.getFirstProperty('organizer');
        let organizer: EventData['organizer'] | undefined;
        if (organizerProp) {
            const orgRaw = organizerProp.getFirstValue();
            const orgEmail = (typeof orgRaw === 'string' ? orgRaw : String(orgRaw ?? '')).replace('mailto:', '');
            const orgCnRaw = organizerProp.getParameter('cn') || orgEmail;
            const orgCn: string = Array.isArray(orgCnRaw) ? (orgCnRaw[0] ?? orgEmail) : orgCnRaw;
            organizer = {
                userId: '',
                email: orgEmail,
                name: orgCn !== orgEmail ? orgCn : undefined,
            };
        }

        const valarms = vevent.getAllSubcomponents('valarm');
        const reminders = valarms.map((alarm) => {
            const trigger = alarm.getFirstPropertyValue('trigger') as ICAL.Duration | string | null;
            let minutes = 15;
            if (trigger instanceof ICAL.Duration) {
                minutes = Math.abs(Math.round(trigger.toSeconds() / 60));
            }
            const action = (alarm.getFirstPropertyValue('action') || 'DISPLAY').toString().toUpperCase();
            return {
                type: (action === 'EMAIL' ? 'email' : 'notification') as 'notification' | 'email',
                minutes,
            };
        });

        const data: EventData | null =
            attendees.length || organizer || reminders.length
                ? {
                      attendees: attendees.length ? attendees : undefined,
                      organizer,
                      reminders: reminders.length ? reminders : undefined,
                  }
                : null;

        return {
            uid,
            title,
            description,
            location,
            startTime,
            endTime,
            allDay,
            rrule,
            timezone: tzid,
            status,
            sequence,
            recurrenceDate,
            data,
        };
    });
}
