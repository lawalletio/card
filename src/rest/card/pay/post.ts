import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { nowInSeconds, requiredEnvVar, suuid2uuid } from '@lib/utils';
import { Kind } from '@lib/event';

import { Delegation } from '@prisma/client';

import {
  PaymentRequestWithCard,
  ScanResponseExtended,
  Tokens,
  addPaymentsForPaymentRequest,
  getCardDelegation,
  getExtantPaymentRequestByUuid,
  getLimits,
} from '@lib/card';
import { NostrEvent } from '@nostr-dev-kit/ndk';

const nostrPubKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');
const ledgerPubKey: string = requiredEnvVar('LEDGER_PUBLIC_KEY');

const generateTransactionEvent = async (
  k1: string,
  npub: string,
  tokens: Tokens,
): Promise<NostrEvent | null> => {
  const paymentRequest: PaymentRequestWithCard | null =
    await getExtantPaymentRequestByUuid(suuid2uuid(k1) ?? '');
  if (null === paymentRequest) {
    return null;
  }
  const paymentRequestResponse: ScanResponseExtended =
    paymentRequest.response as ScanResponseExtended;
  if ('extendedWithdrawRequest' !== paymentRequestResponse.tag) {
    return null;
  }
  const limits: { [_: string]: number } = await getLimits(
    paymentRequest.card,
    Object.keys(tokens),
  );

  for (const token in tokens) {
    if (
      !(token in paymentRequestResponse.tokens) ||
      !(token in limits) ||
      paymentRequestResponse.tokens[token].maxWithdrawable < tokens[token] ||
      limits[token] < tokens[token]
    ) {
      return null;
    }
  }

  const delegation: Delegation | null = await getCardDelegation(
    paymentRequest.cardUuid,
  );
  if (null === delegation) {
    return null;
  }

  addPaymentsForPaymentRequest(paymentRequest, tokens);

  return {
    created_at: nowInSeconds(),
    content: JSON.stringify({ tokens: tokens }),
    tags: [
      ['p', ledgerPubKey],
      ['p', npub],
      ['t', 'internal-transaction-start'],
      [
        'delegation',
        delegation.delegatorPubKey,
        delegation.conditions,
        delegation.delegationToken,
      ],
    ],
    kind: Kind.REGULAR,
    pubkey: nostrPubKey,
  };
};

type PayBody = {
  k1: string;
  npub: string;
  tokens: Tokens;
};

const validateBody = (
  body: PayBody,
): { k1: string; npub: string; tokens: Tokens } | null => {
  if (
    null === body ||
    !('k1' in body && 'npub' in body && 'tokens' in body) ||
    typeof body.tokens !== 'object'
  ) {
    return null;
  }
  for (const key in body.tokens) {
    if (typeof key !== 'string') {
      return null;
    }
    if (typeof body.tokens[key as keyof typeof body.tokens] !== 'number') {
      return null;
    }
  }
  return body as { k1: string; npub: string; tokens: Tokens };
};

const handler = async (req: ExtendedRequest, res: Response) => {
  const body: PayBody | null = validateBody(req.body);
  if (null === body) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Invalid transaction' })
      .send();
    return;
  }

  const transactionEvent: NostrEvent | null = await generateTransactionEvent(
    body.k1,
    body.npub,
    body.tokens,
  );
  if (null === transactionEvent) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Invalid transaction' })
      .send();
    return;
  }

  req.context.outbox.publish(transactionEvent);
  res.status(200).json({ status: 'OK' }).send();
};

export default handler;
