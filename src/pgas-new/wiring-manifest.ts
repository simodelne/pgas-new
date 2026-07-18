import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, sep } from 'node:path';
import { load } from 'js-yaml';
import { FIXED_WIRING_MANIFEST_PATH } from './model.js';
import { PGAS_SERVER_PACKAGE, isAllowedPgasServerImport, isBannedImport } from './version.js';

export const WIRING_MANIFEST_PATH = FIXED_WIRING_MANIFEST_PATH;
const WIRING_MANIFEST_SCHEMA_VERSION = 1;
const REPO_KINDS = ['existing_repo', 'standalone_repo'] as const;
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
const REGISTRATION_STRATEGIES = ['curator_request'] as const;
const REQUIRED_VERIFICATION_COMMANDS = ['install', 'typecheck', 'test'] as const;
const INTEGRATION_KINDS = ['http_api', 'db', 'sdk', 'module'] as const;
const AVAILABLE_PROGRAM_PROVIDES = [
  'delegation_research_agent',
  'delegation_document_ingest',
  'delegation_review',
] as const;
const INTEGRATION_NAME = /^[a-z][a-z0-9_-]*$/u;
const DOTTED_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/u;
const EXPORTED_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const BANNED_INTEGRATION_IMPORTS = new Set([
  'child_process',
  'node:child_process',
  'http',
  'node:http',
  'https',
  'node:https',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
]);

export type WiringIntegrationKind = (typeof INTEGRATION_KINDS)[number];
export type WiringAvailableProgramProvides = (typeof AVAILABLE_PROGRAM_PROVIDES)[number];

export interface WiringIntegration {
  name: string;
  kind: WiringIntegrationKind;
  import: string;
  factory?: string;
  methods: string[];
  config_env: string[];
}

export interface WiringAvailableProgram {
  slug: string;
  target_spec: string;
  provides: WiringAvailableProgramProvides;
  payload_map?: Record<string, string>;
  result_path?: string;
}

export interface WiringManifest {
  schema_version: number;
  repo: {
    kind: 'existing_repo' | 'standalone_repo';
    package_manager: 'npm' | 'pnpm' | 'yarn';
  };
  pgas: {
    server_package: typeof PGAS_SERVER_PACKAGE;
    allowed_imports: string[];
  };
  paths: {
    programs_dir: string;
    audit_dir: string;
    pgas_new_dir: string;
  };
  registration: {
    strategy: string;
  };
  verification: {
    commands: Record<string, string>;
  };
  curator: {
    github_owner: string;
    github_repo: string;
  };
  integrations?: WiringIntegration[];
  available_programs?: WiringAvailableProgram[];
}

export interface WiringManifestResult {
  ok: boolean;
  manifest?: WiringManifest;
  errors: string[];
}

export function loadWiringManifest(repoRoot: string): WiringManifestResult {
  const path = join(repoRoot, WIRING_MANIFEST_PATH);
  if (!existsSync(path)) {
    return { ok: false, errors: [`missing ${WIRING_MANIFEST_PATH}`] };
  }

  return parseWiringManifest(readFileSync(path, 'utf8'));
}

