import { Response } from 'express';

import { ExtendedRequest } from '@type/request';
import { parseEventBody, responseEvent } from '@lib/event';
import { logger, requiredEnvVar } from '@lib/utils';
import { Debugger } from 'debug';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getWriteNDK } from '@services/ndk';

const log: Debugger = logger.extend('rest:ntag424:delete');

function parseDeleteRequest(content: string): { cid: string } {
  const req = JSON.parse(content);
  const cid: string | undefined = req.cid;
  if (!cid) {
    throw new Error('Not a valid content');
  }
  return { cid };
}

/**
 * Delete a ntag424 from the database
 *
 * Expected event content:
 *  {
 *    "cid": <card_id>,
 *  }
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent = parseEventBody(
    req.body,
    requiredEnvVar('CARD_WRITER_PUBKEY'),
  );
  if (null === reqEvent) {
    log('Received invalid nostr event %O', reqEvent);
    res.status(422).send();
    return;
  }

  let content: { cid: string };
  try {
    content = parseDeleteRequest(reqEvent.content);
  } catch (e) {
    log('Not valid content: %O', reqEvent.content);
    res.status(422).send();
    return;
  }
  await req.context.prisma.ntag424
    .delete({
      where: { cid: content.cid },
    })
    .then(async (ntag424) => {
      const resEvent = new NDKEvent(
        getWriteNDK(),
        responseEvent(
          'card-delete-response',
          JSON.stringify(ntag424),
          reqEvent,
        ),
      );
      await resEvent.sign();
      res
        .status(200)
        .send(
          JSON.stringify(await resEvent.toNostrEvent(), (_, v) =>
            typeof v === 'bigint' ? Number(v) : v,
          ),
        );
    })
    .catch((e) => {
      log('Could not delete ntag424 %s: %O', content.cid, e);
      res.status(500).send();
    });
};

export default handler;
