import NDK, { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';

export class OutboxService implements Outbox {
  constructor(private readonly ndk: NDK) {}

  publish(event: NostrEvent) {
    const ndkEvent = new NDKEvent(this.ndk, event);
    ndkEvent.publish();
  }
}

export interface Outbox {
  publish(event: NostrEvent): void;
}
