import {afterAll} from 'bun:test';
import {cleanup} from './setup';

afterAll(() => {
    cleanup();
});
