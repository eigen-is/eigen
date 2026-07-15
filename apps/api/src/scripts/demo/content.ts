// Demo-world content for "Tuimel Festival" — a small, volunteer-run community arts & music
// festival, ~3 weeks out, line-up ~80% confirmed, short on volunteers, iffy Sunday forecast.
//
// This module is DATA ONLY: personas, folder names, document/mail/event/chat/contact text. The
// mechanics (seed-demo.ts) turn it into a live workspace through the real product surfaces. Keep
// it that way so a later content-deepening pass swaps data here without touching mechanics.
//
// Personas are keyed by a fixed local-part; the runtime email is `<key>@<MAIL_DOMAIN>`. Everything
// the data model keys on (ACLs, comments, calendar attendees, stickies creators) resolves by that
// email, so ids may be random per rebuild. All names, acts and vendors are fictional.

export type LeadRole =
    | 'director'
    | 'programming'
    | 'production'
    | 'comms'
    | 'volunteers'
    | 'finance'
    | 'tech'
    | 'liaison';

export type Persona = {
    key: string; // email local-part, stable across rebuilds
    name: string;
    title: string;
    role?: LeadRole; // set for the 8 named leads
    avatar: string; // fixture filename under fixtures/avatars/ (curated Unsplash portrait, see CREDITS.md)
};

// 8 named leads do the visible authoring; 12 lighter crew fill the roster and @-mention lists.
export const PERSONAS: Persona[] = [
    { key: 'anouk', name: 'Anouk de Wit', title: 'Festival director', role: 'director', avatar: 'anouk.jpg' },
    { key: 'joris', name: 'Joris Bakker', title: 'Programming lead', role: 'programming', avatar: 'joris.jpg' },
    { key: 'saar', name: 'Saar Vermeer', title: 'Production & logistics lead', role: 'production', avatar: 'saar.jpg' },
    { key: 'mees', name: 'Mees de Groot', title: 'Comms & marketing', role: 'comms', avatar: 'mees.jpg' },
    { key: 'nour', name: 'Nour El Amrani', title: 'Volunteer coordinator', role: 'volunteers', avatar: 'nour.jpg' },
    { key: 'bram', name: 'Bram Visser', title: 'Finance & ticketing', role: 'finance', avatar: 'bram.jpg' },
    { key: 'timo', name: 'Timo Jansen', title: 'Stage & tech lead', role: 'tech', avatar: 'timo.jpg' },
    { key: 'lieke', name: 'Lieke Smits', title: 'Artist liaison & hospitality', role: 'liaison', avatar: 'lieke.jpg' },
    { key: 'fenna', name: 'Fenna Bos', title: 'Bar coordinator', avatar: 'fenna.jpg' },
    { key: 'daan', name: 'Daan Mulder', title: 'Gate & wristbands', avatar: 'daan.jpg' },
    { key: 'sanne', name: 'Sanne Kok', title: 'Stage crew', avatar: 'sanne.jpg' },
    { key: 'ravi', name: 'Ravi Nair', title: 'Site crew', avatar: 'ravi.jpg' },
    { key: 'joost', name: 'Joost Peters', title: 'Workshops host', avatar: 'joost.jpg' },
    { key: 'imke', name: 'Imke de Vries', title: 'First aid', avatar: 'imke.jpg' },
    { key: 'lars', name: 'Lars Hendriks', title: 'Waste & recycling', avatar: 'lars.jpg' },
    { key: 'yara', name: 'Yara Haddad', title: 'Camping host', avatar: 'yara.jpg' },
    { key: 'pieter', name: 'Pieter van Dijk', title: 'Box office', avatar: 'pieter.jpg' },
    { key: 'maud', name: 'Maud Willems', title: 'Runner', avatar: 'maud.jpg' },
    { key: 'sem', name: 'Sem Dekker', title: 'Décor & art', avatar: 'sem.jpg' },
    { key: 'tessa', name: 'Tessa Meijer', title: 'Sound assistant', avatar: 'tessa.jpg' },
];

export const ADMIN_NAME = 'Tuimel Admin';
export const ADMIN_LOCALPART = 'admin';
export const ADMIN_AVATAR = 'admin.jpg';
export const ORG_NAME = 'Tuimel Festival';
export const TEAM_NAME = 'festival crew';
export const TEAM_MOUNT_NAME = 'festival';

