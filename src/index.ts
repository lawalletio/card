import app from './app';
import path from 'path';
import { Debugger } from 'debug';
import express, { Router } from 'express';
import * as middlewares from '@lib/middlewares';
import { EmptyRoutesError, setUpRoutes, setUpSubscriptions } from '@lib/utils';
import { Context, ExtendedRequest } from '@type/request';
import 'websocket-polyfill';

import { logger } from '@lib/utils';
import { getReadNDK, getWriteNDK } from '@services/ndk';
import { NDKRelay } from '@nostr-dev-kit/ndk';
import { OutboxService } from '@services/outbox';
import { getPrisma } from '@services/prisma';

const port = process.env.PORT || 8000;

const log: Debugger = logger.extend('index');
const warn: Debugger = log.extend('warn');
const error: Debugger = log.extend('error');

const writeNDK = getWriteNDK();
const ctx: Context = {
  prisma: getPrisma(),
  outbox: new OutboxService(getWriteNDK()),
  writeNDK,
};

// Instantiate ndk
log('Instantiate NDK');
const readNDK = getReadNDK();

readNDK.pool.on('relay:connect', async (relay: NDKRelay) => {
  log('Connected to Relay %s', relay.url);
  log('Subscribing...');
  const subscribed = await setUpSubscriptions(
    ctx,
    readNDK,
    writeNDK,
    path.join(__dirname, './nostr'),
  );

  if (null === subscribed) {
    throw new Error('Error setting up subscriptions');
  }
});

readNDK.pool.on('relay:disconnect', (relay: NDKRelay) => {
  log('Disconnected from relay %s', relay.url);
});

readNDK.on('error', (err) => {
  log('Error connecting to Relay', err);
});

// Connect to Nostr
log('Connecting to Nostr...');
readNDK.connect().catch((e) => {
  warn('Error connecting to read relay: %o', e);
});
writeNDK.connect().catch((e) => {
  warn('Error connecting to write relay: %o', e);
});

// Generate routes
log('Setting up routes...');
let routes: Router = express.Router();
let startExpress = true;

try {
  routes = setUpRoutes(routes, path.join(__dirname, 'rest'));
} catch (e) {
  if (e instanceof EmptyRoutesError) {
    log('Empty routes, this module will not be reachable by HTTP API');
    startExpress = false;
  } else {
    throw e;
  }
}

if (startExpress) {
  // Setup context
  routes.use((req, res, next) => {
    (req as ExtendedRequest).context = ctx;
    next();
  });

  // Setup express routes
  app.use('/', routes);

  // Setup express routes
  app.use(middlewares.notFound);
  app.use(middlewares.errorHandler);

  //-- Start process --//

  // Start listening
  app.listen(port, () => {
    log(`Server is running on port ${port}`);
  });
}

process.on('uncaughtException', (err) => {
  error('Unexpected uncaught exception: %O', err);
  log('Shutting down...');
  process.exit(1);
});
