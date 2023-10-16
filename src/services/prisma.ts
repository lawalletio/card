import { logger } from '@lib/utils';
import { PrismaClient } from '@prisma/client';
import { Debugger } from 'debug';

const log: Debugger = logger.extend('services:prisma');

let prisma: PrismaClient;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    log('Instantiate prisma');
    prisma = new PrismaClient({
      log: [{ level: 'query', emit: 'event' }],
    });
  }
  return prisma;
}
