import {
  CardDataPayload,
  buildCardDataEvent,
  buildCardDataPayload,
} from '@lib/config';
import { getTagValue, parseEventBody } from '@lib/event';
import { NostrEvent } from '@nostr-dev-kit/ndk';

import handler from '@rest/card/data/request/post';

jest.mock('@lib/config', () => {
  return {
    __esModule: true,
    buildCardDataEvent: jest.fn(),
    buildCardDataPayload: jest.fn(),
  };
});
jest.mock('@lib/event', () => {
  return {
    __esModule: true,
    getTagValue: jest.fn(),
    parseEventBody: jest.fn(),
  };
});

describe('POST to /card/data/request', () => {
  it('should publish event when received valid request', async () => {
    const pubkey =
      '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
    const reqEvent = { pubkey };
    const dataEvent = {
      id: '1234',
    };
    const dataPayload = {};
    jest.mocked(parseEventBody).mockReturnValue(reqEvent as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('card-data-request');
    jest.mocked(buildCardDataEvent).mockResolvedValue(dataEvent as NostrEvent);
    jest
      .mocked(buildCardDataPayload)
      .mockResolvedValue(dataPayload as CardDataPayload);
    const body = {};
    const req: any = {
      context: {
        outbox: {
          publish: jest.fn(),
        },
      },
      body,
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await handler(req, res);

    expect(req.context.outbox.publish).toHaveBeenCalledWith(dataEvent);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(dataPayload);
  });

  it('should fail when received invalid request', async () => {
    jest.mocked(parseEventBody).mockReturnValue(null);
    const req: any = {
      context: {
        outbox: {
          publish: jest.fn(),
        },
      },
    };
    const res: any = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('should fail when received invalid request tag', async () => {
    jest.mocked(parseEventBody).mockReturnValue({} as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('invalid-tag');
    const req: any = {
      context: {
        outbox: {
          publish: jest.fn(),
        },
      },
    };
    const res: any = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('should fail when publishing throws error', async () => {
    const pubkey =
      '9e34efffcc194e9636392a5937ce7986aef62f5f36b62312dcc7ddecd606b175';
    const reqEvent = { pubkey };
    const dataEvent = {
      id: '1234',
    };
    jest.mocked(parseEventBody).mockReturnValue(reqEvent as NostrEvent);
    jest.mocked(getTagValue).mockReturnValue('card-data-request');
    jest.mocked(buildCardDataEvent).mockResolvedValue(dataEvent as NostrEvent);
    const body = {};
    const req: any = {
      context: {
        outbox: {
          publish: jest.fn().mockRejectedValue(''),
        },
      },
      body,
    };
    const res: any = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };

    await handler(req, res);

    expect(req.context.outbox.publish).toHaveBeenCalledWith(dataEvent);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
