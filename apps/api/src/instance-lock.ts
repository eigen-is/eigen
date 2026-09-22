import { getDataRoot } from './lib/config/paths';
import { holdInstanceLock } from './lib/core/instance-lock';

// Its own module so index.ts can import it ahead of ./app, whose modules open server databases as they load.
export const instanceLock = holdInstanceLock(getDataRoot());
