import { describe, expect, test } from 'bun:test';
import { Calendar, File, Mail, UsersRound } from 'lucide-react';
import { getFileIconComponent, getFilePresentation } from '../../core/file-presentation';
import { EML_MIME, ICS_MIME } from '../../types/drive';

// A .vcf, a .eml and a .ics each belong to an app the way an eigendoc does, so each wears that app's
// icon and color wherever a file is drawn — and each is recognised by name or by mime alone, because
// exporters disagree on both.
describe('an app format carries its app icon and color', () => {
    test('a vCard is Contacts', () => {
        expect(getFilePresentation('text/vcard', 'file', 'team.vcf')).toEqual({
            icon: UsersRound,
            colorVar: 'var(--app-contacts-color)',
            softColorVar: 'var(--app-contacts-color-soft)',
            fillColorVar: 'var(--app-contacts-color-soft)',
            label: 'Contacts',
        });
    });

    test('a message is Mail', () => {
        expect(getFilePresentation(EML_MIME, 'file', 'attachment-1')).toEqual({
            icon: Mail,
            colorVar: 'var(--app-mail-color)',
            softColorVar: 'var(--app-mail-color-soft)',
            fillColorVar: 'var(--app-mail-color-soft)',
            label: 'Mail',
        });
    });

    test('a calendar is Calendar', () => {
        expect(getFilePresentation(ICS_MIME, 'file', 'festival.ics')).toEqual({
            icon: Calendar,
            colorVar: 'var(--app-calendar-color)',
            softColorVar: 'var(--app-calendar-color-soft)',
            fillColorVar: 'var(--app-calendar-color-soft)',
            label: 'Calendar',
        });
    });

    test('by name where the exporter names no type', () => {
        expect(getFileIconComponent('application/octet-stream', 'file', 'team.VCF')).toBe(UsersRound);
        expect(getFileIconComponent('application/octet-stream', 'file', 'forwarded.eml')).toBe(Mail);
        expect(getFileIconComponent('application/octet-stream', 'file', 'invite.ics')).toBe(Calendar);
    });

    test('by mime where the part carries no name', () => {
        expect(getFileIconComponent('text/x-vcard', 'file', 'attachment-1')).toBe(UsersRound);
        expect(getFileIconComponent(EML_MIME, 'file', 'attachment-1')).toBe(Mail);
        expect(getFileIconComponent('text/calendar; method=REQUEST', 'file', 'attachment-1')).toBe(Calendar);
    });

    // The three read before the text and code families a bare mime would otherwise fall into.
    test('an ordinary file stays generic and muted', () => {
        expect(getFilePresentation('application/octet-stream', 'file', 'shoot.cr2')).toEqual({
            icon: File,
            colorVar: 'var(--muted-foreground)',
            softColorVar: 'var(--muted)',
            fillColorVar: 'none',
            label: 'application/octet-stream',
        });
    });
});
