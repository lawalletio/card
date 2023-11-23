/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  transform: {
    '\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    "^@constants/(.*)$": '<rootDir>/src/constants/$1',
    "^@lib/(.*)$": '<rootDir>/src/lib/$1',
    "^@nostr/(.*)$": '<rootDir>/src/nostr/$1',
    "^@rest/(.*)$": '<rootDir>/src/rest/$1',
    "^@services/(.*)$": '<rootDir>/src/services/$1',
    "^@type/(.*)$": '<rootDir>/src/type/$1',
  },
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
  ],
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
  ],
  coverageDirectory: '.coverage',
  coverageProvider: 'v8',
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
  ],
  setupFiles: [
    'dotenv/config',
  ],
};
