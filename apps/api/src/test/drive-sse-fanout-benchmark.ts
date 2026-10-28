// Measures what relaying drive events to a team's members costs the server. It builds a team of 50
// members with an open stream each, then times one change's fan-out, its parts, and a burst of uploads
// into a team folder next to the same burst into a personal folder, which has nobody to relay to.
//
// Run from apps/api:
//   bun src/test/drive-sse-fanout-benchmark.ts [--members 50] [--uploads 500] [--concurrency 8]
//
// Not a .test.ts on purpose: it takes tens of seconds and its numbers are machine-relative.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { SSEvent } from '@workspace/lib/types/sse';

// './setup' must evaluate before any lib module so EIGEN_DATA_ROOT points at the test dir, the same job
// --preload does for the test suite. Dynamic imports keep the import organizer from hoisting lib modules.
const setup = await import('./setup');
const { teamOwnerId } = await import('@workspace/lib/types');
const { SSEventType } = await import('@workspace/lib/types/sse');
const { getServerConfig } = await import('../lib/config/server-config');
const { getHome } = await import('../lib/home/get-home');
const { broadcastToOwnerAndMembers, relayEventToMembers } = await import('../lib/home/home-relay');
const { buildDriveEvent } = await import('../lib/drive/sse-events');

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : fallback;
}
const MEMBERS = argNum('members', 50);
const UPLOADS = argNum('uploads', 500);
const CONCURRENCY = argNum('concurrency', 8);
const ROUNDS = 200;

function percentiles(samples: number[]): string {
    const s = [...samples].sort((a, b) => a - b);
    const pick = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    const mean = s.reduce((sum, x) => sum + x, 0) / s.length;
    return `mean=${mean.toFixed(2)}ms p50=${pick(0.5).toFixed(2)}ms p95=${pick(0.95).toFixed(2)}ms max=${pick(1).toFixed(2)}ms`;
}

async function timeRounds(label: string, run: () => Promise<unknown>): Promise<void> {
    const samples: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        const start = performance.now();
        await run();
        samples.push(performance.now() - start);
    }
    console.log(`${label.padEnd(34)} ${percentiles(samples)}`);
}

const ctx = await setup.getTestContext();
const orgId = getServerConfig()?.orgId;
if (!orgId) throw new Error('the server has no org');
const token = ctx.alice.user.sessionToken;
await setup.authedRequest(token, '/auth/organization/set-active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId: orgId }),
});
const teamId = await setup.createTeam(ctx, orgId, `Fanout Bench ${Date.now()}`);
const teamOwner = teamOwnerId(teamId);
await setup.addMember(ctx, teamId, ctx.alice.user.id);

// Every member has one open tab, a listener on their loaded home, which counts what reaches it.
const received = new Map<string, number>();
const memberIds = [ctx.alice.user.id];
for (let i = 1; i < MEMBERS; i++) {
    const member = await setup.createTestUser(`fanout-bench-${i}@test.eigen.is`, 'testpassword123', `Bench ${i}`);
    await setup.addMember(ctx, teamId, member.id);
    memberIds.push(member.id);
}
for (const id of memberIds) {
    const home = await getHome(id);
    received.set(id, 0);
    home.subscribeSSE((_event: SSEvent) => received.set(id, (received.get(id) ?? 0) + 1));
}
await setup.addTeamMount(ctx, teamId, 'Fanout Bench Drive');
const teamMountId = await setup.firstMountId(token, teamOwner);
const teamRoot = await setup.driveGet<DrivePath>(token, teamOwner, teamMountId, 'root');
const teamFolder = await setup.drivePost<DrivePath>(token, teamOwner, teamMountId, `folder/${teamRoot.id}`, {
    folderName: 'burst',
});
const teamHome = await getHome(teamOwner);

console.log(`\n=== one change, team of ${MEMBERS}, ${ROUNDS} rounds ===`);
const members = await teamHome.drive.getEffectiveMembers(teamMountId, teamFolder.id);
const event = buildDriveEvent(SSEventType.DRIVE_FILE_UPLOADED, teamFolder);
await timeRounds('read the members', () => teamHome.drive.getEffectiveMembers(teamMountId, teamFolder.id));
await timeRounds('relay to the members', () => relayEventToMembers(teamOwner, members, event));
await timeRounds('read and relay (one drive event)', () =>
    broadcastToOwnerAndMembers(teamOwner, teamHome.drive.getEffectiveMembers(teamMountId, teamFolder.id), event),
);

async function burst(label: string, ownerId: string, mountId: string, folderId: string): Promise<void> {
    for (const id of memberIds) received.set(id, 0);
    let lagMax = 0;
    let running = true;
    const loopProbe = (async () => {
        while (running) {
            const before = performance.now();
            await new Promise((resolve) => setTimeout(resolve, 5));
            lagMax = Math.max(lagMax, performance.now() - before - 5);
        }
    })();
    let next = 0;
    const start = performance.now();
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < UPLOADS) {
                const n = next++;
                const file = new File([`file ${n}`], `burst-${n}.txt`, { type: 'text/plain' });
                await setup.driveUpload(token, ownerId, mountId, folderId, file);
            }
        }),
    );
    const ms = performance.now() - start;
    // The relays run after each upload answered, so give the last ones a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    running = false;
    await loopProbe;
    const counts = memberIds.slice(1).map((id) => received.get(id) ?? 0);
    console.log(
        `${label.padEnd(34)} ${ms.toFixed(0)}ms total, ${(ms / UPLOADS).toFixed(2)}ms per upload, ` +
            `loop lag max ${lagMax.toFixed(1)}ms, events per other member tab ${Math.min(...counts)}-${Math.max(...counts)}`,
    );
}

console.log(`\n=== ${UPLOADS} uploads, ${CONCURRENCY} at a time ===`);
const aliceMountId = await setup.firstMountId(token, ctx.alice.user.id);
const aliceRoot = await setup.driveGet<DrivePath>(token, ctx.alice.user.id, aliceMountId, 'root');
const aliceFolder = await setup.drivePost<DrivePath>(token, ctx.alice.user.id, aliceMountId, `folder/${aliceRoot.id}`, {
    folderName: `burst-${Date.now()}`,
});
await burst('personal folder (nobody to relay)', ctx.alice.user.id, aliceMountId, aliceFolder.id);
await burst(`team folder (${MEMBERS} members)`, teamOwner, teamMountId, teamFolder.id);
process.exit(0);
