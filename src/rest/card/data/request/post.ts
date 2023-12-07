import { Debugger } from 'debug';
import { Response } from 'express';

import { buildCardDataEvent, buildCardDataPayload } from '@lib/config';
import { getTagValue, parseEventBody } from '@lib/event';
import { logger } from '@lib/utils';
import { ExtendedRequest } from '@type/request';
import { NostrEvent } from '@nostr-dev-kit/ndk';

const log: Debugger = logger.extend('rest:card:data:request:post');
const error: Debugger = log.extend('error');

/**
 * Triggers a card data event publication to nostr
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent: NostrEvent | null = parseEventBody(req.body);
  if (!reqEvent) {
    res.status(422).send();
    return;
  }
  if ('card-data-request' !== getTagValue(reqEvent, 't')) {
    log('Received incorrect request');
    res.status(422).send();
    return;
  }
  try {
    const cardDataPayloadJson: string = JSON.stringify(
      await buildCardDataPayload(reqEvent.pubkey, req.context.prisma),
      (_, v) => (typeof v === 'bigint' ? Number(v) : v),
    );
    const event = await buildCardDataEvent(
      reqEvent.pubkey,
      cardDataPayloadJson,
    );
    log('Built card data event: %O', event);
    await req.context.outbox.publish(event);
    res.status(200).send(cardDataPayloadJson);
  } catch (e) {
    error('Unexpected error: %O', e);
    res.status(500).send();
  }
};

export default handler;
