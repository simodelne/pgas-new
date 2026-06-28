import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWiringManifest, parseWiringManifest, WIRING_MANIFEST_PATH } from '../../src/pgas-new/wiring-manifest.js';

const VALID_MANIFEST = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;

const VALID_MANIFEST_WITH_INTEGRATION = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
integrations:
  - name: crm
    kind: http_api
    import: "@acme/crm-client"
    factory: createCrmClient
    methods: [lookupAccount]
    config_env: [CRM_BASE_URL, CRM_TOKEN]
`;

describe('wiring manifest parser', () => {
  it('parses a valid fixed-path manifest', () => {
    const result = parseWiringManifest(VALID_MANIFEST);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.pgas.server_package).toBe('@simodelne/pgas-server');
    expect(result.manifest?.paths.pgas_new_dir).toBe('.pgas/pgas-new');
  });

  it('parses optional declared repo integrations without env values', () => {
    const result = parseWiringManifest(VALID_MANIFEST_WITH_INTEGRATION);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.integrations).toEqual([
      {
        name: 'crm',
        kind: 'http_api',
        import: '@acme/crm-client',
        factory: 'createCrmClient',
        methods: ['lookupAccount'],
        config_env: ['CRM_BASE_URL', 'CRM_TOKEN'],
      },
    ]);
  });

  it('allows integrations to be omitted or empty', () => {
    expect(parseWiringManifest(VALID_MANIFEST)).toMatchObject({ ok: true, errors: [] });
    expect(parseWiringManifest(`${VALID_MANIFEST}\nintegrations: []\n`)).toMatchObject({ ok: true, errors: [] });
  });

  it('loads only .pgas/wiring.yml from a repo root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-manifest-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, WIRING_MANIFEST_PATH), VALID_MANIFEST);

      const result = loadWiringManifest(repo);
      expect(result.ok).toBe(true);
      expect(result.manifest?.curator.github_repo).toBe('simoneos');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports a missing fixed-path manifest without throwing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-missing-'));
    try {
      expect(loadWiringManifest(repo)).toEqual({
        ok: false,
        errors: ['missing .pgas/wiring.yml'],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a manifest for the wrong server package', () => {
    const result = parseWiringManifest(VALID_MANIFEST.replace('@simodelne/pgas-server', '@example/pgas-server'));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('pgas.server_package must be @simodelne/pgas-server');
  });

  it('rejects private or non-approved pgas imports', () => {
    const result = parseWiringManifest(
      VALID_MANIFEST.replace(
        '"@simodelne/pgas-server/routes/index.js"',
        '"@simodelne/pgas-server/src/testing.js"',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('pgas.allowed_imports contains banned import: @simodelne/pgas-server/src/testing.js');
  });

  it('rejects malformed integration declarations with clear field errors', () => {
    const result = parseWiringManifest(`
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
integrations:
  - name: ""
    kind: raw_socket
    import: "node:child_process"
    factory: ""
    methods: []
    config_env: ["CRM_TOKEN=secret", "lowercase"]
`);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'integrations[0].name must be a non-empty logical identifier',
        'integrations[0].kind must be one of: http_api, db, sdk, module',
        'integrations[0].import contains banned import: node:child_process',
        'integrations[0].factory must be a non-empty exported symbol when present',
        'integrations[0].methods must contain at least one exported method name',
        'integrations[0].config_env[0] must be an env var name, not a value',
        'integrations[0].config_env[1] must be an env var name, not a value',
      ]),
    );
  });

  it('rejects test-only and obsolete public imports from runtime wiring', () => {
    const result = parseWiringManifest(
      VALID_MANIFEST.replace(
        '"@simodelne/pgas-server/routes/index.js"',
        '"@simodelne/pgas-server/testing.js"',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('pgas.allowed_imports contains non-approved runtime import: @simodelne/pgas-server/testing.js');
  });

  it('requires exact schema, enums, command strings, and safe repo-relative paths', () => {
    const result = parseWiringManifest(`
schema_version: 2
repo:
  kind: other
  package_manager: bun
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
paths:
  programs_dir: "../programs"
  audit_dir: "/tmp/audit"
  pgas_new_dir: "."
registration:
  strategy: direct_patch
verification:
  commands:
    install: ["npm", "install"]
    typecheck: ""
curator:
  github_owner: simodelne
  github_repo: simoneos
`);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'schema_version must be 1',
        'repo.kind must be one of: existing_repo, standalone_repo',
        'repo.package_manager must be one of: npm, pnpm, yarn',
        'registration.strategy must be one of: curator_request',
        'paths.programs_dir must be a safe repo-relative path',
        'paths.audit_dir must be a safe repo-relative path',
        'paths.pgas_new_dir must be a safe repo-relative path',
        'verification.commands.install must be a non-empty string',
        'verification.commands.typecheck must be a non-empty string',
        'verification.commands.test must be a non-empty string',
      ]),
    );
  });

  it('rejects null, scalar, and array YAML payloads as non-object manifests', () => {
    for (const source of ['null', '~', 'just-a-string', '- one\n- two']) {
      const result = parseWiringManifest(source);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('manifest must be a YAML object');
    }
  });

  it('ships a valid manifest template', () => {
    const template = readFileSync('templates/pgas-new/repo/.pgas/wiring.yml.tmpl', 'utf8');
    const rendered = template
      .replaceAll('{{GITHUB_OWNER}}', 'simodelne')
      .replaceAll('{{GITHUB_REPO}}', 'simoneos');

    expect(parseWiringManifest(rendered)).toMatchObject({ ok: true, errors: [] });
  });
});
