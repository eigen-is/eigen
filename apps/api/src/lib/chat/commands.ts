import {resolveEmoteKey} from '@workspace/lib/core/chat/emotes';
import {validateCommand} from '@workspace/lib/validation';

type EmoteDefinition = {
    firstPerson?: string;
    thirdPerson?: string;
    targetedFirstPerson?: string;
    targetedSecondPerson?: string;
    targetedThirdPerson?: string;
}

const BUILT_IN_EMOTES: Record<string, EmoteDefinition> = {
    // ── Greetings & Social ──────────────────────────────────────────────
    greet: {
        firstPerson: "You greet everyone warmly.",
        thirdPerson: "{name} greets everyone warmly.",
        targetedFirstPerson: "You greet {target} warmly.",
        targetedSecondPerson: "{name} greets you warmly.",
        targetedThirdPerson: "{name} greets {target} warmly.",
    },
    hello: {
        firstPerson: "You greet everyone with a hearty hello!",
        thirdPerson: "{name} greets everyone with a hearty hello!",
        targetedFirstPerson: "You greet {target} with a hearty hello!",
        targetedSecondPerson: "{name} greets you with a hearty hello!",
        targetedThirdPerson: "{name} greets {target} with a hearty hello!",
    },
    bye: {
        firstPerson: "You wave goodbye to everyone. Farewell!",
        thirdPerson: "{name} waves goodbye to everyone. Farewell!",
        targetedFirstPerson: "You wave goodbye to {target}. Farewell!",
        targetedSecondPerson: "{name} waves goodbye to you. Farewell!",
        targetedThirdPerson: "{name} waves goodbye to {target}. Farewell!",
    },
    wave: {
        firstPerson: "You wave.",
        thirdPerson: "{name} waves.",
        targetedFirstPerson: "You wave at {target}.",
        targetedSecondPerson: "{name} waves at you.",
        targetedThirdPerson: "{name} waves at {target}.",
    },
    bow: {
        firstPerson: "You bow down graciously.",
        thirdPerson: "{name} bows down graciously.",
        targetedFirstPerson: "You bow before {target}.",
        targetedSecondPerson: "{name} bows before you.",
        targetedThirdPerson: "{name} bows before {target}.",
    },
    curtsey: {
        firstPerson: "You curtsey.",
        thirdPerson: "{name} curtseys.",
        targetedFirstPerson: "You curtsey before {target}.",
        targetedSecondPerson: "{name} curtseys before you.",
        targetedThirdPerson: "{name} curtseys before {target}.",
    },
    salute: {
        firstPerson: "You stand at attention and salute.",
        thirdPerson: "{name} stands at attention and salutes.",
        targetedFirstPerson: "You salute {target} with respect.",
        targetedSecondPerson: "{name} salutes you with respect.",
        targetedThirdPerson: "{name} salutes {target} with respect.",
    },
    welcome: {
        firstPerson: "You welcome everyone.",
        thirdPerson: "{name} welcomes everyone.",
        targetedFirstPerson: "You welcome {target}.",
        targetedSecondPerson: "{name} welcomes you.",
        targetedThirdPerson: "{name} welcomes {target}.",
    },
    introduce: {
        firstPerson: "You introduce yourself to everyone.",
        thirdPerson: "{name} introduces themselves to everyone.",
        targetedFirstPerson: "You introduce yourself to {target}.",
        targetedSecondPerson: "{name} introduces themselves to you.",
        targetedThirdPerson: "{name} introduces themselves to {target}.",
    },
    hug: {
        firstPerson: "You need a hug!",
        thirdPerson: "{name} needs a hug!",
        targetedFirstPerson: "You hug {target}.",
        targetedSecondPerson: "{name} hugs you.",
        targetedThirdPerson: "{name} hugs {target}.",
    },
    highfive: {
        firstPerson: "You put up your hand for a high five.",
        thirdPerson: "{name} puts up a hand for a high five.",
        targetedFirstPerson: "You give {target} a high five!",
        targetedSecondPerson: "{name} gives you a high five!",
        targetedThirdPerson: "{name} gives {target} a high five!",
    },

    // ── Positive Emotions ───────────────────────────────────────────────
    cheer: {
        firstPerson: "You cheer!",
        thirdPerson: "{name} cheers!",
        targetedFirstPerson: "You cheer at {target}.",
        targetedSecondPerson: "{name} cheers at you.",
        targetedThirdPerson: "{name} cheers at {target}.",
    },
    smile: {
        firstPerson: "You smile.",
        thirdPerson: "{name} smiles.",
        targetedFirstPerson: "You smile at {target}.",
        targetedSecondPerson: "{name} smiles at you.",
        targetedThirdPerson: "{name} smiles at {target}.",
    },
    grin: {
        firstPerson: "You grin wickedly.",
        thirdPerson: "{name} grins wickedly.",
        targetedFirstPerson: "You grin wickedly at {target}.",
        targetedSecondPerson: "{name} grins wickedly at you.",
        targetedThirdPerson: "{name} grins wickedly at {target}.",
    },
    laugh: {
        firstPerson: "You laugh.",
        thirdPerson: "{name} laughs.",
        targetedFirstPerson: "You laugh at {target}.",
        targetedSecondPerson: "{name} laughs at you.",
        targetedThirdPerson: "{name} laughs at {target}.",
    },
    giggle: {
        firstPerson: "You giggle.",
        thirdPerson: "{name} giggles.",
        targetedFirstPerson: "You giggle at {target}.",
        targetedSecondPerson: "{name} giggles at you.",
        targetedThirdPerson: "{name} giggles at {target}.",
    },
    chuckle: {
        firstPerson: "You let out a hearty chuckle.",
        thirdPerson: "{name} lets out a hearty chuckle.",
        targetedFirstPerson: "You chuckle at {target}.",
        targetedSecondPerson: "{name} chuckles at you.",
        targetedThirdPerson: "{name} chuckles at {target}.",
    },
    guffaw: {
        firstPerson: "You let out a boisterous guffaw!",
        thirdPerson: "{name} lets out a boisterous guffaw!",
        targetedFirstPerson: "You take one look at {target} and let out a guffaw!",
        targetedSecondPerson: "{name} takes one look at you and lets out a guffaw!",
        targetedThirdPerson: "{name} takes one look at {target} and lets out a guffaw!",
    },
    rofl: {
        firstPerson: "You roll on the floor laughing.",
        thirdPerson: "{name} rolls on the floor laughing.",
        targetedFirstPerson: "You roll on the floor laughing at {target}.",
        targetedSecondPerson: "{name} rolls on the floor laughing at you.",
        targetedThirdPerson: "{name} rolls on the floor laughing at {target}.",
    },
    happy: {
        firstPerson: "You are filled with happiness!",
        thirdPerson: "{name} is filled with happiness!",
        targetedFirstPerson: "You are very happy with {target}!",
        targetedSecondPerson: "{name} is very happy with you!",
        targetedThirdPerson: "{name} is very happy with {target}!",
    },
    thank: {
        firstPerson: "You thank everyone around you.",
        thirdPerson: "{name} thanks everyone.",
        targetedFirstPerson: "You thank {target}.",
        targetedSecondPerson: "{name} thanks you.",
        targetedThirdPerson: "{name} thanks {target}.",
    },
    yw: {
        firstPerson: "You were happy to help.",
        thirdPerson: "{name} was happy to help.",
        targetedFirstPerson: "You were happy to help {target}.",
        targetedSecondPerson: "{name} was happy to help you.",
        targetedThirdPerson: "{name} was happy to help {target}.",
    },

    // ── Negative Emotions ───────────────────────────────────────────────
    cry: {
        firstPerson: "You cry.",
        thirdPerson: "{name} cries.",
        targetedFirstPerson: "You cry on {target}'s shoulder.",
        targetedSecondPerson: "{name} cries on your shoulder.",
        targetedThirdPerson: "{name} cries on {target}'s shoulder.",
    },
    sigh: {
        firstPerson: "You let out a long, drawn-out sigh.",
        thirdPerson: "{name} lets out a long, drawn-out sigh.",
        targetedFirstPerson: "You sigh at {target}.",
        targetedSecondPerson: "{name} sighs at you.",
        targetedThirdPerson: "{name} sighs at {target}.",
    },
    frown: {
        firstPerson: "You frown.",
        thirdPerson: "{name} frowns.",
        targetedFirstPerson: "You frown with disappointment at {target}.",
        targetedSecondPerson: "{name} frowns with disappointment at you.",
        targetedThirdPerson: "{name} frowns with disappointment at {target}.",
    },
    groan: {
        firstPerson: "You begin to groan.",
        thirdPerson: "{name} begins to groan.",
        targetedFirstPerson: "You look at {target} and groan.",
        targetedSecondPerson: "{name} looks at you and groans.",
        targetedThirdPerson: "{name} looks at {target} and groans.",
    },
    whine: {
        firstPerson: "You whine pathetically.",
        thirdPerson: "{name} whines pathetically.",
        targetedFirstPerson: "You whine pathetically at {target}.",
        targetedSecondPerson: "{name} whines pathetically at you.",
        targetedThirdPerson: "{name} whines pathetically at {target}.",
    },
    mutter: {
        firstPerson: "You mutter angrily to yourself. Hmmmph!",
        thirdPerson: "{name} mutters angrily. Hmmmph!",
        targetedFirstPerson: "You mutter angrily at {target}. Hmmmph!",
        targetedSecondPerson: "{name} mutters angrily at you. Hmmmph!",
        targetedThirdPerson: "{name} mutters angrily at {target}. Hmmmph!",
    },
    sad: {
        firstPerson: "You hang your head dejectedly.",
        thirdPerson: "{name} hangs their head dejectedly.",
    },
    angry: {
        firstPerson: "You raise your fist in anger.",
        thirdPerson: "{name} raises a fist in anger.",
        targetedFirstPerson: "You raise your fist in anger at {target}.",
        targetedSecondPerson: "{name} raises a fist in anger at you.",
        targetedThirdPerson: "{name} raises a fist in anger at {target}.",
    },
    pout: {
        firstPerson: "You pout at everyone around you.",
        thirdPerson: "{name} pouts.",
        targetedFirstPerson: "You pout at {target}.",
        targetedSecondPerson: "{name} pouts at you.",
        targetedThirdPerson: "{name} pouts at {target}.",
    },
    cringe: {
        firstPerson: "You cringe in fear.",
        thirdPerson: "{name} cringes in fear.",
        targetedFirstPerson: "You cringe away from {target}.",
        targetedSecondPerson: "{name} cringes away from you.",
        targetedThirdPerson: "{name} cringes away from {target}.",
    },

    // ── Reactions & Responses ───────────────────────────────────────────
    nod: {
        firstPerson: "You nod.",
        thirdPerson: "{name} nods.",
        targetedFirstPerson: "You nod at {target}.",
        targetedSecondPerson: "{name} nods at you.",
        targetedThirdPerson: "{name} nods at {target}.",
    },
    no: {
        firstPerson: "You clearly state, NO.",
        thirdPerson: "{name} clearly states, NO.",
        targetedFirstPerson: "You tell {target} NO. Not going to happen.",
        targetedSecondPerson: "{name} tells you NO. Not going to happen.",
        targetedThirdPerson: "{name} tells {target} NO. Not going to happen.",
    },
    agree: {
        firstPerson: "You agree.",
        thirdPerson: "{name} agrees.",
        targetedFirstPerson: "You agree with {target}.",
        targetedSecondPerson: "{name} agrees with you.",
        targetedThirdPerson: "{name} agrees with {target}.",
    },
    disagree: {
        firstPerson: "You disagree.",
        thirdPerson: "{name} disagrees.",
        targetedFirstPerson: "You disagree with {target}.",
        targetedSecondPerson: "{name} disagrees with you.",
        targetedThirdPerson: "{name} disagrees with {target}.",
    },
    shrug: {
        firstPerson: "You shrug. \u00AF\\_(\u30C4)_/\u00AF",
        thirdPerson: "{name} shrugs. \u00AF\\_(\u30C4)_/\u00AF",
        targetedFirstPerson: "You shrug at {target}. Who knows?",
        targetedSecondPerson: "{name} shrugs at you. Who knows?",
        targetedThirdPerson: "{name} shrugs at {target}. Who knows?",
    },
    facepalm: {
        firstPerson: "You cover your face with your palm.",
        thirdPerson: "{name} covers their face with their palm.",
        targetedFirstPerson: "You look at {target} and cover your face with your palm.",
        targetedSecondPerson: "{name} looks at you and covers their face with their palm.",
        targetedThirdPerson: "{name} looks at {target} and covers their face with their palm.",
    },
    rolleyes: {
        firstPerson: "You roll your eyes.",
        thirdPerson: "{name} rolls their eyes.",
        targetedFirstPerson: "You roll your eyes at {target}.",
        targetedSecondPerson: "{name} rolls their eyes at you.",
        targetedThirdPerson: "{name} rolls their eyes at {target}.",
    },
    gasp: {
        firstPerson: "You gasp.",
        thirdPerson: "{name} gasps.",
        targetedFirstPerson: "You gasp at {target}.",
        targetedSecondPerson: "{name} gasps at you.",
        targetedThirdPerson: "{name} gasps at {target}.",
    },
    boggle: {
        firstPerson: "You boggle at the situation.",
        thirdPerson: "{name} boggles at the situation.",
        targetedFirstPerson: "You boggle at {target}.",
        targetedSecondPerson: "{name} boggles at you.",
        targetedThirdPerson: "{name} boggles at {target}.",
    },
    applaud: {
        firstPerson: "You applaud. Bravo!",
        thirdPerson: "{name} applauds. Bravo!",
        targetedFirstPerson: "You applaud at {target}. Bravo!",
        targetedSecondPerson: "{name} applauds at you. Bravo!",
        targetedThirdPerson: "{name} applauds at {target}. Bravo!",
    },
    golfclap: {
        firstPerson: "You clap half-heartedly, clearly unimpressed.",
        thirdPerson: "{name} claps half-heartedly, clearly unimpressed.",
        targetedFirstPerson: "You clap for {target}, clearly unimpressed.",
        targetedSecondPerson: "{name} claps for you, clearly unimpressed.",
        targetedThirdPerson: "{name} claps for {target}, clearly unimpressed.",
    },
    impressed: {
        firstPerson: "You clap vigorously, clearly impressed.",
        thirdPerson: "{name} claps vigorously, clearly impressed.",
        targetedFirstPerson: "You clap vigorously for {target}, clearly impressed.",
        targetedSecondPerson: "{name} claps vigorously for you, clearly impressed.",
        targetedThirdPerson: "{name} claps vigorously for {target}, clearly impressed.",
    },
    wince: {
        firstPerson: "You wince sympathetically.",
        thirdPerson: "{name} winces sympathetically.",
        targetedFirstPerson: "You wince sympathetically at {target}. That looked like it hurt!",
        targetedSecondPerson: "{name} winces sympathetically at you. That looked like it hurt!",
        targetedThirdPerson: "{name} winces sympathetically at {target}. That looked like it hurt!",
    },
    confused: {
        firstPerson: "You are hopelessly confused.",
        thirdPerson: "{name} is hopelessly confused.",
        targetedFirstPerson: "You look at {target} with a confused look.",
        targetedSecondPerson: "{name} looks at you with a confused look.",
        targetedThirdPerson: "{name} looks at {target} with a confused look.",
    },

    // ── Attitude & Sass ─────────────────────────────────────────────────
    taunt: {
        firstPerson: "You taunt everyone around you. Bring it fools!",
        thirdPerson: "{name} taunts everyone. Bring it fools!",
        targetedFirstPerson: "You make a taunting gesture at {target}. Bring it!",
        targetedSecondPerson: "{name} makes a taunting gesture at you. Bring it!",
        targetedThirdPerson: "{name} makes a taunting gesture at {target}. Bring it!",
    },
    mock: {
        firstPerson: "You mock life and all it stands for.",
        thirdPerson: "{name} mocks life and all it stands for.",
        targetedFirstPerson: "You mock the foolishness of {target}.",
        targetedSecondPerson: "{name} mocks your foolishness.",
        targetedThirdPerson: "{name} mocks the foolishness of {target}.",
    },
    gloat: {
        firstPerson: "You gloat over everyone's misfortune.",
        thirdPerson: "{name} gloats over everyone's misfortune.",
        targetedFirstPerson: "You gloat over {target}'s misfortune.",
        targetedSecondPerson: "{name} gloats over your misfortune.",
        targetedThirdPerson: "{name} gloats over {target}'s misfortune.",
    },
    smirk: {
        firstPerson: "A sly smirk spreads across your face.",
        thirdPerson: "A sly smirk spreads across {name}'s face.",
        targetedFirstPerson: "You smirk slyly at {target}.",
        targetedSecondPerson: "{name} smirks slyly at you.",
        targetedThirdPerson: "{name} smirks slyly at {target}.",
    },
    snub: {
        firstPerson: "You snub all of the lowly peons around you.",
        thirdPerson: "{name} snubs all of the lowly peons.",
        targetedFirstPerson: "You snub {target}.",
        targetedSecondPerson: "{name} snubs you.",
        targetedThirdPerson: "{name} snubs {target}.",
    },
    glare: {
        firstPerson: "You glare angrily.",
        thirdPerson: "{name} glares angrily.",
        targetedFirstPerson: "You glare angrily at {target}.",
        targetedSecondPerson: "{name} glares angrily at you.",
        targetedThirdPerson: "{name} glares angrily at {target}.",
    },
    scoff: {
        firstPerson: "You scoff.",
        thirdPerson: "{name} scoffs.",
        targetedFirstPerson: "You scoff at {target}.",
        targetedSecondPerson: "{name} scoffs at you.",
        targetedThirdPerson: "{name} scoffs at {target}.",
    },
    insult: {
        firstPerson: "You think everyone around you is a son of a motherless ogre.",
        thirdPerson: "{name} thinks everyone is a son of a motherless ogre.",
        targetedFirstPerson: "You think {target} is the son of a motherless ogre.",
        targetedSecondPerson: "{name} thinks you are the son of a motherless ogre.",
        targetedThirdPerson: "{name} thinks {target} is the son of a motherless ogre.",
    },
    violin: {
        firstPerson: "You begin to play the world's smallest violin.",
        thirdPerson: "{name} begins to play the world's smallest violin.",
        targetedFirstPerson: "You play the world's smallest violin for {target}.",
        targetedSecondPerson: "{name} plays the world's smallest violin for you.",
        targetedThirdPerson: "{name} plays the world's smallest violin for {target}.",
    },
    sexy: {
        firstPerson: "You're too sexy for your tunic...so sexy it hurts.",
        thirdPerson: "{name} is too sexy for their tunic...so sexy it hurts.",
        targetedFirstPerson: "You think {target} is a sexy devil.",
        targetedSecondPerson: "{name} thinks you are a sexy devil.",
        targetedThirdPerson: "{name} thinks {target} is a sexy devil.",
    },
    threaten: {
        firstPerson: "You threaten everyone with the wrath of doom.",
        thirdPerson: "{name} threatens everyone with the wrath of doom.",
        targetedFirstPerson: "You threaten {target} with the wrath of doom.",
        targetedSecondPerson: "{name} threatens you with the wrath of doom.",
        targetedThirdPerson: "{name} threatens {target} with the wrath of doom.",
    },

    // ── Physical Actions ────────────────────────────────────────────────
    dance: {
        firstPerson: "You burst into dance.",
        thirdPerson: "{name} bursts into dance.",
        targetedFirstPerson: "You dance with {target}.",
        targetedSecondPerson: "{name} dances with you.",
        targetedThirdPerson: "{name} dances with {target}.",
    },
    flex: {
        firstPerson: "You flex your muscles. Oooooh so strong!",
        thirdPerson: "{name} flexes. Oooooh so strong!",
        targetedFirstPerson: "You flex at {target}. Oooooh so strong!",
        targetedSecondPerson: "{name} flexes at you. Oooooh so strong!",
        targetedThirdPerson: "{name} flexes at {target}. Oooooh so strong!",
    },
    bounce: {
        firstPerson: "You bounce up and down.",
        thirdPerson: "{name} bounces up and down.",
        targetedFirstPerson: "You bounce up and down in front of {target}.",
        targetedSecondPerson: "{name} bounces up and down in front of you.",
        targetedThirdPerson: "{name} bounces up and down in front of {target}.",
    },
    fidget: {
        firstPerson: "You fidget.",
        thirdPerson: "{name} fidgets.",
        targetedFirstPerson: "You fidget impatiently while waiting for {target}.",
        targetedSecondPerson: "{name} fidgets impatiently while waiting for you.",
        targetedThirdPerson: "{name} fidgets impatiently while waiting for {target}.",
    },
    yawn: {
        firstPerson: "You yawn sleepily.",
        thirdPerson: "{name} yawns sleepily.",
        targetedFirstPerson: "You yawn sleepily at {target}.",
        targetedSecondPerson: "{name} yawns sleepily at you.",
        targetedThirdPerson: "{name} yawns sleepily at {target}.",
    },
    stretch: {
        firstPerson: "You stretch your arms out.",
        thirdPerson: "{name} stretches their arms out.",
        targetedFirstPerson: "You put your arm around {target}'s shoulder.",
        targetedSecondPerson: "{name} puts their arm around your shoulder.",
        targetedThirdPerson: "{name} puts their arm around {target}'s shoulder.",
    },
    crack: {
        firstPerson: "You crack your knuckles.",
        thirdPerson: "{name} cracks their knuckles.",
        targetedFirstPerson: "You crack your knuckles while staring at {target}.",
        targetedSecondPerson: "{name} cracks their knuckles while staring at you.",
        targetedThirdPerson: "{name} cracks their knuckles while staring at {target}.",
    },
    bonk: {
        firstPerson: "You bonk yourself on the noggin. Doh!",
        thirdPerson: "{name} bonks themselves on the noggin. Doh!",
        targetedFirstPerson: "You bonk {target} on the noggin. Doh!",
        targetedSecondPerson: "{name} bonks you on the noggin. Doh!",
        targetedThirdPerson: "{name} bonks {target} on the noggin. Doh!",
    },
    blush: {
        firstPerson: "You blush.",
        thirdPerson: "{name} blushes.",
        targetedFirstPerson: "You blush at {target}.",
        targetedSecondPerson: "{name} blushes at you.",
        targetedThirdPerson: "{name} blushes at {target}.",
    },
    wink: {
        firstPerson: "You wink slyly.",
        thirdPerson: "{name} winks slyly.",
        targetedFirstPerson: "You wink slyly at {target}.",
        targetedSecondPerson: "{name} winks slyly at you.",
        targetedThirdPerson: "{name} winks slyly at {target}.",
    },
    whistle: {
        firstPerson: "You let forth a sharp whistle.",
        thirdPerson: "{name} lets forth a sharp whistle.",
        targetedFirstPerson: "You whistle at {target}.",
        targetedSecondPerson: "{name} whistles at you.",
        targetedThirdPerson: "{name} whistles at {target}.",
    },

    // ── Silly & Fun ─────────────────────────────────────────────────────
    flip: {
        firstPerson: "You flip the table! (\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B",
        thirdPerson: "{name} flips the table! (\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B",
    },
    allthethings: {
        firstPerson: "You raise your arms dramatically and declare: ALL THE THINGS! \\o/",
        thirdPerson: "{name} raises their arms dramatically and declares: ALL THE THINGS! \\o/",
    },
    chicken: {
        firstPerson: "With arms flapping, you strut around. Cluck, Cluck, Chicken!",
        thirdPerson: "With arms flapping, {name} struts around. Cluck, Cluck, Chicken!",
        targetedFirstPerson: "With arms flapping, you strut around {target}. Cluck, Cluck, Chicken!",
        targetedSecondPerson: "With arms flapping, {name} struts around you. Cluck, Cluck, Chicken!",
        targetedThirdPerson: "With arms flapping, {name} struts around {target}. Cluck, Cluck, Chicken!",
    },
    moo: {
        firstPerson: "Mooooooooooo.",
        thirdPerson: "{name} moos. Mooooooooooo.",
        targetedFirstPerson: "You moo at {target}. Mooooooooooo.",
        targetedSecondPerson: "{name} moos at you. Mooooooooooo.",
        targetedThirdPerson: "{name} moos at {target}. Mooooooooooo.",
    },
    quack: {
        firstPerson: "You pretend to be a duck. Quack!",
        thirdPerson: "{name} pretends to be a duck. Quack!",
        targetedFirstPerson: "You quack at {target}. Quack!",
        targetedSecondPerson: "{name} quacks at you. Quack!",
        targetedThirdPerson: "{name} quacks at {target}. Quack!",
    },
    moon: {
        firstPerson: "You drop your trousers and moon everyone.",
        thirdPerson: "{name} drops their trousers and moons everyone.",
        targetedFirstPerson: "You drop your trousers and moon {target}.",
        targetedSecondPerson: "{name} drops their trousers and moons you.",
        targetedThirdPerson: "{name} drops their trousers and moons {target}.",
    },
    nosepick: {
        firstPerson: "With a finger deep in one nostril, you pass the time.",
        thirdPerson: "{name} picks their nose. Charming.",
        targetedFirstPerson: "You pick your nose and show it to {target}.",
        targetedSecondPerson: "{name} picks their nose and shows it to you.",
        targetedThirdPerson: "{name} picks their nose and shows it to {target}.",
    },
    burp: {
        firstPerson: "You let out a loud belch.",
        thirdPerson: "{name} lets out a loud belch.",
        targetedFirstPerson: "You burp rudely in {target}'s face.",
        targetedSecondPerson: "{name} burps rudely in your face.",
        targetedThirdPerson: "{name} burps rudely in {target}'s face.",
    },
    fart: {
        firstPerson: "You fart loudly. Whew...what stinks?",
        thirdPerson: "{name} farts loudly. Whew...what stinks?",
        targetedFirstPerson: "You brush up against {target} and fart loudly.",
        targetedSecondPerson: "{name} brushes up against you and farts loudly.",
        targetedThirdPerson: "{name} brushes up against {target} and farts loudly.",
    },
    grovel: {
        firstPerson: "You grovel on the ground, wallowing in subservience.",
        thirdPerson: "{name} grovels on the ground, wallowing in subservience.",
        targetedFirstPerson: "You grovel before {target} like a subservient peon.",
        targetedSecondPerson: "{name} grovels before you like a subservient peon.",
        targetedThirdPerson: "{name} grovels before {target} like a subservient peon.",
    },
    surrender: {
        firstPerson: "You surrender to your opponents.",
        thirdPerson: "{name} surrenders. Such is the agony of defeat...",
        targetedFirstPerson: "You surrender before {target}. Such is the agony of defeat...",
        targetedSecondPerson: "{name} surrenders before you. Such is the agony of defeat...",
        targetedThirdPerson: "{name} surrenders before {target}. Such is the agony of defeat...",
    },
    trout: {
        targetedFirstPerson: "You slap {target} around a bit with a large trout.",
        targetedSecondPerson: "{name} slaps you around a bit with a large trout.",
        targetedThirdPerson: "{name} slaps {target} around a bit with a large trout.",
    },

    // ── State & Meta ────────────────────────────────────────────────────
    brb: {
        firstPerson: "You let everyone know you'll be right back.",
        thirdPerson: "{name} will be right back.",
        targetedFirstPerson: "You let {target} know you'll be right back.",
        targetedSecondPerson: "{name} lets you know they'll be right back.",
        targetedThirdPerson: "{name} lets {target} know they'll be right back.",
    },
    afk: {
        firstPerson: "You let everyone know you are away.",
        thirdPerson: "{name} has gone away.",
    },
    think: {
        firstPerson: "You are lost in thought.",
        thirdPerson: "{name} is lost in thought.",
        targetedFirstPerson: "You think about {target}.",
        targetedSecondPerson: "{name} thinks about you.",
        targetedThirdPerson: "{name} thinks about {target}.",
    },
    ponder: {
        firstPerson: "You ponder the situation.",
        thirdPerson: "{name} ponders the situation.",
        targetedFirstPerson: "You ponder {target}'s actions.",
        targetedSecondPerson: "{name} ponders your actions.",
        targetedThirdPerson: "{name} ponders {target}'s actions.",
    },
    idea: {
        firstPerson: "You have an idea!",
        thirdPerson: "{name} has an idea!",
    },
    ready: {
        firstPerson: "You let everyone know that you are ready!",
        thirdPerson: "{name} is ready!",
        targetedFirstPerson: "You let {target} know that you are ready!",
        targetedSecondPerson: "{name} lets you know they are ready!",
        targetedThirdPerson: "{name} lets {target} know they are ready!",
    },
    victory: {
        firstPerson: "You bask in the glory of victory.",
        thirdPerson: "{name} basks in the glory of victory.",
        targetedFirstPerson: "You bask in the glory of victory with {target}.",
        targetedSecondPerson: "{name} basks in the glory of victory with you.",
        targetedThirdPerson: "{name} basks in the glory of victory with {target}.",
    },
    apologize: {
        firstPerson: "You apologize to everyone. Sorry!",
        thirdPerson: "{name} apologizes to everyone. Sorry!",
        targetedFirstPerson: "You apologize to {target}. Sorry!",
        targetedSecondPerson: "{name} apologizes to you. Sorry!",
        targetedThirdPerson: "{name} apologizes to {target}. Sorry!",
    },
};

