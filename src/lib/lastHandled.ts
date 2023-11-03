import NDK, { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';

import { nowInSeconds, requiredEnvVar } from '@lib/utils';

const tagName = (fileName: string) => `lastHandled:${fileName}`;

function publishLastHandled(ndk: NDK, tracker: LastHandledTracker): void {
  if (ndk.pool.stats().disconnected) {
    return;
  }
  for (const name of tracker.handlerNames) {
    const lastHandled = tracker.get(name);
    if (!lastHandled) {
      continue;
    }
    const event: NDKEvent = new NDKEvent(ndk, {
      content: lastHandled.toString(),
      created_at: nowInSeconds(),
      kind: 31111,
      pubkey: requiredEnvVar('NOSTR_PUBLIC_KEY'),
      tags: [['d', tagName(name)]],
    });
    event.publish();
  }
}

export default class LastHandledTracker {
  private indexes: Record<string, number>;

  private arr: Int32Array;

  public constructor(
    private readNDK: NDK,
    private writeNDK: NDK,
    public handlerNames: string[],
  ) {
    this.indexes = {};
    const sab = new SharedArrayBuffer(
      handlerNames.length * Int32Array.BYTES_PER_ELEMENT,
    );
    this.arr = new Int32Array(sab);
    for (let i = 0; i < handlerNames.length; ++i) {
      this.indexes[handlerNames[i]] = i;
    }
    setInterval(publishLastHandled, 60000, writeNDK, this);
  }

  public get(name: string): number {
    return Atomics.load(this.arr, this.indexes[name]);
  }

  public hit(name: string, timestamp: number): void {
    const curr = this.get(name);
    if (curr < timestamp) {
      if (
        Atomics.compareExchange(
          this.arr,
          this.indexes[name],
          curr,
          timestamp,
        ) !== curr
      ) {
        this.hit(name, timestamp);
      }
    }
  }

  public async fetchLastHandled(): Promise<void> {
    const filter = {
      authors: [requiredEnvVar('NOSTR_PUBLIC_KEY')],
      kinds: [31111],
      '#d': this.handlerNames.map(tagName),
    };
    return new Promise((resolve, reject) => {
      this.readNDK
        .subscribe(filter, { closeOnEose: true })
        .on('event', (event: NostrEvent) => {
          const tag: string[] | undefined = event.tags.find(
            (t) => t[0] === 'd',
          );
          const dTagValue = tag?.at(1);
          if (!dTagValue) {
            return;
          }
          const handlerName = dTagValue.match(/^lastHandled:(?<name>.+)$/)
            ?.groups?.name;
          if (handlerName) {
            this.hit(handlerName, Number(event.content));
          }
        })
        .on('eose', resolve)
        .on('close', resolve)
        .on('error', reject);
    });
  }
}
