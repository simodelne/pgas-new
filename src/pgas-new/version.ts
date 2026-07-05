export const PGAS_SERVER_PACKAGE = "@simodelne/pgas-server";

export const PGAS_SERVER_VERSION = "3.5.0";

export const PGAS_SERVER_RUNTIME_IMPORTS = [
  "@simodelne/pgas-server/plugin.js",
  "@simodelne/pgas-server/create-server.js",
  "@simodelne/pgas-server/client.js",
  "@simodelne/pgas-server/channels/index.js",
  "@simodelne/pgas-server/routes/index.js",
] as const;

export const PGAS_SERVER_TEST_IMPORTS = [
  "@simodelne/pgas-server/testing.js",
] as const;

export const PGAS_SERVER_IMPORTS = [
  ...PGAS_SERVER_RUNTIME_IMPORTS,
  ...PGAS_SERVER_TEST_IMPORTS,
] as const;

export type PgasServerRuntimeImport = (typeof PGAS_SERVER_RUNTIME_IMPORTS)[number];
export type PgasServerTestImport = (typeof PGAS_SERVER_TEST_IMPORTS)[number];
export type PgasServerImport = (typeof PGAS_SERVER_IMPORTS)[number];

export const BANNED_IMPORT_PATTERNS = [
  /^@simodelne\/pgas-server\/api(?:$|\/)/,
  /^@simodelne\/pgas-server\/src(?:$|\/)/,
  /^@simodelne\/pgas-runtime(?:$|[-/])/,
  /^@simodelne\/pgas-contracts(?:$|\/)/,
  /^@simodelne\/pgas-middleware(?:$|\/)/,
  /^@simodelne\/pgas-drivers(?:$|\/)/,
] as const;

export function isBannedImport(specifier: string): boolean {
  return BANNED_IMPORT_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isAllowedPgasServerImport(specifier: string): boolean {
  if (isBannedImport(specifier)) {
    return false;
  }

  return (PGAS_SERVER_RUNTIME_IMPORTS as readonly string[]).includes(specifier);
}

export function isAllowedPgasServerTestImport(specifier: string): boolean {
  if (isBannedImport(specifier)) {
    return false;
  }

  return (PGAS_SERVER_TEST_IMPORTS as readonly string[]).includes(specifier);
}
