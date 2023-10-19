import { NostrEvent } from '@nostr-dev-kit/ndk';
import { Debugger } from 'debug';
import { nip26, validateEvent, verifySignature } from 'nostr-tools';

import { logger } from '@lib/utils';

const log: Debugger = logger.extend('lib:event');
const debug: Debugger = log.extend('debug');

/**
 * Return false if there is an invalid delegation
 *
 * If there is a valid delegation, change the pubkey of the event to
 * the delegator.
 */
function validateNip26(event: NostrEvent): boolean {
  if (event.tags.some((t) => 'delegation' === t[0])) {
    const delegator = nip26.getDelegator(event);
    if (delegator) {
      event.pubkey = delegator;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Common validations for nostr events
 */
export function parseEventBody(
  event: NostrEvent,
  expectedPubkey: string,
): NostrEvent | null {
  debug('Received event: %O', event);
  if (
    !validateEvent(event) ||
    !verifySignature(event) ||
    !validateNip26(event) ||
    event.pubkey !== expectedPubkey
  ) {
    log('Received invalid nostr event %O', event);
    return null;
  }
  return event;
}
