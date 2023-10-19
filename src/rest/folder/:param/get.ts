import { Debugger } from 'debug';
import type { Response } from 'express';
import type { ExtendedRequest } from '@type/request';

import { logger } from '@lib/utils';

const log: Debugger = logger.extend('rest:folder:param');

const handler = (req: ExtendedRequest, res: Response) => {
  log(req.params);
  res.status(200).json({ message: 'Test GET responde' }).send();
};

export default handler;
