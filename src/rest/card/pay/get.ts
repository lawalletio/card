import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { nowInSeconds, requiredEnvVar, suuid2uuid } from '@lib/utils';
import { Kind } from '@lib/event';

import { Card, Delegation, PaymentRequest, PrismaClient } from '@prisma/client';

import { PaymentRequestObject, decode } from 'bolt11';
import { ScanResponseBasic } from '@lib/card';

const paymentRequestExpiryInSeconds: number = parseInt(
  requiredEnvVar('PAYMENT_REQUEST_EXPIRY_IN_SECONDS'),
);

const prisma: PrismaClient = new PrismaClient();

const handler = async (req: ExtendedRequest, res: Response) => {
  const k1: string | undefined = req.query.k1 as string | undefined;
  const pr: string | undefined = req.query.pr as string | undefined;

  if (typeof k1 !== 'string' || typeof pr !== 'string') {
    res.status(400).json({ status: 'ERROR', reason: 'Missing k1' }).send();
    return;
  }
  if (typeof pr !== 'string') {
    res.status(400).json({ status: 'ERROR', reason: 'Missing pr' }).send();
    return;
  }

  const paymentRequest: PaymentRequest | null =
    await prisma.paymentRequest.findUnique({
      where: {
        uuid: suuid2uuid(k1 as string) ?? '',
        createdAt: {
          gt: new Date(Date.now() - paymentRequestExpiryInSeconds * 1000),
        },
        payments: { none: {} },
      },
    });
  if (null === paymentRequest) {
    res.status(400).json({ status: 'ERROR', reason: 'Erroneous k1' }).send();
    return;
  }
  const paymentRequestResponse: ScanResponseBasic =
    paymentRequest.response as ScanResponseBasic;
  if ('withdrawRequest' !== paymentRequestResponse.tag) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Mismatched payment request entry' })
      .send();
    return;
  }

  const decodedPr: PaymentRequestObject = decode(pr);

  let msats: number | null = null;
  if (null !== decodedPr.millisatoshis) {
    msats = parseInt(decodedPr.millisatoshis ?? '');
  } else if (null !== decodedPr.satoshis) {
    msats = 1000 * (decodedPr.satoshis ?? 0);
  }
  if (null === msats) {
    res.status(400).json({ status: 'ERROR', reason: 'No amount given' }).send();
    return;
  }
  if ((decodedPr.timeExpireDate ?? 0) < nowInSeconds()) {
    res.status(400).json({ status: 'ERROR', reason: 'PR Expired' }).send();
    return;
  }

  if (paymentRequestResponse.maxWithdrawable < msats) {
    res.status(400).json({ status: 'ERROR', reason: 'Limit exceeded' }).send();
    return;
  }

  const card: Card | null = await prisma.card.findUnique({
    where: {
      uuid: paymentRequest.cardUuid,
    },
  });
  if (null === card || null === card.holderPubKey) {
    res.status(400).json({ status: 'ERROR', reason: 'No holder' }).send();
    return;
  }
  const delegations: Delegation[] | null = await prisma.delegation.findMany({
    where: {
      delegatorPubKey: card.holderPubKey,
      since: { lte: new Date() },
      until: { gte: new Date() },
    },
  });
  if (null === delegations) {
    res.status(400).json({ status: 'ERROR', reason: 'No delegations' }).send();
    return;
  }

  req.context.outbox.publish({
    created_at: nowInSeconds(),
    content: JSON.stringify({ tokens: { BTC: msats } }),
    tags: [
      ['p', requiredEnvVar('LEDGER_PUBLIC_KEY')],
      ['p', requiredEnvVar('BTC_GATEWAY_PUBLIC_KEY')],
      ['t', 'internal-transaction-start'],
      [
        'delegation',
        delegations[0].delegatorPubKey,
        delegations[0].conditions,
        delegations[0].delegationToken,
      ],
      ['bolt11', pr],
    ],
    kind: Kind.REGULAR,
    pubkey: requiredEnvVar('NOSTR_PUBLIC_KEY'),
  });

  res.status(200).json({ status: 'OK' }).send();
};

export default handler;
