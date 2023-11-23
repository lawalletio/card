import {
  buildCardConfigPayload,
  CardConfigPayload,
  CardStatus,
} from '@lib/config';

let prismaMock: any;

beforeAll(() => {
  prismaMock = {
    trustedMerchants: { findMany: jest.fn() },
    card: { findMany: jest.fn() },
  };
});

describe('Config utils', () => {
  describe('buildCardConfigEvent', () => {
    it('should build the config payload with received info', async () => {
      const pubkey =
        '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
      const trustedMerchants = [{ merchantPubKey: pubkey }];
      const expectedTrustedMerchants = [{ pubkey }];
      const limits = [
        {
          name: 'Per minute',
          description: '',
          token: 'BTC',
          amount: 1000000n,
          delta: 60,
        },
      ];
      const cards = [
        {
          uuid: '4ef96000-ac1b-4c3a-af1d-e2fa8423d74a',
          name: 'To the moon',
          description: '',
          enabled: true,
          limits,
        },
      ];
      const expectedCards = {
        '4ef96000-ac1b-4c3a-af1d-e2fa8423d74a': {
          name: 'To the moon',
          description: '',
          status: CardStatus.ENABLED,
          limits,
        },
      };
      jest
        .mocked(prismaMock.trustedMerchants.findMany)
        .mockResolvedValue(trustedMerchants);
      jest.mocked(prismaMock.card.findMany).mockResolvedValue(cards);
      const expectedCardConfig: CardConfigPayload = {
        'trusted-merchants': expectedTrustedMerchants,
        cards: expectedCards,
      };

      const cardConfig: CardConfigPayload = await buildCardConfigPayload(
        pubkey,
        prismaMock,
      );

      expect(prismaMock.trustedMerchants.findMany).toBeCalled();
      expect(cardConfig).toStrictEqual(expectedCardConfig);
    });

    it('should return empty for not found trustedMerchants and cards', async () => {
      const pubkey =
        '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
      jest.mocked(prismaMock.trustedMerchants.findMany).mockResolvedValue([]);
      jest.mocked(prismaMock.card.findMany).mockResolvedValue([]);
      const expectedCardConfig: CardConfigPayload = {
        'trusted-merchants': [],
        cards: {},
      };

      const cardConfig: CardConfigPayload = await buildCardConfigPayload(
        pubkey,
        prismaMock,
      );

      expect(cardConfig).toStrictEqual(expectedCardConfig);
    });
  });
});
