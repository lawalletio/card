import type { Response } from 'express';

import {
  Kind,
  parseEventBody,
  validateDelegation,
  validateDelegationConditions,
} from '@lib/event';
import {
  fetchBalances,
  jsonParseOrNull,
  nowInSeconds,
  requiredEnvVar,
} from '@lib/utils';
import type { ExtendedRequest } from '@type/request';
import {
  Holder,
  Prisma,
  PrismaClient,
  ResetToken,
  TrustedMerchants,
  Delegation,
} from '@prisma/client';
import { NDKEvent, NostrEvent } from '@nostr-dev-kit/ndk';
import { getReadNDK, getWriteNDK } from '@services/ndk';

const RESET_EXPIRY_SECONDS: number = 180; // 3 minutes

const nostrPubKey: string = requiredEnvVar('NOSTR_PUBLIC_KEY');
const ledgerPubKey: string = requiredEnvVar('LEDGER_PUBLIC_KEY');
const identityProviderApiBase: string = requiredEnvVar(
  'IDENTITY_PROVIDER_API_BASE',
);

const tokensToTransferOnReset: string[] = ['BTC'];

type DelegationReq = {
  since: Date;
  until: Date;
  conditions: string;
  delegationToken: string;
};

type ResetClaimReq = {
  otc: string;
  delegation: DelegationReq;
};

async function cloneHolder(
  prisma: PrismaClient,
  oldPubkey: string,
  newPubKey: string,
  newDelegation: DelegationReq,
): Promise<Holder | null> {
  if (0 != (await prisma.holder.count({ where: { pubKey: newPubKey } }))) {
    return null;
  }

  const create: Prisma.HolderCreateInput = {
    pubKey: newPubKey,
    delegations: { create: newDelegation },
  };

  const trustedMerchants: TrustedMerchants[] =
    await prisma.trustedMerchants.findMany({
      where: { holderPubKey: oldPubkey },
    });
  if (0 < trustedMerchants.length) {
    create.trustedMerchants = { createMany: { data: trustedMerchants } };
  }

  return prisma.holder.create({ data: create });
}

async function buildIdentityProviderTransferEvent(
  oldPubkey: string,
  newPubkey: string,
  oldDelegation: DelegationReq,
): Promise<NostrEvent> {
  return new NDKEvent(getWriteNDK(), {
    pubkey: nostrPubKey,
    tags: [
      ['p', newPubkey],
      ['t', 'identity-transfer'],
      [
        'delegation',
        oldPubkey,
        oldDelegation.conditions,
        oldDelegation.delegationToken,
      ],
    ],
    content: '',
    created_at: nowInSeconds(),
    kind: Kind.REGULAR,
  }).toNostrEvent();
}

async function callIdentityProvider(
  oldPubkey: string,
  newPubkey: string,
  oldDelegation: DelegationReq,
): Promise<{ name: string } | { error: string }> {
  let apiBase = identityProviderApiBase;
  while (apiBase.lastIndexOf('/') === apiBase.length - 1) {
    apiBase = apiBase.slice(0, -1);
  }
  const apiUrl: URL = new URL('identity/transfer', `${apiBase}/`);

  const identityProviderResponse = await fetch(apiUrl, {
    method: 'POST',
    body: JSON.stringify(
      buildIdentityProviderTransferEvent(oldPubkey, newPubkey, oldDelegation),
    ),
    headers: {
      'Content-type': 'application/json',
    },
  });
  if (!identityProviderResponse.ok) {
    return {
      error: `non-2xx response from identity provider: ${identityProviderResponse.status}`,
    };
  }
  const textResponse: string = await identityProviderResponse.text();
  const result = jsonParseOrNull(textResponse);
  if (null === result) {
    return {
      error: `response from identity provider is not JSON: ${textResponse}`,
    };
  } else if (!('name' in result)) {
    return {
      error: 'response from identity provider doe snot contain a "name" entry',
    };
  }

  return result;
}

/**
 * Parse and validate request content
 *
 * @return the parsed card activate request
 */
function parseResetClaimReq(
  content: string,
): { ok: ResetClaimReq } | { error: string } {
  const req = JSON.parse(content);
  if (
    typeof req.otc !== 'string' ||
    typeof req.delegation?.conditions !== 'string' ||
    typeof req.delegation?.token !== 'string'
  ) {
    return { error: 'Not a valid content' };
  }
  const conditions = validateDelegationConditions(req.delegation.conditions);
  if (!conditions) {
    return { error: 'Not valid delegation conditions' };
  }
  req.delegation = {
    since: new Date(conditions.since * 1000),
    until: new Date(conditions.until * 1000),
    delegationToken: req.delegation.token,
    conditions: req.delegation.conditions,
  };
  return { ok: req };
}

/**
 * Endpoint for reset claim.
 *
 * Takes a one time code and a nip26 delegation, if there is an
 * available ntag424 create a card record associated to the ntag and to
 * the holder.
 *
 * Expected event content:
 *  {
 *    "otc": <one-time-code>,
 *    "delegation": {
 *      "conditions": <nip26-conditions>,
 *      "token": <nip26-sig>
 *    }
 *  }
 */
