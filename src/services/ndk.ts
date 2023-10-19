import NDK, {
  NDKPrivateKeySigner,
  NDKRelay,
  NDKRelaySet,
} from '@nostr-dev-kit/ndk';

import { logger, requiredEnvVar } from '@lib/utils';
import { Debugger } from 'debug';

const log: Debugger = logger.extend('services:ndk');
const warn: Debugger = log.extend('warn');

const INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
let writeNDK: NDK;
let readNDK: NDK;

type TempRelay = {
  relay: NDKRelay;
  timer: NodeJS.Timeout;
};
const tempRelaysPool = new Map<string, TempRelay>();

/**
 * Return the NDK instance for fetching events from relays.
 *
 * Create it if it does not exist.
 */
export function getReadNDK(): NDK {
  if (!readNDK) {
    readNDK = new NDK({
      explicitRelayUrls: process.env.NOSTR_RELAYS?.split(','),
    });
  }
  return readNDK;
}

/**
 * Return the NDK instance for publishing events to relay.
 *
 * Create it if it does not exist.
 */
export function getWriteNDK(): NDK {
  if (!writeNDK) {
    writeNDK = new NDK({
      explicitRelayUrls: [requiredEnvVar('NOSTR_WRITE_RELAY')],
      signer: new NDKPrivateKeySigner(process.env.NOSTR_PRIVATE_KEY),
    });
  }
  return writeNDK;
}

export function getSignerNDK(): NDK {
  return new NDK({
    signer: new NDKPrivateKeySigner(process.env.NOSTR_PRIVATE_KEY),
  });
}

function removeTempRelay(relayUrl: string): void {
  const tempRelay = tempRelaysPool.get(relayUrl);
  if (tempRelay) {
    log('%s ws inactive for %d ms, disconnecting', relayUrl, INACTIVE_TIMEOUT);
    clearTimeout(tempRelay.timer);
    tempRelay.relay.disconnect();
    tempRelaysPool.delete(relayUrl);
  }
}

/**
 * Returns a set of connected relays for publishing
 *
 * Reuses connection to known relays.
 */
export function connectToTempRelays(
  relayUrls: string[],
  ndk: NDK,
): NDKRelaySet {
  const relays: NDKRelay[] = [];
  for (const url of relayUrls) {
    let tempRelay = tempRelaysPool.get(url);
    const timer = setTimeout(() => removeTempRelay(url), INACTIVE_TIMEOUT);
    if (tempRelay) {
      clearTimeout(tempRelay.timer);
      tempRelay.timer = timer;
    } else {
      const relay = new NDKRelay(url);
      relay.connect().catch((e) => {
        warn('Error connecting to relay %s: %O', url, e);
        removeTempRelay(url);
      });
      relay.on('connect', () =>
        log('Connected to %s for %d ms', url, INACTIVE_TIMEOUT),
      );
      tempRelay = { relay, timer };
      tempRelaysPool.set(url, tempRelay);
    }
    relays.push(tempRelay.relay);
  }
  return new NDKRelaySet(new Set(relays), ndk);
}
