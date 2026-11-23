// The naming rule reviveTimestamp relies on, checked by the compiler: every Date an API route answers sits under a
// key that ends in At or Time or is at or date. A Date under any other key, or straight in an array, a tuple or a
// record, would reach the browser as a string, so its path shows up in the type error below.
import { expect, test } from 'bun:test';
import type { app } from '@apps/api';

type TimestampKey = `${string}At` | `${string}Time` | 'at' | 'date';

type Misnamed<T, Path extends string, Key extends string, Seen> = 0 extends 1 & T
    ? never
    : T extends Date
      ? Key extends TimestampKey
          ? never
          : Path
      : T extends readonly (infer Item)[]
        ? Misnamed<Item, `${Path}[]`, '[]', Seen>
        : T extends object
          ? [T] extends [Seen]
              ? never
              : {
                    [K in keyof T]-?: Misnamed<
                        T[K],
                        `${Path}.${K & (string | number)}`,
                        `${K & (string | number)}`,
                        Seen | T
                    >;
                }[keyof T]
          : never;

type MisnamedInRoutes<Routes, Path extends string> = Routes extends { response: infer Replies; body: unknown }
    ? Misnamed<Replies[keyof Replies], Path, '', never>
    : { [K in keyof Routes]-?: MisnamedInRoutes<Routes[K], `${Path}/${K & string}`> }[keyof Routes];

test('every Date a route answers sits under a timestamp key', () => {
    const misnamed: MisnamedInRoutes<app['~Routes'], ''>[] = [];
    const none: never[] = misnamed;
    expect(none).toEqual([]);
});
