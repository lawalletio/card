import { buildCardDataEvent } from '@lib/config';
import {
  buildMultiNip04Event,
  parseEventBody,
  validateDelegation,
  validateDelegationConditions,
} from '@lib/event';
import NDK, { NDKPrivateKeySigner, NostrEvent } from '@nostr-dev-kit/ndk';

import handler from '@rest/card/post';

jest.mock('@lib/event', () => {
  const ogModule = jest.requireActual('@lib/event');
  return {
    __esModule: true,
    ...ogModule,
    parseEventBody: jest.fn(),
    validateDelegationConditions: jest.fn(),
    validateDelegation: jest.fn(),
    buildMultiNip04Event: jest.fn(),
  };
});

jest.mock('@lib/config', () => {
  const ogModule = jest.requireActual('@lib/config');
  return {
    __esModule: true,
    ...ogModule,
    buildCardDataPayload: jest.fn(),
    buildCardConfigPayload: jest.fn(),
    buildCardDataEvent: jest.fn(),
  };
});

const mockReq: any = {
  context: {
    outbox: {
      publish: jest.fn(),
    },
    prisma: {
      ntag424: { findFirst: jest.fn() },
      card: { create: jest.fn() },
      holder: { upsert: jest.fn() },
    },
    writeNDK: new NDK({
      autoConnectUserRelays: false,
      explicitRelayUrls: [],
      signer: new NDKPrivateKeySigner(process.env.NOSTR_PRIVATE_KEY),
    }),
  },
};
const mockRes: any = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn(),
};

describe('POST /card', () => {
  it.each([
    null,
    { content: '' } as NostrEvent,
    { content: '{"otc":""}' } as NostrEvent,
    { content: '{"delegation":{}}' } as NostrEvent,
    { content: '{"otc":"","delegation":{"conditions":""}}' } as NostrEvent,
    { content: '{"delegation":{"token":""}}' } as NostrEvent,
    { content: '{"otc":"","delegation":""}' } as NostrEvent,
    {
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
    } as NostrEvent,
  ])('should fail for invalid body', async (reqEvent: NostrEvent | null) => {
    jest.mocked(parseEventBody).mockReturnValue(reqEvent);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail for invalid delegation conditions', async () => {
    const event = {
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
    } as NostrEvent;
    jest.mocked(parseEventBody).mockReturnValue(event);
    jest.mocked(validateDelegationConditions).mockReturnValue(null);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail for invalid delegation', async () => {
    const event = {
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
    } as NostrEvent;
    const conditions = { kind: 1, since: 1, until: 1 };
    jest.mocked(parseEventBody).mockReturnValue(event);
    jest.mocked(validateDelegationConditions).mockReturnValue(conditions);
    jest.mocked(validateDelegation).mockReturnValue(false);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail for if there is no ntag424 found', async () => {
    const event = {
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
    } as NostrEvent;
    const conditions = { kind: 1, since: 1, until: 1 };
    jest.mocked(parseEventBody).mockReturnValue(event);
    jest.mocked(validateDelegationConditions).mockReturnValue(conditions);
    jest.mocked(validateDelegation).mockReturnValue(true);
    mockReq.context.prisma.ntag424.findFirst.mockResolvedValue(null);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('should publish events for activated card', async () => {
    const event = {
      id: '0a4ddf490a20950f87dec8ee40cf1ab714f9896f5f7f501c5344cc8fdacd8967',
      pubkey:
        '2acd3af870ed392393a9858683959672fee0a8e11c7c9c310277c1bbd1add394',
      created_at: 1704814370,
      kind: 21111,
      tags: [
        [
          'p',
          'f756a0b7e291255af68add8b989c87974adad76d89f6c41388747ae8a77b117f',
        ],
        ['t', 'card-activate-request'],
      ],
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
      sig: '52fdd3ed23f0ea3caf7208365aac87ce3dcf24da0ddc660e93e78cbd7c7b934798819aa3dbccbc29f3a9ba25e9fa797a74c0e470f56d0256b19e1caca019002c',
    };
    const conditions = { kind: 1, since: 1, until: 1 };
    jest.mocked(parseEventBody).mockReturnValue(event);
    jest.mocked(validateDelegationConditions).mockReturnValue(conditions);
    jest.mocked(validateDelegation).mockReturnValue(true);
    const ntag424 = { design: { name: 'To the moon' } };
    const cardConfigEvent = { tags: [] } as unknown as NostrEvent;
    const cardDataEvent = {
      id: '12345',
      tags: [['t', 'card-data']],
    } as NostrEvent;
    jest.mocked(buildMultiNip04Event).mockResolvedValue(cardConfigEvent);
    jest.mocked(buildCardDataEvent).mockResolvedValue(cardDataEvent);
    mockReq.context.prisma.ntag424.findFirst.mockResolvedValue(ntag424);
    const card = { limits: [{ amount: 1n }] };
    mockReq.context.prisma.card.create.mockResolvedValue(card);
    mockReq.context.prisma.holder.upsert.mockResolvedValue({});

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 21111,
        tags: expect.arrayContaining([
          ['p', event.pubkey],
          ['t', 'card-activate-response'],
          ['e', event.id],
        ]),
      }),
    );
    expect(mockReq.context.outbox.publish).toHaveBeenCalledTimes(2);
    expect(mockReq.context.outbox.publish).toHaveBeenNthCalledWith(
      1,
      cardDataEvent,
    );
    expect(mockReq.context.outbox.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 31111,
        tags: expect.arrayContaining([
          ['e', event.id],
          ['t', 'card-config'],
          ['d', `${event.pubkey}:card-config`],
        ]),
      }),
    );
  });

  it('should fail if creating card failed', async () => {
    const event = {
      content: '{"otc":"","delegation":{"conditions":"","token":""}}',
    } as NostrEvent;
    const conditions = { kind: 1, since: 1, until: 1 };
    jest.mocked(parseEventBody).mockReturnValue(event);
    jest.mocked(validateDelegationConditions).mockReturnValue(conditions);
    jest.mocked(validateDelegation).mockReturnValue(true);
    const ntag424 = { design: { name: 'To the moon' } };
    mockReq.context.prisma.ntag424.findFirst.mockResolvedValue(ntag424);
    mockReq.context.prisma.card.create.mockRejectedValue();
    mockReq.context.prisma.holder.upsert.mockResolvedValue({});

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });
});
