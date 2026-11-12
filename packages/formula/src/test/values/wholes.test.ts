import { expect, test } from 'bun:test';
import { NUM } from '../../values/errors';
import { greatestDivisor, leastMultiple, multinomial } from '../../values/wholes';

test('the greatest divisor cuts each number first and refuses a negative one and one past 2^53', () => {
    expect(greatestDivisor([12, 18, 24])).toBe(6);
    expect(greatestDivisor([4.9, 6.9])).toBe(2);
    expect(greatestDivisor([0, 0])).toBe(0);
    expect(greatestDivisor([])).toBe(0);
    expect(greatestDivisor([2 ** 53, 6])).toBe(2);
    expect(greatestDivisor([1e16, 3])).toBe(NUM);
    expect(greatestDivisor([4, -6])).toBe(NUM);
});

test('the least multiple is 0 with a 0 among the numbers and #NUM! past 2^53', () => {
    expect(leastMultiple([3, 5, 7])).toBe(105);
    expect(leastMultiple([3, 5, 0])).toBe(0);
    expect(leastMultiple([1e15, 7])).toBe(7e15);
    expect(leastMultiple([2 ** 53, 3])).toBe(NUM);
    expect(leastMultiple([99999999, 99999998])).toBe(NUM);
    expect(leastMultiple([-5])).toBe(NUM);
});

test('the multinomial is exact for small groups and #NUM! where a factorial no longer fits', () => {
    expect(multinomial([1, 2, 3])).toBe(60);
    expect(multinomial([2, 3, 4])).toBe(1260);
    expect(multinomial([0])).toBe(1);
    expect(multinomial([171])).toBe(NUM);
    expect(multinomial([1e15, 2])).toBe(NUM);
    expect(multinomial([-1])).toBe(NUM);
});
