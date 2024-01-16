/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
  ],
  coverageDirectory: '.coverage',
  coverageProvider: 'v8',
  moduleNameMapper: {
    "^@constants/(.*)$": '<rootDir>/src/constants/$1',
    "^@lib/(.*)$": '<rootDir>/src/lib/$1',
    "^@nostr/(.*)$": '<rootDir>/src/nostr/$1',
    "^@rest/(.*)$": '<rootDir>/src/rest/$1',
    "^@services/(.*)$": '<rootDir>/src/services/$1',
    "^@type/(.*)$": '<rootDir>/src/type/$1',
  },
  randomize: true,
  setupFiles: [
    'dotenv/config',
  ],
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
  ],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
  ],
  transform: {
    '\\.ts$': '@swc/jest',
  },
};
