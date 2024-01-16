import { buildCardDataEvent } from '@lib/config';
import {
  buildMultiNip04Event,
  parseEventBody,
  validateDelegation,
  validateDelegationConditions,
} from '@lib/event';
import NDK, { NDKPrivateKeySigner, NostrEvent } from '@nostr-dev-kit/ndk';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

import handler from '@rest/card/post';
import { nip04 } from 'nostr-tools';

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

jest.mock('nostr-tools', () => {
  const ogModule = jest.requireActual('nostr-tools');
  return {
    __esModule: true,
    ...ogModule,
    nip04: { decrypt: jest.fn() },
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
      card: { create: jest.fn(), update: jest.fn() },
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
  beforeEach(() => {
    jest.mocked(parseEventBody).mockReset();
    jest.mocked(nip04.decrypt).mockReset();
    jest.mocked(validateDelegationConditions).mockReset();
    jest.mocked(validateDelegation).mockReset();
  });

  it('should fail for invalid body', async () => {
    jest.mocked(parseEventBody).mockReturnValueOnce(null);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail for invalid request', async () => {
    jest
      .mocked(parseEventBody)
      .mockReturnValueOnce({ tags: [['t', 'invalidtag']] } as NostrEvent);

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  describe('Card activation', () => {
    const reqTag = ['t', 'card-activation-request'];
    it.each([
      { content: '' } as NostrEvent,
      { content: '{"otc":""}' } as NostrEvent,
      { content: '{"delegation":{}}' } as NostrEvent,
      { content: '{"otc":"","delegation":{"conditions":""}}' } as NostrEvent,
      { content: '{"delegation":{"token":""}}' } as NostrEvent,
      { content: '{"otc":"","delegation":""}' } as NostrEvent,
      {
        content: '{"otc":"","delegation":{"conditions":"","token":""}}',
      } as NostrEvent,
    ])(
      'should fail for invalid request $content',
      async (reqEvent: NostrEvent) => {
        jest.mocked(parseEventBody).mockReturnValueOnce({
          ...reqEvent,
          tags: [reqTag],
        } as NostrEvent);

        await handler(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(422);
      },
    );

    it('should fail for invalid delegation conditions', async () => {
      const event = {
        content: '{"otc":"","delegation":{"conditions":"","token":""}}',
        tags: [reqTag],
      } as NostrEvent;
      jest.mocked(parseEventBody).mockReturnValueOnce(event);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(null);

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
    });

    it('should fail for invalid delegation', async () => {
      const event = {
        content: '{"otc":"","delegation":{"conditions":"","token":""}}',
        tags: [reqTag],
      } as NostrEvent;
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(parseEventBody).mockReturnValueOnce(event);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(false);

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
    });

    it('should fail for if there is no ntag424 found', async () => {
      const event = {
        content: '{"otc":"","delegation":{"conditions":"","token":""}}',
        tags: [reqTag],
      } as NostrEvent;
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(parseEventBody).mockReturnValueOnce(event);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(true);
      mockReq.context.prisma.ntag424.findFirst.mockResolvedValueOnce(null);

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
          reqTag,
        ],
        content: '{"otc":"","delegation":{"conditions":"","token":""}}',
        sig: '52fdd3ed23f0ea3caf7208365aac87ce3dcf24da0ddc660e93e78cbd7c7b934798819aa3dbccbc29f3a9ba25e9fa797a74c0e470f56d0256b19e1caca019002c',
      };
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(parseEventBody).mockReturnValueOnce(event);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(true);
      const ntag424 = { design: { name: 'To the moon' } };
      const cardConfigEvent = { tags: [] } as unknown as NostrEvent;
      const cardDataEvent = {
        id: '12345',
        tags: [['t', 'card-data']],
      } as NostrEvent;
      jest.mocked(buildMultiNip04Event).mockResolvedValueOnce(cardConfigEvent);
      jest.mocked(buildCardDataEvent).mockResolvedValueOnce(cardDataEvent);
      mockReq.context.prisma.ntag424.findFirst.mockResolvedValueOnce(ntag424);
      const card = { holderPubKey: event.pubkey, limits: [{ amount: 1n }] };
      mockReq.context.prisma.card.create.mockResolvedValueOnce(card);
      mockReq.context.prisma.holder.upsert.mockResolvedValueOnce({});

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 21111,
          tags: expect.arrayContaining([
            ['p', event.pubkey],
            ['t', 'card-activation-response'],
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
        tags: [reqTag],
      } as NostrEvent;
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(parseEventBody).mockReturnValueOnce(event);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(true);
      const ntag424 = { design: { name: 'To the moon' } };
      mockReq.context.prisma.ntag424.findFirst.mockResolvedValueOnce(ntag424);
      mockReq.context.prisma.card.create.mockRejectedValueOnce();
      mockReq.context.prisma.holder.upsert.mockResolvedValueOnce({});

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Card transfer', () => {
    const reqTag = ['t', 'card-transfer-acceptance'];

    it.each([
      {
        reqEvent: { content: '', tags: [reqTag] } as NostrEvent,
        donationEvent: null,
      },
      {
        reqEvent: { content: '{}', tags: [reqTag] } as NostrEvent,
        donationEvent: null,
      },
      {
        reqEvent: { content: '{}', tags: [reqTag] } as NostrEvent,
        donationEvent: { tags: [['t', 'invalid']] } as NostrEvent,
      },
      {
        reqEvent: { content: '{}', tags: [reqTag] } as NostrEvent,
        donationEvent: {
          tags: [['t', 'card-transfer-donation']],
        } as NostrEvent,
      },
    ])(
      'should fail for invalid request $reqEvent $donationEvent',
      async ({ reqEvent, donationEvent }) => {
        jest
          .mocked(parseEventBody)
          .mockReturnValueOnce(reqEvent)
          .mockReturnValueOnce(donationEvent);

        await handler(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(422);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'ERROR',
            reason: expect.any(String),
          }),
        );
        expect(mockRes.send).toHaveBeenCalled();
      },
    );

    it('should fail for invalid delegation conditions', async () => {
      const reqEvent = {
        content: '{"delegation":{"conditions": "", "token": ""}}',
        tags: [reqTag],
      } as NostrEvent;
      const donationEvent = {
        content: '{}',
        tags: [['t', 'card-transfer-donation']],
      } as NostrEvent;
      jest
        .mocked(parseEventBody)
        .mockReturnValueOnce(reqEvent)
        .mockReturnValueOnce(donationEvent);
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(null);

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
    });

    it('should fail for invalid delegation', async () => {
      const reqEvent = {
        content: '{"delegation":{"conditions": "", "token": ""}}',
        tags: [reqTag],
      } as NostrEvent;
      const donationEvent = {
        content: '{}',
        tags: [['t', 'card-transfer-donation']],
      } as NostrEvent;
      jest
        .mocked(parseEventBody)
        .mockReturnValueOnce(reqEvent)
        .mockReturnValueOnce(donationEvent);
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(false);

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
    });

    it.each([
      {
        reqEvent: {
          content: '{"delegation":{"conditions": "", "token": ""}}',
          tags: [reqTag, ['p', '1234']],
        } as NostrEvent,
        donationEvent: {
          pubkey:
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          tags: [['t', 'card-transfer-donation']],
        } as NostrEvent,
      },
      {
        reqEvent: {
          content: '{"delegation":{"conditions": "", "token": ""}}',
          tags: [
            reqTag,
            [
              'p',
              '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
            ],
          ],
        } as NostrEvent,
        donationEvent: {
          pubkey:
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          tags: [['t', 'card-transfer-donation']],
        } as NostrEvent,
      },
    ])(
      'should fail if trying to reclaim from different donator',
      async ({ reqEvent, donationEvent }) => {
        jest
          .mocked(parseEventBody)
          .mockReturnValueOnce(reqEvent)
          .mockReturnValueOnce(donationEvent);
        const conditions = { kind: 1, since: 1, until: 1 };
        jest
          .mocked(validateDelegationConditions)
          .mockReturnValueOnce(conditions);
        jest.mocked(validateDelegation).mockReturnValueOnce(true);

        await handler(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(422);
      },
    );

    it('should fail if unable to parse nip04 donation event', async () => {
      const reqEvent = {
        content: '{}',
        tags: [
          reqTag,
          ['p', process.env.NOSTR_PUBLIC_KEY],
          [
            'p',
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          ],
        ],
      } as NostrEvent;
      const donationEvent = {
        pubkey:
          '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
        tags: [['t', 'card-transfer-donation']],
      } as NostrEvent;
      jest
        .mocked(parseEventBody)
        .mockReturnValueOnce(reqEvent)
        .mockReturnValueOnce(donationEvent);
      jest.mocked(nip04.decrypt).mockRejectedValueOnce('');

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ERROR',
          reason: expect.any(String),
        }),
      );
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('should fail if nip04 is wrong', async () => {
      const reqEvent = {
        id: '123456',
        pubkey:
          '235e1d8124b0d22fe06e01c7d717600f85a6f071b4a8de3b984499d3e1019b27',
        content: '{"delegation":{"conditions": "", "token": ""}}',
        tags: [
          reqTag,
          ['p', process.env.NOSTR_PUBLIC_KEY],
          [
            'p',
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          ],
        ],
      } as NostrEvent;
      const donationEvent = {
        pubkey:
          '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
        tags: [['t', 'card-transfer-donation']],
      } as NostrEvent;
      jest
        .mocked(parseEventBody)
        .mockReturnValueOnce(reqEvent)
        .mockReturnValueOnce(donationEvent);
      jest.mocked(nip04.decrypt).mockRejectedValueOnce('');
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(true);

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ERROR',
          reason: expect.any(String),
        }),
      );
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('should publish events after updating successfully', async () => {
      const reqEvent = {
        id: '123456',
        pubkey:
          '235e1d8124b0d22fe06e01c7d717600f85a6f071b4a8de3b984499d3e1019b27',
        content: '{"delegation":{"conditions": "", "token": ""}}',
        tags: [
          reqTag,
          ['p', process.env.NOSTR_PUBLIC_KEY],
          [
            'p',
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          ],
        ],
      } as NostrEvent;
      const donationEvent = {
        pubkey:
          '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
        tags: [['t', 'card-transfer-donation']],
        content: '{}',
      } as NostrEvent;
      const cardUuid = '80d0bd6e-5550-49e0-bd0e-8874c2eb94a4';
      jest
        .mocked(parseEventBody)
        .mockReturnValueOnce(reqEvent)
        .mockReturnValueOnce(donationEvent);
      jest.mocked(nip04.decrypt).mockResolvedValueOnce(cardUuid);
      const cardConfigEvent = { tags: [] } as unknown as NostrEvent;
      const cardDataEvent = {
        id: '12345',
        tags: [['t', 'card-data']],
      } as NostrEvent;
      jest.mocked(buildMultiNip04Event).mockResolvedValueOnce(cardConfigEvent);
      jest.mocked(buildCardDataEvent).mockResolvedValueOnce(cardDataEvent);
      const card = { holderPubKey: reqEvent.pubkey, limits: [{ amount: 1n }] };
      const conditions = { kind: 1, since: 1, until: 1 };
      jest.mocked(validateDelegationConditions).mockReturnValueOnce(conditions);
      jest.mocked(validateDelegation).mockReturnValueOnce(true);
      mockReq.context.prisma.card.update.mockResolvedValueOnce(card);
      mockReq.context.prisma.holder.upsert.mockResolvedValueOnce({
        pubKey: reqEvent.pubkey,
      });

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 21111,
          tags: expect.arrayContaining([
            ['p', reqEvent.pubkey],
            ['e', reqEvent.id],
            ['t', 'card-transfer-response'],
          ]),
        }),
      );
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalled();
      expect(mockReq.context.prisma.card.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          enabled: false,
          holderPubKey: reqEvent.pubkey,
        }),
        where: { holderPubKey: donationEvent.pubkey, uuid: cardUuid },
      });
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
            ['e', reqEvent.id],
            ['t', 'card-config'],
            ['d', `${reqEvent.pubkey}:card-config`],
          ]),
        }),
      );
    });

    it.each([
      { e: '', expectedCode: 500 },
      {
        e: new PrismaClientKnownRequestError('', {
          clientVersion: '',
          code: 'P2025',
        }),
        expectedCode: 404,
      },
    ])(
      'should fail if updating the card failed',
      async ({
        e,
        expectedCode,
      }: {
        e: string | Error;
        expectedCode: number;
      }) => {
        const reqEvent = {
          id: '123456',
          pubkey:
            '235e1d8124b0d22fe06e01c7d717600f85a6f071b4a8de3b984499d3e1019b27',
          content: '{"delegation":{"conditions": "", "token": ""}}',
          tags: [
            reqTag,
            ['p', process.env.NOSTR_PUBLIC_KEY],
            [
              'p',
              '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
            ],
          ],
        } as NostrEvent;
        const donationEvent = {
          pubkey:
            '088f0b2ecb66e37bdf1f036fcae261ad5a1b04f704f4d93bdebd8bf855495da2',
          tags: [['t', 'card-transfer-donation']],
        } as NostrEvent;
        const cardUuid = '80d0bd6e-5550-49e0-bd0e-8874c2eb94a4';
        jest
          .mocked(parseEventBody)
          .mockReturnValueOnce(reqEvent)
          .mockReturnValueOnce(donationEvent);
        jest.mocked(nip04.decrypt).mockResolvedValueOnce(cardUuid);
        const conditions = { kind: 1, since: 1, until: 1 };
        jest
          .mocked(validateDelegationConditions)
          .mockReturnValueOnce(conditions);
        jest.mocked(validateDelegation).mockReturnValueOnce(true);
        mockReq.context.prisma.card.update.mockRejectedValueOnce(e);
        mockReq.context.prisma.holder.upsert.mockResolvedValueOnce({
          pubKey: reqEvent.pubkey,
        });

        await handler(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(expectedCode);
      },
    );
  });
});
