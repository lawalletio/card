import { NostrEvent } from '@nostr-dev-kit/ndk';
import { Debugger } from 'debug';
import { nip26, validateEvent, verifySignature } from 'nostr-tools';

import { logger } from '@lib/utils';

const log: Debugger = logger.extend('lib:event');
const debug: Debugger = log.extend('debug');

export enum Kind {
  REGULAR = 1112,
  EPHEMERAL = 21111,
  PARAMETRIZED_REPLACEABLE = 31111,
}

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
 *
 * @param event to be validated
 * @param expectedPubkey if present, validate that it is equal to event
 *  author
 * @return the event if valid, null otherwise
 */
export function parseEventBody(
  event: NostrEvent,
  expectedPubkey?: string,
): NostrEvent | null {
  debug('Received event: %O, expectedPubkey: %O', event, expectedPubkey);
  if (
    !validateEvent(event) ||
    !verifySignature(event) ||
    !validateNip26(event) ||
    (expectedPubkey && event.pubkey !== expectedPubkey)
  ) {
    log('Received invalid nostr event %s', event.id);
    return null;
  }
  return event;
}
