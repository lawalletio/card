import { Buffer } from 'buffer';

import { Debugger } from 'debug';

import { logger, requiredEnvVar } from '@lib/utils';

import { AesCmac } from 'aes-cmac';
import {
  Cipher,
  Decipher,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';

import { Ntag424, PrismaClient } from '@prisma/client';

const log: Debugger = logger.extend('lib:card:scan');
const debug: Debugger = log.extend('debug');

const k1: string = requiredEnvVar('SERVER_AES_KEY_HEX').toLowerCase();
const zeroIv: Buffer = Buffer.alloc(16);
const sv2prefix: Buffer = Buffer.from('3cc300010080', 'hex');

const prisma: PrismaClient = new PrismaClient();

/**
 * Decrypt (using the the given hex-string key) the given hex-string ciphertext, and return the decrypted result as a lowercase hex-string
 *
 * @param ciphertext  The ciphertext to decrypt with the server-side keys, as a hex-string
 * @returns  The decrypted result, as a lowercase hex-string
 */
const decrypt = (key: string, ciphertext: string): Buffer => {
  const decipher: Decipher = createDecipheriv(
    'aes128',
    Buffer.from(key, 'hex'),
    zeroIv,
  ).setAutoPadding(false);
  decipher.update(Buffer.from(ciphertext, 'hex'));
  return decipher.final();
};

/**
 * Calculate the SV2-like CMAC signature for the given card ID and tap-counter value, using the given key
 *
 * @param k2  Key to use (viz. k2), to calculate the CMAC
 * @param cid  Card ID, as a byte-buffer
 * @param ctr  Card tap-counter, as a byte value
 * @returns   The calculated CMAC value, as a lowercase hex-string
 */
const cmac = async (k2: string, cid: Buffer, ctr: Buffer): Promise<string> => {
  const cmacBytes: Uint8Array = await new AesCmac(
    Buffer.from(k2, 'hex'),
  ).calculate(Buffer.from([...sv2prefix, ...cid, ...ctr]));
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

/**
 * Given the "p" and "c" arguments in the scan url, retrieve the associated Ntag424 entity and update the card tap-counter
 *
 * @param p  The scan url's "p" parameter (ie.  AES(k1     , ctr || cid))
 * @param c  The scan url's "c" parameter (ie. CMAC(k2[cid], ctr || cid))
 * @returns  The retrieved Ntag424 entity or null if errors encountered
 */
export const retrieveNtag424FromPC = async (
  p: string | undefined,
  c: string | undefined,
): Promise<Ntag424 | null> => {
  if (typeof p !== 'string' || !/^[A-F0-9]{32}$/.test(p)) {
    debug('Malformed p: not a 32-char uppercase hex value');
    return null;
  }
  if (typeof c !== 'string' || !/^[A-F0-9]{16}$/.test(c)) {
    debug('Malformed c: not a 16-char uppercase hex value');
    return null;
  }

  const pBytes: Buffer = decrypt(k1, p);
  if (0xc7 !== pBytes[0]) {
    debug('Malformed p: does not start with 0xC7');
    return null;
  }

  const cidBytes: Buffer = pBytes.subarray(1, 8);
  const ctrBytes: Buffer = pBytes.subarray(8, 11);

  const cid: string = cidBytes.toString('hex').toLowerCase();
  const ctrNew: number = (ctrBytes[2] << 16) | (ctrBytes[1] << 8) | ctrBytes[0]; // LSB

  const ntag424: Ntag424 | null = await prisma.ntag424.findUnique({
    where: { cid: cid, k1: k1 },
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

  if (c.toLowerCase() !== (await cmac(k2, cidBytes, ctrBytes))) {
    debug('Malformed c: CMAC mismatch');
    return null;
  }

  prisma.ntag424.update({
    where: { cid: cid, k1: k1 },
    data: { ctr: ctrNew },
  });

  return ntag424;
};

/**
 * Generate "p" and "c" parameters for given values
 *
 * @param k2  Key to use (viz. k2) to calculate the CMAC, as a 32-character hex-string
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
    !/^[a-f0-9]{32}$/gi.test(k2) ||
    !/^[a-f0-9]{14}$/gi.test(cid) ||
    ctr < 0 ||
    0xffffff < ctr ||
    !/^[a-f0-9]{10}$/gi.test(pad)
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
