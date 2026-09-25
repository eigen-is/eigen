import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile, writeEnvFile } from '../../cli/env-file';

const DIR = mkdtempSync(join(tmpdir(), 'eigen-env-file-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// Each line below was read back by `docker compose --env-file` interpolation AND by `env_file:` in a running
// alpine container (Compose 2.32), and both yielded exactly the value on the left.
const COMPOSE_VERIFIED: [string, string][] = [
    ['pa$word', "'pa$word'"],
    ['single $dollar', "'single $dollar'"],
    ['back\\slash $x "dq" #h', `'back\\slash $x "dq" #h'`],
    [`it's $ "q" \\ end`, `"it's $$ \\"q\\" \\\\ end"`],
    ['a # b', "'a # b'"],
    ['  lead and trail  ', "'  lead and trail  '"],
    ['héllo wörld', "'héllo wörld'"],
    ['abc.def-1_2:3/4@5,6+7=8%9', 'abc.def-1_2:3/4@5,6+7=8%9'],
    ['', ''],
];

describe('env file', () => {
    test('writes values in a form Compose reads back byte-identical', () => {
        const path = join(DIR, 'verified.env');
        writeEnvFile(path, new Map(COMPOSE_VERIFIED.map(([value], i) => [`K${i}`, value])));
        expect(readFileSync(path, 'utf8')).toBe(COMPOSE_VERIFIED.map(([, line], i) => `K${i}=${line}\n`).join(''));
        expect([...readEnvFile(path).values()]).toEqual(COMPOSE_VERIFIED.map(([value]) => value));
    });

    test('reads hand-written lines the way Compose does, but $NAME literally', () => {
        const path = join(DIR, 'hand.env');
        writeFileSync(
            path,
            [
                '# a comment',
                'PW=pa$$word',
                'U=un$dollar',
                'UDQ="un$dollar"',
                "S='single $dollar'",
                'DQ="it\'s $$ \\"q\\" \\\\ end"',
                'BARE_HASH=a # b',
                "EMPTY_SQ=''",
                'EMPTY=',
                `REF=\${S}x`,
                'export EXP=2',
                'DUP=first',
                'DUP=second',
                'not a key line',
                '',
            ].join('\n'),
        );
        expect(Object.fromEntries(readEnvFile(path))).toEqual({
            PW: 'pa$word',
            U: 'un$dollar',
            UDQ: 'un$dollar',
            S: 'single $dollar',
            DQ: `it's $ "q" \\ end`,
            BARE_HASH: 'a',
            EMPTY_SQ: '',
            EMPTY: '',
            REF: `\${S}x`,
            EXP: '2',
            DUP: 'second',
        });
    });

    test('a missing file reads as empty', () => {
        expect(readEnvFile(join(DIR, 'missing.env')).size).toBe(0);
    });

    test('keeps comments, order, unknown keys and unchanged lines byte-for-byte', () => {
        const path = join(DIR, 'keep.env');
        const original = [
            '# Eigen production config',
            'DOMAIN=eigen.example.org',
            '',
            'SMTP_RELAY_PASSWORD=pa$$word',
            'CUSTOM="quoted value"',
            'TRUSTED_NETWORKS=127.0.0.0/8,::1,172.20.0.0/24',
            'ACME_EMAIL=old@example.org',
            '',
        ].join('\n');
        writeFileSync(path, original);
        const entries = readEnvFile(path);
        entries.set('SMTP_RELAY_PASSWORD', 'pa$word');
        entries.set('ACME_EMAIL', 'new@example.org');
        entries.set('MAIL_ENABLED', '1');
        writeEnvFile(path, entries);
        expect(readFileSync(path, 'utf8')).toBe(
            `${original.replace('ACME_EMAIL=old@example.org', 'ACME_EMAIL=new@example.org')}MAIL_ENABLED=1\n`,
        );
    });

    test('drops a key the entries no longer carry', () => {
        const path = join(DIR, 'drop.env');
        writeFileSync(path, 'A=1\nB=2\nC=3\n');
        const entries = readEnvFile(path);
        entries.delete('B');
        writeEnvFile(path, entries);
        expect(readFileSync(path, 'utf8')).toBe('A=1\nC=3\n');
    });

    test('replaces the file through a rename with mode 0600', () => {
        const dir = join(DIR, 'mode');
        mkdirSync(dir);
        const path = join(dir, '.env.production');
        writeFileSync(path, 'A=1\n');
        chmodSync(path, 0o644);
        const inode = statSync(path).ino;
        writeEnvFile(path, new Map([['A', '2']]));
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(path).ino).not.toBe(inode);
        expect(readdirSync(dir)).toEqual(['.env.production']);
    });

    test('refuses a value Compose cannot hold on one line', () => {
        expect(() => writeEnvFile(join(DIR, 'multi.env'), new Map([['A', 'one\ntwo']]))).toThrow();
    });
});
