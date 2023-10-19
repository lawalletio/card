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

const writeNDK = getWriteNDK();
const ctx: Context = {
  prisma: getPrisma(),
  outbox: new OutboxService(getWriteNDK()),
};

// Instantiate ndk
log('Instantiate NDK');
const readNDK = getReadNDK();
log('Subscribing...');
const subscribed = setUpSubscriptions(
  ctx,
  readNDK,
  path.join(__dirname, './nostr'),
);

if (null === subscribed) {
  throw new Error('Error setting up subscriptions');
}

readNDK.pool.on('relay:connect', (relay: NDKRelay) => {
  log('Connected to Relay', relay.url);
});

readNDK.on('error', (err) => {
  log('Error connecting to Relay', err);
});

// Connect to Nostr
log('Connecting to Nostr...');
readNDK.connect().catch((error) => {
  warn('Error connecting to read relay: %o', error);
});
writeNDK.connect().catch((error) => {
  warn('Error connecting to write relay: %o', error);
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