const handler = async (req: ExtendedRequest, res: Response) => {
  const now: number = nowInSeconds();

  // validate input
  const reqEvent: NostrEvent | null = parseEventBody(req.body);
  if (null === reqEvent) {
    res.status(422).send('Request body is not a valid NOSTR event');
    return;
  }
  const content: { ok: ResetClaimReq } | { error: string } = parseResetClaimReq(
    reqEvent.content,
  );
  if ('error' in content) {
    res.status(422).send(`Not a valid content: ${content.error}`);
    return;
  }
  if (
    !validateDelegation(
      reqEvent.pubkey,
      content.ok.delegation.conditions,
      content.ok.delegation.delegationToken,
    )
  ) {
    res.status(422).send('Invalid delegation');
    return;
  }

  // check resettoken validity
  const resetTokenEntity: ResetToken | null =
    await req.context.prisma.resetToken.findFirst({
      where: { token: content.ok.otc },
    });
  if (null === resetTokenEntity) {
    res.status(422).send('Reset token not found');
    return;
  } else if (
    Math.floor(resetTokenEntity.createdAt.getTime() / 1000) +
      RESET_EXPIRY_SECONDS <
    now
  ) {
    await req.context.prisma.resetToken.delete({
      where: { holderPubKey: resetTokenEntity.holderPubKey },
    });
    res.status(422).send('Reset token expired');
    return;
  }

  // check oldholder existence
  const oldHolder: Holder | null = await req.context.prisma.holder.findUnique({
    where: { pubKey: resetTokenEntity.holderPubKey },
  });
  if (null === oldHolder) {
    await req.context.prisma.resetToken.delete({
      where: { holderPubKey: resetTokenEntity.holderPubKey },
    });
    res.status(422).send('Holder does not exist anymore');
    return;
  }

  // fetch old delegation to use
  const oldHolderDelegation: Delegation | null =
    await req.context.prisma.delegation.findFirst({
      where: {
        delegatorPubKey: oldHolder.pubKey,
        since: { lte: new Date() },
        until: { gte: new Date() },
      },
    });
  if (null === oldHolderDelegation) {
    await req.context.prisma.resetToken.delete({
      where: { holderPubKey: resetTokenEntity.holderPubKey },
    });
    res.status(422).send('Holder has no valid delegations');
    return;
  }

  // ------- POINT OF NO RETURN -------

  // delete resettoken
  await req.context.prisma.resetToken.delete({
    where: { holderPubKey: resetTokenEntity.holderPubKey },
  });

  // create new holder as copy of old holder
  const newHolder: Holder | null = await cloneHolder(
    req.context.prisma,
    oldHolder.pubKey,
    reqEvent.pubkey,
    content.ok.delegation,
  );
  if (null === newHolder) {
    res.status(422).send('Holder collision');
    return;
  }

  // change card holder
  await req.context.prisma.card.updateMany({
    where: { holderPubKey: oldHolder.pubKey },
    data: { holderPubKey: newHolder.pubKey },
  });

  let fundsTransferOK = false;
  let identityTransferOK = false;
  let identityTransferPropagationOK = false;

  // transfer funds
  try {
    await req.context.outbox.publish({
      created_at: now,
      content: JSON.stringify({
        tokens: await fetchBalances(
          getReadNDK(),
          oldHolder.pubKey,
          tokensToTransferOnReset,
        ),
      }),
      tags: [
        ['p', ledgerPubKey],
        ['p', newHolder.pubKey],
        ['t', 'internal-transaction-start'],
        [
          'delegation',
          oldHolderDelegation.delegatorPubKey,
          oldHolderDelegation.conditions,
          oldHolderDelegation.delegationToken,
        ],
      ],
      kind: Kind.REGULAR,
      pubkey: nostrPubKey,
    });
    fundsTransferOK = true;
  } catch {
    // NOP
  }

  // let everybody know about the identity change
  try {
    await req.context.outbox.publish({
      created_at: now,
      content: '',
      tags: [
        ['p', newHolder.pubKey],
        ['t', 'identity-transfer-ok'],
        [
          'delegation',
          oldHolderDelegation.delegatorPubKey,
          oldHolderDelegation.conditions,
          oldHolderDelegation.delegationToken,
        ],
      ],
      kind: Kind.REGULAR,
      pubkey: nostrPubKey,
    });
    identityTransferOK = true;
  } catch {
    // NOP
  }

  // call identityprovider
  const identityProviderResponse: { name: string } | { error: string } =
    await callIdentityProvider(
      oldHolder.pubKey,
      newHolder.pubKey,
      oldHolderDelegation,
    );
  if (!('error' in identityProviderResponse)) {
    identityTransferPropagationOK = true;
  }

  res.status(201).send(
    JSON.stringify({
      ...identityProviderResponse,
      fundsTransferOK,
      identityTransferOK,
      identityTransferPropagationOK,
    }),
  );
  return;
};

export default handler;
