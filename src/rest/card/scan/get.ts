import { Debugger } from 'debug';
import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { logger, requiredEnvVar, uuid2suuid } from '@lib/utils';
import {
  ScanQuasiResponse,
  ScanResponse,
  defaultToken,
  getLimits,
  retrieveNtag424FromPC,
} from '@lib/card';

import { Card, PrismaClient } from '@prisma/client';

const log: Debugger = logger.extend('rest:card:scan');
const debug: Debugger = log.extend('debug');

const prisma: PrismaClient = new PrismaClient();

const federationId: string = requiredEnvVar(
  'LAWALLET_FEDERATION_ID',
).toLowerCase();
const apiBaseUrl: string = requiredEnvVar('LAWALLET_API_BASE_URL');

const laWalletHeader: string = 'X-LaWallet-Settings';

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
 * Build a pseudo-response (ie. a response lacking the "k1" field) for the given federation and limits
 *
 * @param federation  The federation asking for a response
 * @param limits  The limits remaining on this card
 * @returns  The corresponding pseudo-response
 */
const buildQuasiResponse = (
  federation: string | null,
  limits: { [_: string]: number },
): ScanQuasiResponse => {
  let tokensResponse: {
    [_: string]: { minWithdrawable: 0; maxWithdrawable: number };
  } = {};
  for (const tokenName in limits) {
    tokensResponse[tokenName] = {
      minWithdrawable: 0,
      maxWithdrawable: limits[tokenName],
    };
  }

  if (federation === federationId) {
    // extended response
    return {
      tag: 'extendedWithdrawRequest',
      callback: `${apiBaseUrl}/card/pay`,
      defaultDescription: 'LaWallet',
      tokens: tokensResponse,
    };
  } else {
    // standard response
    return {
      tag: 'withdrawRequest',
      callback: `${apiBaseUrl}/card/pay`,
      defaultDescription: 'LaWallet',
      ...tokensResponse[defaultToken],
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
  const card: Card | null = await prisma.card.findUnique({
    where: {
      ntag424Cid:
        (
          await retrieveNtag424FromPC(
            req.query.p as string | undefined,
            req.query.c as string | undefined,
          )
        )?.cid ?? '',
    },
  });
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
  const quasiResponse: ScanQuasiResponse = buildQuasiResponse(
    federation,
    limits,
  );
  const response: ScanResponse = {
    k1:
      uuid2suuid(
        (
          await prisma.paymentRequest.create({
            data: { response: quasiResponse, cardUuid: card.uuid },
          })
        ).uuid,
      ) ?? '',
    ...quasiResponse,
  };

  res.status(200).json(response).send();
};

export default handler;
