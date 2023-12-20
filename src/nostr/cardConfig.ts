import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';

import { Kind, buildMultiNip04Event } from '@lib/event';
import { nowInSeconds, requiredEnvVar } from '@lib/utils';

import {
  ConfigTypes,
  CardConfigPayload,
  Limit,
  parseCardConfigEvent,
  CardStatus,
  buildCardConfigPayload,
} from '@lib/config';

import { Context } from '@type/request';

import { Prisma, PrismaClient } from '@prisma/client';

const filter: NDKFilter = {
  kinds: [Kind.REGULAR.valueOf()],
  '#p': [requiredEnvVar('NOSTR_PUBLIC_KEY')],
  '#t': [`${ConfigTypes.CONFIG.valueOf()}-request`],
  since: nowInSeconds() - 86000,
};

const cardPrivateKey: string = requiredEnvVar('NOSTR_PRIVATE_KEY');
const cardPublicKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');

/**
 * Return the internal-transaction-ok handler
 */
const getHandler = (ctx: Context): ((event: NostrEvent) => void) => {
  /**
   * Handle "<HOLDER_PUBKEY>:card-config" events
   *
   */
  return async (event: NostrEvent) => {
    const holderPubKey: string = event.pubkey;
    const content: CardConfigPayload = await parseCardConfigEvent(
      event,
      cardPrivateKey,
      cardPublicKey,
    );

    await ctx.prisma.$transaction(async (tx) => {
      if ('trusted-merchants' in content) {
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
      }

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

      const modifications: Promise<unknown>[] = [];

      for (const uuid in content.cards) {
        if (!holderCardUuids.includes(uuid)) {
          continue;
        }
        if ('limits' in content.cards[uuid]) {
          modifications.push(
            (async function (cardUuid: string) {
              await tx.limit.deleteMany({ where: { cardUuid } });
              await tx.limit.createMany({
                data: content.cards[uuid].limits.map(
                  (limit: Limit): Prisma.LimitCreateManyInput => {
                    return {
                      cardUuid,
                      amount: limit.amount,
                      delta: limit.delta,
                      description: limit.description,
                      name: limit.name,
                      token: limit.token,
                    };
                  },
                ),
              });
            })(uuid),
          );
        }

        const cardUpdate: Prisma.CardUpdateInput = {};
        if ('name' in content.cards[uuid]) {
          cardUpdate.name = content.cards[uuid].name;
        }
        if ('description' in content.cards[uuid]) {
          cardUpdate.description = content.cards[uuid].description;
        }
        if ('status' in content.cards[uuid]) {
          cardUpdate.enabled =
            content.cards[uuid].status === CardStatus.ENABLED;
        }

        modifications.push(
          tx.card.update({ where: { uuid }, data: cardUpdate }),
        );
      }

      await Promise.all(modifications);

      const configAckEvent: NostrEvent = await buildMultiNip04Event(
        JSON.stringify(
          await buildCardConfigPayload(holderPubKey, tx as PrismaClient),
        ),
        cardPrivateKey,
        cardPublicKey,
        [cardPublicKey, holderPubKey],
      );
      configAckEvent.kind = Kind.PARAMETRIZED_REPLACEABLE.valueOf();
      configAckEvent.tags.concat([
        ['e', event.id!],
        ['t', ConfigTypes.CONFIG.valueOf()],
        ['d', `${holderPubKey}:${ConfigTypes.CONFIG.valueOf()}`],
      ]);

      ctx.outbox.publish(configAckEvent);
    });
  };
};

export { filter, getHandler };