export type ParsedCommand =
    | { kind: 'message'; content: string }
    | { kind: 'emote'; content: string }
    | { kind: 'builtin-emote'; emoteKey: string; target?: string }
    | { kind: 'whisper'; target: string; content: string }
    | { kind: 'reply'; content: string }
    | { kind: 'invite'; target: string }
    | { kind: 'error'; error: string };

export function parseCommand(raw: string): ParsedCommand {
    const trimmed = raw.trim();

    const validation = validateCommand(trimmed);
    if (!validation.valid) {
        return {kind: 'error', error: validation.error};
    }

    // Built-in emotes (with optional target)
    const spaceIdx = trimmed.indexOf(' ');
    const cmdWord = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
    const emoteKey = resolveEmoteKey(cmdWord);

    if (emoteKey) {
        const rest = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
        if (rest) {
            return {kind: 'builtin-emote', emoteKey, target: rest};
        }
        return {kind: 'builtin-emote', emoteKey};
    }

    // Custom emote: /me [action]
    if (trimmed.startsWith('/me ')) {
        return {kind: 'emote', content: trimmed.slice(4)};
    }

    // Whisper commands: /whisper [email] [message]
    for (const cmd of ['/whisper ', '/tell ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const si = rest.indexOf(' ');
            if (si > 0) {
                return {kind: 'whisper', target: rest.slice(0, si), content: rest.slice(si + 1)};
            }
        }
    }

    // Reply commands: /reply [message]
    if (trimmed.startsWith('/reply ')) {
        return {kind: 'reply', content: trimmed.slice(7)};
    }

    // Invite commands: /invite [email]
    if (trimmed.startsWith('/invite ')) {
        return {kind: 'invite', target: trimmed.slice(8).trim()};
    }

    return {kind: 'error', error: 'Unknown command'};
}

