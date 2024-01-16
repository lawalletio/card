import { Debugger } from 'debug';
import type { Response } from 'express';

import {
  Kind,
  buildMultiNip04Event,
  getTagValue,
  parseEventBody,
  responseEvent,
  validateDelegation,
  validateDelegationConditions,
} from '@lib/event';
import { logger, requiredEnvVar } from '@lib/utils';
import type { Context, ExtendedRequest, RestHandler } from '@type/request';
import { Holder, Prisma, PrismaClient } from '@prisma/client';
import { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';
import {
  ConfigTypes,
  buildCardConfigPayload,
  buildCardDataEvent,
  buildCardDataPayload,
} from '@lib/config';
import { nip04 } from 'nostr-tools';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

const log: Debugger = logger.extend('rest:card:post');
const error: Debugger = log.extend('error');

const cardPrivateKey: string = requiredEnvVar('NOSTR_PRIVATE_KEY');
const cardPublicKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');

type DelegationReq = {
  since: Date;
  until: Date;
  conditions: string;
  delegationToken: string;
};

type CardActivateReq = {
  otc: string;
  delegation: DelegationReq;
};

type CardTransferReq = {
  delegation: DelegationReq;
  donationEvent: NostrEvent;
};

type EventHandler = {
  (event: NostrEvent, req: ExtendedRequest, res: Response): Promise<void>;
};

/**
 * Sends the http response with error message
 * @param res The response object
 * @param status code to be sent
 * @param reason string to be sent
 */
function sendError(res: Response, status: number, reason: string): void {
  res.status(status).json({ status: 'ERROR', reason }).send();
}

/**
 * Return the default limits from environment variable
 *
 * The environment variable `DEFAULT_LIMITS` is expected to be a colon
 * separated list of semi-colon separated objects with the following
 * fields:
 *    name;description;token;amount;delta
 */
function defaultLimits(): Prisma.LimitCreateNestedManyWithoutCardInput {
  return {
    createMany: {
      data: requiredEnvVar('DEFAULT_LIMITS')
        .split(':')
        .map((l: string): Prisma.LimitCreateWithoutCardInput => {
          const limit = l.split(';');
          return {
            name: limit[0],
            description: limit[1],
            token: limit[2],
            amount: BigInt(limit[3]),
            delta: Number(limit[4]),
          };
        }),
    },
  };
}

/**
 * Return the default trusted merchants from environment variable
 *
 * The environment variable `DEFAULT_TRUSTED_MERCHANTS` is expected to
 * be a colon separated list of hex public keys
 */
function defaultTrustedMerchants(): Prisma.TrustedMerchantsUncheckedCreateWithoutHolderInput[] {
  return requiredEnvVar('DEFAULT_TRUSTED_MERCHANTS')
    .split(':')
    .filter((m: string): boolean => !!m)
    .map((m: string): { merchantPubKey: string } => {
      return { merchantPubKey: m };
    });
}

/**
 * Return a holder from the database based on hex pubkey
 *
 * If there is no holder with that pubkey, create one. Associate
 * delegation from the request and trusted merchants from the default
 * ones if they exist
 */
function findOrCreateHolder(
  prisma: PrismaClient,
  pubKey: string,
  delegation: DelegationReq,
): Promise<Holder> {
  const trustedMerchants: Prisma.TrustedMerchantsUncheckedCreateWithoutHolderInput[] =
    defaultTrustedMerchants();
  const create: Prisma.HolderCreateInput = {
    pubKey,
    delegations: { create: delegation },
  };
  const update: Prisma.HolderUpdateInput = {
    delegations: {
      connectOrCreate: {
        where: {
          delegationToken: delegation.delegationToken,
        },
        create: delegation,
      },
    },
  };
  if (0 < trustedMerchants.length) {
    create.trustedMerchants = {
      createMany: { data: trustedMerchants },
    };
    update.trustedMerchants = {
      connectOrCreate: trustedMerchants.map(
        (
          merchant: Prisma.TrustedMerchantsUncheckedCreateWithoutHolderInput,
        ): Prisma.TrustedMerchantsCreateOrConnectWithoutHolderInput => {
          return {
            where: {
              holderPubKey_merchantPubKey: {
                holderPubKey: pubKey,
                merchantPubKey: merchant.merchantPubKey,
              },
            },
            create: {
              merchantPubKey: merchant.merchantPubKey,
            },
          };
        },
      ),
    };
  }
  return prisma.holder.upsert({
    create,
    update,
    where: { pubKey },
    select: { pubKey: true },
  });
}

/**
 * Parse and validate request content
 *
 * @return the parsed card activate request
 * @throws Error if the content is not valid
 */
function parseCardActivateReq(content: string): CardActivateReq {
  const req = JSON.parse(content);
  if (
    typeof req.otc !== 'string' ||
    typeof req.delegation?.conditions !== 'string' ||
    typeof req.delegation?.token !== 'string'
  ) {
    throw new Error('Not a valid content');
  }
  const conditions: { kind: number; since: number; until: number } | null =
    validateDelegationConditions(req.delegation.conditions);
  if (!conditions) {
    throw new Error('Not valid delegation conditions');
  }
  req.delegation = {
    since: new Date(conditions.since * 1000),
    until: new Date(conditions.until * 1000),
    delegationToken: req.delegation.token,
    conditions: req.delegation.conditions,
  };
  return req;
}

/**
 * Parse and validate request content
 *
 * @return the parsed card transfer request
 * @throws Error if the content is not valid
 */
function parseCardTransferReq(content: string): CardTransferReq {
  const req = JSON.parse(content);
  req.donationEvent = parseEventBody(req.donationEvent);
  if (
    !req.donationEvent ||
    getTagValue(req.donationEvent, 't') !== 'card-transfer-donation' ||
    typeof req.delegation?.conditions !== 'string' ||
    typeof req.delegation?.token !== 'string'
  ) {
    throw new Error('Not a valid card transfer content');
  }
  const conditions: { kind: number; since: number; until: number } | null =
    validateDelegationConditions(req.delegation.conditions);
  if (!conditions) {
    throw new Error('Not valid delegation conditions');
  }
  req.delegation = {
    since: new Date(conditions.since * 1000),
    until: new Date(conditions.until * 1000),
    delegationToken: req.delegation.token,
    conditions: req.delegation.conditions,
  };
  return req;
}

/**
 * Publish the configuration events for the holder of a card
 *
 * @param holderPubKey pubkey of the holder for whom to publish the event
 * @param eventId that generated the publication
 * @param context that contains prisma and the outbox
 */
async function publishDataAndConfig(
  holderPubKey: string,
  eventId: string,
  context: Context,
): Promise<void> {
  const cardDataPayloadJson: string = JSON.stringify(
    await buildCardDataPayload(holderPubKey, context.prisma),
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
  );
  const cardDataEvent = await buildCardDataEvent(
    holderPubKey,
    cardDataPayloadJson,
  );
  const cardConfigEvent: NostrEvent = await buildMultiNip04Event(
    JSON.stringify(
      await buildCardConfigPayload(holderPubKey, context.prisma),
      (_, v) => (typeof v === 'bigint' ? String(v) : v),
    ),
    cardPrivateKey,
    cardPublicKey,
    [cardPublicKey, holderPubKey],
  );
  cardConfigEvent.kind = Kind.PARAMETRIZED_REPLACEABLE.valueOf();
  cardConfigEvent.tags = cardConfigEvent.tags.concat([
    ['e', eventId],
    ['t', ConfigTypes.CONFIG.valueOf()],
    ['d', `${holderPubKey}:${ConfigTypes.CONFIG.valueOf()}`],
  ]);

  await Promise.all([
    context.outbox.publish(cardDataEvent),
    context.outbox.publish(cardConfigEvent),
  ]);
}

/**
 * Takes a one time code and a nip26 delegation, if there is an
 * available ntag424 create a card record associated to the ntag and to
 * the holder.
 *
 * Expected event content:
 *  {
 *    "otc":<one-time-code>,
 *    "delegation": {
 *      "conditions": <nip26-conditions>,
 *      "token": <nip26-sig>
 *    }
 *  }
 */
const cardActivationHandler: EventHandler = async (
  reqEvent: NostrEvent,
  req: ExtendedRequest,
  res: Response,
) => {
  let content: CardActivateReq;
  try {
    content = parseCardActivateReq(reqEvent.content);
  } catch (e) {
    log('Error: %O', e);
    log('Not valid content: %O', reqEvent.content);
    res.status(422).send();
    return;
  }
  if (
    !validateDelegation(
      reqEvent.pubkey,
      content.delegation.conditions,
      content.delegation.delegationToken,
    )
  ) {
    log(
      'Received invalid delegation %O for pubkey %s',
      content.delegation,
      reqEvent.pubkey,
    );
    res.status(422).send();
    return;
  }
  const ntag424: Prisma.Ntag424GetPayload<{
    select: { cid: true; design: true };
  }> | null = await req.context.prisma.ntag424.findFirst({
    select: {
      cid: true,
      design: true,
    },
    where: {
      otc: content.otc,
      card: null, // we only care about available NTags
    },
  });
  if (!ntag424) {
    res.status(404).send();
    return;
  }
  const holder: Holder = await findOrCreateHolder(
    req.context.prisma,
    reqEvent.pubkey,
    content.delegation,
  );
  await req.context.prisma.card
    .create({
      data: {
        name: ntag424.design.name,
        description: ntag424.design.description,
        enabled: true,
        holder: {
          connect: {
            pubKey: holder.pubKey,
          },
        },
        ntag424: {
          connect: {
            cid: ntag424.cid,
          },
        },
        limits: defaultLimits(),
      },
      include: {
        holder: true,
        limits: true,
      },
    })
    .then(async (card) => {
      await publishDataAndConfig(card.holderPubKey!, reqEvent.id!, req.context);

      const cardActivateEvent = new NDKEvent(
        req.context.writeNDK,
        responseEvent(
          'card-activation-response',
          JSON.stringify(card, (_, v) =>
            typeof v === 'bigint' ? String(v) : v,
          ),
          reqEvent,
        ),
      );
      await cardActivateEvent.sign();
      res
        .status(201)
        .json(await cardActivateEvent.toNostrEvent())
        .send();
    })
    .catch((e) => {
      error('Unexpected error: %O', e);
      res.status(500).send();
    });
};

/**
 * Takes a nip26 delegation, and a donation event. After validating the
 * data, proceeds to transfer the card referred in the dontation event
 * to the signer of the received event
 *
 * Expected event content:
 *  {
 *    "delegation": {
 *      "conditions": <nip26-conditions>,
 *      "token": <nip26-sig>
 *    },
 *    "donationEvent": {
 *      ...
 *      content: <nip04 with donor privkey and card module pubkey of card uuid>
 *      tags: [
 *        ['t', 'card-transfer-donation']
 *      ]
 *      ...
 *    }
 *  }
 */
const cardTransferHandler: EventHandler = async (
  reqEvent: NostrEvent,
  req: ExtendedRequest,
  res: Response,
) => {
  let content: CardTransferReq;
  try {
    content = parseCardTransferReq(reqEvent.content);
  } catch (e) {
    log('Invalid transfer acceptance content: %O', e);
    sendError(res, 422, String(e));
    return;
  }
  if (
    !validateDelegation(
      reqEvent.pubkey,
      content.delegation.conditions,
      content.delegation.delegationToken,
    )
  ) {
    log(
      'Received invalid delegation %O for pubkey %s',
      content.delegation,
      reqEvent.pubkey,
    );
    sendError(res, 422, 'Invalid delegation');
    return;
  }
  const donor = reqEvent.tags
    .filter((t) => 'p' === t[0])
    .at(1)
    ?.at(1);
  if (!donor || donor !== content.donationEvent.pubkey) {
    log('Donation pubkey must be referred in acceptance event');
    sendError(res, 422, 'Donation pubkey must be referred in acceptance event');
    return;
  }
  let cardUuid;
  try {
    cardUuid = await nip04.decrypt(
      requiredEnvVar('NOSTR_PRIVATE_KEY'),
      donor,
      content.donationEvent.content,
    );
  } catch (e) {
    log(e);
    sendError(res, 422, String(e));
    return;
  }
  const holder: Holder = await findOrCreateHolder(
    req.context.prisma,
    reqEvent.pubkey,
    content.delegation,
  );
  await req.context.prisma.card
    .update({
      data: {
        enabled: false,
        holderPubKey: holder.pubKey,
      },
      where: {
        holderPubKey: donor,
        uuid: cardUuid,
      },
    })
    .then(async (card) => {
      await publishDataAndConfig(card.holderPubKey!, reqEvent.id!, req.context);
      const response = new NDKEvent(
        req.context.writeNDK,
        responseEvent(
          'card-transfer-response',
          JSON.stringify(card, (_, v) =>
            typeof v === 'bigint' ? String(v) : v,
          ),
          reqEvent,
        ),
      );
      await response.sign();
      res
        .status(200)
        .json(await response.toNostrEvent())
        .send();
    })
    .catch((e) => {
      if (e instanceof PrismaClientKnownRequestError && 'P2025' === e.code) {
        sendError(res, 404, 'Could not find card for donor');
        return;
      }
      error('Unexpected error: %O', e);
      res.status(500).send();
    });
};

/**
 * Based on a received tag value it returns a handler for the request,
 * returns a standard handler if no handler was found
 */
function getHandler(tag: string): EventHandler {
  switch (tag) {
    case 'card-activation-request':
      return cardActivationHandler;
    case 'card-transfer-acceptance':
      return cardTransferHandler;
    default:
      return async (reqEvent, req, res) => {
        log('Received invalid request: %0', reqEvent);
        res.status(422).send();
      };
  }
}

const handler: RestHandler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent: NostrEvent | null = parseEventBody(req.body);
  if (!reqEvent) {
    res.status(422).send();
    return;
  }
  await getHandler(getTagValue(reqEvent, 't') ?? '')(reqEvent, req, res);
};

export default handler;
