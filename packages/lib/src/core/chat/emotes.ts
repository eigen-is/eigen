type EmoteCommandDef = {
    key: string;
    aliases?: string[];
    desc: string;
    canTarget?: boolean;
    requiresTarget?: boolean;
}

export const EMOTE_COMMANDS: EmoteCommandDef[] = [
    {key: 'afk', desc: 'Away from keyboard'},
    {key: 'agree', desc: 'Agree', canTarget: true},
    {key: 'allthethings', desc: 'ALL THE THINGS! \\o/'},
    {key: 'angry', aliases: ['mad'], desc: 'Raise your fist in anger', canTarget: true},
    {key: 'apologize', aliases: ['sorry'], desc: 'Apologize. Sorry!', canTarget: true},
    {key: 'applaud', desc: 'Applaud. Bravo!', canTarget: true},
    {key: 'blush', desc: 'Blush', canTarget: true},
    {key: 'boggle', desc: 'Boggle at the situation', canTarget: true},
    {key: 'bonk', desc: 'Bonk on the noggin. Doh!', canTarget: true},
    {key: 'bounce', desc: 'Bounce up and down', canTarget: true},
    {key: 'bow', desc: 'Bow graciously', canTarget: true},
    {key: 'brb', desc: 'Be right back', canTarget: true},
    {key: 'burp', aliases: ['belch'], desc: 'Loud belch', canTarget: true},
    {key: 'bye', aliases: ['farewell'], desc: 'Wave goodbye', canTarget: true},
    {key: 'cackle', desc: 'Cackle with insane glee', canTarget: true},
    {key: 'cheer', desc: 'Cheer', canTarget: true},
    {key: 'chicken', desc: 'Cluck, Cluck, Chicken!', canTarget: true},
    {key: 'chuckle', desc: 'Hearty chuckle', canTarget: true},
    {key: 'comfort', desc: 'Comfort', canTarget: true},
    {key: 'confused', desc: 'Hopelessly confused', canTarget: true},
    {key: 'crack', desc: 'Crack your knuckles', canTarget: true},
    {key: 'cringe', desc: 'Cringe in fear', canTarget: true},
    {key: 'cry', aliases: ['sob'], desc: 'Cry', canTarget: true},
    {key: 'curtsey', desc: 'Curtsey', canTarget: true},
    {key: 'dance', desc: 'Burst into dance', canTarget: true},
    {key: 'disagree', desc: 'Disagree', canTarget: true},
    {key: 'facepalm', desc: 'Cover face with palm', canTarget: true},
    {key: 'fart', desc: 'Fart loudly', canTarget: true},
    {key: 'fidget', desc: 'Fidget impatiently', canTarget: true},
    {key: 'flex', desc: 'Flex your muscles', canTarget: true},
    {key: 'flip', desc: '(\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B'},
    {key: 'frown', desc: 'Frown', canTarget: true},
    {key: 'gasp', desc: 'Gasp', canTarget: true},
    {key: 'giggle', desc: 'Giggle', canTarget: true},
    {key: 'glare', desc: 'Glare angrily', canTarget: true},
    {key: 'gloat', desc: 'Gloat over misfortune', canTarget: true},
    {key: 'golfclap', desc: 'Clap, clearly unimpressed', canTarget: true},
    {key: 'greet', desc: 'Greet everyone warmly', canTarget: true},
    {key: 'grin', desc: 'Grin wickedly', canTarget: true},
    {key: 'groan', desc: 'Groan', canTarget: true},
    {key: 'grovel', desc: 'Grovel in subservience', canTarget: true},
    {key: 'guffaw', desc: 'Boisterous guffaw', canTarget: true},
    {key: 'happy', desc: 'Filled with happiness', canTarget: true},
    {key: 'hello', aliases: ['hi'], desc: 'Hearty hello', canTarget: true},
    {key: 'highfive', desc: 'High five', canTarget: true},
    {key: 'hug', desc: 'Hug', canTarget: true},
    {key: 'idea', desc: 'You have an idea!'},
    {key: 'impressed', desc: 'Clap vigorously, clearly impressed', canTarget: true},
    {key: 'insult', desc: 'Son of a motherless ogre', canTarget: true},
    {key: 'introduce', desc: 'Introduce yourself', canTarget: true},
    {key: 'laugh', aliases: ['lol'], desc: 'Laugh', canTarget: true},
    {key: 'mock', desc: 'Mock life and all it stands for', canTarget: true},
    {key: 'moo', desc: 'Mooooooooooo', canTarget: true},
    {key: 'moon', desc: 'Moon everyone', canTarget: true},
    {key: 'mutter', desc: 'Mutter angrily', canTarget: true},
    {key: 'no', desc: 'Clearly state NO', canTarget: true},
    {key: 'nod', aliases: ['yes'], desc: 'Nod', canTarget: true},
    {key: 'nosepick', desc: 'Pick your nose', canTarget: true},
    {key: 'pat', desc: 'Gently pat', canTarget: true},
    {key: 'poke', desc: 'Poke in the ribs', canTarget: true},
    {key: 'ponder', desc: 'Ponder the situation', canTarget: true},
    {key: 'pout', desc: 'Pout', canTarget: true},
    {key: 'quack', desc: 'Quack!', canTarget: true},
    {key: 'ready', desc: 'Ready!', canTarget: true},
    {key: 'rofl', desc: 'Roll on the floor laughing', canTarget: true},
    {key: 'rolleyes', desc: 'Roll your eyes', canTarget: true},
    {key: 'sad', desc: 'Hang your head dejectedly'},
    {key: 'salute', desc: 'Stand at attention and salute', canTarget: true},
    {key: 'scoff', desc: 'Scoff', canTarget: true},
    {key: 'sexy', desc: 'Too sexy for your tunic', canTarget: true},
    {key: 'shrug', desc: '\u00AF\\_(\u30C4)_/\u00AF', canTarget: true},
    {key: 'sigh', desc: 'Long, drawn-out sigh', canTarget: true},
    {key: 'sing', desc: 'SEEK SHELTER AT ONCE!', canTarget: true},
    {key: 'smile', desc: 'Smile', canTarget: true},
    {key: 'smirk', desc: 'Sly smirk', canTarget: true},
    {key: 'snap', desc: 'Snap your fingers', canTarget: true},
    {key: 'snub', desc: 'Snub the lowly peons', canTarget: true},
    {key: 'stretch', desc: 'Stretch your arms out', canTarget: true},
    {key: 'surrender', desc: 'Surrender', canTarget: true},
    {key: 'taunt', desc: 'Taunt. Bring it fools!', canTarget: true},
    {key: 'thank', desc: 'Thank everyone', canTarget: true},
    {key: 'think', desc: 'Lost in thought', canTarget: true},
    {key: 'threaten', aliases: ['doom'], desc: 'Threaten with the wrath of doom', canTarget: true},
    {key: 'trout', desc: 'Slap with a large trout', requiresTarget: true},
    {key: 'victory', desc: 'Bask in the glory of victory', canTarget: true},
    {key: 'violin', desc: "World's smallest violin", canTarget: true},
    {key: 'wave', desc: 'Wave', canTarget: true},
    {key: 'welcome', desc: 'Welcome everyone', canTarget: true},
    {key: 'whine', desc: 'Whine pathetically', canTarget: true},
    {key: 'whistle', desc: 'Sharp whistle', canTarget: true},
    {key: 'wince', desc: 'Wince sympathetically', canTarget: true},
    {key: 'wink', desc: 'Wink suggestively', canTarget: true},
    {key: 'yawn', desc: 'Yawn sleepily', canTarget: true},
    {key: 'yw', desc: 'Happy to help', canTarget: true},
];

// Build lookup maps
const emoteKeySet = new Set<string>();
const aliasToKey = new Map<string, string>();
for (const cmd of EMOTE_COMMANDS) {
    emoteKeySet.add(cmd.key);
    for (const alias of cmd.aliases ?? []) {
        aliasToKey.set(alias, cmd.key);
    }
}

export function resolveEmoteKey(command: string): string | null {
    if (emoteKeySet.has(command)) return command;
    return aliasToKey.get(command) ?? null;
}

export function getEmoteCommand(key: string) {
    return EMOTE_COMMANDS.find(c => c.key === key);
}

export function isEmoteCommand(command: string): boolean {
    return resolveEmoteKey(command) !== null;
}
