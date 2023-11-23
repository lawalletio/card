import { Debugger } from 'debug';
import type { Response } from 'express';

import {
  parseEventBody,
  responseEvent,
  validateDelegation,
  validateDelegationConditions,
} from '@lib/event';
import { logger, requiredEnvVar } from '@lib/utils';
import type { ExtendedRequest } from '@type/request';
import { Holder, Prisma, PrismaClient } from '@prisma/client';
import { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';
import { getWriteNDK } from '@services/ndk';
import { buildCardDataEvent } from '@lib/config';

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
  const reqEvent: NostrEvent | null = parseEventBody(req.body);
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
      include: {
        holder: true,
        limits: true,
      },
    })
    .then(async (card) => {
      const resEvent = new NDKEvent(
        getWriteNDK(),
        responseEvent(
          'card-activate-response',
          JSON.stringify(card, (_, v) =>
            typeof v === 'bigint' ? Number(v) : v,
          ),
          reqEvent,
        ),
      );
      await resEvent.sign();
      const event = await buildCardDataEvent(
        reqEvent.pubkey,
        req.context.prisma,
      );
      await req.context.outbox.publish(event);
      res
        .status(201)
        .send(
          JSON.stringify(await resEvent.toNostrEvent(), (_, v) =>
            typeof v === 'bigint' ? Number(v) : v,
          ),
        );
    })
    .catch((e) => {
      error('Unexpected error: %O', e);
      res.status(500).send();
    });
};

export default handler;
