import { buildCardConfigPayload, CardConfigPayload } from '@lib/config';
import { getTagValue, parseEventBody } from '@lib/event';
import { NostrEvent } from '@nostr-dev-kit/ndk';

import handler from '@rest/card/config/request/post';

jest.mock('@lib/config', () => {
  return {
    __esModule: true,
    buildCardConfigPayload: jest.fn(),
  };
});
jest.mock('@lib/event', () => {
  return {
    __esModule: true,
    getTagValue: jest.fn(),
    parseEventBody: jest.fn(),
  };
});
const mockRes: any = {
  status: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
};

describe('POST to /card/config', () => {
  it('should return config when received valid request', async () => {
    const pubkey =
      '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
    const reqEvent = { pubkey };
    const config: CardConfigPayload = {
      'trusted-merchants': [],
      cards: {},
    };
    jest.mocked(parseEventBody).mockReturnValue(reqEvent as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('card-config-request');
    jest.mocked(buildCardConfigPayload).mockResolvedValue(config);
    const body = {};
    const req: any = {
      context: {
        prisma: jest.fn(),
      },
      body,
    };

    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(config);
  });

  it('should fail when received invalid request', async () => {
    jest.mocked(parseEventBody).mockReturnValue(null);
    const req: any = {};

    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail when received invalid request tag', async () => {
    jest.mocked(parseEventBody).mockReturnValue({} as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('invalid-tag');
    const req: any = {};

    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(422);
  });

  it('should fail when building throws error', async () => {
    const pubkey =
      '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
    const reqEvent = { pubkey };
    jest.mocked(parseEventBody).mockReturnValue(reqEvent as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('card-config-request');
    jest.mocked(buildCardConfigPayload).mockRejectedValue('');
    const body = {};
    const req: any = {
      context: {
        prisma: jest.fn(),
      },
      body,
    };

    await handler(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });
});