// All seeded directory and file names are lowercase. Chat channels live under `chats/`.
export const TEAM_FOLDERS = [
    'production',
    'programming',
    'marketing',
    'finance',
    'volunteers',
    'images',
    'chats',
] as const;
export type TeamFolder = (typeof TEAM_FOLDERS)[number];

// --- Documents (seeded via the shipped .docx -> eigendoc converter, dogfooding import) ---

export type DocComment = {
    // Slug used for the comment thread's chat name (lowercase, no extension).
    card: string;
    // Exact phrase from the doc text the comment mark anchors on (also the card title,
    // mirroring the editor's "title = selected text" convention).
    anchor: string;
    author: string; // persona key
    text: string;
    replies?: { author: string; text: string }[];
    assignTo?: LeadRole; // records an `assigned` activity + notification
};

export type SeededDoc = {
    folder: TeamFolder;
    name: string; // lowercase, no extension
    author: LeadRole;
    html: string; // rendered to .docx, then converted to an eigendoc
    comments: DocComment[];
};

export const DOCS: SeededDoc[] = [
    {
        folder: 'production',
        name: 'production plan',
        author: 'production',
        html: [
            '<h1>Production plan</h1>',
            '<p>Working document for this edition. Three weeks out. Line-up roughly 80% confirmed, tickets moving, still short on crew for the build weekend.</p>',
            '<h2>Site & access</h2>',
            '<p>The festival is on the Hoeve Tuimelaar field near Vlierzand, on the coast. Remote by design, which means we bring everything in: water, power, sanitation, and the people.</p>',
            '<ul><li>Shuttle buses from the nearest station, every 30 minutes</li><li>Two generators plus a backup, quote pending</li><li>Camping field opens Friday midday</li></ul>',
            '<h2>Timeline</h2>',
            '<ul><li>Build weekend: fencing, stages, power</li><li>Load-in and soundchecks: Friday</li><li>Doors: Saturday and Sunday midday</li><li>Strike: Monday</li></ul>',
            '<h2>Responsibilities</h2>',
            '<p>Programming owns the line-up and stage times. Production owns the site and logistics. Volunteers owns the shift roster. Finance owns tickets and the budget. Comms owns the public info.</p>',
            '<h2>Open risks</h2>',
            '<p>The Sunday forecast for the exposed field looks rough. We decide on wind cover for the second stage at the go/no-go meeting.</p>',
        ].join(''),
        comments: [
            {
                card: 'volunteers-gap',
                anchor: 'short on crew for the build weekend',
                author: 'saar',
                text: "We're still about 10 volunteers short for the build weekend. Can we push the call-out again?",
                replies: [
                    { author: 'nour', text: 'On it, sending a fresh call-out to the mailing list today.' },
                    { author: 'saar', text: '/highfive' },
                ],
                assignTo: 'volunteers',
            },
            {
                card: 'sunday-weather',
                anchor: 'wind cover for the second stage',
                author: 'timo',
                text: 'The Sunday forecast for the field looks rough. Do we tent the second stage?',
                replies: [
                    { author: 'saar', text: "Let's decide at the go/no-go. Getting a quote for wind-rated cover." },
                ],
            },
            {
                card: 'shuttle-timing',
                anchor: 'Shuttle buses from the nearest station',
                author: 'joris',
                text: 'Last shuttle at 01:00 or 02:00? It affects the closing set.',
                replies: [{ author: 'mees', text: "02:00, I'll put it on the info page." }],
            },
        ],
    },
    {
        folder: 'marketing',
        name: 'press release draft',
        author: 'comms',
        html: [
            '<h1>Press release draft</h1>',
            '<p><em>For release once the line-up hits 100%.</em></p>',
            '<p>Tuimel Festival returns to the coastal fields near Vlierzand for a weekend of emerging music, spoken word, installations and workshops. Small on purpose: two stages, a food corner, and camping under big skies.</p>',
            '<p>Tickets are on sale now. The full line-up reveal follows in the coming days.</p>',
        ].join(''),
        comments: [
            {
                card: 'headline',
                anchor: 'full line-up reveal',
                author: 'anouk',
                text: 'Can we lead with the line-up reveal date instead of the theme?',
            },
        ],
    },
];

// --- Budget sheet (built as .xlsx, converted through the shipped xlsx -> eigensheets path) ---

