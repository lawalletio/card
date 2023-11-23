import { Debugger } from 'debug';
import { Response } from 'express';

import { buildCardConfigPayload } from '@lib/config';
import { getTagValue, parseEventBody } from '@lib/event';
import { logger } from '@lib/utils';
import { ExtendedRequest } from '@type/request';
import { NostrEvent } from '@nostr-dev-kit/ndk';

const log: Debugger = logger.extend('rest:card:config:request:post');
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
  if ('card-config-request' !== getTagValue(reqEvent, 't')) {
    log('Received incorrect request');
    res.status(422).send();
    return;
  }
  try {
    res
      .status(200)
      .json(await buildCardConfigPayload(reqEvent.pubkey, req.context.prisma))
      .send();
  } catch (e) {
    error('Unexpected error: %O', e);
    res.status(500).send();
  }
};

export default handler;
