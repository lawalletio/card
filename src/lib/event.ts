import { NostrEvent } from '@nostr-dev-kit/ndk';
import { Debugger } from 'debug';
import { nip26, validateEvent, verifySignature } from 'nostr-tools';

import { logger, nowInSeconds, requiredEnvVar, requiredProp } from '@lib/utils';

const log: Debugger = logger.extend('lib:event');
const debug: Debugger = log.extend('debug');

const MAX_EVENT_AGE = 180; // 3 minutes

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
  if (!validateEvent(event)) {
    log('Event validation failed');
  } else if (!verifySignature(event)) {
    log('Signature validation failed');
  } else if (!validateNip26(event)) {
    log('NIP-26 validation failed');
  } else if (event.created_at + MAX_EVENT_AGE < nowInSeconds()) {
    log(
      'Event age validation failed --- event.created_at + MAX_EVENT_AGE = %O / nowInSeconds() = %O',
      event.created_at + MAX_EVENT_AGE,
      nowInSeconds(),
    );
  } else if (expectedPubkey && event.pubkey !== expectedPubkey) {
    log(
      'Expected pubkey mismatch --- expectedPubkey = %O / event.pubkey = ',
      expectedPubkey,
      event.pubkey,
    );
  } else {
    return event;
  }
  log('Received invalid nostr event %s', event.id);
  return null;
}

/**
 * Return a response event for a request
 */
export function responseEvent(
  resType: string,
  content: string,
  req?: NostrEvent,
): NostrEvent {
  let tags = [['t', resType]];
  if (req) {
    tags = tags.concat([
      ['p', req.pubkey],
      ['e', requiredProp(req, 'id')],
    ]);
  }
  return {
    pubkey: requiredEnvVar('NOSTR_PUBLIC_KEY'),
    created_at: nowInSeconds(),
    kind: 21111,
    tags,
    content,
  };
}

/**
 * Parse and validate a nip26 conditions string
 *
 * @return the kind, since and until if the conditions is valid, null
 * otherwise
 */
export function validateDelegationConditions(
  conditions: string,
): { kind: number; since: number; until: number } | null {
  const rKind: RegExp = /^kind=(?<kind>[1-9][0-9]*)$/g;
  const rSince: RegExp = /^created_at>(?<ts>[1-9][0-9]*)$/g;
  const rUntil: RegExp = /^created_at<(?<ts>[1-9][0-9]*)$/g;

  let kind: number | null = null;
  let since: number | null = null;
  let until: number | null = null;

  for (const part of conditions.split('&')) {
    const mKind: RegExpExecArray | null = rKind.exec(part);
    const mSince: RegExpExecArray | null = rSince.exec(part);
    const mUntil: RegExpExecArray | null = rUntil.exec(part);

    if (null !== mKind) {
      if (null === kind) {
        kind = parseInt(mKind.groups?.kind ?? '', 10);
      } else {
        return null;
      }
    } else if (null !== mSince) {
      if (null === since) {
        since = parseInt(mSince.groups?.ts ?? '', 10);
      } else {
        return null;
      }
    } else if (null !== mUntil) {
      if (null === until) {
        until = parseInt(mUntil.groups?.ts ?? '', 10);
      } else {
        return null;
      }
    }
  }

  if (
    null === kind ||
    null === since ||
    null === until ||
    isNaN(kind) ||
    isNaN(since) ||
    isNaN(until) ||
    until <= since
  ) {
    return null;
  }

  return { kind, since, until };
}