export function parseWiringManifest(source: string): WiringManifestResult {
  let parsed: unknown;
  try {
    parsed = load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`invalid YAML: ${message}`] };
  }

  const errors: string[] = [];
  if (!isRecord(parsed)) {
    return { ok: false, errors: ['manifest must be a YAML object'] };
  }

  requireNumber(parsed, 'schema_version', errors);
  const repo = requireObject(parsed, 'repo', errors);
  const pgas = requireObject(parsed, 'pgas', errors);
  const paths = requireObject(parsed, 'paths', errors);
  const registration = requireObject(parsed, 'registration', errors);
  const verification = requireObject(parsed, 'verification', errors);
  const curator = requireObject(parsed, 'curator', errors);
  validateIntegrations(parsed.integrations, errors);
  validateAvailablePrograms(parsed.available_programs, errors);

  requireString(repo, 'kind', errors, 'repo.kind');
  requireString(repo, 'package_manager', errors, 'repo.package_manager');
  requireString(pgas, 'server_package', errors, 'pgas.server_package');
  requireStringArray(pgas, 'allowed_imports', errors, 'pgas.allowed_imports');
  requireString(paths, 'programs_dir', errors, 'paths.programs_dir');
  requireString(paths, 'audit_dir', errors, 'paths.audit_dir');
  requireString(paths, 'pgas_new_dir', errors, 'paths.pgas_new_dir');
  requireString(registration, 'strategy', errors, 'registration.strategy');
  requireObject(verification, 'commands', errors, 'verification.commands');
  requireString(curator, 'github_owner', errors, 'curator.github_owner');
  requireString(curator, 'github_repo', errors, 'curator.github_repo');

  if (parsed.schema_version !== WIRING_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${WIRING_MANIFEST_SCHEMA_VERSION}`);
  }

  requireEnum(repo, 'kind', REPO_KINDS, errors, 'repo.kind');
  requireEnum(repo, 'package_manager', PACKAGE_MANAGERS, errors, 'repo.package_manager');
  requireEnum(registration, 'strategy', REGISTRATION_STRATEGIES, errors, 'registration.strategy');

  if (isRecord(pgas)) {
    if (pgas.server_package !== PGAS_SERVER_PACKAGE) {
      errors.push(`pgas.server_package must be ${PGAS_SERVER_PACKAGE}`);
    }

    if (Array.isArray(pgas.allowed_imports)) {
      for (const specifier of pgas.allowed_imports) {
        if (typeof specifier !== 'string') {
          continue;
        }
        if (isBannedImport(specifier)) {
          errors.push(`pgas.allowed_imports contains banned import: ${specifier}`);
        } else if (!isAllowedPgasServerImport(specifier)) {
          errors.push(`pgas.allowed_imports contains non-approved runtime import: ${specifier}`);
        }
      }
    }
  }

  if (isRecord(paths)) {
    for (const key of ['programs_dir', 'audit_dir', 'pgas_new_dir'] as const) {
      const value = paths[key];
      if (typeof value === 'string' && !isSafeRepoRelativePath(value)) {
        errors.push(`paths.${key} must be a safe repo-relative path`);
      }
    }
  }

  if (isRecord(verification?.commands)) {
    // Validate required commands first (this also catches a required command that is
    // absent entirely), then any remaining present commands. `flagged` prevents a
    // required-and-present-but-invalid command from being reported twice.
    const flagged = new Set<string>();
    for (const command of REQUIRED_VERIFICATION_COMMANDS) {
      const value = verification.commands[command];
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`verification.commands.${command} must be a non-empty string`);
        flagged.add(command);
      }
    }

    for (const [name, value] of Object.entries(verification.commands)) {
      if (flagged.has(name)) continue;
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`verification.commands.${name} must be a non-empty string`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, manifest: parsed as unknown as WiringManifest, errors: [] };
}

function validateIntegrations(value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push('integrations must be an array when present');
    return;
  }

  value.forEach((integration, index) => {
    const label = `integrations[${index}]`;
    if (!isRecord(integration)) {
      errors.push(`${label} must be an object`);
      return;
    }

    const name = integration.name;
    if (typeof name !== 'string' || !INTEGRATION_NAME.test(name)) {
      errors.push(`${label}.name must be a non-empty logical identifier`);
    }

    const kind = integration.kind;
    if (typeof kind !== 'string' || !(INTEGRATION_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${label}.kind must be one of: ${INTEGRATION_KINDS.join(', ')}`);
    }

    const importSpecifier = integration.import;
    if (typeof importSpecifier !== 'string' || importSpecifier.length === 0) {
      errors.push(`${label}.import must be a non-empty module specifier`);
    } else if (isBannedImport(importSpecifier) || BANNED_INTEGRATION_IMPORTS.has(importSpecifier)) {
      errors.push(`${label}.import contains banned import: ${importSpecifier}`);
    } else if (!isSafeIntegrationImportSpecifier(importSpecifier)) {
      errors.push(`${label}.import must be a safe module specifier`);
    }

    if (
      integration.factory !== undefined &&
      (typeof integration.factory !== 'string' || !EXPORTED_SYMBOL.test(integration.factory))
    ) {
      errors.push(`${label}.factory must be a non-empty exported symbol when present`);
    }

    const methods = integration.methods;
    if (!Array.isArray(methods) || methods.length === 0) {
      errors.push(`${label}.methods must contain at least one exported method name`);
    } else {
      methods.forEach((method, methodIndex) => {
        if (typeof method !== 'string' || !EXPORTED_SYMBOL.test(method)) {
          errors.push(`${label}.methods[${methodIndex}] must be an exported method name`);
        }
      });
    }

    const configEnv = integration.config_env;
    if (!Array.isArray(configEnv)) {
      errors.push(`${label}.config_env must be a string array`);
    } else {
      configEnv.forEach((envName, envIndex) => {
        if (typeof envName !== 'string' || !ENV_NAME.test(envName)) {
          errors.push(`${label}.config_env[${envIndex}] must be an env var name, not a value`);
        }
      });
    }
  });
}

