import { Buffer } from 'buffer';

import { Debugger } from 'debug';
import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { logger, requiredEnvVar } from '@lib/utils';

import { AesCmac } from 'aes-cmac';
import { Decipher, createDecipheriv } from 'crypto';

import {
  Card,
  Delegation,
  Design,
  Holder,
  Limit,
  Ntag424,
  Payment,
  Prisma,
  PrismaClient,
} from '@prisma/client';

const log: Debugger = logger.extend('rest:card:scan');
const debug: Debugger = log.extend('debug');

const k1: string = requiredEnvVar('SERVER_AES_KEY_HEX').toLowerCase();
const prisma: PrismaClient = new PrismaClient();

const federationId: string = requiredEnvVar(
  'LAWALLET_FEDERATION_ID',
).toLowerCase();

const laWalletHeader: string = 'X-LaWallet-Settings';
const defaultToken: string = 'BTC';

/**
 * Decrypt (using the the given hex-string key) the given hex-string ciphertext, and return the decrypted result as a lowercase hex-string
 *
 * @param ciphertext  The ciphertext to decrypt with the server-side keys, as a hex-string
 * @returns  The decrypted result, as a lowercase hex-string
 */
const decrypt = (key: string, ciphertext: string): string => {
  const decipher: Decipher = createDecipheriv(
    'aes256',
    Buffer.from(key, 'hex'),
    Buffer.from('00000000000000000000000000000000', 'hex'),
  ).setAutoPadding(false);
  decipher.update(Buffer.from(ciphertext, 'hex'));
  return decipher.final('hex').toLowerCase();
};

/**
 * Calculate the SV2-like CMAC signature for the given card ID and tap-counter value, using the given key
 *
 * @param cid  Card ID, as a byte-buffer
 * @param ctr  Card tap-counter, as a byte value
 * @param k2  Key to use (viz. k2), to calculate the CMAC
 * @returns   The calculated CMAC value, as a lowercase hex-string
 */
const cmac = async (cid: Buffer, ctr: Buffer, k2: string): Promise<string> => {
  return Buffer.from(
    await new AesCmac(Buffer.from(k2, 'hex')).calculate(
      Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80, ...cid, ...ctr]),
    ),
  )
    .toString('hex')
    .toLowerCase();
};

/**
 * Given the "p" and "c" arguments in the scan url, retrieve the associated Card entity and update the card tap-counter
 *
 * @param p  The scan url's "p" parameter (ie.  AES(k1     , ctr || cid))
 * @param c  The scan url's "c" parameter (ie. CMAC(k2[cid], ctr || cid))
 * @returns  The retrieved Card entity or null if errors encountered
 */
const retrieveCard = async (
  p: string | undefined,
  c: string | undefined,
): Promise<Card | null> => {
  if (typeof p !== 'string' || !/^[A-F0-9]{32}$/.test(p)) {
    debug('Malformed p: not a 32-char uppercase hex value');
    return null;
  }
  if (typeof c !== 'string' || !/^[A-F0-9]{16}$/.test(c)) {
    debug('Malformed c: not a 16-char uppercase hex value');
    return null;
  }

  const pBytes: Buffer = Buffer.from(decrypt(k1, p), 'hex');
  if (0xc7 !== pBytes[0]) {
    debug('Malformed p: does not start with 0xC7');
    return null;
  }

  const cidBytes: Buffer = pBytes.subarray(1, 8);
  const ctrBytes: Buffer = pBytes.subarray(8, 11);

  const cid: string = cidBytes.toString('hex').toLowerCase();
  const ctrNew: number = parseInt('0x' + ctrBytes.toString('hex'));

  type Ntag424WithCard = Prisma.Ntag424GetPayload<{ include: { card: true } }>;
  const ntag424: Ntag424WithCard | null = await prisma.ntag424.findUnique({
    where: { cid: cid, k1: k1 },
    include: { card: true },
  });
  if (null === ntag424) {
    debug('No suitable card found');
    return null;
  }
  const ctrOld: number = ntag424.ctr;
  const k2: string = ntag424.k2;

  if (ctrNew < ctrOld) {
    debug('Malformed p: counter too old');
    return null;
  }

  if (c.toLowerCase() !== (await cmac(cidBytes, ctrBytes, k2))) {
    debug('Malformed c: CMAC mismatch');
    return null;
  }

  prisma.ntag424.update({
    where: { cid: cid, k1: k1 },
    data: { ctr: ctrNew },
  });

  return ntag424.card;
};

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
 *
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  // 1. check query params
  const card: Card | null = await retrieveCard(
    req.query.p as string | undefined,
    req.query.c as string | undefined,
  );
  if (null === card) {
    res.status(400).send();
    return;
  }

  // 2. check status & trusted merchants
  if (!checkStatus(card)) {
    res.status(400).send();
    return;
  }

  // 3. check limits
  const { federation, tokens } = parseFederationHeader(
    req.header(laWalletHeader),
  );
  const limits: { [_: string]: number } = await getLimits(card, tokens);

  if (federation === federationId) {
    // send extended response
  } else {
    // send boltcard response
  }
  res.status(200).json({ ok: true }).send();
};

export default handler;
