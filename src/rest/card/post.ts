import { Debugger } from 'debug';
import type { Response } from 'express';

import { parseEventBody } from '@lib/event';
import { logger, nowInSeconds, requiredEnvVar, requiredProp } from '@lib/utils';
import type { ExtendedRequest } from '@type/request';
import { Card, Holder, Prisma, PrismaClient } from '@prisma/client';
import { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';
import { getWriteNDK } from '@services/ndk';

const log: Debugger = logger.extend('rest:card:post');
const error: Debugger = log.extend('error');

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

/**
 * Parse and validate a nip26 conditions string
 *
 * @return the kind, since and until if the conditions is valid, null
 * otherwise
 */
function validateDelegationConditions(
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

  if (null === kind || null === since || null === until || isNaN(kind) || isNaN(since) || isNaN(until) || until <= since) {
    return null;
  }

  return { kind, since, until };
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
        .map<Prisma.LimitCreateWithoutCardInput>((l) => {
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
    .map<{ merchantPubKey: string }>((m) => {
      return { merchantPubKey: m };
    });
}

/**
 * Return a holder from the database based on hex pubkey
 *
 * If there is no holder with that pubkey, create one. Associate
 * delegation from the request and trusted merchants from the default
 * ones
 */
function findOrCreateHolder(
  prisma: PrismaClient,
  pubKey: string,
  delegation: DelegationReq,
): Promise<Holder> {
  const trustedMerchants = defaultTrustedMerchants();
  return prisma.holder.upsert({
    create: {
      pubKey,
      delegations: {
        create: delegation,
      },
      trustedMerchants: {
        createMany: {
          data: trustedMerchants,
        },
      },
    },
    update: {
      delegations: {
        connectOrCreate: {
          where: {
            delegationToken: delegation.delegationToken,
          },
          create: delegation,
        },
      },
      trustedMerchants: {
        connectOrCreate:
          trustedMerchants.map<Prisma.TrustedMerchantsCreateOrConnectWithoutHolderInput>(
            ({ merchantPubKey }) => {
              return {
                where: {
                  holderPubKey_merchantPubKey: {
                    holderPubKey: pubKey,
                    merchantPubKey,
                  },
                },
                create: { merchantPubKey },
              };
            },
          ),
      },
    },
    where: {
      pubKey,
    },
    select: { pubKey: true },
  });
}

/**
 * Return the signed response event for card activation
 *
 * The content of the event is a stringified Card record.
 */
function cardActivateRes(req: NostrEvent, card: Card): NostrEvent {
  return {
    pubkey: requiredEnvVar('NOSTR_PUBLIC_KEY'),
    created_at: nowInSeconds(),
    kind: 21111,
    tags: [
      ['p', req.pubkey],
      ['e', requiredProp(req, 'id')],
      ['t', 'card-activate-response'],
    ],
    content: JSON.stringify(card, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  };
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
  const conditions = validateDelegationConditions(req.delegation.conditions);
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
 * Endpoint for card activation.
 *
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
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent = parseEventBody(req.body);
  if (!reqEvent) {
    res.status(422).send();
    return;
  }
  let content: CardActivateReq;
  try {
    content = parseCardActivateReq(reqEvent.content);
  } catch (e) {
    log('Error: %O', e);
    log('Not valid content: %O', reqEvent.content);
    res.status(422).send();
    return;
  }
  const ntag424 = await req.context.prisma.ntag424.findFirst({
    select: { cid: true, design: true },
    where: {
      otc: content.otc,
      card: null, // we only care about available ntags
    },
  });
  if (!ntag424) {
    res.status(404).send();
    return;
  }
  const holder = await findOrCreateHolder(
    req.context.prisma,
    reqEvent.pubkey,
    content.delegation,
  );
  req.context.prisma.card
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
      include: { holder: true, limits: true },
    })
    .then(async (card) => {
      const resEvent = new NDKEvent(
        getWriteNDK(),
        cardActivateRes(reqEvent, card),
      );
      res
        .status(201)
        .json(await resEvent.toNostrEvent())
        .send();
    })
    .catch((e) => {
      error('Unexpected error: %O', e);
      res.status(500).send();
    });
};

export default handler;