function validateAvailablePrograms(value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push('available_programs must be an array when present');
    return;
  }

  value.forEach((availableProgram, index) => {
    const label = `available_programs[${index}]`;
    if (!isRecord(availableProgram)) {
      errors.push(`${label} must be an object`);
      return;
    }

    const slug = availableProgram.slug;
    if (typeof slug !== 'string' || !INTEGRATION_NAME.test(slug)) {
      errors.push(`${label}.slug must be a non-empty logical identifier`);
    }

    const targetSpec = availableProgram.target_spec;
    if (typeof targetSpec !== 'string' || targetSpec.trim().length === 0) {
      errors.push(`${label}.target_spec must be a non-empty string`);
    }

    const provides = availableProgram.provides;
    if (typeof provides !== 'string' || !(AVAILABLE_PROGRAM_PROVIDES as readonly string[]).includes(provides)) {
      errors.push(`${label}.provides must be one of: ${AVAILABLE_PROGRAM_PROVIDES.join(', ')}`);
    }

    const payloadMap = availableProgram.payload_map;
    if (payloadMap !== undefined) {
      if (!isRecord(payloadMap)) {
        errors.push(`${label}.payload_map must be an object when present`);
      } else {
        for (const [key, mapValue] of Object.entries(payloadMap)) {
          if (typeof mapValue !== 'string' || mapValue.trim().length === 0) {
            errors.push(`${label}.payload_map.${key} must be a non-empty string`);
          }
        }
      }
    }

    const resultPath = availableProgram.result_path;
    if (resultPath !== undefined && (typeof resultPath !== 'string' || !DOTTED_PATH.test(resultPath))) {
      errors.push(`${label}.result_path must be a non-empty dotted path`);
    }
  });
}

function isSafeIntegrationImportSpecifier(specifier: string): boolean {
  if (specifier.includes('\0') || specifier.includes('\\')) {
    return false;
  }
  if (specifier.startsWith('/') || specifier.startsWith('../') || specifier.includes('/../')) {
    return false;
  }
  return true;
}

function requireObject(parent: unknown, key: string, errors: string[], label = key): Record<string, unknown> | undefined {
  if (!isRecord(parent) || !isRecord(parent[key])) {
    errors.push(`missing object: ${label}`);
    return undefined;
  }

  return parent[key];
}

function requireString(parent: unknown, key: string, errors: string[], label = key): void {
  if (!isRecord(parent) || typeof parent[key] !== 'string' || parent[key].length === 0) {
    errors.push(`missing string: ${label}`);
  }
}

function requireNumber(parent: unknown, key: string, errors: string[], label = key): void {
  if (!isRecord(parent) || typeof parent[key] !== 'number') {
    errors.push(`missing number: ${label}`);
  }
}

function requireEnum<T extends string>(
  parent: unknown,
  key: string,
  values: readonly T[],
  errors: string[],
  label = key,
): void {
  const value = isRecord(parent) ? parent[key] : undefined;
  if (typeof value === 'string' && !(values as readonly string[]).includes(value)) {
    errors.push(`${label} must be one of: ${values.join(', ')}`);
  }
}

function requireStringArray(parent: unknown, key: string, errors: string[], label = key): void {
  const value = isRecord(parent) ? parent[key] : undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`missing string array: ${label}`);
  }
}

export function isSafeRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path === '.' || path.includes('\0')) {
    return false;
  }

  const normalized = path.split(sep).join('/');
  if (isAbsolute(path) || normalized.startsWith('/') || normalized.includes('\\')) {
    return false;
  }

  const clean = posix.normalize(normalized);
  if (clean === '.' || clean.startsWith('../') || clean === '..') {
    return false;
  }

  return clean === normalized.replace(/\/+$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
