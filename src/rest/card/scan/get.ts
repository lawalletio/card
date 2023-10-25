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

import { Card, Ntag424 } from '@prisma/client';

const log: Debugger = logger.extend('rest:card:scan');
const debug: Debugger = log.extend('debug');

const federationId: string = requiredEnvVar(
  'LAWALLET_FEDERATION_ID',
).toLowerCase();
const apiBaseUrl: string = requiredEnvVar('LAWALLET_API_BASE_URL');

const laWalletActionHeader: string = 'X-LaWallet-Action'.toLowerCase();
const laWalletParamHeader: string = 'X-LaWallet-Param'.toLowerCase();

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
 * Parse the "X-LaWallet-*" headers
 *
 * @param req  The request to parse headers from
 * @returns  Either null if no parsing is possible, or a dictionary with "action" and "params" keys, this last one being a mapping from string parameter names to string parameter values
 */
const parseLaWalletHeaders = (
  req: ExtendedRequest,
): { action: string; params: { [_: string]: string } } | null => {
  if (
    !(laWalletActionHeader in req.headers) ||
    typeof req.headers[laWalletActionHeader] === 'undefined'
  ) {
    return null;
  }
  if (
    !(laWalletParamHeader in req.headers) ||
    typeof req.headers[laWalletParamHeader] === 'undefined'
  ) {
    return null;
  }

  const action: string = (req.headers[laWalletActionHeader] as string).trim();
  if (!/^[a-z0-9.-]+$/gi.test(action)) {
    return null;
  }

  let params: { [_: string]: string } = {};
  for (const part in (req.headers[laWalletParamHeader] as string).split(',')) {
    const [key, ...values]: string[] = part.trim().split('=');
    const trimKey: string = key.trim();
    if ('' !== trimKey) {
      params[trimKey] = values.join('=');
    }
  }

  return { action, params };
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
      tag: 'laWallet:withdrawRequest',
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
  const ntag424: Ntag424 | null = await retrieveNtag424FromPC(
    req.query.p as string | undefined,
    req.query.c as string | undefined,
  );
  if (null === ntag424) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }
  const card: Card | null = await req.context.prisma.card.findUnique({
    where: {
      ntag424Cid: ntag424.cid,
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

  const laWalletHeaders: {
    action: string;
    params: { [_: string]: string };
  } | null = parseLaWalletHeaders(req);

  let federation: string | null = null;
  let tokens: string[] = [defaultToken];

  if (laWalletHeaders?.action === 'extendedScan') {
    federation = laWalletHeaders?.params?.federationId ?? null;
    tokens = (laWalletHeaders?.params?.tokens ?? defaultToken).split(':');
  }

  // 3. check limits
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
          await req.context.prisma.paymentRequest.create({
            data: { response: quasiResponse, cardUuid: card.uuid },
          })
        ).uuid,
      ) ?? '',
    ...quasiResponse,
  };

  res.status(200).json(response).send();
};

export default handler;
