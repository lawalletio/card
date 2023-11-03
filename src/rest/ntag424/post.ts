import { randomBytes } from 'crypto';
import { Debugger } from 'debug';
import type { Response } from 'express';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { Ntag424, Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

import { logger, requiredEnvVar, uuidRegex } from '@lib/utils';
import { getWriteNDK } from '@services/ndk';
import type { ExtendedRequest } from '@type/request';
import { parseEventBody, responseEvent } from '@lib/event';

const log: Debugger = logger.extend('rest:ntag424:post');
const error: Debugger = log.extend('error');
const U_CONSTRAINT_VIOLATION = 'P2002';
const DEPENDENCY_NOT_FOUND = 'P2025';

type CardInitRequest = {
  cid: string;
  ctr: number;
  design: { name: string } | { uuid: string };
};

/**
 * Returns pseudorandom hex string of provided size in bytes
 */
function randomHex(size: number): string {
  return randomBytes(size).toString('hex');
}

/**
 * Parse and validate content
 */
function parseCardInitRequest(content: string): CardInitRequest {
  const req = JSON.parse(content);

  const cid: string | null = req?.cid ?? null;
  const ctr: number | null = req?.ctr ?? null;
  const designName: string | null = req?.design?.name ?? null;
  const designUuid: string | null = req?.design?.uuid ?? null;

  if (
    null === cid ||
    null === ctr ||
    (null === designName &&
      (null === designUuid || !designUuid.match(uuidRegex)))
  ) {
    throw new Error('Not a valid content');
  }

  if (null === designName) {
    return { cid, ctr, design: { uuid: designUuid as string } };
  } else {
    return { cid, ctr, design: { name: designName } };
  }
}

/**
 * Ntag424 data for database creation
 */
function createNtag424({
  cid,
  ctr,
  design,
}: CardInitRequest): Prisma.Ntag424CreateInput {
  return {
    cid,
    k0: randomHex(16).toLowerCase(),
    k1: requiredEnvVar('SERVER_AES_KEY_HEX').toLowerCase(),
    k2: randomHex(16).toLowerCase(),
    k3: randomHex(16).toLowerCase(),
    k4: randomHex(16).toLowerCase(),
    ctr,
    design: { connect: design },
  };
}

/**
 * Initialize a new ntag424 on the database
 *
 * Generate the keys and return the newly created card
 *
 * Expected event content:
 *  {
 *    "cid": <card_id>,
 *    "ctr": <card_last_counter>,
 *    "design":
 *      {
 *        "name"?: <design_name>,
 *        "uuid"?: <design_uuid>
 *      }
 *  }
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent = parseEventBody(
    req.body,
    requiredEnvVar('CARD_WRITER_PUBKEY'),
  );
  if (null === reqEvent) {
    log('Received invalid nostr event %O', reqEvent);
    res.status(422).send();
    return;
  }

  let content: CardInitRequest;
  try {
    content = parseCardInitRequest(reqEvent.content);
  } catch (e) {
    log('Not valid content: %O', reqEvent.content);
    res.status(422).send();
    return;
  }
  let ntag424: Ntag424;
  try {
    ntag424 = await req.context.prisma.ntag424.create({
      data: createNtag424(content),
    });
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError) {
      switch (e.code) {
        case U_CONSTRAINT_VIOLATION:
          ntag424 = (await req.context.prisma.ntag424.findFirst({
            where: { cid: content.cid },
          })) as Ntag424;
          break;
        case DEPENDENCY_NOT_FOUND:
          res.status(422).send();
          return;
        default:
          error('Could not insert Ntag424: %O', e);
          res.status(500).send();
          return;
      }
    } else {
      error('Could not insert Ntag424: %O', e);
      res.status(500).send();
      return;
    }
  }
  const resEvent = new NDKEvent(
    getWriteNDK(),
    responseEvent('card-init-response', JSON.stringify(ntag424), reqEvent),
  );
  await resEvent.sign();
  res
    .status(201)
    .send(
      JSON.stringify(await resEvent.toNostrEvent(), (_, v) =>
        typeof v === 'bigint' ? Number(v) : v,
      ),
    );
};

export default handler;
