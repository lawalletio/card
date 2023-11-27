import { NostrEvent } from '@nostr-dev-kit/ndk';
import { PrismaClient } from '@prisma/client';
import { Kind, buildMultiNip04Event, parseMultiNip04Event } from '@lib/event';
import { requiredEnvVar } from '@lib/utils';

const cardPrivateKey: string = requiredEnvVar('NOSTR_PRIVATE_KEY');
const cardPublicKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');

export enum CardStatus {
  ENABLED = 'ENABLED',
  DISABLED = 'DISABLED',
}

export enum ConfigTypes {
  DATA = 'card-data',
  CONFIG = 'card-config',
}

export type Design = { uuid: string; name: string; description: string };
export type CardDataPayload = { [uuid: string]: { design: Design } };

export type Limit = {
  name: string;
  description: string;
  token: string;
  amount: bigint;
  delta: number;
};
export type CardPayload = {
  name: string;
  description: string;
  status: string;
  limits: Limit[];
};
export type CardConfigPayload = {
  'trusted-merchants': { pubkey: string }[];
  cards: { [uuid: string]: CardPayload };
};

export async function buildCardDataPayload(
  holderPubKey: string,
  prisma: PrismaClient,
): Promise<CardDataPayload> {
  return Object.fromEntries(
    (
      await prisma.card.findMany({
        where: {
          holderPubKey: holderPubKey,
        },
        select: {
          uuid: true,
          ntag424: {
            select: {
              design: true,
            },
          },
        },
      })
    ).map((data: { uuid: string; ntag424: { design: Design } }) => [
      data.uuid,
      { design: data.ntag424.design },
    ]),
  );
}

export async function buildCardConfigPayload(
  holderPubKey: string,
  prisma: PrismaClient,
): Promise<CardConfigPayload> {
  type DBCard = {
    uuid: string;
    name: string;
    description: string;
    enabled: boolean;
    limits: Limit[];
  };

  return {
    'trusted-merchants': (
      await prisma.trustedMerchants.findMany({
        where: {
          holderPubKey,
        },
        select: {
          merchantPubKey: true,
        },
      })
    ).map((merchant: { merchantPubKey: string }) => {
      return { pubkey: merchant.merchantPubKey };
    }),
    cards: Object.fromEntries(
      (
        await prisma.card.findMany({
          where: {
            holderPubKey,
          },
          select: {
            uuid: true,
            name: true,
            description: true,
            enabled: true,
            limits: {
              select: {
                name: true,
                description: true,
                token: true,
                amount: true,
                delta: true,
              },
            },
          },
        })
      ).map((card: DBCard) => [
        card.uuid,
        {
          name: card.name,
          description: card.description,
          status: card.enabled ? CardStatus.ENABLED : CardStatus.DISABLED,
          limits: card.limits,
        },
      ]),
    ),
  };
}

/**
 * Build a "card-data" event (implemented as a "Multi NIP-04"-type event)
 *
 * A "card-data" event communicates to the holder the card-module-owned data regarding a specific card.
 * This event has a "t" (ie. sub-kind) tag equal to "card-data".
 * This event is a parameterized replaceable event (ie. kind equal to 31111) with "d" tag value equal to "<HOLDER_PUBKEY>:card-data" (where
 * HOLDER_PUBKEY is the holder's public key as is known to the card module).
 *
 * The message's content is the JSON serialization of the following object:
 *
 *   {
 *     <CARD_UUID_1>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_1>,
 *         "name": <DESIGN_NAME_1>,
 *         "description": <DESIGN_DESCRIPTION_1>
 *       }
 *     },
 *     <CARD_UUID_2>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_2>,
 *         "name": <DESIGN_NAME_2>,
 *         "description": <DESIGN_DESCRIPTION_2>
 *       }
 *     },
 *     ...,
 *     <CARD_UUID_N>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_N>,
 *         "name": <DESIGN_NAME_N>,
 *         "description": <DESIGN_DESCRIPTION_N>
 *       }
 *     }
 *   }
 *
 * Where:
 *
 *   - CARD_UUID_*: is the UUIDs associated to the cards whose data is being communicated
 *   - DESIGN_UUID_*: is the UUID of the design (or "theme") associated to the physical card in question
 *   - DESIGN_NAME_*: is the name given to the design (or "theme") associated to the physical card in question
 *   - DESIGN_DESCRIPTION_*: is the description given to the design (or "theme") associated to the physical card in question
 *
 * The "Multi NIP-04" event is readable by both the holder and the card module itself.
 *
 *
 * @param holderPubKey  The public key of the holder for which the card data event is being generated
 * @returns  An unsigned "Multi NIP-04" NOSTR event
 */
