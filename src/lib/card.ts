import { Buffer } from 'buffer';

import { Debugger } from 'debug';

import { logger, requiredEnvVar } from '@lib/utils';

import { AesCmac } from 'aes-cmac';
import { Cipher, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import {
  Card,
  Delegation,
  Ntag424,
  PaymentRequest,
  Prisma,
  PrismaClient,
} from '@prisma/client';

const log: Debugger = logger.extend('lib:card:scan');
const debug: Debugger = log.extend('debug');

const k1: string = requiredEnvVar('SERVER_AES_KEY_HEX').toLowerCase();
const zeroIv: Buffer = Buffer.alloc(16);
const sv2prefix: Buffer = Buffer.from('3cc300010080', 'hex');

/**
 * Decrypt (using the the given hex-string key) the given hex-string ciphertext, and return the decrypted result as a lowercase hex-string
 *
 * @param ciphertext  The ciphertext to decrypt with the server-side keys, as a hex-string
 * @returns  The decrypted result, as a lowercase hex-string
 */
const decrypt = (key: string, ciphertext: string): Buffer => {
  return createDecipheriv('aes128', Buffer.from(key, 'hex'), zeroIv)
    .setAutoPadding(false)
    .update(Buffer.from(ciphertext, 'hex'));
};

/**
 * Calculate the SDMMAC signature for the given card ID and tap-counter value, using the given key
 *
 * @param k2  Key to use (viz. k2), to calculate the SDMMAC
 * @param cid  Card ID, as a byte-buffer
 * @param ctr  Card tap-counter, as a byte value
 * @returns   The calculated SDMMAC value, as a lowercase hex-string
 */
const sdmmac = async (
  k2: string,
  cid: Buffer,
  ctr: Buffer,
): Promise<string> => {
  const cmacBytes: Uint8Array = await new AesCmac(
    await new AesCmac(Buffer.from(k2, 'hex')).calculate(
      Buffer.from([...sv2prefix, ...cid, ...ctr]),
    ),
  ).calculate(Buffer.alloc(0));
  return Buffer.from([
    cmacBytes[1],
    cmacBytes[3],
    cmacBytes[5],
    cmacBytes[7],
    cmacBytes[9],
    cmacBytes[11],
    cmacBytes[13],
    cmacBytes[15],
  ])
    .toString('hex')
    .toLowerCase();
};

export enum Ntag424Error {
  MALFORMED_P__NOT_A_32_CHAR_UPPERCASE_HEX_VALUE = 'Malformed p: not a 32-char uppercase hex value',
  MALFORMED_P__DOES_NOT_START_WITH_0XC7 = 'Malformed p: does not start with 0xC7',
  MALFORMED_P__COUNTER_VALUE_TOO_OLD = 'Malformed p: counter value too old',
  //
  MALFORMED_C__NOT_A_16_CHAR_UPPERCASE_HEX_VALUE = 'Malformed c: not a 16-char uppercase hex value',
  MALFORMED_C__SDMMAC_MISMATCH = 'Malformed c: SDMMAC mismatch',
  //
  NO_SUITABLE_CARD_FOUND = 'No suitable card found',
}

/**
 * Given the "p" and "c" arguments in the scan url, retrieve the associated Ntag424 entity and update the card tap-counter
 *
 * @param p  The scan url's "p" parameter (ie.    AES(k1     , ctr || cid))
 * @param c  The scan url's "c" parameter (ie. SDMMAC(k2[cid], ctr || cid))
 * @returns  The retrieved Ntag424 entity or null if errors encountered
 */
export const retrieveNtag424FromPC = async (
  prisma: PrismaClient,
  p: string | undefined,
  c: string | undefined,
): Promise<{ ok: Ntag424 } | { error: Ntag424Error }> => {
  if (typeof p !== 'string' || !/^[A-F0-9]{32}$/.test(p)) {
    debug(Ntag424Error.MALFORMED_P__NOT_A_32_CHAR_UPPERCASE_HEX_VALUE);
    return {
      error: Ntag424Error.MALFORMED_P__NOT_A_32_CHAR_UPPERCASE_HEX_VALUE,
    };
  }
  if (typeof c !== 'string' || !/^[A-F0-9]{16}$/.test(c)) {
    debug(Ntag424Error.MALFORMED_C__NOT_A_16_CHAR_UPPERCASE_HEX_VALUE);
    return {
      error: Ntag424Error.MALFORMED_C__NOT_A_16_CHAR_UPPERCASE_HEX_VALUE,
    };
  }

  const pBytes: Buffer = decrypt(k1, p);
  if (0xc7 !== pBytes[0]) {
    debug(Ntag424Error.MALFORMED_P__DOES_NOT_START_WITH_0XC7);
    return { error: Ntag424Error.MALFORMED_P__DOES_NOT_START_WITH_0XC7 };
  }

  const cidBytes: Buffer = pBytes.subarray(1, 8);
  const ctrBytes: Buffer = pBytes.subarray(8, 11);

  const cid: string = cidBytes.toString('hex').toLowerCase();
  const ctrNew: number = (ctrBytes[2] << 16) | (ctrBytes[1] << 8) | ctrBytes[0]; // LSB

  const ntag424: Ntag424 | null = await prisma.ntag424.findUnique({
    where: { cid: cid, k1: k1 },
  });
  if (null === ntag424) {
    debug(Ntag424Error.NO_SUITABLE_CARD_FOUND);
    return { error: Ntag424Error.NO_SUITABLE_CARD_FOUND };
  }
  const ctrOld: number = ntag424.ctr;
  const k2: string = ntag424.k2;

  if (ctrNew <= ctrOld) {
    debug(Ntag424Error.MALFORMED_P__COUNTER_VALUE_TOO_OLD);
    return { error: Ntag424Error.MALFORMED_P__COUNTER_VALUE_TOO_OLD };
  }

  if (c.toLowerCase() !== (await sdmmac(k2, cidBytes, ctrBytes))) {
    debug(Ntag424Error.MALFORMED_C__SDMMAC_MISMATCH);
    return { error: Ntag424Error.MALFORMED_C__SDMMAC_MISMATCH };
  }

  await prisma.ntag424.update({
    where: { cid: cid, k1: k1 },
    data: { ctr: ctrNew },
  });

  return { ok: ntag424 };
};

/**
 * Generate "p" and "c" parameters for given values
 *
 * @param k2  Key to use (viz. k2) to calculate the SDMMAC, as a 32-character hex-string
 * @param cid  Card ID, as a 14-character hex-string
 * @param ctr  Card tap-counter, as a number
 * @param pad  Optional 10-character hex-string padding to use for AES encryption
 * @returns
 */
export const generatePC = async (
  k2: string,
  cid: string,
  ctr: number,
  pad: string | null = null,
): Promise<{ p: string; c: string } | null> => {
  if (null === pad) {
    pad = randomBytes(5).toString('hex');
  }

  if (
    !/^[a-f0-9]{32}$/i.test(k2) ||
    !/^[a-f0-9]{14}$/i.test(cid) ||
    ctr < 0 ||
    0xffffff < ctr ||
    !/^[a-f0-9]{10}$/i.test(pad)
  ) {
    return null;
  }

  const ctrBytes: Buffer = Buffer.from(
    ctr.toString(16).padStart(6, '0'),
    'hex',
  );
  const cidCtr: Buffer = Buffer.from([
    ...Buffer.from(cid, 'hex'),
    ctrBytes[2],
    ctrBytes[1],
    ctrBytes[0],
  ]);

  const plaintextAes: Buffer = Buffer.from([
    0xc7,
    ...cidCtr,
    ...Buffer.from(pad, 'hex'),
  ]);
  const plaintextCmac: Buffer = Buffer.from([...sv2prefix, ...cidCtr]);

  const cipher: Cipher = createCipheriv(
    'aes128',
    Buffer.from(k1, 'hex'),
    zeroIv,
  );
  const aesCmac: Uint8Array = await new AesCmac(
    await new AesCmac(Buffer.from(k2, 'hex')).calculate(plaintextCmac),
  ).calculate(Buffer.alloc(0));

  return {
    p: cipher.update(plaintextAes).toString('hex').toUpperCase(),
    c: Buffer.from([
      aesCmac[1],
      aesCmac[3],
      aesCmac[5],
      aesCmac[7],
      aesCmac[9],
      aesCmac[11],
      aesCmac[13],
      aesCmac[15],
    ])
      .toString('hex')
      .toUpperCase(),
  };
};

export type ScanQuasiResponseBasic = {
  tag: string;
  callback: string;
  defaultDescription: string;
  minWithdrawable: number;
  maxWithdrawable: number;
};
export type ScanQuasiResponseExtended = {
  tag: string;
  callback: string;
  defaultDescription: string;
  tokens: {
    [token: string]: {
      minWithdrawable: number;
      maxWithdrawable: number;
    };
  };
};
export type ScanQuasiResponse =
  | ScanQuasiResponseBasic
  | ScanQuasiResponseExtended;

export type ScanResponseBasic = ScanQuasiResponseBasic & { k1: string };
export type ScanResponseExtended = ScanQuasiResponseExtended & { k1: string };
export type ScanResponse = ScanResponseBasic | ScanResponseExtended;

export const defaultToken: string = 'BTC';

const paymentRequestExpiryInSeconds: number = parseInt(
  requiredEnvVar('PAYMENT_REQUEST_EXPIRY_IN_SECONDS'),
  10,
);

export type PaymentRequestWithCard = Prisma.PaymentRequestGetPayload<{
  include: { card: true };
}>;

export const getExtantPaymentRequestByUuid = async (
  prisma: PrismaClient,
  uuid: string,
): Promise<PaymentRequestWithCard | null> => {
  return prisma.paymentRequest.findUnique({
    where: {
      uuid: uuid,
      createdAt: {
        gt: new Date(Date.now() - paymentRequestExpiryInSeconds * 1000),
      },
      payments: { none: {} },
    },
    include: {
      card: true,
    },
  });
};

export const getCardDelegation = async (
  prisma: PrismaClient,
  cardUuid: string,
): Promise<Delegation | null> => {
  const card: Card | null = await prisma.card.findUnique({
    where: {
      uuid: cardUuid,
    },
  });
  if (null === card || null === card.holderPubKey) {
    return null;
  }

  return prisma.delegation.findFirst({
    where: {
      delegatorPubKey: card.holderPubKey,
      since: { lte: new Date() },
      until: { gte: new Date() },
    },
  });
};

/**
 * Retrieve the limits available for the given tokens
 *
 * @param card  The card to retrieve tokens for
 * @param tokens  The tokens to retrieve
 * @returns  A dictionary mapping tokens to their remaining permissible amounts
 */
export const getLimits = async (
  prisma: PrismaClient,
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
      l.amount - COALESCE(SUM(p.amount), 0) AS remaining
    FROM
      limits AS l
    LEFT JOIN
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
      l.card_uuid = ${card.uuid}::uuid
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

export type Tokens = { [_: string]: number };

export async function addPaymentsForPaymentRequest(
  prisma: PrismaClient,
  paymentRequest: PaymentRequest,
  tokens: Tokens,
): Promise<void> {
  await prisma.payment.createMany({
    data: Object.entries(tokens).map((x: [string, number]) => {
      return {
        status: 'Paid',
        token: x[0],
        amount: BigInt(x[1]),
        cardUuid: paymentRequest.cardUuid,
        paymentRequestUuid: paymentRequest.uuid,
      };
    }),
  });
}
