import type { Response } from 'express';
import type { ExtendedRequest, RestHandler } from '@type/request';

import {
  fetchBalances,
  logger,
  nowInSeconds,
  requiredEnvVar,
  requiredProp,
  suuid2uuid,
} from '@lib/utils';
import { Kind, parseEventBody } from '@lib/event';

import { Delegation, PrismaClient } from '@prisma/client';

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
import { nip19 } from 'nostr-tools';
import { Debugger } from 'debug';
import { getReadNDK } from '@services/ndk';

const log: Debugger = logger.extend('rest:card:pay:post');
const error: Debugger = log.extend('error');

const nostrPubKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');
const ledgerPubKey: string = requiredEnvVar('LEDGER_PUBLIC_KEY');

const validatePubkey = (pubkey: string): string | null => {
  const hex64regex: RegExp = /^[0-9a-f]{64}$/i;
  const bech32regex: RegExp = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/i;

  if (hex64regex.test(pubkey)) {
    return pubkey;
  } else if (bech32regex.test(pubkey)) {
    return nip19.decode<'npub'>(pubkey as `npub1${string}`).data;
  }
  return null;
};

const generateTransactionEvent = async (
  prisma: PrismaClient,
  { k1, pubkey, tokens }: PayReq,
  eventId: string,
): Promise<NostrEvent | null> => {
  const recipientPubkey: string | null = validatePubkey(pubkey);
  if (null === recipientPubkey) {
    return null;
  }

  const paymentUuid: string | null = suuid2uuid(k1);
  if (null === paymentUuid) {
    return null;
  }
  const paymentRequest: PaymentRequestWithCard | null =
    await getExtantPaymentRequestByUuid(prisma, paymentUuid);
  if (null === paymentRequest) {
    error('Could not find a payment request with uuid: %o', paymentUuid);
    return null;
  }
  if (null === paymentRequest.card.holderPubKey) {
    error('No card holder for payment request with uuid: %o', paymentUuid);
    return null;
  }
  const paymentRequestResponse: ScanResponseExtended =
    paymentRequest.response as ScanResponseExtended;
  if ('laWallet:withdrawRequest' !== paymentRequestResponse.tag) {
    error('Tag mismatch for payment request with uuid: %o', paymentUuid);
    return null;
  }
  const limits: { [_: string]: number } = await getLimits(
    prisma,
    paymentRequest.card,
    Object.keys(tokens),
  );
  const balance: { [_: string]: number } = await fetchBalances(
    getReadNDK(),
    paymentRequest.card.holderPubKey,
    Object.keys(tokens),
  );

  for (const token in tokens) {
    if (
      !(token in paymentRequestResponse.tokens) ||
      !(token in limits) ||
      !(token in balance) ||
      paymentRequestResponse.tokens[token].maxWithdrawable < tokens[token] ||
      limits[token] < tokens[token] ||
      balance[token] < tokens[token]
    ) {
      error(
        'Bounds check failed for token %o for payment request with uuid: %o',
        token,
        paymentUuid,
      );
      return null;
    }
  }

  const delegation: Delegation | null = await getCardDelegation(
    prisma,
    paymentRequest.cardUuid,
  );
  if (null === delegation) {
    return null;
  }

  addPaymentsForPaymentRequest(prisma, paymentRequest, tokens);

  return {
    created_at: nowInSeconds(),
    content: JSON.stringify({ tokens: tokens }, (_, v) =>
      typeof v === 'bigint' ? String(v) : v,
    ),
    tags: [
      ['p', ledgerPubKey],
      ['p', recipientPubkey],
      ['e', eventId],
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

type PayReq = {
  k1: string;
  pubkey: string;
  tokens: Tokens;
};

const validateContent = (content: string): PayReq | null => {
  let req;
  try {
    req = JSON.parse(content);
  } catch (e) {
    log('Could not parse event content, error: %O', e);
    return null;
  }
  if (
    null === req ||
    !('k1' in req && 'pubkey' in req && 'tokens' in req) ||
    typeof req.tokens !== 'object'
  ) {
    log('Malformed event content, error: %O', req);
    return null;
  }
  for (const key in req.tokens) {
    if (typeof key !== 'string') {
      log('Non-string token name: %O', key);
      return null;
    }
    if (typeof req.tokens[key as keyof typeof req.tokens] !== 'number') {
      log(
        'Non-numeric token value: %O',
        req.tokens[key as keyof typeof req.tokens],
      );
      return null;
    }
  }
  return req as PayReq;
};

const handler: RestHandler = async (req: ExtendedRequest, res: Response) => {
  const reqEvent: NostrEvent | null = parseEventBody(req.body);
  if (null === reqEvent) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: 'Invalid transaction --- Event validation failed',
      })
      .send();
    return;
  }
  const content: PayReq | null = validateContent(reqEvent.content);
  if (null === content) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: 'Invalid transaction --- Content validation failed',
      })
      .send();
    return;
  }

  const transactionEvent: NostrEvent | null = await generateTransactionEvent(
    req.context.prisma,
    content,
    requiredProp(reqEvent, 'id'),
  );
  if (null === transactionEvent) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: 'Invalid transaction --- Transaction generation failed',
      })
      .send();
    return;
  }

  await req.context.outbox
    .publish(transactionEvent)
    .then(() => {
      res.status(200).json({ status: 'OK' }).send();
    })
    .catch((e) => {
      error('Unexpected error while publishing transaction start: %O', e);
      res
        .status(500)
        .json({ status: 'ERROR', reason: 'Could not publish transaction' })
        .send();
    });
};

export default handler;
