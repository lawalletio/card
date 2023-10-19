import debug from 'debug';
import { Router } from 'express';
import { globSync } from 'glob';
import NDK from '@nostr-dev-kit/ndk';

import Path from 'path';
import { Context } from '@type/request';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export const logger: debug.Debugger = debug(process.env.MODULE_NAME || '');
const log: debug.Debugger = logger.extend('lib:utils');
const warn: debug.Debugger = logger.extend('lib:utils:warn');

export class EmptyRoutesError extends Error {}
export class DuplicateRoutesError extends Error {}

const methods: RouteMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const filesWithExtensionsWithoutExtensions = (
  path: string,
  extensions: string[],
) => {
  const extensionsSet = new Set(
    extensions.map((extension) => `.${extension.toLowerCase()}`),
  );

  const allFiles: string[] = [];

  globSync('*', {
    withFileTypes: true,
    cwd: path,
    matchBase: true,
    nocase: true,
    nodir: true,
  }).map((value) => {
    const filePath = value.relative();
    const fileExtension = Path.extname(filePath).toLowerCase();

    if (extensionsSet.has(fileExtension)) {
      const fileBase = Path.basename(filePath);

      allFiles.push(
        Path.join(
          Path.dirname(filePath),
          fileBase.substring(0, fileBase.length - fileExtension.length),
        ),
      );
    }
  });

  return allFiles;
};

const findDuplicates = (values: string[]) => {
  const counter: { [key: string]: number } = {};
  const duplicates: string[] = [];

  values.forEach((value) => {
    counter[value] = (counter[value] ?? 0) + 1;
  });
  for (const key in counter) {
    if (1 < counter[key]) {
      duplicates.push(key);
    }
  }

  return duplicates;
};

export const setUpRoutes = (router: Router, path: string): Router => {
  const allFiles = filesWithExtensionsWithoutExtensions(path, ['js', 'ts']);
  const duplicates = findDuplicates(allFiles);

  if (0 === allFiles.length) {
    throw new EmptyRoutesError();
  }

  if (duplicates.length) {
    throw new DuplicateRoutesError(`Duplicate routes: ${duplicates}`);
  }

  const routeHandlers = new Promise<Record<string, RouteMethod[]>>(
    (resolve, _reject) => {
      const allowedMethods: Record<string, RouteMethod[]> = {};
      allFiles.forEach(async (file, index, array) => {
        const matches = file.match(
          /^(?<route>.*)\/(?<method>get|post|put|patch|delete)$/i,
        );

        if (matches?.groups) {
          const method: RouteMethod = matches.groups.method as RouteMethod;
          const route: string = `/${matches.groups.route}`;

          router[method](
            route,
            (await require(Path.resolve(path, file))).default,
          );
          log(`Created ${method.toUpperCase()} route for ${route}`);
          if (undefined == allowedMethods[route]) {
            allowedMethods[route] = [];
          }
          allowedMethods[route].push(method);
        } else {
          warn(`Skipping ${file} as it doesn't comply to routes conventions.`);
        }
        if (index === array.length - 1) {
          resolve(allowedMethods);
        }
      });
    },
  );
  routeHandlers.then((allowedMethods) => {
    log('Allowed methods %O', allowedMethods);
    for (const route in allowedMethods) {
      const allowed = allowedMethods[route]
        .map((m) => m.toUpperCase())
        .join(', ');
      methods
        .filter((m) => !allowedMethods[route].includes(m))
        .forEach((m) => {
          router[m](route, (req, res) => {
            res.status(405).header('Allow', `OPTIONS, ${allowed}`).send();
          });
          log(`Created ${m.toUpperCase()} route for ${route}`);
        });
    }
  });

  return router;
};

export const setUpSubscriptions = (
  ctx: Context,
  ndk: NDK,
  path: string,
): NDK | null => {
  const allFiles = filesWithExtensionsWithoutExtensions(path, ['js', 'ts']);
  const duplicates = findDuplicates(allFiles);

  if (duplicates.length) {
    duplicates.forEach((duplicate) =>
      warn(`Found duplicate subscription ${duplicate}`),
    );
    return null;
  }

  allFiles.forEach(async (file) => {
    const matches = file.match(/^(?<name>[^/]*)$/i);

    if (matches?.groups) {
      let { filter, getHandler } = await require(Path.resolve(path, file));
      ndk
        .subscribe(filter, {
          closeOnEose: false,
        })
        .on('event', getHandler(ctx, 0));

      log(`Created ${matches.groups.name} subscription`);
    } else {
      warn(
        `Skipping ${file} as it doesn't comply to subscription conventions.`,
      );
    }
  });

  return ndk;
};

export const requiredEnvVar = (key: string): string => {
  const envVar = process.env[key];
  if (undefined === envVar) {
    throw new Error(`Environment process ${key} must be defined`);
  }
  return envVar;
};

export const requiredProp = <T>(obj: any, key: string): T => {
  if (obj[key] === undefined) {
    throw new Error(`Expected ${key} of ${obj} to be defined`);
  }
  return obj[key];
};

export const nowInSeconds = (): number => {
  return Math.round(Date.now() / 1000);
};

export const isEmpty = (obj: object): boolean => {
  for (let i in obj) {
    return false;
  }
  return true;
};

const sAlpha: string =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const sAlphaLength: bigint = BigInt(sAlpha.length);

export const uuid2suuid = (uuid: string): string => {
  if (
    !uuid.match(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/gi,
    )
  ) {
    throw new Error('Not a valid uuid');
  }

  let n: bigint = (uuid.replace(/-/g, '').match(/../g) ?? [])
    .map((hexPair: string) => BigInt(parseInt(hexPair, 16)))
    .reduce((acc: bigint, curr: bigint) => acc * 256n + curr);
  let suuid: string = '';
  while (n) {
    [suuid, n] = [sAlpha[Number(n % sAlphaLength)] + suuid, n / sAlphaLength];
  }
  return suuid;
};

export const suuid2uuid = (suuid: string): string => {
  if (!suuid.match(/^[a-z0-9_-]*$/gi)) {
    throw new Error('Not a valid suuid');
  }

  let n: bigint = (suuid.match(/./g) ?? [])
    .map((char: string) => BigInt(sAlpha.indexOf(char)))
    .reduce((acc: bigint, curr: bigint) => acc * sAlphaLength + curr);
  if (0xffffffffffffffffffffffffffffffffn < n) {
    throw new Error('Out of range');
  }
  let uuid = n.toString(16).padStart(32, '0');

  return (
    uuid.substring(0, 8) +
    '-' +
    uuid.substring(8, 12) +
    '-' +
    uuid.substring(12, 16) +
    '-' +
    uuid.substring(16, 20) +
    '-' +
    uuid.substring(20, 32)
  );
};
