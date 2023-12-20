import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import {
  fetchBalances,
  logger,
  nowInSeconds,
  requiredEnvVar,
  suuid2uuid,
} from '@lib/utils';
import { Kind } from '@lib/event';

import { Delegation, PrismaClient } from '@prisma/client';

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
import { Debugger } from 'debug';
import { getReadNDK } from '@services/ndk';

const log: Debugger = logger.extend('rest:card:pay:get');
const debug: Debugger = log.extend('debug');

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

enum TransactionError {
  INVALID_K1_OR_PR = 'Invalid k1 or pr',
  COULD_NOT_EXTRACT_TRANSACTION_AMOUNT = 'Could not extract transaction amount from pr',
  COULD_NOT_PARSE_K1_SSUID = 'Could not parse k1 as SSUID',
  COULD_NOT_FIND_PAYMENT_REQUEST_FOR_UUID = 'Could not find a payment request for UUID',
  NO_CARD_HOLDER_FOR_UUID = 'No card holder for UUID',
  INVALID_TAG_FOR_PAYMENT_REQUEST = 'Invalid tag for payment request',
  INVALID_AMOUNT_FOR_PAYMENT_REQUEST = 'Invalid amount for payment request',
  EXCEEDED_LIMIT = 'Limit reached',
  EXCEEDED_BALANCE = 'Insufficient funds',
  MISSING_DELEGATION = 'Card has no valid delegation',
}

const generateTransactionEvent = async (
  prisma: PrismaClient,
  k1: string | undefined,
  pr: string | undefined,
): Promise<{ ok: NostrEvent } | { error: TransactionError }> => {
  if (typeof k1 !== 'string' || typeof pr !== 'string') {
    debug('Invalid k1: %o or pr: %o', k1, pr);
    return { error: TransactionError.INVALID_K1_OR_PR };
  }

  let msats: number | null = extractMsatsFromBolt11PR(pr);
  if (null === msats) {
    debug('Could not extract invoice amount');
    return { error: TransactionError.COULD_NOT_EXTRACT_TRANSACTION_AMOUNT };
  }

  const paymentUuid: string | null = suuid2uuid(k1);
  if (null === paymentUuid) {
    debug('Could not parse k1 suuid: %o', k1);
    return { error: TransactionError.COULD_NOT_PARSE_K1_SSUID };
  }
  const paymentRequest: PaymentRequestWithCard | null =
    await getExtantPaymentRequestByUuid(prisma, paymentUuid);
  if (null === paymentRequest) {
    debug('Could not find a payment request with uuid: %o', paymentUuid);
    return { error: TransactionError.COULD_NOT_FIND_PAYMENT_REQUEST_FOR_UUID };
  }
  if (null === paymentRequest.card.holderPubKey) {
    debug('No card holder for payment request with uuid: %o', paymentUuid);
    return { error: TransactionError.NO_CARD_HOLDER_FOR_UUID };
  }
  const paymentRequestResponse: ScanResponseBasic =
    paymentRequest.response as ScanResponseBasic;
  if ('withdrawRequest' !== paymentRequestResponse.tag) {
    debug('Invalid tag for payment request');
    return { error: TransactionError.INVALID_TAG_FOR_PAYMENT_REQUEST };
  }

  if (paymentRequestResponse.maxWithdrawable < msats) {
    debug('Invalid amount for payment request');
    return { error: TransactionError.INVALID_AMOUNT_FOR_PAYMENT_REQUEST };
  }

  const limits: { [_: string]: number } = await getLimits(
    prisma,
    paymentRequest.card,
    [defaultToken],
  );
  const balance: { [_: string]: number } = await fetchBalances(
    getReadNDK(),
    paymentRequest.card.holderPubKey,
    [defaultToken],
  );
  if ((limits[defaultToken] ?? 0) < msats) {
    debug('Exceeded limit for token: %o', defaultToken);
    return { error: TransactionError.EXCEEDED_LIMIT };
  }
  if ((balance[defaultToken] ?? 0) < msats) {
    debug('Exceeded balance for token: %o', defaultToken);
    return { error: TransactionError.EXCEEDED_BALANCE };
  }

  const delegation: Delegation | null = await getCardDelegation(
    prisma,
    paymentRequest.cardUuid,
  );
  if (null === delegation) {
    debug('Card does not have delegation');
    return { error: TransactionError.MISSING_DELEGATION };
  }

  addPaymentsForPaymentRequest(prisma, paymentRequest, {
    [defaultToken]: msats,
  });

  return {
    ok: {
      created_at: nowInSeconds(),
      content: JSON.stringify({ tokens: { BTC: msats } }, (_, v) =>
        typeof v === 'bigint' ? String(v) : v,
      ),
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
    },
  };
};

const handler = async (req: ExtendedRequest, res: Response) => {
  const k1: string | undefined = req.query.k1 as string | undefined;
  const pr: string | undefined = req.query.pr as string | undefined;

  const transactionEvent: { ok: NostrEvent } | { error: TransactionError } =
    await generateTransactionEvent(req.context.prisma, k1, pr);
  if ('error' in transactionEvent) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: 'Invalid transaction: ' + transactionEvent.error,
      })
      .send();
    return;
  }

  req.context.outbox
    .publish(transactionEvent.ok)
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
