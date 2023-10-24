import type { Response } from 'express';

import { retrieveNtag424FromPC } from '@lib/card';
import type { ExtendedRequest } from '@type/request';
import { getWriteNDK } from '@services/ndk';
import { responseEvent } from '@lib/event';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { Prisma } from '@prisma/client';

/**
 * Returns the pubkey associated to a card
 *
 * Receives the p and c params from a card scan and returns the pubkey
 * of the card holder if any.
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const ntag424 = await retrieveNtag424FromPC(
    req.query.p as string | undefined,
    req.query.c as string | undefined,
  );
  if (null === ntag424) {
    res.status(404).send();
    return;
  }

  const card: Prisma.CardGetPayload<{ include: { holder: true } }> | null =
    await req.context.prisma.card.findUnique({
      where: { ntag424Cid: ntag424.cid },
      include: { holder: true },
    });
  if (null === card) {
    res.status(404).send();
    return;
  }

  const resEvent: NDKEvent = new NDKEvent(
    getWriteNDK(),
    responseEvent('card-holder-response', JSON.stringify(card.holder)),
  );

  res
    .status(200)
    .json(await resEvent.toNostrEvent())
    .send();
  return;
};

export default handler;
