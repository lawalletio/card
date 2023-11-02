import { Debugger } from 'debug';
import NDK, { NDKEvent, NDKRelaySet, NostrEvent } from '@nostr-dev-kit/ndk';

import { logger } from '@lib/utils';

const log: Debugger = logger.extend('index');
const error: Debugger = log.extend('warn');

export class OutboxService implements Outbox {
  constructor(private readonly ndk: NDK) {}

  publish(event: NostrEvent, relaySet?: NDKRelaySet): Promise<void> {
    const ndkEvent = new NDKEvent(this.ndk, event);
    return new Promise((resolve, reject) => {
      ndkEvent
        .publish(relaySet)
        .then((relays) => {
          if (0 === relays.size) {
            error('Could not publish to any relay event %s', event.id);
            reject('Did not publish to any relay');
          } else {
            resolve();
          }
        })
        .catch((e) => {
          error('Error found when publishing event %O: %O', event, e);
          reject('Unexpected error publishing event');
        });
    });
  }
}

export interface Outbox {
  publish(event: NostrEvent, relaySet?: NDKRelaySet): Promise<void>;
}
