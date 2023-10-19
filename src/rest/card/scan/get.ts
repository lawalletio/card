import { Debugger } from 'debug';
import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { logger, requiredEnvVar } from '@lib/utils';
import { retrieveCardFromPC } from '@lib/card';

import { Card, Prisma, PrismaClient } from '@prisma/client';

const log: Debugger = logger.extend('rest:card:scan');
const debug: Debugger = log.extend('debug');

const prisma: PrismaClient = new PrismaClient();

const federationId: string = requiredEnvVar(
  'LAWALLET_FEDERATION_ID',
).toLowerCase();
const apiBaseUrl: string = requiredEnvVar('LAWALLET_API_BASE_URL');

const laWalletHeader: string = 'X-LaWallet-Settings';
const defaultToken: string = 'BTC';

/**
 * Check if the given card is enabled and has a valid card holder.
 *
 * @param card  The card to check
 * @returns  True if the card is OK, false otherwise
 */
const checkStatus = (card: Card): boolean => {
  if (!card.enabled) {
    debug('Card disabled');
    return false;
  }
  if (null === card.holderPubKey) {
    debug('Card has no holder');
    return false;
  }

  return true;
};

/**
 * Parse the federation header to extract the federation ID and tokens to retrieve
 *
 * @param header  Header to parse (possibly undefined)
 * @returns  A dictionary of "federation" and "tokens" keys, this last one an array of strings
 */
const parseFederationHeader = (
  header: string | undefined,
): { federation: string | null; tokens: string[] } => {
  const m =
    /^(?<federation>[a-zA-Z0-9_-]+)(;tokens=(?<tokens>[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)*))?$/g.exec(
      header ?? '',
    );
  const federation: string | null = m?.groups?.federation ?? null;
  const tokens: string[] = (federation === federationId
    ? m?.groups?.tokens?.split(':')
    : null) ?? [defaultToken];
  return { federation: federation, tokens: tokens };
};

/**
 * Retrieve the limits available for the given tokens
 *
 * @param card  The card to retrieve tokens for
 * @param tokens  The tokens to retrieve
 * @returns  A dictionary mapping tokens to their remaining permissible amounts
 */
const getLimits = async (
  card: Card,
  tokens: string[] = [],
): Promise<{ [_: string]: number }> => {
  if (0 === tokens.length) {
    tokens = [defaultToken];
  }

  type Record = { token: string } & { remaining: number };
  const records: Record[] = await prisma.$queryRaw<Record[]>`SELECT
  p.token AS token,
  MIN(p.remaining) AS remaining
FROM
  (
    SELECT
      l.token AS token,
      l.amount - SUM(p.amount) AS remaining
    FROM
      limits AS l
    JOIN
      payments AS p ON (
          p.token = l.token
        AND
          p.card_uuid = l.card_uuid
        AND
          NOW() - MAKE_INTERVAL(SECS => l.delta) <= p.created_at
      )
    WHERE
      l.token IN (${Prisma.join(tokens)})
    AND
      l.card_uuid = ${card.uuid}
    GROUP BY
      l.uuid,
      l.token
  ) AS p
GROUP BY
  p.token
HAVING
  0 < MIN(p.remaining)`;

  let result: { [_: string]: number } = {};
  for (const { token, remaining } of records) {
    result[token] = remaining;
  }

  return result;
};

/**
 * Build a pseudo-response (ie. a response lacking the "k1" field) for the given federation and limits
 *
 * @param federation  The federation asking for a response
 * @param limits  The limits remaining on this card
 * @returns  The corresponding pseudo-response
 */
const buildQuasiResponse = (
  federation: string | null,
  limits: { [_: string]: number },
): object => {
  let tokensResponse: {
    [_: string]: { minWithdrawable: 0; maxWithdrawable: number };
  } = {};
  for (const tokenName in limits) {
    tokensResponse[tokenName] = {
      minWithdrawable: 0,
      maxWithdrawable: limits[tokenName],
    };
  }

  let response: object = {
    callback: `${apiBaseUrl}/card/pay`,
    defaultDescription: 'LaWallet',
  };

  if (federation === federationId) {
    // extended response
    return {
      tag: 'extendedWithdrawRequest',
      tokens: tokensResponse,
      ...response,
    };
  } else {
    // standard response
    return {
      tag: 'withdrawRequest',
      ...tokensResponse[defaultToken],
      ...response,
    };
  }
};

/**
 * Handle a "/scan" endpoint
 *
 * @param req  HTTP request to handle
 * @param res  HTTP response to send
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  // 1. check query params
  const card: Card | null = await retrieveCardFromPC(
    req.query.p as string | undefined,
    req.query.c as string | undefined,
  );
  if (null === card) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }

  // 2. check status & trusted merchants
  if (!checkStatus(card)) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }

  // 3. check limits
  const { federation, tokens } = parseFederationHeader(
    req.header(laWalletHeader),
  );
  const limits: { [_: string]: number } = await getLimits(card, tokens);
  if (0 === limits.length) {
    res.status(400).json({ status: 'ERROR', reason: 'Limits exceeded' }).send();
    return;
  }

  // 4. build responses
  const quasiResponse: object = buildQuasiResponse(federation, limits);

  res
    .status(200)
    .json({
      k1: (
        await prisma.paymentRequest.create({
          data: { response: quasiResponse, cardUuid: card.uuid },
        })
      ).uuid,
      ...quasiResponse,
    })
    .send();
};

export default handler;
