import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';

import { Kind } from '@lib/event';
import { nowInSeconds, requiredEnvVar } from '@lib/utils';

import {
  ConfigTypes,
  CardConfigPayload,
  Limit,
  parseCardConfigEvent,
  CardStatus,
} from '@lib/config';

import { Context } from '@type/request';

import { Prisma } from '@prisma/client';

const filter: NDKFilter = {
  kinds: [Kind.PARAMETRIZED_REPLACEABLE.valueOf()],
  '#p': [requiredEnvVar('NOSTR_PUBLIC_KEY')],
  '#t': [ConfigTypes.CONFIG.valueOf()],
  since: nowInSeconds() - 86000,
};

const cardPrivateKey: string = requiredEnvVar('NOSTR_PRIVATE_KEY');
const cardPublicKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');

/**
 * Extract value of first "d" tag adhering to the config template, or null if none found
 */
function extractDPubkey(event: NostrEvent): string | null {
  try {
    return (
      (event.tags.find(
        (t: string[]): boolean =>
          'd' === t[0] && t[1].endsWith(`:${ConfigTypes.CONFIG.valueOf()}`),
      ) ?? [null, null])[1]?.split(':')[0] ?? null
    );
  } catch {
    /* ... */
  }
  return null;
}

/**
 * Return the internal-transaction-ok handler
 */
const getHandler = (ctx: Context): ((event: NostrEvent) => void) => {
  /**
   * Handle "<HOLDER_PUBKEY>:card-config" events
   *
   */
  return async (event: NostrEvent) => {
    const holderPubKey: string | null = extractDPubkey(event);
    if (null === holderPubKey) {
      throw new Error('Missing holder pubkey');
    }

    const content: CardConfigPayload = await parseCardConfigEvent(
      event,
      cardPrivateKey,
      cardPublicKey,
    );

    await ctx.prisma.$transaction(async (tx) => {
      const merchantPubKeys: string[] = (
        await tx.merchant.findMany({
          select: {
            pubKey: true,
          },
        })
      ).map((merchant: { pubKey: string }): string => merchant.pubKey);
      await tx.trustedMerchants.deleteMany({
        where: {
          holderPubKey: holderPubKey,
        },
      });
      await tx.trustedMerchants.createMany({
        data: content['trusted-merchants']
          .filter((trustedMerchant: { pubkey: string }): boolean =>
            merchantPubKeys.includes(trustedMerchant.pubkey),
          )
          .map(
            (trustedMerchant: {
              pubkey: string;
            }): Prisma.TrustedMerchantsCreateManyInput => {
              return {
                holderPubKey: holderPubKey,
                merchantPubKey: trustedMerchant.pubkey,
              };
            },
          ),
      });

      const holderCardUuids: string[] = (
        await tx.card.findMany({
          where: {
            holderPubKey: holderPubKey,
          },
          select: {
            uuid: true,
          },
        })
      ).map((x: { uuid: string }) => x.uuid);

      const cardUuids: string[] = Object.keys(content.cards).filter(
        (uuid: string): boolean => holderCardUuids.includes(uuid),
      );

      await tx.limit.deleteMany({
        where: {
          cardUuid: {
            in: cardUuids,
          },
        },
      });
      await tx.limit.createMany({
        data: ([] as Prisma.LimitCreateManyInput[]).concat(
          ...cardUuids.map((uuid: string): Prisma.LimitCreateManyInput[] => {
            return content.cards[uuid].limits.map(
              (limit: Limit): Prisma.LimitCreateManyInput => {
                return {
                  cardUuid: uuid,
                  amount: limit.amount,
                  delta: limit.delta,
                  description: limit.description,
                  name: limit.name,
                  token: limit.token,
                };
              },
            );
          }),
        ),
      });
      cardUuids.forEach(async (uuid) => {
        await tx.card.update({
          where: { uuid },
          data: {
            description: content.cards[uuid].description,
            enabled: content.cards[uuid].status === CardStatus.ENABLED,
            name: content.cards[uuid].name,
          },
        });
      });
    });
  };
};

export { filter, getHandler };