export async function buildCardDataEvent(
  holderPubKey: string,
  prisma: PrismaClient,
): Promise<NostrEvent> {
  const event: NostrEvent = await buildMultiNip04Event(
    JSON.stringify(buildCardDataPayload(holderPubKey, prisma)),
    cardPrivateKey,
    cardPublicKey,
    [cardPublicKey, holderPubKey],
  );
  event.kind = Kind.PARAMETRIZED_REPLACEABLE.valueOf();
  event.tags = event.tags.concat([
    ['t', ConfigTypes.DATA.valueOf()],
    ['d', `${holderPubKey}:${ConfigTypes.DATA.valueOf()}`],
  ]);

  return event;
}

/**
 * Parse a "card-data" event (implemented as a "Multi NIP-04"-type event)
 *
 * A "card-data" event communicates to the holder the card-module-owned data regarding a specific card.
 * This event has a "t" (ie. sub-kind) tag equal to "card-data".
 * This event is a parameterized replaceable event (ie. kind equal to 31111) with "d" tag value equal to "<HOLDER_PUBKEY>:card-data" (where
 * HOLDER_PUBKEY is the holder's public key as is known to the card module).
 *
 * The message's content is the JSON serialization of the following object:
 *
 *   {
 *     <CARD_UUID_1>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_1>,
 *         "name": <DESIGN_NAME_1>,
 *         "description": <DESIGN_DESCRIPTION_1>
 *       }
 *     },
 *     <CARD_UUID_2>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_2>,
 *         "name": <DESIGN_NAME_2>,
 *         "description": <DESIGN_DESCRIPTION_2>
 *       }
 *     },
 *     ...,
 *     <CARD_UUID_N>: {
 *       "design": {
 *         "uuid": <DESIGN_UUID_N>,
 *         "name": <DESIGN_NAME_N>,
 *         "description": <DESIGN_DESCRIPTION_N>
 *       }
 *     }
 *   }
 *
 * Where:
 *
 *   - CARD_UUID_*: is the UUIDs associated to the cards whose data is being communicated
 *   - DESIGN_UUID_*: is the UUID of the design (or "theme") associated to the physical card in question
 *   - DESIGN_NAME_*: is the name given to the design (or "theme") associated to the physical card in question
 *   - DESIGN_DESCRIPTION_*: is the description given to the design (or "theme") associated to the physical card in question
 *
 * The "Multi NIP-04" event is readable by both the holder and the card module itself.
 *
 *
 * @param event  The event to parse
 * @param receiverPrivKey  The private key of one of the expected message receivers
 * @param receiverPubKey  The corresponding public key of one of the expected message receivers
 * @returns  The message's content as an Object
 */
export async function parseCardDataEvent(
  event: NostrEvent,
  receiverPrivKey: string,
  receiverPubKey: string,
): Promise<CardDataPayload> {
  return JSON.parse(
    await parseMultiNip04Event(event, receiverPrivKey, receiverPubKey),
  );
}

