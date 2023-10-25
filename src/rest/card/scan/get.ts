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

import { Card, Ntag424, Prisma } from '@prisma/client';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getWriteNDK } from '@services/ndk';
import { responseEvent } from '@lib/event';

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

const handleScan = async (req: ExtendedRequest, res: Response) => {
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
  // TODO: TRUSTED MERCHANTS
  if (!checkStatus(card)) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }

  // 3. check limits
  const limits: { [_: string]: number } = await getLimits(card, [defaultToken]);
  if (0 === limits.length) {
    res.status(400).json({ status: 'ERROR', reason: 'Limits exceeded' }).send();
    return;
  }

  // 4. build responses
  let tokensResponse: {
    [_: string]: { minWithdrawable: 0; maxWithdrawable: number };
  } = {};
  for (const tokenName in limits) {
    tokensResponse[tokenName] = {
      minWithdrawable: 0,
      maxWithdrawable: limits[tokenName],
    };
  }

  // standard response
  const quasiResponse: ScanQuasiResponse = {
    tag: 'withdrawRequest',
    callback: `${apiBaseUrl}/card/pay`,
    defaultDescription: 'LaWallet',
    ...tokensResponse[defaultToken],
  };

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

const handleExtendedScan = async (req: ExtendedRequest, res: Response) => {
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
  // TODO: TRUSTED MERCHANTS
  if (!checkStatus(card)) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }

  let tokens: string[] = (
    parseLaWalletHeaders(req)?.params?.tokens ?? defaultToken
  )
    .split(':')
    .map((token: string) => {
      return token.trim();
    });

  // 3. check limits
  const limits: { [_: string]: number } = await getLimits(card, tokens);
  if (0 === limits.length) {
    res.status(400).json({ status: 'ERROR', reason: 'Limits exceeded' }).send();
    return;
  }

  // 4. build responses
  let tokensResponse: {
    [_: string]: { minWithdrawable: 0; maxWithdrawable: number };
  } = {};
  for (const tokenName in limits) {
    tokensResponse[tokenName] = {
      minWithdrawable: 0,
      maxWithdrawable: limits[tokenName],
    };
  }

  // extended response
  const quasiResponse: ScanQuasiResponse = {
    tag: 'laWallet:withdrawRequest',
    callback: `${apiBaseUrl}/card/pay`,
    defaultDescription: 'LaWallet',
    tokens: tokensResponse,
  };

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

const handleIdentityQuery = async (req: ExtendedRequest, res: Response) => {
  const ntag424 = await retrieveNtag424FromPC(
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

  const card: Prisma.CardGetPayload<{ include: { holder: true } }> | null =
    await req.context.prisma.card.findUnique({
      where: { ntag424Cid: ntag424.cid },
      include: { holder: true },
    });
  if ((card?.holder ?? null) === null) {
    res
      .status(404)
      .json({ status: 'ERROR', reason: 'Failed to retrieve card data' })
      .send();
    return;
  }

  const resEvent: NDKEvent = new NDKEvent(
    getWriteNDK(),
    responseEvent('card-holder-response', JSON.stringify(card?.holder?.pubKey)),
  );

  res
    .status(200)
    .json(await resEvent.toNostrEvent())
    .send();
  return;
};

/**
 * Handle a "/scan" endpoint
 *
 * @param req  HTTP request to handle
 * @param res  HTTP response to send
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const laWalletHeaders: {
    action: string;
    params: { [_: string]: string };
  } | null = parseLaWalletHeaders(req);
  if (laWalletHeaders?.params?.federationId ?? null === federationId) {
    if (laWalletHeaders?.action ?? null === 'extendedScan') {
      handleExtendedScan(req, res);
    } else if (laWalletHeaders?.action ?? null === 'identityQuery') {
      handleIdentityQuery(req, res);
    } else {
      res
        .status(400)
        .json({ status: 'ERROR', reason: 'Unrecognized action' })
        .send();
      return;
    }
  } else {
    handleScan(req, res);
  }
};

export default handler;
