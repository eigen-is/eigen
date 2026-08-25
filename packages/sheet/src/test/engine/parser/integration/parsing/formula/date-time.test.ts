import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Parser from '../../../../../../engine/parser/parser';

describe('.parse() date & time formulas', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    it('DATE', () => {
        const { error: e1, result: r1 } = parser!.parse('DATE()');
        expect(e1).toBeNull();
        expect(r1).toBeInstanceOf(Date);

        const { error, result } = parser!.parse('DATE(2001, 5, 12)');

        expect(error).toBeNull();
        expect(result.getFullYear()).toBe(2001);
        expect(result.getMonth()).toBe(4); // counting from zero
        expect(result.getDate()).toBe(12);
    });

    it('DATEVALUE', () => {
        expect(parser!.parse('DATEVALUE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });

        const { error: e1, result: r1 } = parser!.parse('DATEVALUE("1/1/1900")');
        expect(e1).toBeNull();
        expect(r1).toBeInstanceOf(Date);

        const { error: e2, result: r2 } = parser!.parse('DATEVALUE("1/1/2000")');
        expect(e2).toBeNull();
        expect(r2).toBeInstanceOf(Date);
    });

    it('DAY', () => {
        expect(parser!.parse('DAY()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DAY(1)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('DAY(2958465)')).toMatchObject({
            error: null,
            result: 31,
        });
        expect(parser!.parse('DAY("2958465")')).toMatchObject({
            error: null,
            result: 31,
        });
    });

    it('DAYS', () => {
        expect(parser!.parse('DAYS()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DAYS(1)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DAYS(1, 6)')).toMatchObject({
            error: null,
            result: -5,
        });
        expect(parser!.parse('DAYS("1/2/2000", "1/10/2001")')).toMatchObject({
            error: null,
            result: -374,
        });
    });

    it('DAYS360', () => {
        expect(parser!.parse('DAYS360()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DAYS360(1)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DAYS360(1, 6)')).toMatchObject({
            error: null,
            result: 5,
        });
        expect(parser!.parse('DAYS360("1/1/1901", "2/1/1901", TRUE)')).toMatchObject({ error: null, result: 30 });
        expect(parser!.parse('DAYS360("1/1/1901", "12/31/1901", FALSE)')).toMatchObject({ error: null, result: 360 });
    });

    it('EDATE', () => {
        expect(parser!.parse('EDATE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('EDATE(1)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        const { error: e1, result: r1 } = parser!.parse('EDATE("1/1/1900", 1)');
        expect(e1).toBeNull();
        expect(r1).toBeInstanceOf(Date);
    });

    it('EOMONTH', () => {
        expect(parser!.parse('EOMONTH()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('EOMONTH(1)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        const { error: e1, result: r1 } = parser!.parse('EOMONTH("1/1/1900", 1)');
        expect(e1).toBeNull();
        expect(r1).toBeInstanceOf(Date);
    });

    // formulajs's date functions return JS Date objects but Excel returns serial
    // numbers, so any arithmetic on those results has to coerce Date → serial
    // for `EOMONTH(d,0) - EOMONTH(d,-1)` to come out as a day count rather than
    // milliseconds (or worse, NaN). This is what calendar templates use to compute
    // "days in this month".
    it('subtracting date function results yields day counts', () => {
        // Jan has 31 days. EOMONTH(Jan 1, 0) - EOMONTH(Jan 1, -1) === 31.
        expect(parser!.parse('EOMONTH("1/1/2027", 0) - EOMONTH("1/1/2027", -1)')).toMatchObject({
            error: null,
            result: 31,
        });
        // Feb 2027: 28 days (not leap).
        expect(parser!.parse('EOMONTH("2/1/2027", 0) - EOMONTH("2/1/2027", -1)')).toMatchObject({
            error: null,
            result: 28,
        });
        // Adding 1 to a Date result steps forward one day.
        expect(parser!.parse('DATEVALUE("1/1/2027") + 1 - DATEVALUE("1/1/2027")')).toMatchObject({
            error: null,
            result: 1,
        });
    });

    it('HOUR', () => {
        expect(parser!.parse('HOUR()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('HOUR("1/1/1900 16:33")')).toMatchObject({
            error: null,
            result: 16,
        });
    });

    it('INTERVAL', () => {
        expect(parser!.parse('INTERVAL()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('INTERVAL(0)')).toMatchObject({
            error: null,
            result: 'PT',
        });
        expect(parser!.parse('INTERVAL(1)')).toMatchObject({
            error: null,
            result: 'PT1S',
        });
        expect(parser!.parse('INTERVAL(60)')).toMatchObject({
            error: null,
            result: 'PT1M',
        });
        expect(parser!.parse('INTERVAL(10000000)')).toMatchObject({
            error: null,
            result: 'P3M25DT17H46M40S',
        });
    });

    it('ISOWEEKNUM', () => {
        expect(parser!.parse('ISOWEEKNUM()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('ISOWEEKNUM("1/8/1901")')).toMatchObject({
            error: null,
            result: 2,
        });
        expect(parser!.parse('ISOWEEKNUM("6/6/1902")')).toMatchObject({
            error: null,
            result: 23,
        });
    });

    it('MINUTE', () => {
        expect(parser!.parse('MINUTE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('MINUTE("1/1/1901 1:01")')).toMatchObject({
            error: null,
            result: 1,
        });
        expect(parser!.parse('MINUTE("1/1/1901 15:36")')).toMatchObject({
            error: null,
            result: 36,
        });
    });

    it('MONTH', () => {
        expect(parser!.parse('MONTH()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('MONTH("2/1/1901")')).toMatchObject({
            error: null,
            result: 2,
        });
        expect(parser!.parse('MONTH("10/1/1901")')).toMatchObject({
            error: null,
            result: 10,
        });
    });

    it('NETWORKDAYS', () => {
        expect(parser!.parse('NETWORKDAYS()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('NETWORKDAYS("2/1/1901")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('NETWORKDAYS("2013-12-04", "2013-12-05")')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('NETWORKDAYS("2013-11-04", "2013-12-05")')).toMatchObject({ error: null, result: 24 });
    });

    it('NOW', () => {
        const { error, result } = parser!.parse('NOW()');
        const now = new Date();

        expect(error).toBeNull();
        expect(result.toString()).toBe(now.toString());
    });

    it('SECOND', () => {
        expect(parser!.parse('SECOND()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('SECOND("2/1/1901 13:33:12")')).toMatchObject({
            error: null,
            result: 12,
        });
    });

    it('TIME', () => {
        expect(parser!.parse('TIME()')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('TIME(0)')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('TIME(0, 0)')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('TIME(0, 0, 0)')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('TIME(1, 1, 1)')).toMatchObject({
            error: null,
            result: 0.04237268518518519,
        });
        expect(parser!.parse('TIME(24, 0, 0)')).toMatchObject({
            error: null,
            result: 1,
        });
    });

    it('TIMEVALUE', () => {
        expect(parser!.parse('TIMEVALUE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('TIMEVALUE("1/1/1900 00:00:00")')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('TIMEVALUE("1/1/1900 23:00:00")')).toMatchObject({
            error: null,
            result: 0.9583333333333334,
        });
    });

    it('TODAY', () => {
        const { error, result } = parser!.parse('TODAY()');
        const now = new Date();

        expect(error).toBeNull();
        expect(result.getDate()).toBe(now.getDate());
    });

    it('WEEKDAY', () => {
        expect(parser!.parse('WEEKDAY()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('WEEKDAY("1/1/1901")')).toMatchObject({
            error: null,
            result: 3,
        });
        expect(parser!.parse('WEEKDAY("1/1/1901", 2)')).toMatchObject({
            error: null,
            result: 2,
        });
    });

    it('WEEKNUM', () => {
        expect(parser!.parse('WEEKNUM()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('WEEKNUM("2/1/1900")')).toMatchObject({
            error: null,
            result: 5,
        });
        expect(parser!.parse('WEEKNUM("2/1/1909", 2)')).toMatchObject({
            error: null,
            result: 6,
        });
    });

    it('WORKDAY', () => {
        expect(parser!.parse('WORKDAY()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        const { error: e1, result: r1 } = parser!.parse('WORKDAY("1/1/1900")');
        expect(e1).toBeNull();
        expect(r1).toBeInstanceOf(Date);

        const { result, error } = parser!.parse('WORKDAY("1/1/1900", 1)');

        expect(error).toBeNull();
        expect(result.getDate()).toBe(2);
    });

    it('YEAR', () => {
        expect(parser!.parse('YEAR()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('YEAR("1/1/1904")')).toMatchObject({
            error: null,
            result: 1904,
        });
        expect(parser!.parse('YEAR("12/12/2001")')).toMatchObject({
            error: null,
            result: 2001,
        });
    });

    it('YEARFRAC', () => {
        expect(parser!.parse('YEARFRAC()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('YEARFRAC("1/1/1904")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('YEARFRAC("1/1/1900", "1/2/1900")')).toMatchObject({
            error: null,
            result: 0.002777777777777778,
        });
    });
});