/**
 * Build a "card-config" event (implemented as a "Multi NIP-04"-type event)
 *
 * A "card-config" event is generated by the holder and directed to the card module regarding a specific card's user-supplied configuration.
 * This event has a "t" (ie. sub-kind) tag equal to "card-config".
 * This event is a parameterized replaceable event (ie. kind equal to 31111) with "d" tag value equal to "<HOLDER_PUBKEY>:card-config" (where
 * HOLDER_PUBKEY is the holder's public key as is known to the card module).
 *
 * The message's content is the JSON serialization of the following object:
 *
 *   {
 *     "trusted-merchants": [
 *       { "pubkey": <TRUSTED_MERCHANT_1_PUBLIC_KEY> },
 *       { "pubkey": <TRUSTED_MERCHANT_2_PUBLIC_KEY> },
 *       ...
 *       { "pubkey": <TRUSTED_MERCHANT_N_PUBLIC_KEY> }
 *     ],
 *     "cards": {
 *       <CARD_UUID_1>: {
 *         "name": <CARD_NAME_1>,
 *         "description": <CARD_DESCRIPTION_1>,
 *         "status": <CARD_STATUS_1>,
 *         "limits": <LIMITS_1>
 *       },
 *       <CARD_UUID_2>: {
 *         "name": <CARD_NAME_2>,
 *         "description": <CARD_DESCRIPTION_2>,
 *         "status": <CARD_STATUS_2>,
 *         "limits": <LIMITS_2>
 *       },
 *       ...,
 *       <CARD_UUID_N>: {
 *         "name": <CARD_NAME_N>,
 *         "description": <CARD_DESCRIPTION_N>,
 *         "status": <CARD_STATUS_N>,
 *         "limits": <LIMITS_N>
 *       }
 *     }
 *   }
 *
 * Where the LIMITS_* structure is an array of the form:
 *
 *   [
 *     {
 *       "name": <LIMIT_NAME_1>,
 *       "description": <LIMIT_DESCRIPTION_1>,
 *       "token": <LIMIT_TOKEN_1>,
 *       "amount": <LIMIT_AMOUNT_1>,
 *       "delta": <LIMIT_DELTA_1>
 *     },
 *     {
 *       "name": <LIMIT_NAME_2>,
 *       "description": <LIMIT_DESCRIPTION_2>,
 *       "token": <LIMIT_TOKEN_2>,
 *       "amount": <LIMIT_AMOUNT_2>,
 *       "delta": <LIMIT_DELTA_2>
 *     },
 *     ...,
 *     {
 *       "name": <LIMIT_NAME_N>,
 *       "description": <LIMIT_DESCRIPTION_N>,
 *       "token": <LIMIT_TOKEN_N>,
 *       "amount": <LIMIT_AMOUNT_N>,
 *       "delta": <LIMIT_DELTA_N>
 *     }
 *   ]
 *
 * Where:
 *
 *   - TRUSTED_MERCHANT_*_PUBLIC_KEY: the public key associated to a trusted merchant
 *   - CARD_UUID_*: is the UUID associated to the card whose data is being communicated
 *   - CARD_NAME_*: the name associated to the card whose data is being communicated
 *   - CARD_DESCRIPTION_*: the description associated to the card whose data is being communicated
 *   - CARD_STATUS_*: the status associated to the card whose data is being communicated (currently either "ENABLED" or "DISABLED")
 *   - LIMIT_NAME_*: the name associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_DESCRIPTION_*: the description associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_TOKEN_*: the token associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_AMOUNT_*: the amount associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_DELTA_*: the time delta associated to the current limit entry of card whose data is being communicated
 *
 * The "Multi NIP-04" event is readable by both the holder and the card module itself.
 *
 *
 * @param holderPrivKey  The private key of the holder for which the card data event is being generated
 * @param holderPubKey  The corresponding public key of the holder for which the card data event is being generated
 * @returns  An unsigned "Multi NIP-04" NOSTR event
 */
export async function buildCardConfigEvent(
  holderPrivKey: string,
  holderPubKey: string,
  prisma: PrismaClient,
): Promise<NostrEvent> {
  const event: NostrEvent = await buildMultiNip04Event(
    JSON.stringify(await buildCardConfigPayload(holderPubKey, prisma)),
    holderPrivKey,
    holderPubKey,
    [cardPublicKey, holderPubKey],
  );
  event.kind = Kind.PARAMETRIZED_REPLACEABLE.valueOf();
  event.tags.concat([
    ['t', ConfigTypes.CONFIG.valueOf()],
    ['d', `${holderPubKey}:${ConfigTypes.CONFIG.valueOf()}`],
  ]);

  return event;
}

