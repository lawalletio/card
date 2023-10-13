import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';

import { requiredEnvVar } from '@lib/utils';

let writeNDK: NDK;
let readNDK: NDK;

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
