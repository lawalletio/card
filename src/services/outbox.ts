import { Debugger } from 'debug';
import NDK, { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';

import { logger } from '@lib/utils';

const log: Debugger = logger.extend('index');
const error: Debugger = log.extend('warn');

export class OutboxService implements Outbox {
  constructor(private readonly ndk: NDK) {}

  publish(event: NostrEvent): Promise<void> {
    const ndkEvent = new NDKEvent(this.ndk, event);
    return new Promise((resolve, reject) => {
      ndkEvent
        .publish()
        .then((relays) => {
          if (0 === relays.size) {
            reject('Did not publish to any relay');
          } else {
            resolve();
          }
        })
        .catch((e) => {
          error('Error found when publishing event %s: %O', event.id, e);
          reject('Unexpected error publishing event');
        });
    });
  }
}

export interface Outbox {
  publish(event: NostrEvent): Promise<void>;
}