/**
 * Parse a "card-config" event (implemented as a "Multi NIP-04"-type event)
 *
 * A "card-config" event is generated by the holder and directed to the card module regarding a specific card's user-supplied configuration.
 * This event has a "t" (ie. sub-kind) tag equal to "card-config".
 * This event is a parameterized replaceable event (ie. kind equal to 31111) with "d" tag value equal to "<HOLDER_PUBKEY>:card-config" (where
 * HOLDER_PUBKEY is the holder's public key as is known to the card module).
 *
 * The message's content is the JSON serialization of the following object:
 *
 *   {
 *     "trusted-merchants": [
 *       { "pubkey": <TRUSTED_MERCHANT_1_PUBLIC_KEY> },
 *       { "pubkey": <TRUSTED_MERCHANT_2_PUBLIC_KEY> },
 *       ...
 *       { "pubkey": <TRUSTED_MERCHANT_N_PUBLIC_KEY> }
 *     ],
 *     "cards": {
 *       <CARD_UUID_1>: {
 *         "name": <CARD_NAME_1>,
 *         "description": <CARD_DESCRIPTION_1>,
 *         "status": <CARD_STATUS_1>,
 *         "limits": <LIMITS_1>
 *       },
 *       <CARD_UUID_2>: {
 *         "name": <CARD_NAME_2>,
 *         "description": <CARD_DESCRIPTION_2>,
 *         "status": <CARD_STATUS_2>,
 *         "limits": <LIMITS_2>
 *       },
 *       ...,
 *       <CARD_UUID_N>: {
 *         "name": <CARD_NAME_N>,
 *         "description": <CARD_DESCRIPTION_N>,
 *         "status": <CARD_STATUS_N>,
 *         "limits": <LIMITS_N>
 *       }
 *     }
 *   }
 *
 * Where the LIMITS_* structure is an array of the form:
 *
 *   [
 *     {
 *       "name": <LIMIT_NAME_1>,
 *       "description": <LIMIT_DESCRIPTION_1>,
 *       "token": <LIMIT_TOKEN_1>,
 *       "amount": <LIMIT_AMOUNT_1>,
 *       "delta": <LIMIT_DELTA_1>
 *     },
 *     {
 *       "name": <LIMIT_NAME_2>,
 *       "description": <LIMIT_DESCRIPTION_2>,
 *       "token": <LIMIT_TOKEN_2>,
 *       "amount": <LIMIT_AMOUNT_2>,
 *       "delta": <LIMIT_DELTA_2>
 *     },
 *     ...,
 *     {
 *       "name": <LIMIT_NAME_N>,
 *       "description": <LIMIT_DESCRIPTION_N>,
 *       "token": <LIMIT_TOKEN_N>,
 *       "amount": <LIMIT_AMOUNT_N>,
 *       "delta": <LIMIT_DELTA_N>
 *     }
 *   ]
 *
 * Where:
 *
 *   - TRUSTED_MERCHANT_*_PUBLIC_KEY: the public key associated to a trusted merchant
 *   - CARD_UUID_*: is the UUID associated to the card whose data is being communicated
 *   - CARD_NAME_*: the name associated to the card whose data is being communicated
 *   - CARD_DESCRIPTION_*: the description associated to the card whose data is being communicated
 *   - CARD_STATUS_*: the status associated to the card whose data is being communicated (currently either "ENABLED" or "DISABLED")
 *   - LIMIT_NAME_*: the name associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_DESCRIPTION_*: the description associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_TOKEN_*: the token associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_AMOUNT_*: the amount associated to the current limit entry of card whose data is being communicated
 *   - LIMIT_DELTA_*: the time delta associated to the current limit entry of card whose data is being communicated
 *
 * The "Multi NIP-04" event is readable by both the holder and the card module itself.
 *
 *
 * @param event  The event to parse
 * @param receiverPrivKey  The private key of one of the expected message receivers
 * @param receiverPubKey  The corresponding public key of one of the expected message receivers
 * @returns  The message's content as an Object
 */
export async function parseCardConfigEvent(
  event: NostrEvent,
  receiverPrivKey: string,
  receiverPubKey: string,
): Promise<CardConfigPayload> {
  return JSON.parse(
    await parseMultiNip04Event(event, receiverPrivKey, receiverPubKey),
  );
}
