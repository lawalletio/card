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
 * Expected event content:
 *  {
 *    "otc": <one-time-code>
 *  }
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
    if ((ntag424.otc ?? content.otc) !== content.otc) {
      log(
        'NTAG already has OTC - OLD OTC: %s - NEW OTC: %s',
        ntag424.otc,
        content.otc,
      );
      res
        .status(409)
        .json({
          msg: 'NTAG already has OTC',
          old_otc: ntag424.otc,
          new_otc: content.otc,
        })
        .send();
      return;
    } else {
      const oldNtag = await req.context.prisma.ntag424.findFirst({
        where: { otc: content.otc },
      });
      if (null !== oldNtag) {
        log(
          'OTC already has NTAG - OLD NTAG_CID: %s - NEW NTAG_CID: %s',
          oldNtag.cid,
          ntag424.cid,
        );
        res
          .status(409)
          .json({
            msg: 'OTC already has NTAG',
            old_ntag_cid: oldNtag.cid,
            new_ntag_cid: ntag424.cid,
          })
          .send();
        return;
      }
    }
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
