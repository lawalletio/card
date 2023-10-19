import { Debugger } from 'debug';
import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';

import { logger } from '@lib/utils';
import { Context } from '@type/request';

const log: Debugger = logger.extend('nostr:subscriptionName');

const filter: NDKFilter = {
  // ids: null,
  authors: [''],
  kinds: [1],
  // '#e': null,
  // '#p': null,
  // '#a': null,
  since: Math.round(Date.now() / 1000) - 86000,
  until: Math.round(Date.now() / 1000) + 86000,
  // limit: null,
};

const getHandler = (ctx: Context): ((event: NostrEvent) => void) => {
  return (event: NostrEvent) => {
    log('******* Received event: *******');
    log(event.content);
    ctx.outbox.publish(event);
  };
};

export { filter, getHandler };
