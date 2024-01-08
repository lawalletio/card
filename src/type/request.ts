import { Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { Outbox } from '@services/outbox';

export interface Context {
  prisma: PrismaClient;
  outbox: Outbox;
}

export interface ExtendedRequest extends Request {
  context: Context;
}

export type RestHandler = {
  (req: ExtendedRequest, res: Response): Promise<void>;
};