export function formatEmoteForViewer(content: string, authorEmail: string, authorId: string, viewerId: string, viewerEmail?: string): string {
    const authorName = authorEmail.split('@')[0] || authorEmail;

    if (content.startsWith('$')) {
        const raw = content.slice(1);
        const colonIdx = raw.indexOf(':');
        const emoteKey = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
        const targetEmail = colonIdx > 0 ? raw.slice(colonIdx + 1) : undefined;

        const emote = BUILT_IN_EMOTES[emoteKey];
        if (!emote) return `${authorName} does something mysterious.`;

        if (targetEmail) {
            const targetName = targetEmail.split('@')[0] || targetEmail;
            const isAuthor = authorId === viewerId;
            const isTarget = viewerEmail?.toLowerCase() === targetEmail.toLowerCase();

            if (isAuthor) return (emote.targetedFirstPerson ?? `You emote at ${targetName}.`).replace('{target}', targetName);
            if (isTarget) return (emote.targetedSecondPerson ?? `${authorName} emotes at you.`).replace('{name}', authorName);
            return (emote.targetedThirdPerson ?? `${authorName} emotes at ${targetName}.`).replace('{name}', authorName).replace('{target}', targetName);
        }

        if (authorId === viewerId) return emote.firstPerson ?? `You do something.`;
        return (emote.thirdPerson ?? `${authorName} does something.`).replace('{name}', authorName);
    }

    return `${authorName} ${content}`;
}
