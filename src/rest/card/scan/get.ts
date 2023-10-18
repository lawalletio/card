import { Buffer } from 'buffer';

import { Debugger } from 'debug';
import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { logger, requiredEnvVar } from '@lib/utils';

import { enc, lib, mode, pad, AES } from 'crypto-js';
import { AesCmac } from 'aes-cmac';


const log: Debugger = logger.extend('rest:card:scan');
const debug: Debugger = log.extend('debug');


/**
 * Decrypt the given hex-string using the server-side keys, and return the decrypted result as a lowercase hex-string
 * 
 * @param ciphertext  The ciphertext to decrypt with the server-side keys, as a hex-string
 * @returns  The decrypted result, as a lowercase hex-string
 */
const serverDecrypt = (ciphertext: string): string => {
  return AES.decrypt(
    lib.CipherParams.create({
      ciphertext: enc.Hex.parse(ciphertext),
    }),
    enc.Hex.parse(requiredEnvVar('SERVER_AES_KEY_HEX')),
    {
      iv: enc.Hex.parse('00000000000000000000000000000000'),
      mode: mode.CBC,
      padding: pad.NoPadding,
    },
  ).toString(enc.Hex).toLowerCase();
};


/**
 * Calculate the SV2-like CMAC signature for the given card ID and tap-counter value, using the given key
 *
 * @param cid  Card ID, as a byte-buffer
 * @param ctr  Card tap-counter, as a byte value
 * @param k2  Key to use (viz. k2), to calculate the CMAC
 * @returns   The calculated CMAC value, as a lowercase hex-string
 */
const calculateCMAC = async (cid: Buffer, ctr: Buffer, k2: string): Promise<string> => {
  return Buffer.from(
    await (new AesCmac(Buffer.from(k2, 'hex')))
      .calculate(Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80, ...cid, ...ctr])),
  ).toString('hex').toLowerCase();
};



const xxxxxxxGetCtrAndK2HexFromCidBytes = (_cidBytes: Buffer): { ctr: bigint, k2: string } => {
  return { ctr: 1n, k2: 'abc123' };
};



/**
 *
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const { p, c } = req.query as { [_: string]: string };

  if (typeof p !== 'string' || !/^[A-F0-9]{32}$/.test(p)) {
    debug('Malformed p: not a 32-char uppercase hex value');
    res.status(400).send();
    return;
  }
  if (typeof c !== 'string' || !/^[A-F0-9]{16}$/.test(c)) {
    debug('Malformed c: not a 16-char uppercase hex value');
    res.status(400).send();
    return;
  }

  const pBytes = Buffer.from(serverDecrypt(p), 'hex');
  if (0xc7 !== pBytes[0]) {
    debug('Malformed p: does not start with 0xC7');
    res.status(400).send();
    return;
  }

  const cidBytes = pBytes.subarray(1,  8);
  const ctrBytes = pBytes.subarray(8, 11);
  const ctrNew = BigInt('0x' + ctrBytes.toString('hex'));

  const { ctr: ctrOld, k2: k2 } = xxxxxxxGetCtrAndK2HexFromCidBytes(cidBytes);
  
  if (ctrNew <= ctrOld) {
    debug('Malformed p: counter too old');
    res.status(400).send();
    return;
  }

  if (c.toLowerCase() !== (await calculateCMAC(cidBytes, ctrBytes, k2))) {
    debug('Malformed c: CMAC mismatch');
    res.status(400).send();
    return;
  }

  res.status(200).json({ ok: true }).send();
};

export default handler;
