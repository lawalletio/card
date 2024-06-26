import type { NDKEvent, NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';

import { Debugger } from 'debug';

import { Kind, buildMultiNip04Event } from '@lib/event';
import { logger, nowInSeconds, requiredEnvVar } from '@lib/utils';

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
  '#t': [`${ConfigTypes.CONFIG.valueOf()}-change`],
  since: nowInSeconds() - 86000,
};

const cardPrivateKey: string = requiredEnvVar('NOSTR_PRIVATE_KEY');
const cardPublicKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');

const log: Debugger = logger.extend('nostr:card:config:change');
const error: Debugger = log.extend('error');

/**
 * Return the internal-transaction-ok handler
 */
const getHandler = (ctx: Context): ((event: NostrEvent) => void) => {
  /**
   * Handle "<HOLDER_PUBKEY>:card-config" events
   *
   */
  return async (event: NostrEvent) => {
    log(
      'Handling card-config-change: %O',
      await (event as NDKEvent).toNostrEvent(),
    );

    const holderPubKey: string = event.pubkey;
    const content: CardConfigPayload = await parseCardConfigEvent(
      event,
      cardPrivateKey,
      cardPublicKey,
    );

    try {
      await ctx.prisma.$transaction(async (tx) => {
        log('Starting transaction');

        if ('trusted-merchants' in content) {
          log('Found trusted-merchants: %O', content['trusted-merchants']);
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
          log('Finished updating trusted merchants');
        } else {
          log('No trusted-merchants found');
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
        log('Found the following card uuids: %O', holderCardUuids);

        const modifications: Promise<unknown>[] = [];

        for (const uuid in content.cards) {
          log('Dealing with cardUuid: %O', uuid);
          if (!holderCardUuids.includes(uuid)) {
            log('Not listed');
            continue;
          }
          if ('limits' in content.cards[uuid]) {
            log('Found limits: %O', content.cards[uuid].limits);
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
                log('Finished updating limits for cardUuid: %O', cardUuid);
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

          log('Will update: %O', cardUpdate);
          modifications.push(
            tx.card.update({ where: { uuid }, data: cardUpdate }),
          );
        }

        await Promise.all(modifications);
        log('Finished updating');

        log('Will send config-ack');
        const configAckEvent: NostrEvent = await buildMultiNip04Event(
          JSON.stringify(
            await buildCardConfigPayload(holderPubKey, tx as PrismaClient),
            (_, v) => (typeof v === 'bigint' ? String(v) : v),
          ),
          cardPrivateKey,
          cardPublicKey,
          [cardPublicKey, holderPubKey],
        );
        configAckEvent.kind = Kind.PARAMETRIZED_REPLACEABLE.valueOf();
        configAckEvent.tags = configAckEvent.tags.concat([
          ['e', event.id!],
          ['t', ConfigTypes.CONFIG.valueOf()],
          ['d', `${holderPubKey}:${ConfigTypes.CONFIG.valueOf()}`],
        ]);
        log('Sending config-ack event: %O', configAckEvent);

        await ctx.outbox.publish(configAckEvent);
        log('Finished handling card-config-change');
      });
    } catch (e) {
      error('Unexpected error: %O', e);
    }
  };
};

export { filter, getHandler };
