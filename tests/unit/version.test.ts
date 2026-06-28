import { describe, expect, it } from 'vitest';
import {
  BANNED_IMPORT_PATTERNS,
  PGAS_SERVER_IMPORTS,
  PGAS_SERVER_PACKAGE,
  PGAS_SERVER_RUNTIME_IMPORTS,
  PGAS_SERVER_TEST_IMPORTS,
  PGAS_SERVER_VERSION,
  isAllowedPgasServerImport,
  isAllowedPgasServerTestImport,
  isBannedImport,
} from '../../src/pgas-new/version.js';

describe('PGAS server version contract', () => {
  it('pins the published pgas-server version checked for this foundry', () => {
    expect(PGAS_SERVER_PACKAGE).toBe('@simodelne/pgas-server');
    expect(PGAS_SERVER_VERSION).toBe('2.16.0');
  });

  it('lists the allowed public pgas-server subpath imports', () => {
    expect(PGAS_SERVER_RUNTIME_IMPORTS).toEqual([
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ]);
    expect(PGAS_SERVER_TEST_IMPORTS).toEqual([
      '@simodelne/pgas-server/testing.js',
    ]);
    expect(PGAS_SERVER_IMPORTS).toEqual([...PGAS_SERVER_RUNTIME_IMPORTS, ...PGAS_SERVER_TEST_IMPORTS]);
  });

  it('recognizes only approved runtime subpaths without admitting private or test-only paths', () => {
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/client.js')).toBe(true);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/channels/index.js')).toBe(true);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/testing.js')).toBe(false);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/client/http.js')).toBe(false);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/routes/foo.js')).toBe(false);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server')).toBe(false);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/api')).toBe(false);
    expect(isAllowedPgasServerImport('@simodelne/pgas-server/src/plugin.js')).toBe(false);
  });

  it('keeps testing.js test-only', () => {
    expect(isAllowedPgasServerTestImport('@simodelne/pgas-server/testing.js')).toBe(true);
    expect(isAllowedPgasServerTestImport('@simodelne/pgas-server/plugin.js')).toBe(false);
    expect(isAllowedPgasServerTestImport('@simodelne/pgas-server/src/testing.js')).toBe(false);
  });

  it('captures banned v1, private, and split-runtime imports', () => {
    expect(BANNED_IMPORT_PATTERNS.length).toBeGreaterThan(0);
    expect(isBannedImport('@simodelne/pgas-server/api')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-server/src/plugin.js')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-runtime')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-runtime-core/foo')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-runtime-foo')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-contracts')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-middleware')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-drivers')).toBe(true);
    expect(isBannedImport('@simodelne/pgas-server/plugin.js')).toBe(false);
  });
});