export const BUDGET = {
    folder: 'finance' as TeamFolder,
    name: 'budget', // lowercase, no extension
    author: 'finance' as LeadRole,
    income: [
        ['Ticket sales', 42000],
        ['Bar', 9000],
        ['Culture fund grant', 15000],
        ['Local sponsors', 6000],
    ] as [string, number][],
    costs: [
        ['Artist fees', 28000],
        ['Stage & tech', 12000],
        ['Security', 6000],
        ['Sanitation', 4000],
        ['Shuttle buses', 3500],
        ['Marketing', 2500],
    ] as [string, number][],
};

// --- Slides deck fixture (authored once, byte-copied in; slides embed no identity) ---

export type SlideSpec = { heading: string; body: string };

export const SPONSOR_DECK = {
    folder: 'marketing' as TeamFolder,
    name: 'sponsor pitch', // lowercase, no extension
    author: 'comms' as LeadRole,
    slides: [
        { heading: 'Tuimel Festival', body: 'A small coastal festival for emerging music and art' },
        { heading: 'Who comes', body: 'A couple thousand curious people, two stages, camping under big skies' },
        {
            heading: 'Why partner with us',
            body: 'Warm, local, and independent. Your name next to a much-loved weekend',
        },
        { heading: 'What you get', body: 'Stage credit, on-site presence, and a mention in every announcement' },
        { heading: "Let's talk", body: 'Reach out to the crew and join this edition' },
    ] as SlideSpec[],
};

// --- Stickies board fixture (authored once, byte-copied in; creator = persona email) ---

export type CardSpec = {
    title: string;
    description: string;
    column: string; // must be one of KANBAN.columns
    creator: string; // persona key; domainised into an email by the seeder
    // Linked chat thread, mirroring DocComment: a real chat inside the container's chat/ subfolder,
    // seeded by the creator persona (chat) and referenced back by name (chatName on the card).
    chat: string; // slug, lowercase, no extension
    chatText: string;
    chatReplies?: { author: string; text: string }[];
};

export const KANBAN = {
    folder: 'production' as TeamFolder,
    name: 'festival kanban', // lowercase, no extension
    columns: ['to do', 'doing', 'done'],
    cards: [
        {
            title: 'Confirm headliner contract',
            description: 'Signed and countersigned.',
            column: 'done',
            creator: 'joris',
            chat: 'headliner-contract',
            chatText: 'Signed and countersigned today.',
            chatReplies: [
                { author: 'anouk', text: "Nice one, let's get it into the press release." },
                { author: 'joris', text: '/cheer' },
            ],
        },
        {
            title: 'Order fencing',
            description: 'Build-weekend delivery.',
            column: 'doing',
            creator: 'saar',
            chat: 'fencing-order',
            chatText: 'Getting quotes in for the build-weekend delivery.',
            chatReplies: [
                { author: 'timo', text: 'See if they can drop it Thursday, we need the site clear before that.' },
            ],
        },
        {
            title: 'Publish full line-up',
            description: 'Once the last two acts confirm.',
            column: 'to do',
            creator: 'mees',
            chat: 'lineup-publish',
            chatText: 'Holding this until the last two acts confirm.',
            chatReplies: [{ author: 'joris', text: 'Should have both locked in by Friday.' }],
        },
        {
            title: 'Recruit 10 more volunteers',
            description: 'Blocked on the call-out going out.',
            column: 'to do',
            creator: 'nour',
            chat: 'volunteer-recruit',
            chatText: 'Still about 10 short for the build weekend. Call-out goes out today.',
            chatReplies: [{ author: 'anouk', text: 'Let me know if you want a hand drafting it.' }],
        },
        {
            title: 'Fix generator quote',
            description: 'Two generators plus a backup.',
            column: 'doing',
            creator: 'saar',
            chat: 'generator-quote',
            chatText: 'Chasing numbers for two generators plus a backup.',
            chatReplies: [
                { author: 'timo', text: 'Make sure the backup can carry the second stage on its own if it has to.' },
            ],
        },
        {
            title: 'Print wristbands',
            description: 'Three tiers, camping included.',
            column: 'to do',
            creator: 'daan',
            chat: 'wristbands-print',
            chatText: 'Three tiers, camping included. Sending the design to print this week.',
            chatReplies: [{ author: 'anouk', text: "Nice, post a preview here when it's back." }],
        },
        {
            title: 'Book shuttle buses',
            description: 'Every 30 minutes from the station.',
            column: 'done',
            creator: 'saar',
            chat: 'shuttle-buses',
            chatText: 'Booked. Every 30 minutes from the station.',
            chatReplies: [{ author: 'mees', text: "I'll put the schedule on the info page." }],
        },
        {
            title: 'Sunday wind cover',
            description: 'Decide at the go/no-go meeting.',
            column: 'to do',
            creator: 'timo',
            chat: 'wind-cover',
            chatText: 'Forecast for the field is turning windy Sunday. Need a call on tenting the second stage.',
            chatReplies: [
                { author: 'saar', text: "Let's decide at the go/no-go, I'll get a wind-cover quote before then." },
            ],
        },
    ] as CardSpec[],
};

