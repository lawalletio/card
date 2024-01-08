import { Debugger } from 'debug';

import type { Response } from 'express';
import type { ExtendedRequest, RestHandler } from '@type/request';

import { Card, Ntag424, PrismaClient } from '@prisma/client';

import { retrieveNtag424FromPC } from '@lib/card';
import { requiredEnvVar, generateSuuid, logger } from '@lib/utils';

const adminPubkeys: string[] = requiredEnvVar('ADMIN_PUBKEYS').split(':');

const log: Debugger = logger.extend('rest:card:reset:request');
const debug: Debugger = log.extend('debug');

type ResetRequest = {
  target_p: string;
  target_c: string;
  admin_p: string;
  admin_c: string;
};

const getPubkeyFromPC = async (
  prisma: PrismaClient,
  p: string,
  c: string,
): Promise<{ ok: string } | { error: string }> => {
  const ntag424: { ok: Ntag424 } | { error: string } =
    await retrieveNtag424FromPC(prisma, p, c);
  if ('error' in ntag424) {
    return { error: `Invalid NTAG: ${ntag424.error}` };
  }
  const card: Card | null = await prisma.card.findUnique({
    where: { ntag424Cid: ntag424.ok.cid },
  });
  if (null === card) {
    return { error: 'Failed to retrieve target card data' };
  } else if (null === card.holderPubKey) {
    return { error: 'No target card holder' };
  }
  return { ok: card.holderPubKey };
};

const handler: RestHandler = async (req: ExtendedRequest, res: Response) => {
  debug(
    `Request body as JSON: ${JSON.stringify(req.body, (_, v) =>
      typeof v === 'bigint' ? String(v) : v,
    )}`,
  );
  debug(`TARGET_P: ${['target_p'].every((t) => t in req.body)}`);
  debug(`TARGET_C: ${['target_c'].every((t) => t in req.body)}`);
  debug(`ADMIN_P: ${['admin_p'].every((t) => t in req.body)}`);
  debug(`ADMIN_C: ${['admin_c'].every((t) => t in req.body)}`);
  debug(`TARGET_PC: ${['target_p', 'target_c'].every((t) => t in req.body)}`);
  debug(`ADMIN_PC: ${['admin_p', 'admin_c'].every((t) => t in req.body)}`);
  debug(
    `ALL: ${['target_p', 'target_c', 'admin_p', 'admin_c'].every(
      (t) => t in req.body,
    )}`,
  );

  if (
    !['target_p', 'target_c', 'admin_p', 'admin_c'].every((t) => t in req.body)
  ) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: 'Invalid request: missing parameters' })
      .send();
    return;
  }
  const resetRequest: ResetRequest = req.body as ResetRequest;

  const adminPubkey: { ok: string } | { error: string } = await getPubkeyFromPC(
    req.context.prisma,
    resetRequest.admin_p,
    resetRequest.admin_c,
  );
  if ('error' in adminPubkey) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: `Invalid admin: ${adminPubkey.error}` })
      .send();
    return;
  }
  if (!adminPubkeys.some((k) => k === adminPubkey.ok)) {
    res
      .status(400)
      .json({ status: 'ERROR', reason: `Not an admin: ${adminPubkey.ok}` })
      .send();
    return;
  }

  const targetPubkey: { ok: string } | { error: string } =
    await getPubkeyFromPC(
      req.context.prisma,
      resetRequest.target_p,
      resetRequest.target_c,
    );
  if ('error' in targetPubkey) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: `Invalid target: ${targetPubkey.error}`,
      })
      .send();
    return;
  }
  if (adminPubkeys.some((k) => k === targetPubkey.ok)) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: `Admin cannot be reset: ${targetPubkey.ok}`,
      })
      .send();
    return;
  }

  if (targetPubkey === adminPubkey) {
    res
      .status(400)
      .json({
        status: 'ERROR',
        reason: 'Reset keys collision',
      })
      .send();
    return;
  }

  const token: string = generateSuuid();
  await req.context.prisma.resetToken.upsert({
    where: {
      holderPubKey: targetPubkey.ok,
    },
    create: {
      holderPubKey: targetPubkey.ok,
      token: token,
    },
    update: {
      createdAt: new Date(),
      token: token,
    },
  });

  res.status(200).json({ status: 'OK', nonce: token }).send();
};

export default handler;
