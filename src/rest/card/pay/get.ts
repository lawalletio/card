import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { nowInSeconds, requiredEnvVar, suuid2uuid } from '@lib/utils';
import { Kind } from '@lib/event';

import { Delegation } from '@prisma/client';

import { PaymentRequestObject, decode } from 'bolt11';
import {
  PaymentRequestWithCard,
  ScanResponseBasic,
  addPaymentsForPaymentRequest,
  defaultToken,
  getCardDelegation,
  getExtantPaymentRequestByUuid,
  getLimits,
} from '@lib/card';
import { NostrEvent } from '@nostr-dev-kit/ndk';

const nostrPubKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');
const ledgerPubKey: string = requiredEnvVar('LEDGER_PUBLIC_KEY');
const btcGatewayPubKey: string = requiredEnvVar('BTC_GATEWAY_PUBLIC_KEY');

const extractMsatsFromBolt11PR = (pr: string): number | null => {
  const decodedPr: PaymentRequestObject = decode(pr);

  let msats: number | null = null;
  if (null !== decodedPr.millisatoshis) {
    msats = parseInt(decodedPr.millisatoshis ?? '', 10);
  } else if (null !== decodedPr.satoshis) {
    msats = 1000 * (decodedPr.satoshis ?? 0);
  }

  if (null === msats || (decodedPr.timeExpireDate ?? 0) < nowInSeconds()) {
    return null;
  }
  return msats;
};

const generateTransactionEvent = async (
  k1: string | undefined,
  pr: string | undefined,
): Promise<NostrEvent | null> => {
  if (typeof k1 !== 'string' || typeof pr !== 'string') {
    return null;
  }

  let msats: number | null = extractMsatsFromBolt11PR(pr);
  if (null === msats) {
    return null;
  }

  const paymentUuid: string | null = suuid2uuid(k1);
  if (null === paymentUuid) {
    return null;
  }
  const paymentRequest: PaymentRequestWithCard | null =
    await getExtantPaymentRequestByUuid(paymentUuid);
  if (null === paymentRequest) {
    return null;
  }
  const paymentRequestResponse: ScanResponseBasic =
    paymentRequest.response as ScanResponseBasic;
  if (
    'withdrawRequest' !== paymentRequestResponse.tag ||
    paymentRequestResponse.maxWithdrawable < msats
  ) {
    return null;
  }

  const limits: { [_: string]: number } = await getLimits(paymentRequest.card, [
    defaultToken,
  ]);
  if ((limits[defaultToken] ?? 0) < msats) {
    return null;
  }

  const delegation: Delegation | null = await getCardDelegation(
    paymentRequest.cardUuid,
  );
  if (null === delegation) {
    return null;
  }

  addPaymentsForPaymentRequest(paymentRequest, { [defaultToken]: msats });

  return {
    created_at: nowInSeconds(),
    content: JSON.stringify({ tokens: { BTC: msats } }),
    tags: [
      ['p', ledgerPubKey],
      ['p', btcGatewayPubKey],
      ['t', 'internal-transaction-start'],
      [
        'delegation',
        delegation.delegatorPubKey,
        delegation.conditions,
        delegation.delegationToken,
      ],
      ['bolt11', pr],
    ],
    kind: Kind.REGULAR,
    pubkey: nostrPubKey,
  };
};

const handler = async (req: ExtendedRequest, res: Response) => {
  const k1: string | undefined = req.query.k1 as string | undefined;
  const pr: string | undefined = req.query.pr as string | undefined;

  const transactionEvent: NostrEvent | null = await generateTransactionEvent(
    k1,
    pr,
  );
  if (null === transactionEvent) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Invalid transaction' })
      .send();
    return;
  }

  req.context.outbox
    .publish(transactionEvent)
    .then(() => {
      res.status(200).json({ status: 'OK' }).send();
    })
    .catch(() => {
      res
        .status(500)
        .json({ status: 'ERROR', reason: 'Could not publish transaction' })
        .send();
    });
};

export default handler;
