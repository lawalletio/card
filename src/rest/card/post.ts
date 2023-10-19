import { randomBytes } from 'crypto';
import { Debugger } from 'debug';
import type { Response } from 'express';
import { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';
import { nip26, validateEvent, verifySignature } from 'nostr-tools';
import { Ntag424 } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

import {
  isEmpty,
  logger,
  nowInSeconds,
  requiredEnvVar,
  requiredProp,
} from '@lib/utils';
import { getWriteNDK } from '@services/ndk';
import type { ExtendedRequest } from '@type/request';

const log: Debugger = logger.extend('rest:card:post');
const debug: Debugger = log.extend('debug');
const error: Debugger = log.extend('error');
const U_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Returns pseudorandom hex string of provided length
 */
function randomHex(length: number): string {
  return randomBytes(length).toString('hex');
}

/**
 * Create a nostr event with ntag424 information
 */
function cardInitRes(req: NostrEvent, ntag424: Ntag424): NostrEvent {
  return {
    pubkey: requiredEnvVar('NOSTR_PUBLIC_KEY'),
    created_at: nowInSeconds(),
    kind: 21111,
    tags: [
      ['p', req.pubkey],
      ['e', requiredProp(req, 'id')],
      ['t', 'card-init-response'],
    ],
    content: JSON.stringify(ntag424),
  };
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
 * Initialize a new ntag424 on the database
 *
 * Generate the keys and return the newly created card
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent: NostrEvent = req.body;
  if (isEmpty(reqEvent)) {
    log('Received unparsable body %O', req.body);
    res.status(415).send();
    return;
  }
  debug('Received event: %O', reqEvent);

  let content: { cid: string; ctr: number };
  if (
    !validateEvent(reqEvent) ||
    !verifySignature(reqEvent) ||
    !validateNip26(reqEvent) ||
    reqEvent.pubkey !== requiredEnvVar('CARD_WRITER_PUBKEY') ||
    !(content = JSON.parse(reqEvent.content))?.cid ||
    typeof content.ctr !== 'number'
  ) {
    log('Received invalid nostr event %O', reqEvent);
    res.status(422).send();
    return;
  }

  const data = {
    cid: content.cid,
    k0: randomHex(16),
    k1: requiredEnvVar('K1_ENC_KEY'),
    k2: randomHex(16),
    k3: randomHex(16),
    k4: randomHex(16),
    ctr: content.ctr,
  };
  let ntag424: Ntag424;
  try {
    ntag424 = await req.context.prisma.ntag424.create({ data });
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError) {
      switch (e.code) {
        case U_CONSTRAINT_VIOLATION:
          res.status(409).send();
          return;
          break;
        default:
          break;
      }
    }
    error('Could not insert Ntag424: %O', e);
    res.status(500).send();
    return;
  }
  const resEvent = new NDKEvent(getWriteNDK(), cardInitRes(reqEvent, ntag424));
  await resEvent.sign();
  res
    .status(201)
    .json(await resEvent.toNostrEvent())
    .send();
};

export default handler;
