// One `.ics` the way a client writes one to disk: CRLF, one VCALENDAR, a PRODID, and whatever blocks the
// test hands over in the order it hands them over (VTIMEZONEs first, then the VEVENTs that name them).
export const vcal = (...blocks: string[][]): string =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Another Client//EN', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n');