// --- Site photos (committed .webp fixtures uploaded into the team drive's images/ folder) ---

export type PhotoSpec = {
    file: string; // fixture filename under fixtures/images/ (see CREDITS.md)
    caption: string; // in-world note describing the shot
    uploader: string; // persona key
};

export const PHOTOS: PhotoSpec[] = [
    { file: 'camping-field.webp', caption: 'Camping field is taking shape. The sign went up today.', uploader: 'yara' },
    {
        file: 'storm-over-the-field.webp',
        caption: 'Sky over the field last week. This is the Sunday weather I keep flagging.',
        uploader: 'timo',
    },
    {
        file: 'wildflower-meadow.webp',
        caption: 'The meadow by the entrance is in full bloom right now.',
        uploader: 'mees',
    },
    {
        file: 'beach-poles-sunset.webp',
        caption: 'Sunset five minutes from the field. One for the socials.',
        uploader: 'mees',
    },
    { file: 'dune-sunset.webp', caption: 'Dune and sea at golden hour, for the marketing set.', uploader: 'mees' },
    {
        file: 'crowd-arriving.webp',
        caption: 'Crowd arriving from last edition. Nice for the announcement.',
        uploader: 'mees',
    },
    {
        file: 'hands-up-at-camp.webp',
        caption: 'Camping mornings from last year. Still makes me smile.',
        uploader: 'mees',
    },
];

// --- Chat channels (real chat rooms in chats/, seeded via ChatRoom.postMessage as personas) ---

export type ChatLine = { author: string; text: string };
export type SeededChat = { name: string; messages: ChatLine[] };

export const CHATS: SeededChat[] = [
    {
        name: 'production',
        messages: [
            { author: 'saar', text: 'Build weekend plan is up in the drive. Shout if a slot clashes.' },
            { author: 'timo', text: 'Power run looks fine. One generator quote still open.' },
            { author: 'daan', text: 'Wristbands ordered. Three tiers, camping included.' },
            { author: 'timo', text: 'Heads up: the Sunday forecast for the field is turning windy.' },
            { author: 'saar', text: 'How bad? The second stage is the exposed one.' },
            { author: 'timo', text: 'Gusts into the evening. No shelter out there right now.' },
            { author: 'sanne', text: 'We could move the quieter acts to the barn stage on Sunday.' },
            { author: 'anouk', text: "Let's keep the option open and decide at the go/no-go. Get a wind-cover quote." },
            { author: 'saar', text: 'On it. Will have numbers before the meeting.' },
            { author: 'ravi', text: 'Site crew can re-peg the second stage either way. Ready for both.' },
        ],
    },
    {
        name: 'volunteers',
        messages: [
            { author: 'nour', text: "We're about 10 short for the build weekend. Pushing the call-out today." },
            { author: 'maud', text: 'I can bring two friends for load-in Friday.' },
            { author: 'nour', text: 'Nice, added you three to the roster.' },
            { author: 'yara', text: 'Camping host desk needs one more for the night shift.' },
            { author: 'imke', text: 'First aid is covered for both days, one gap Sunday morning.' },
            { author: 'nour', text: "I'll flag the Sunday morning gap in the call-out." },
            { author: 'lars', text: 'Waste team is set. Extra bins arrive with the fencing.' },
            { author: 'pieter', text: 'Box office wants two runners at peak. Any takers?' },
            { author: 'maud', text: 'Put me down as a runner for Saturday peak.' },
            { author: 'nour', text: 'Thanks all. Roster is looking a lot healthier.' },
            { author: 'maud', text: '/cheer' },
        ],
    },
];

