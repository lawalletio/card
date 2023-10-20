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
    Buffer.from('00000000000000000000000000000000', 'hex'),
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
  return Buffer.from(
    await new AesCmac(Buffer.from(k2, 'hex')).calculate(
      Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80, ...cid, ...ctr]),
    ),
  )
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
 * @returns
 */
export const generatePC = async (
  k2: string,
  cid: string,
  ctr: number,
): Promise<{ p: string; c: string } | null> => {
  if (32 !== k2.length || 14 !== cid.length || ctr < 0 || 0xffffff < ctr) {
    return null;
  }
  const ctrBytes: Buffer = Buffer.from(
    ctr.toString(16).padStart(6, '0'),
    'hex',
  );
  const cidCtr: Buffer = Buffer.from([
    ...Buffer.from(cid, 'hex'),
    ctrBytes[0],
    ctrBytes[1],
    ctrBytes[2],
  ]);
  const plaintextAes: Buffer = Buffer.from([
    0xc7,
    ...cidCtr,
    ...randomBytes(5),
  ]);
  const plaintextCmac: Buffer = Buffer.from([
    0x3c,
    0xc3,
    0x00,
    0x01,
    0x00,
    0x80,
    ...cidCtr,
  ]);

  const cipher: Cipher = createCipheriv(
    'aes128',
    Buffer.from(k1, 'hex'),
    Buffer.from('00000000000000000000000000000000', 'hex'),
  ).setAutoPadding(false);
  const aesCmac: AesCmac = new AesCmac(Buffer.from(k2, 'hex'));

  return {
    p: cipher.update(plaintextAes).toString('hex').toLowerCase(),
    c: Buffer.from(await aesCmac.calculate(plaintextCmac))
      .toString('hex')
      .toLowerCase(),
  };
};
