import { NostrEvent } from '@nostr-dev-kit/ndk';

import { getTagValue } from '@lib/event';

describe('Event utils', () => {
  it('should get tag value', () => {
    const [expectedTagName, expectedTagValue]: [string, string] = [
      't',
      'example-value',
    ];
    const event: NostrEvent = {
      created_at: 1700597798,
      content: '',
      tags: [[expectedTagName, expectedTagValue]],
      pubkey: '',
    };

    const tagValue: string | undefined = getTagValue(event, expectedTagName);

    expect(tagValue).toBe(expectedTagValue);
  });

  it('should return undefined for invalid tag name', () => {
    const [expectedTagName, expectedTagValue]: [string, string] = [
      't',
      'example-value',
    ];
    const event: NostrEvent = {
      created_at: 1700597798,
      content: '',
      tags: [[expectedTagName, expectedTagValue]],
      pubkey: '',
    };

    const tagValue: string | undefined = getTagValue(event, 'other-tag');

    expect(tagValue).toBeUndefined();
  });

  it('should return undefined for empty tags', () => {
    const event: NostrEvent = {
      created_at: 1700597798,
      content: '',
      tags: [],
      pubkey: '',
    };

    const tagValue: string | undefined = getTagValue(event, 'tag-name');

    expect(tagValue).toBeUndefined();
  });
});