// --- Mail (raw RFC822 delivered into persona inboxes; dates spread over the past ~10 days) ---

export type SeededMail = {
    // 'inbox-thread' lands in one persona's inbox; 'all-hands' lands in every persona's inbox.
    kind: 'inbox-thread' | 'all-hands';
    to?: LeadRole | string; // required for inbox-thread; role or persona key (mirrors EVENTS.attendees)
    from?: LeadRole; // sender lead for all-hands
    subject: string;
    messages: {
        fromExternal?: { name: string; email: string }; // else `from` is the persona key
        from?: string; // persona key
        daysAgo: number;
        hour: number;
        text: string;
    }[];
};

export const MAILS: SeededMail[] = [
    {
        kind: 'inbox-thread',
        to: 'programming',
        subject: 'Tuimel Festival booking',
        messages: [
            {
                fromExternal: { name: 'Wolf Nachtlicht', email: 'wolf@nachtlicht-bookings.example' },
                daysAgo: 9,
                hour: 10,
                text: 'Hi Joris,\n\nThanks for the invite. The band would love to play Tuimel. Saturday works best for us. Could you confirm the fee and the stage times?\n\nBest,\nWolf',
            },
            {
                from: 'joris',
                daysAgo: 8,
                hour: 16,
                text: 'Hi Wolf,\n\nSaturday works for us too, glad that is settled. Fee as discussed, half on signing. Stage times land next week once the grid is locked. Sending the contract shortly.\n\nJoris',
            },
            {
                fromExternal: { name: 'Wolf Nachtlicht', email: 'wolf@nachtlicht-bookings.example' },
                daysAgo: 7,
                hour: 9,
                text: 'Sounds good, thanks Joris. We will watch for the contract. One question: is there a backline on the second stage or do we bring our own?\n\nWolf',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'director',
        subject: 'Are you doing it again this year',
        messages: [
            {
                fromExternal: { name: 'Tom Rovers', email: 'tom.rovers@example.com' },
                daysAgo: 8,
                hour: 21,
                text: 'Hi Anouk,\n\nSaw the posters going up near the station. Are you all doing Tuimel again this year? Would love to come back, it was the best weekend of last summer.\n\nTom',
            },
            {
                from: 'anouk',
                daysAgo: 8,
                hour: 22,
                text: 'Hi Tom,\n\nWe are, three weeks out now. Tickets are up on the site, hope to see you on the field again.\n\nAnouk',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'production',
        subject: 'Generator quote',
        messages: [
            {
                fromExternal: { name: 'Rob Tempel', email: 'rob@vlierkracht-verhuur.example' },
                daysAgo: 6,
                hour: 11,
                text: 'Hi Saar,\n\nQuote attached for two 60kVA units plus a backup. We can deliver Thursday morning, pickup Monday. Let me know if the dates work.\n\nRob\nVlierkracht Verhuur',
            },
            {
                from: 'saar',
                daysAgo: 6,
                hour: 15,
                text: 'Hi Rob,\n\nThursday works. Can the backup run the second stage on its own if the main unit trips? Timo will want to know before we sign off.\n\nSaar',
            },
            {
                fromExternal: { name: 'Rob Tempel', email: 'rob@vlierkracht-verhuur.example' },
                daysAgo: 5,
                hour: 9,
                text: 'Yes, the backup is rated for a full stage on its own. Sending the contract now.\n\nRob',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'comms',
        subject: 'Line-up reveal',
        messages: [
            {
                fromExternal: { name: 'Sanne Post', email: 'sanne@kustkrant.example' },
                daysAgo: 4,
                hour: 13,
                text: 'Hi Mees,\n\nWe would love to run something on the line-up reveal for the weekend edition. Deadline is Wednesday, any chance you can send a draft before then?\n\nSanne\nKustkrant',
            },
            {
                from: 'mees',
                daysAgo: 3,
                hour: 10,
                text: 'Hi Sanne,\n\nWe are two acts away from the full line-up, should land by Friday. I will send you the draft as soon as it is locked, before Wednesday if I can.\n\nMees',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'volunteers',
        subject: 'Volunteering this weekend',
        messages: [
            {
                fromExternal: { name: 'Femke Aarts', email: 'femke.aarts@example.com' },
                daysAgo: 3,
                hour: 19,
                text: 'Hi,\n\nSaw the call-out from a friend. I am free the whole build weekend and Saturday of the festival. Happy to help wherever needed.\n\nFemke',
            },
            {
                from: 'nour',
                daysAgo: 3,
                hour: 20,
                text: 'Hi Femke,\n\nThat is a big help, thank you. Put you down for build weekend and Saturday gate duty, I will send the schedule closer to the time.\n\nNour',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'finance',
        subject: 'Grant paperwork',
        messages: [
            {
                fromExternal: { name: 'Marijke Veen', email: 'marijke@cultuurfonds-kust.example' },
                daysAgo: 5,
                hour: 10,
                text: 'Hi Bram,\n\nAhead of our call, could you send the updated budget and the visitor estimate? We need both for the committee.\n\nMarijke\nCultuurfonds Kust',
            },
            {
                from: 'bram',
                daysAgo: 4,
                hour: 16,
                text: 'Hi Marijke,\n\nBudget is attached. Estimating around two thousand visitors across the weekend, similar to last edition. See you at the call.\n\nBram',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'tech',
        subject: 'Backline second stage',
        messages: [
            {
                fromExternal: { name: 'Jasper Cools', email: 'jasper@geluidsploeg.example' },
                daysAgo: 4,
                hour: 9,
                text: 'Hi Timo,\n\nCan confirm a backline for the second stage: drums, two guitar amps, a bass rig. Same crew that did the barn last year.\n\nJasper\nGeluidsploeg',
            },
            {
                from: 'timo',
                daysAgo: 4,
                hour: 14,
                text: 'Hi Jasper,\n\nGood timing, one of the headliners just asked about exactly that. I will pass the specs along. Can you be on-site Friday for load-in?\n\nTimo',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'liaison',
        subject: 'Quiet room for Wolf',
        messages: [
            {
                fromExternal: { name: 'Nadia Roos', email: 'nadia@wolfpack-management.example' },
                daysAgo: 3,
                hour: 12,
                text: 'Hi Lieke,\n\nWolf needs a quiet room before the set, ideally somewhere out of the wind. Vegetarian catering is fine, nothing fancy.\n\nNadia\nWolfpack Management',
            },
            {
                from: 'lieke',
                daysAgo: 3,
                hour: 17,
                text: 'Hi Nadia,\n\nWe have a small back room behind the stage that should do. Catering is sorted. See you at load-in.\n\nLieke',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'fenna',
        subject: 'Bar delivery',
        messages: [
            {
                fromExternal: { name: 'Bo Reijn', email: 'bo@brouwerij-vlier.example' },
                daysAgo: 5,
                hour: 14,
                text: 'Hi Fenna,\n\nDelivery is set for Friday afternoon: the usual kegs plus the extra crate of soft drinks you asked for. Let me know if the gate needs a heads-up.\n\nBo\nBrouwerij Vlier',
            },
            {
                from: 'fenna',
                daysAgo: 5,
                hour: 16,
                text: 'Hi Bo,\n\nFriday works, I will let the gate know a van is coming in. Thanks for sorting the extra crate.\n\nFenna',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'daan',
        subject: 'Wristband print run',
        messages: [
            {
                fromExternal: { name: 'Print shop', email: 'orders@drukkerij-vlierzand.example' },
                daysAgo: 4,
                hour: 10,
                text: 'Hi Daan,\n\nDesign received, three tiers as discussed. Print run will be ready for pickup Wednesday.\n\nDrukkerij Vlierzand',
            },
            {
                from: 'daan',
                daysAgo: 4,
                hour: 11,
                text: 'Thanks, I will swing by Wednesday afternoon. Can you double-check the camping tier is the blue one? Last year it printed green.\n\nDaan',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'ravi',
        subject: 'Fencing delivery',
        messages: [
            {
                fromExternal: { name: 'Hein Klarenbeek', email: 'hein@hekwerkverhuur.example' },
                daysAgo: 6,
                hour: 8,
                text: 'Hi Ravi,\n\nFencing is loaded and coming Thursday, same as last year. Where do you want the pallets dropped this time?\n\nHein\nHekwerkverhuur Vlierzand',
            },
            {
                from: 'ravi',
                daysAgo: 6,
                hour: 13,
                text: 'Hi Hein,\n\nDrop them by the north track this year, closer to where we are building. Saar can meet you there.\n\nRavi',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'imke',
        subject: 'Sunday morning shift',
        messages: [
            {
                fromExternal: { name: 'Willem de Boer', email: 'willem.deboer@example.com' },
                daysAgo: 2,
                hour: 20,
                text: 'Hi Imke,\n\nHeard first aid still needs someone Sunday morning. I did the course last year, happy to cover it if you still need someone.\n\nWillem',
            },
            {
                from: 'imke',
                daysAgo: 2,
                hour: 21,
                text: 'Hi Willem,\n\nThat would fill the last gap, thank you. Sunday 8 to 12, I will send the kit list closer to the time.\n\nImke',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'yara',
        subject: 'Camping field toilets',
        messages: [
            {
                fromExternal: { name: 'Sanitair Kust', email: 'planning@sanitairkust.example' },
                daysAgo: 5,
                hour: 9,
                text: 'Hi Yara,\n\nConfirming four units for the camping field, placed Friday morning, serviced once during the weekend.\n\nSanitair Kust',
            },
            {
                from: 'yara',
                daysAgo: 5,
                hour: 12,
                text: 'Hi,\n\nFriday morning works, before campers start arriving at midday. Can the service happen early Sunday, before it gets busy?\n\nYara',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'pieter',
        subject: 'Box office scanners',
        messages: [
            {
                fromExternal: { name: 'Ticketing support', email: 'support@ticketflow.example' },
                daysAgo: 3,
                hour: 15,
                text: 'Hi Pieter,\n\nYour two scanners are shipped, tracking attached. They come pre-loaded with the guest list, just charge them the night before.\n\nTicketFlow Support',
            },
            {
                from: 'pieter',
                daysAgo: 3,
                hour: 18,
                text: 'Thanks, will do. Does the offline mode still work if the field has no signal? Last year we lost it for an hour.\n\nPieter',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'sem',
        subject: 'Installation on the dune path',
        messages: [
            {
                fromExternal: { name: 'Iris Bergman', email: 'iris.bergman@example.com' },
                daysAgo: 4,
                hour: 16,
                text: 'Hi Sem,\n\nI can bring the driftwood piece we talked about, it just needs a spot that will not flood if it rains. The dune path near the entrance still open?\n\nIris',
            },
            {
                from: 'sem',
                daysAgo: 4,
                hour: 19,
                text: 'Hi Iris,\n\nYes, that spot is still free and it sits high enough. Bring it Friday and we will find the exact angle together.\n\nSem',
            },
        ],
    },
    {
        kind: 'all-hands',
        from: 'director',
        subject: 'Three weeks out',
        messages: [
            {
                from: 'director',
                daysAgo: 2,
                hour: 8,
                text: "Hi everyone,\n\nThree weeks to go. Line-up is about 80% confirmed, tickets are moving, and the build weekend is getting close. Two things on my mind: we are still short on volunteers, so if you can bring one person along, tell Nour. And the Sunday forecast for the field looks iffy, we will decide on wind cover at the go/no-go.\n\nProud of this crew. Let's make it a good one.\n\nAnouk",
            },
        ],
    },
    {
        kind: 'all-hands',
        from: 'volunteers',
        subject: 'Volunteers needed for build weekend',
        messages: [
            {
                from: 'volunteers',
                daysAgo: 1,
                hour: 11,
                text: 'Hi all,\n\nWe still need about 10 hands for the build weekend, plus one for the Sunday morning first-aid slot. If you know someone reliable, send them my way. Meals and a weekend ticket included.\n\nThank you!\nNour',
            },
        ],
    },
];

// --- Calendar (team calendar; future-dated relative to seed time; cross-persona attendees) ---

export type SeededEvent = {
    title: string;
    inDays: number;
    startHour: number;
    durationHours: number;
    allDay?: boolean;
    rrule?: string;
    location?: string;
    description?: string;
    organizer: LeadRole;
    attendees: (LeadRole | string)[]; // role or persona key
};

export const EVENTS: SeededEvent[] = [
    {
        title: 'Weekly production meeting',
        inDays: 2,
        startHour: 17,
        durationHours: 1,
        rrule: 'FREQ=WEEKLY;COUNT=4',
        location: 'Crew cabin',
        description: 'Standing check-in for all leads.',
        organizer: 'production',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Site visit',
        inDays: 5,
        startHour: 10,
        durationHours: 3,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Walk the field, mark stages and camping.',
        organizer: 'production',
        attendees: ['production', 'tech', 'director'],
    },
    {
        title: 'Culture fund call',
        inDays: 6,
        startHour: 14,
        durationHours: 1,
        description: 'Grant check-in with the culture fund.',
        organizer: 'finance',
        attendees: ['finance', 'director'],
    },
    {
        title: 'Build day',
        inDays: 18,
        startHour: 8,
        durationHours: 10,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Fencing, stages, power.',
        organizer: 'production',
        attendees: ['production', 'tech', 'volunteers'],
    },
    {
        title: 'Tuimel Festival weekend',
        inDays: 21,
        startHour: 0,
        durationHours: 0,
        allDay: true,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Doors Saturday and Sunday midday.',
        organizer: 'director',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Go / no-go meeting',
        inDays: 20,
        startHour: 18,
        durationHours: 1,
        location: 'Crew cabin',
        description: 'Final call, including Sunday wind cover.',
        organizer: 'director',
        attendees: ['director', 'production', 'tech', 'programming', 'finance'],
    },
];

// --- Contacts (external ecosystem, added to a few leads' address books) ---

export type SeededContact = {
    owner: LeadRole;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    company?: string;
    jobTitle?: string;
    notes?: string;
};

export const CONTACTS: SeededContact[] = [
    {
        owner: 'programming',
        firstName: 'Wolf',
        lastName: 'Nachtlicht',
        email: 'wolf@nachtlicht-bookings.example',
        company: 'Nachtlicht Bookings',
        jobTitle: 'Booker',
        notes: 'Books the Saturday headliner.',
    },
    {
        owner: 'production',
        firstName: 'Griet',
        lastName: 'Tuimelaar',
        email: 'griet@hoeve-tuimelaar.example',
        phone: '+31 6 1234 5678',
        company: 'Hoeve Tuimelaar',
        jobTitle: 'Farmer',
        notes: 'Owns the field. Gate code by text.',
    },
    {
        owner: 'production',
        firstName: 'Kees',
        lastName: 'Duin',
        email: 'kees@duinshuttle.example',
        company: 'Duin Shuttle',
        jobTitle: 'Operations',
        notes: 'Shuttle buses, 30-minute loop.',
    },
    {
        owner: 'finance',
        firstName: 'Marijke',
        lastName: 'Veen',
        email: 'marijke@cultuurfonds-kust.example',
        company: 'Cultuurfonds Kust',
        jobTitle: 'Grants contact',
        notes: 'Our culture-fund contact.',
    },
    {
        owner: 'comms',
        firstName: 'Bo',
        lastName: 'Reijn',
        email: 'bo@brouwerij-vlier.example',
        company: 'Brouwerij Vlier',
        jobTitle: 'Sales',
        notes: 'Regional brewery, bar supply.',
    },
    {
        owner: 'comms',
        firstName: 'Sanne',
        lastName: 'Post',
        email: 'sanne@kustkrant.example',
        company: 'Kustkrant',
        jobTitle: 'Culture desk',
        notes: 'Local press, wants the line-up reveal.',
    },
];

// --- Personal-drive files shared person-to-person (shared-with-me variety) ---

export type SeededShare = {
    owner: LeadRole;
    name: string; // lowercase filename
    body: string;
    shareWith: LeadRole;
};

export const PERSONAL_SHARES: SeededShare[] = [
    {
        owner: 'production',
        name: 'site access notes.txt',
        body: 'Gate code by text from Griet. Deliveries via the north track. Water point is behind the barn.',
        shareWith: 'tech',
    },
    {
        owner: 'liaison',
        name: 'artist riders.txt',
        body: 'Riders are modest this year. Two acts vegetarian catering, one needs a quiet room before the set.',
        shareWith: 'programming',
    },
];

export function personaByRole(role: LeadRole): Persona {
    const persona = PERSONAS.find((p) => p.role === role);
    if (!persona) throw new Error(`No persona for role ${role}`);
    return persona;
}

export function personaByKey(key: string): Persona {
    const persona = PERSONAS.find((p) => p.key === key);
    if (!persona) throw new Error(`No persona for key ${key}`);
    return persona;
}
