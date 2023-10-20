import { Debugger } from 'debug';
import type { Response } from 'express';

import { retrieveNtag424FromPC } from '@lib/card';
import { parseEventBody } from '@lib/event';
import { logger, requiredEnvVar } from '@lib/utils';
import type { ExtendedRequest } from '@type/request';

const log: Debugger = logger.extend('rest:ntag424:patch');

/**
 * Associate a one time code with a ntag424
 *
 * @param req  HTTP request to handle
 * @param res  HTTP response to send
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent = parseEventBody(
    req.body,
    requiredEnvVar('CARD_WRITER_PUBKEY'),
  );
  if (!reqEvent) {
    log('Received invalid nostr event %O', reqEvent);
    res.status(422).send();
    return;
  }
  const content: { otc: string } = JSON.parse(reqEvent.content);
  if (!content.otc) {
    log('Not valid content: %O', reqEvent.content);
    res.status(422).send();
    return;
  }

  const ntag424 = await retrieveNtag424FromPC(
    req.query.p as string,
    req.query.c as string,
  );
  if (ntag424) {
    await req.context.prisma.ntag424.update({
      data: { otc: content.otc },
      where: { cid: ntag424.cid },
    });
    res.status(204).send();
  } else {
    res.status(404).send();
  }
};

export default handler;
