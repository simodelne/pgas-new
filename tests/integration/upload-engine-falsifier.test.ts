import { File } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ReactionHandler,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';

const REQUIRED_PROGRAM = 'upload-falsifier-required';
const NO_CHANNEL_PROGRAM = 'upload-falsifier-no-channel';
const OPTIONAL_PROGRAM = 'upload-falsifier-optional';
const PARK_PROGRAM = 'upload-falsifier-park';
const REUPLOAD_PROGRAM = 'upload-falsifier-reupload';
const DOCUMENT_REFS_PATH = 'inputs.document_intake.file_refs';
const DOCUMENT_STATUS_PATH = 'inputs.document_intake.status';
const DOCUMENT_ROOT_PATH = 'inputs.document_intake';
const SOURCE_PATH = 'work.source';
const SOURCE_READY_PATH = 'work.source_ready';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const NO_DOCS_SOURCE = '[No documents \u2014 user skipped upload]';

describe('upload route-level engine falsifier', () => {
  it('executes F-1..F-9 through the real HTTP route', async () => {
    const required = await runRequiredScenarioOrStop();
    const failures: Error[] = [];

    await recordFalsifier('F-2', failures, async () => {
      const refs = required.afterUploadDomain[DOCUMENT_REFS_PATH];
      const indexedRef = required.afterUploadDomain[`${DOCUMENT_REFS_PATH}.0`];
      expect(Array.isArray(refs)).toBe(true);
      expect(isRecord(indexedRef)).toBe(true);
      expect((refs as Array<Record<string, unknown>>)[0]?.fileId).toBe(required.fileRef.fileId);
      expect((indexedRef as Record<string, unknown>).fileId).toBe(required.fileRef.fileId);
      return {
        domain_ref_array: refs,
        indexed_child: indexedRef,
        uploaded_file_id: required.fileRef.fileId,
      };
    });

    runF3OrStop(required);

    await recordFalsifier('F-4', failures, async () => {
      expect(required.triggerError).toBeUndefined();
      expect(required.source.status).toBe('extracted');
      expect(String(required.source.full_text)).toContain(required.fixture.sentinel);
      expect(required.source.char_count).toBe(required.fixture.sizeBytes);
      expect(required.source.file_count).toBe(1);
      expect(required.sourceReady).toBe(true);
      expect(required.finalMode).toBe('complete');
      return {
        landed_work_source: required.source,
        source_ready: required.sourceReady,
        final_mode: required.finalMode,
        order: required.order,
      };
    });

    await recordFalsifier('F-5', failures, async () => {
      const evidence = await runUndeclaredChannelScenario();
      // Installed 3.21.0 maps this spec-channel validation failure to ClientInputError/422.
      // The design expected 400; the rejection reason and message are the route-level proof.
      expect(evidence.status).toBe(422);
      expect(evidence.reason).toBe('channel_not_declared');
      expect(evidence.message).toMatch(/not declared in spec\.channels/i);
      return evidence;
    });

    await recordFalsifier('F-6', failures, async () => {
      const evidence = await runUploadValidatorScenario();
      expect(evidence.pdf_mismatch.status).toBe(400);
      expect(evidence.pdf_mismatch.message).toMatch(/signature.*declared content type/i);
      expect(evidence.empty_text.status).toBe(400);
      expect(evidence.empty_text.message).toMatch(/empty/i);
      expect(evidence.oversize.status).toBe(400);
      expect(evidence.oversize.message).toMatch(/exceeds|maximum upload size|25 MB/i);
      return evidence;
    });

    await recordFalsifier('F-7', failures, async () => {
      const evidence = await runSkipScenario();
      expect(evidence.no_docs_record).toEqual({
        status: 'no_documents_available',
        completed: true,
        documents_requested: true,
        source: NO_DOCS_SOURCE,
      });
      expect(evidence.source_status).toBe('skipped_no_documents');
      expect(evidence.source_ready).toBe(true);
      expect(evidence.final_mode).toBe('complete');
      return evidence;
    });

    await recordFalsifier('F-8', failures, async () => {
      const evidence = await runParkScenario();
      expect(evidence.awaiting_decision).toMatchObject({
        channelId: 'document_upload',
        actionName: 'request_documents',
        mode: 'request',
      });
      expect(evidence.mode_after_request).toBe('request');
      expect(evidence.order_after_request).toEqual(['park:request_documents']);
      expect(evidence.source_before_upload).toEqual({});
      expect(String(evidence.source.full_text)).toContain(evidence.fixture.sentinel);
      expect(evidence.final_mode).toBe('complete');
      return evidence;
    });

    await recordInformativeFalsifier('F-9', async () => {
      const evidence = await runReuploadScenario();
      expect(evidence.second_observation?.sentinelMatch).toBe(true);
      expect(evidence.second_observation?.contentText).toContain(evidence.second_fixture.sentinel);
      expect(evidence.second_observation?.contentText).not.toContain(evidence.first_fixture.sentinel);
      expect(String(evidence.source.full_text)).toContain(evidence.second_fixture.sentinel);
      expect(String(evidence.source.full_text)).not.toContain(evidence.first_fixture.sentinel);
      return evidence;
    });

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('\n'));
    }
  });
});

async function runRequiredScenarioOrStop(): Promise<RequiredScenarioEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: REQUIRED_PROGRAM,
      script: [
        scripted('required:enter_upload', effect('enter_upload', { topic: 'upload-intake' })),
        scripted('required:ingest_documents', effect('ingest_documents', {})),
      ],
      createEntry: (tempDir) => createEntry(tempDir, REQUIRED_PROGRAM, requiredSpecYaml(REQUIRED_PROGRAM), state, {
        handlerNames: ['enter_upload', 'ingest_documents'],
        reactionHandlers: new Map<string, ReactionHandler>([
          ['settle_source', settleExtractedSource],
        ]),
      }),
      state,
    },
    async ({ client, tempDir, state: handlerState, order }) => {
      const created = await client.sessions.create({ program: REQUIRED_PROGRAM });
      const fixture = createFixture(tempDir, 'f1');
      const f1 = await runF1OrStop(client, created.sessionId, fixture);
      handlerState.expected = expectedDocumentFromFixture(fixture, f1.fileRef);

      await client.sessions.trigger(created.sessionId, {
        channel: 'user_text',
        payload: 'bootstrap upload intake',
      });
      const afterBootstrap = await client.sessions.get(created.sessionId);
      expect(modeOf(afterBootstrap)).toBe('await_upload');

      let triggerError: string | undefined;
      try {
        await client.sessions.trigger(created.sessionId, {
          channel: 'document_upload',
          payload: documentRefPayload(f1.fileRef),
        });
      } catch (error) {
        triggerError = errorMessage(error);
      }

      const [afterUploadSession, afterUploadWorld] = await Promise.all([
        safeRead(() => client.sessions.get(created.sessionId)),
        safeRead(() => client.sessions.world(created.sessionId)),
      ]);
      let afterUploadDomain: Record<string, unknown> = {};
      if (afterUploadWorld.ok && isRecord(afterUploadWorld.value.domain)) {
        afterUploadDomain = afterUploadWorld.value.domain;
      }
      const source = resultAt(afterUploadDomain, SOURCE_PATH);

      return {
        sessionId: created.sessionId,
        fixture,
        fileRef: f1.fileRef,
        listedFiles: f1.listedFiles,
        roundTripText: f1.roundTripText,
        triggerError,
        afterUploadDomain,
        finalMode: afterUploadSession.ok ? modeOf(afterUploadSession.value) : null,
        finalStatus: afterUploadSession.ok && typeof afterUploadSession.value.status === 'string'
          ? afterUploadSession.value.status
          : undefined,
        source,
        sourceReady: afterUploadDomain[SOURCE_READY_PATH],
        handlerObservations: [...handlerState.observations],
        order: [...order],
      };
    },
  );
}

async function runF1OrStop(
  client: PgasClient,
  sessionId: string,
  fixture: UploadFixture,
): Promise<F1Evidence> {
  let observed: Record<string, unknown> | null = null;
  try {
    const uploadResponse = await uploadFixture(client, sessionId, fixture);
    const [fileRef] = refsFromResponse(uploadResponse);
    expect(fileRef).toBeDefined();
    expect(fileRef.fileId).toEqual(expect.any(String));
    expect(fileRef.name).toBe(fixture.name);
    expect(fileRef.mimeType).toBe('text/plain');
    expect(fileRef.size).toBe(fixture.sizeBytes);

    const listResponse = await client.files.list(sessionId);
    const listedFiles = refsFromResponse(listResponse);
    const bytes = Buffer.from(await client.files.getBytes(sessionId, fileRef.fileId));
    const roundTripText = bytes.toString('utf8');

    observed = {
      upload_resolved: true,
      upload_response: uploadResponse,
      file_ref: fileRef,
      listed_files: listedFiles,
      roundtrip_size: bytes.length,
      roundtrip_contains_sentinel: roundTripText.includes(fixture.sentinel),
    };

    expect(listedFiles.some((listed) => listed.fileId === fileRef.fileId)).toBe(true);
    expect(roundTripText).toBe(fixture.content);
    writeFalsifierLine('F-1', 'PASS', observed);

    return { fileRef, listedFiles, roundTripText };
  } catch (error) {
    writeFalsifierLine('F-1', 'FAIL', {
      expected: {
        upload_surface: 'client.files.upload resolves with {files:[FileRef]}',
        listed_by_client_files_list: true,
        get_bytes_roundtrips_sentinel: fixture.sentinel,
      },
      observed,
      error: errorMessage(error),
    });
    throw error;
  }
}

function runF3OrStop(required: RequiredScenarioEvidence): void {
  const observed = required.handlerObservations.at(-1) ?? null;
  const expected = {
    sentinel: required.fixture.sentinel,
    mime_type: 'text/plain',
    size: required.fixture.sizeBytes,
    name: required.fixture.name,
  };
  try {
    expect(required.triggerError).toBeUndefined();
    expect(observed).not.toBeNull();
    expect(observed?.sentinelMatch).toBe(true);
    expect(observed?.mimeType).toBe(expected.mime_type);
    expect(observed?.size).toBe(expected.size);
    expect(observed?.name).toBe(expected.name);
    writeFalsifierLine('F-3', 'PASS', {
      expected,
      observed,
      trigger_error: required.triggerError,
    });
  } catch (error) {
    writeFalsifierLine('F-3', 'FAIL', {
      expected,
      observed,
      trigger_error: required.triggerError,
      error: errorMessage(error),
    });
    throw new Error(`F-3 failed: ${errorMessage(error)}`);
  }
}

async function runUndeclaredChannelScenario(): Promise<ApiErrorEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: NO_CHANNEL_PROGRAM,
      script: [],
      createEntry: (tempDir) => createEntry(tempDir, NO_CHANNEL_PROGRAM, noChannelSpecYaml(NO_CHANNEL_PROGRAM), state, {
        handlerNames: ['noop'],
      }),
      state,
    },
    async ({ client }) => {
      const created = await client.sessions.create({ program: NO_CHANNEL_PROGRAM });
      return expectTriggerReject(client, created.sessionId, {
        channel: 'document_upload',
        payload: 'undeclared document upload channel',
      });
    },
  );
}

async function runUploadValidatorScenario(): Promise<UploadValidatorEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: NO_CHANNEL_PROGRAM,
      script: [],
      createEntry: (tempDir) => createEntry(tempDir, NO_CHANNEL_PROGRAM, noChannelSpecYaml(NO_CHANNEL_PROGRAM), state, {
        handlerNames: ['noop'],
      }),
      state,
    },
    async ({ client }) => {
      const created = await client.sessions.create({ program: NO_CHANNEL_PROGRAM });
      const textAsPdf = new File(['plain text that is not a pdf'], 'declared.pdf', { type: 'application/pdf' });
      const emptyText = new File([''], 'empty.txt', { type: 'text/plain' });
      const oversize = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'oversize.txt', { type: 'text/plain' });

      return {
        pdf_mismatch: await expectUploadReject(client, created.sessionId, textAsPdf),
        empty_text: await expectUploadReject(client, created.sessionId, emptyText),
        oversize: await expectUploadReject(client, created.sessionId, oversize),
      };
    },
  );
}

async function runSkipScenario(): Promise<SkipEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: OPTIONAL_PROGRAM,
      script: [
        scripted('skip:complete_skip', effect('complete_skip', {})),
      ],
      createEntry: (tempDir) => createEntry(tempDir, OPTIONAL_PROGRAM, optionalSpecYaml(OPTIONAL_PROGRAM), state, {
        handlerNames: ['complete_skip'],
        reactionHandlers: new Map<string, ReactionHandler>([
          ['settle_optional_skip', settleOptionalSkip],
        ]),
      }),
      state,
    },
    async ({ client, order }) => {
      const created = await client.sessions.create({ program: OPTIONAL_PROGRAM });
      await client.sessions.trigger(created.sessionId, {
        channel: 'document_upload',
        payload: { [DOCUMENT_STATUS_PATH]: 'no_documents_available' },
      });
      const [session, world] = await Promise.all([
        client.sessions.get(created.sessionId),
        client.sessions.world(created.sessionId),
      ]);
      const domain = world.domain;
      const source = resultAt(domain, SOURCE_PATH);
      return {
        no_docs_record: domain[DOCUMENT_ROOT_PATH],
        source_status: source.status,
        source_ready: domain[SOURCE_READY_PATH],
        final_mode: modeOf(session),
        order: [...order],
      };
    },
  );
}

async function runParkScenario(): Promise<ParkEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: PARK_PROGRAM,
      script: [
        scripted('park:request_documents', effect('request_documents', { prompt: 'upload the source document' })),
        scripted('park:ingest_documents', effect('ingest_documents', {})),
      ],
      createEntry: (tempDir) => createEntry(tempDir, PARK_PROGRAM, parkSpecYaml(PARK_PROGRAM), state, {
        handlerNames: ['request_documents', 'ingest_documents'],
        reactionHandlers: new Map<string, ReactionHandler>([
          ['settle_source', settleExtractedSource],
        ]),
      }),
      state,
    },
    async ({ client, tempDir, state: handlerState, order }) => {
      const created = await client.sessions.create({ program: PARK_PROGRAM });
      await client.sessions.trigger(created.sessionId, {
        channel: 'user_text',
        payload: 'please request my source document',
      });
      const afterRequest = await client.sessions.get(created.sessionId);
      const worldAfterRequest = await client.sessions.world(created.sessionId);
      const roundAfterRequest = currentRoundNumberOf(afterRequest);
      const awaitingDecision = awaitingDecisionOf(afterRequest);
      const orderAfterRequest = [...order];
      const sourceBeforeUpload = resultAt(worldAfterRequest.domain, SOURCE_PATH);

      const fixture = createFixture(tempDir, 'park');
      const uploadResponse = await uploadFixture(client, created.sessionId, fixture);
      const [fileRef] = refsFromResponse(uploadResponse);
      handlerState.expected = expectedDocumentFromFixture(fixture, fileRef);

      await client.sessions.trigger(created.sessionId, {
        channel: 'document_upload',
        payload: documentRefPayload(fileRef),
      });
      const [finalSession, world] = await Promise.all([
        client.sessions.get(created.sessionId),
        client.sessions.world(created.sessionId),
      ]);
      const source = resultAt(world.domain, SOURCE_PATH);

      return {
        awaiting_decision: awaitingDecision,
        mode_after_request: modeOf(afterRequest),
        round_after_request: roundAfterRequest,
        order_after_request: orderAfterRequest,
        source_before_upload: sourceBeforeUpload,
        fixture,
        file_ref: fileRef,
        source,
        final_mode: modeOf(finalSession),
        final_awaiting_decision: awaitingDecisionOf(finalSession),
        order: [...order],
      };
    },
  );
}

async function runReuploadScenario(): Promise<ReuploadEvidence> {
  const state = createHandlerState();
  return withUploadServer(
    {
      programName: REUPLOAD_PROGRAM,
      script: [
        scripted('reupload:first_ingest', effect('ingest_documents', {})),
        scripted('reupload:second_ingest', effect('ingest_documents', {})),
      ],
      createEntry: (tempDir) => createEntry(tempDir, REUPLOAD_PROGRAM, reuploadSpecYaml(REUPLOAD_PROGRAM), state, {
        handlerNames: ['ingest_documents', 'finish'],
      }),
      state,
    },
    async ({ client, tempDir, state: handlerState, order }) => {
      const created = await client.sessions.create({ program: REUPLOAD_PROGRAM });

      const firstFixture = createFixture(tempDir, 'reupload-first');
      const firstUpload = await uploadFixture(client, created.sessionId, firstFixture);
      const [firstFileRef] = refsFromResponse(firstUpload);
      handlerState.expected = expectedDocumentFromFixture(firstFixture, firstFileRef);
      await client.sessions.trigger(created.sessionId, {
        channel: 'document_upload',
        payload: documentRefPayload(firstFileRef),
      });

      const secondFixture = createFixture(tempDir, 'reupload-second');
      const secondUpload = await uploadFixture(client, created.sessionId, secondFixture);
      const [secondFileRef] = refsFromResponse(secondUpload);
      handlerState.expected = expectedDocumentFromFixture(secondFixture, secondFileRef);
      await client.sessions.trigger(created.sessionId, {
        channel: 'document_upload',
        payload: documentRefPayload(secondFileRef),
      });

      const world = await client.sessions.world(created.sessionId);
      const source = resultAt(world.domain, SOURCE_PATH);
      return {
        first_fixture: firstFixture,
        second_fixture: secondFixture,
        first_file_ref: firstFileRef,
        second_file_ref: secondFileRef,
        first_observation: handlerState.observations[0],
        second_observation: handlerState.observations[1],
        source,
        order: [...order],
      };
    },
  );
}

async function withUploadServer<T>(
  scenario: UploadServerScenario,
  run: (ctx: { client: PgasClient; tempDir: string; state: UploadHandlerState; order: string[] }) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-upload-falsifier-'));
  const order: string[] = [];
  const entry = scenario.createEntry(tempDir);
  const server = await createPgasServer({
    programs: [
      { name: scenario.programName, entry },
    ],
    drivers: {
      authorHandle: scriptedAuthor(scenario.script, order),
      observerHandle: {
        modelId: 'upload-falsifier-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    return await run({ client, tempDir, state: scenario.state, order });
  } finally {
    await server.close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createEntry(
  tempDir: string,
  programName: string,
  yaml: string,
  state: UploadHandlerState,
  options: { handlerNames: string[]; reactionHandlers?: Map<string, ReactionHandler> },
): ProgramEntry {
  const specPath = path.join(tempDir, `${programName}-${crypto.randomUUID()}.yml`);
  writeFileSync(specPath, yaml, 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const handlers = selectHandlers(createUploadHandlers(state), options.handlerNames);
  return {
    spec,
    reactionHandlers: options.reactionHandlers,
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, handlers),
  };
}

function createUploadHandlers(state: UploadHandlerState): Record<string, ToolHandler> {
  return {
    async enter_upload(payload) {
      return { ok: true, action: 'enter_upload', payload };
    },
    async request_documents(payload) {
      return { ok: true, action: 'request_documents', payload };
    },
    async complete_skip(payload) {
      return { ok: true, action: 'complete_skip', payload };
    },
    async noop(payload) {
      return { ok: true, action: 'noop', payload };
    },
    async finish(payload) {
      return { ok: true, action: 'finish', payload };
    },
    async ingest_documents(payload) {
      const observation = observeDocumentPayload(payload, state.expected);
      state.observations.push(observation);
      if (state.expected && !observationMatches(observation, state.expected)) {
        throw new Error(`document injection mismatch: ${JSON.stringify({
          expected: state.expected,
          observed: observation,
        })}`);
      }
      return {
        status: 'extracted',
        full_text: observation.contentText ?? '',
        char_count: observation.contentText?.length ?? 0,
        file_count: observation.documentCount,
        files_json: JSON.stringify(observation.documentSummaries),
      };
    },
  };
}

function selectHandlers(
  handlers: Record<string, ToolHandler>,
  names: string[],
): Record<string, ToolHandler> {
  const selected: Record<string, ToolHandler> = {};
  for (const name of names) {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`missing upload falsifier handler "${name}"`);
    }
    selected[name] = handler;
  }
  return selected;
}

const settleExtractedSource: ReactionHandler = (snapshot) => {
  if (snapshot.get(SOURCE_READY_PATH) === true) {
    return undefined;
  }
  const status = sourceStatusFromSnapshot(snapshot);
  if (status !== 'extracted') {
    return undefined;
  }
  return {
    mutations: [
      { op: 'MSet', path: SOURCE_READY_PATH, value: true },
      { op: 'MSet', path: 'work.source.observed_status', value: status },
    ],
  };
};

const settleOptionalSkip: ReactionHandler = (snapshot) => {
  if (snapshot.get(SOURCE_READY_PATH) === true) {
    return undefined;
  }
  const root = snapshot.get(DOCUMENT_ROOT_PATH);
  const status = typeof snapshot.get(DOCUMENT_STATUS_PATH) === 'string'
    ? snapshot.get(DOCUMENT_STATUS_PATH)
    : isRecord(root) && typeof root.status === 'string'
      ? root.status
      : undefined;
  if (status !== 'no_documents_available') {
    return undefined;
  }
  return {
    mutations: [
      { op: 'MSet', path: 'work.source.status', value: 'skipped_no_documents' },
      { op: 'MSet', path: SOURCE_READY_PATH, value: true },
    ],
  };
};

function sourceStatusFromSnapshot(snapshot: Parameters<ReactionHandler>[0]): string | null {
  const direct = snapshot.get(`${SOURCE_PATH}.status`);
  if (typeof direct === 'string') {
    return direct;
  }
  const source = snapshot.get(SOURCE_PATH);
  if (isRecord(source) && typeof source.status === 'string') {
    return source.status;
  }
  return null;
}

function requiredSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level document upload falsifier.

initial: bootstrap
terminal: [complete]

features:
  - base
  - reactions

channels:
  user_text: { direction: In, sync: Async }
  document_upload: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  bootstrap:
    vocabulary: [enter_upload]
    channels: [user_text, widget_output]
    transitions:
      - target: await_upload
        guard: { kind: FieldTruthy, path: upload.ready }
  await_upload:
    vocabulary: [ingest_documents]
    channels: [document_upload, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: ${SOURCE_PATH} }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  enter_upload: await_upload
  ingest_documents: complete

projection:
  bootstrap:
    include: [inputs.user_text, upload.ready]
    exclude: []
  await_upload:
    include:
      - inputs.user_text
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${DOCUMENT_REFS_PATH}.0
      - ${DOCUMENT_REFS_PATH}.0.fileId
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_PATH}.char_count
      - ${SOURCE_PATH}.file_count
      - ${SOURCE_READY_PATH}
    exclude: []
  complete:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${DOCUMENT_REFS_PATH}.0
      - ${DOCUMENT_REFS_PATH}.0.fileId
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_PATH}.char_count
      - ${SOURCE_PATH}.file_count
      - ${SOURCE_READY_PATH}
    exclude: []

prompts:
  bootstrap: "Enter upload intake."
  await_upload: "After document_upload arrives, call ingest_documents with no arguments."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text
  document_upload:
    - ${DOCUMENT_ROOT_PATH}

action_map:
  enter_upload:
    description: "Enter the upload intake mode."
    mutations:
      - { op: MSet, path: upload.ready, value: true }
    channel: widget_output
  ingest_documents:
    description: "Read injected request.documents and write extracted text."
    mutations: []
    channel: widget_output
    result_path: ${SOURCE_PATH}
schema:
  inputs.user_text: string
  ${DOCUMENT_ROOT_PATH}: object
  ${DOCUMENT_REFS_PATH}: array
  ${DOCUMENT_REFS_PATH}.*: object
  ${DOCUMENT_REFS_PATH}.*.fileId: string
  ${DOCUMENT_REFS_PATH}.*.name: string
  upload.ready: boolean
  ${SOURCE_PATH}: object
  ${SOURCE_PATH}.status: string
  ${SOURCE_PATH}.full_text: string
  ${SOURCE_PATH}.char_count: number
  ${SOURCE_PATH}.file_count: number
  ${SOURCE_PATH}.files_json: string
  work.source.observed_status: string
  ${SOURCE_READY_PATH}: boolean

reactions:
  settle_source:
    event: AfterRound
    watch: []
    write_scope: [${SOURCE_READY_PATH}, work.source.observed_status]

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function noChannelSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Program that intentionally does not declare document_upload.

initial: idle
terminal: [complete]

features:
  - base

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  idle:
    vocabulary: [noop]
    channels: [user_text, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: noop.done }
  complete:
    vocabulary: []
    channels: [widget_output]

projection:
  idle:
    include: [inputs.user_text]
    exclude: []
  complete:
    include: []
    exclude: []

prompts:
  idle: "Idle."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  noop:
    description: "Unused no-op."
    mutations:
      - { op: MSet, path: noop.done, value: true }
    channel: widget_output

schema:
  inputs.user_text: string
  noop.done: boolean

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function optionalSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Optional document-upload skip path falsifier.

initial: await_upload
terminal: [complete]

features:
  - base
  - reactions

channels:
  document_upload: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  await_upload:
    vocabulary: [complete_skip]
    channels: [document_upload, widget_output]
    transitions:
      - target: complete
  complete:
    vocabulary: []
    channels: [widget_output]

projection:
  await_upload:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_STATUS_PATH}
      - inputs.document_intake.completed
      - inputs.document_intake.documents_requested
      - inputs.document_intake.source
      - inputs.document_intake.normalized_message
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_READY_PATH}
    exclude: []
  complete:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_STATUS_PATH}
      - inputs.document_intake.completed
      - inputs.document_intake.documents_requested
      - inputs.document_intake.source
      - inputs.document_intake.normalized_message
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_READY_PATH}
    exclude: []

prompts:
  await_upload: "If the user skipped documents, acknowledge the skip."
  complete: "Terminal."

ingestion:
  document_upload:
    - inputs.document_intake.normalized_message

action_map:
  complete_skip:
    description: "Acknowledge the optional no-documents path."
    mutations: []
    channel: widget_output

proceed_to:
  complete_skip: complete

schema:
  ${DOCUMENT_ROOT_PATH}: object
  ${DOCUMENT_STATUS_PATH}: string
  inputs.document_intake.completed: boolean
  inputs.document_intake.documents_requested: boolean
  inputs.document_intake.source: string
  inputs.document_intake.normalized_message: string
  ${SOURCE_PATH}: object
  ${SOURCE_PATH}.status: string
  ${SOURCE_READY_PATH}: boolean

reactions:
  settle_optional_skip:
    event: AfterIngestion
    watch: [inputs.document_intake.normalized_message]
    write_scope: [${SOURCE_PATH}.status, ${SOURCE_READY_PATH}]

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function parkSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Document-upload await-user-decision falsifier.

initial: request
terminal: [complete]

features:
  - base
  - reactions

channels:
  user_text: { direction: In, sync: Async }
  document_upload: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  request:
    vocabulary: [request_documents, ingest_documents]
    channels: [user_text, document_upload, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: ${SOURCE_PATH} }
  complete:
    vocabulary: []
    channels: [widget_output]

projection:
  request:
    include:
      - inputs.user_text
      - request.issued
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_READY_PATH}
    exclude: []
  complete:
    include:
      - request.issued
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_READY_PATH}
    exclude: []

prompts:
  request: "First request documents. After document_upload arrives, call ingest_documents."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text
  document_upload:
    - ${DOCUMENT_ROOT_PATH}

action_map:
  request_documents:
    description: "Ask the user to upload a document and park until document_upload."
    mutations:
      - { op: MSet, path: request.issued, value: true }
    channel: widget_output
    awaits_user_decision: { channel: document_upload, intent: request_file_upload }
  ingest_documents:
    description: "Read injected request.documents and write extracted text."
    mutations: []
    channel: widget_output
    result_path: ${SOURCE_PATH}

proceed_to:
  ingest_documents: complete

schema:
  inputs.user_text: string
  request.issued: boolean
  ${DOCUMENT_ROOT_PATH}: object
  ${DOCUMENT_REFS_PATH}: array
  ${DOCUMENT_REFS_PATH}.*: object
  ${DOCUMENT_REFS_PATH}.*.fileId: string
  ${DOCUMENT_REFS_PATH}.*.name: string
  ${SOURCE_PATH}: object
  ${SOURCE_PATH}.status: string
  ${SOURCE_PATH}.full_text: string
  ${SOURCE_PATH}.char_count: number
  ${SOURCE_PATH}.file_count: number
  ${SOURCE_PATH}.files_json: string
  work.source.observed_status: string
  ${SOURCE_READY_PATH}: boolean

reactions:
  settle_source:
    event: AfterRound
    watch: []
    write_scope: [${SOURCE_READY_PATH}, work.source.observed_status]

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function reuploadSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Informative document re-upload falsifier.

initial: collect
terminal: [complete]

features:
  - base

channels:
  document_upload: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  collect:
    vocabulary: [ingest_documents, finish]
    channels: [document_upload, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: reupload.done }
  complete:
    vocabulary: []
    channels: [widget_output]

projection:
  collect:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${DOCUMENT_REFS_PATH}.0
      - ${DOCUMENT_REFS_PATH}.0.fileId
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_PATH}.char_count
      - ${SOURCE_PATH}.file_count
    exclude: []
  complete:
    include: []
    exclude: []

prompts:
  collect: "On every document_upload trigger, call ingest_documents with no arguments."
  complete: "Terminal."

ingestion:
  document_upload:
    - ${DOCUMENT_ROOT_PATH}

action_map:
  ingest_documents:
    description: "Read injected request.documents and overwrite work.source."
    mutations: []
    channel: widget_output
    result_path: ${SOURCE_PATH}
  finish:
    description: "Unused reachable terminal action."
    mutations:
      - { op: MSet, path: reupload.done, value: true }
    channel: widget_output

schema:
  ${DOCUMENT_ROOT_PATH}: object
  ${DOCUMENT_REFS_PATH}: array
  ${DOCUMENT_REFS_PATH}.*: object
  ${DOCUMENT_REFS_PATH}.*.fileId: string
  ${DOCUMENT_REFS_PATH}.*.name: string
  ${SOURCE_PATH}: object
  ${SOURCE_PATH}.status: string
  ${SOURCE_PATH}.full_text: string
  ${SOURCE_PATH}.char_count: number
  ${SOURCE_PATH}.file_count: number
  ${SOURCE_PATH}.files_json: string
  reupload.done: boolean

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

async function uploadFixture(client: PgasClient, sessionId: string, fixture: UploadFixture): Promise<unknown> {
  const form = new FormData();
  const file = new File([readFileSync(fixture.path)], fixture.name, { type: 'text/plain' });
  form.append('files', file as unknown as Blob, file.name);
  return client.files.upload(sessionId, form);
}

async function expectUploadReject(client: PgasClient, sessionId: string, file: File): Promise<ApiErrorEvidence> {
  const form = new FormData();
  form.append('files', file as unknown as Blob, file.name);
  try {
    await client.files.upload(sessionId, form);
  } catch (error) {
    return apiErrorEvidence(error);
  }
  throw new Error(`upload unexpectedly succeeded for ${file.name}`);
}

async function expectTriggerReject(
  client: PgasClient,
  sessionId: string,
  event: { channel: string; payload: unknown },
): Promise<ApiErrorEvidence> {
  try {
    await client.sessions.trigger(sessionId, event);
  } catch (error) {
    return apiErrorEvidence(error);
  }
  throw new Error(`trigger unexpectedly succeeded for channel ${event.channel}`);
}

function createFixture(tempDir: string, label: string): UploadFixture {
  const nonce = crypto.randomUUID();
  const sentinel = `PGAS-UPLOAD-SENTINEL-${nonce}`;
  const name = `${label}-${nonce}.txt`;
  const content = [
    `Route-level upload falsifier fixture ${label}.`,
    sentinel,
    'ASCII payload keeps byte length equal to character count for exact assertions.',
  ].join('\n');
  const filePath = path.join(tempDir, name);
  writeFileSync(filePath, content, 'utf8');
  return {
    name,
    path: filePath,
    content,
    sentinel,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

function expectedDocumentFromFixture(fixture: UploadFixture, fileRef: FileRef): ExpectedDocument {
  return {
    name: fixture.name,
    sentinel: fixture.sentinel,
    mimeType: 'text/plain',
    size: fixture.sizeBytes,
    fileId: fileRef.fileId,
  };
}

function observeDocumentPayload(payload: unknown, expected?: ExpectedDocument): DocumentObservation {
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : undefined;
  const documents = Array.isArray(request?.documents) ? request.documents : [];
  const doc = documents.find(isRecord);
  const contentText = typeof doc?.content_text === 'string' ? doc.content_text : undefined;
  const mimeType = typeof doc?.mime_type === 'string' ? doc.mime_type : undefined;
  const size = typeof doc?.size === 'number' ? doc.size : undefined;
  const name = typeof doc?.name === 'string' ? doc.name : undefined;
  const sentinelMatch = expected?.sentinel ? contentText?.includes(expected.sentinel) === true : false;
  return {
    documentCount: documents.length,
    name,
    mimeType,
    size,
    contentText,
    contentTextPreview: contentText?.slice(0, 160),
    sentinelMatch,
    documentSummaries: documents.filter(isRecord).map((document) => ({
      name: typeof document.name === 'string' ? document.name : undefined,
      mime_type: typeof document.mime_type === 'string' ? document.mime_type : undefined,
      size: typeof document.size === 'number' ? document.size : undefined,
      has_content_text: typeof document.content_text === 'string',
      has_content_base64: typeof document.content_base64 === 'string',
    })),
  };
}

function observationMatches(observation: DocumentObservation, expected: ExpectedDocument): boolean {
  return observation.sentinelMatch === true
    && observation.mimeType === expected.mimeType
    && observation.size === expected.size
    && observation.name === expected.name;
}

function documentRefPayload(fileRef: FileRef): Record<string, unknown> {
  return {
    [DOCUMENT_REFS_PATH]: [
      { fileId: fileRef.fileId, name: fileRef.name },
    ],
  };
}

function refsFromResponse(response: unknown): FileRef[] {
  if (!isRecord(response) || !Array.isArray(response.files)) {
    throw new Error(`expected response with files array, got ${JSON.stringify(response)}`);
  }
  return response.files.map((file) => {
    if (!isRecord(file)) {
      throw new Error(`expected FileRef object, got ${JSON.stringify(file)}`);
    }
    const fileRef = {
      fileId: requiredString(file.fileId, 'fileId'),
      name: requiredString(file.name, 'name'),
      mimeType: requiredString(file.mimeType, 'mimeType'),
      size: requiredNumber(file.size, 'size'),
      sessionId: typeof file.sessionId === 'string' ? file.sessionId : undefined,
      userId: typeof file.userId === 'string' ? file.userId : undefined,
      uploadedAt: typeof file.uploadedAt === 'string' ? file.uploadedAt : undefined,
    };
    return fileRef;
  });
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(label: string, response: Record<string, unknown>): ScriptedResponse {
  return { label, response };
}

function scriptedAuthor(
  responses: ScriptedResponse[],
  order: string[],
): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'upload-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no upload falsifier author response scripted for call ${String(index - 1)}`);
      }
      order.push(response.label);
      return JSON.stringify(response.response);
    },
  };
}

async function recordFalsifier(
  id: string,
  failures: Error[],
  run: () => Promise<unknown>,
): Promise<void> {
  let evidence: unknown;
  try {
    evidence = await run();
    writeFalsifierLine(id, 'PASS', evidence);
  } catch (error) {
    const message = `${id} failed: ${errorMessage(error)}`;
    failures.push(new Error(message));
    writeFalsifierLine(id, 'FAIL', { observed: evidence, error: errorMessage(error) });
  }
}

async function recordInformativeFalsifier(
  id: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    const evidence = await run();
    writeFalsifierLine(id, 'PASS', evidence);
  } catch (error) {
    writeFalsifierLine(id, 'FAIL', {
      informative: true,
      soft_fail: true,
      error: errorMessage(error),
    });
  }
}

function writeFalsifierLine(id: string, status: 'PASS' | 'FAIL', evidence: unknown): void {
  process.stdout.write(`[upload-engine-falsifier] ${id} ${status} ${JSON.stringify(evidence)}\n`);
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) {
    return direct;
  }
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    result[key.slice(prefix.length)] = value;
  }
  return result;
}

async function safeRead<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function modeOf(envelope: { mode?: unknown; state?: unknown }): string | null {
  if (typeof envelope.mode === 'string') {
    return envelope.mode;
  }
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') {
    return envelope.state.mode;
  }
  return null;
}

function currentRoundNumberOf(envelope: unknown): number | null {
  if (!isRecord(envelope) || !isRecord(envelope.state)) {
    return null;
  }
  if (typeof envelope.state.currentRoundNumber === 'number') {
    return envelope.state.currentRoundNumber;
  }
  return null;
}

function awaitingDecisionOf(envelope: unknown): Record<string, unknown> | null {
  if (!isRecord(envelope) || !isRecord(envelope.state)) {
    return null;
  }
  if (isRecord(envelope.state.awaitingUserDecision)) {
    return envelope.state.awaitingUserDecision;
  }
  return null;
}

function apiErrorEvidence(error: unknown): ApiErrorEvidence {
  if (isRecord(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : undefined,
      status: typeof error.status === 'number' ? error.status : undefined,
      message: errorMessage(error),
      body: error.body,
      reason: typeof error.reason === 'string' ? error.reason : undefined,
      kind: typeof error.kind === 'string' ? error.kind : undefined,
    };
  }
  return { message: errorMessage(error) };
}

function createHandlerState(): UploadHandlerState {
  return { observations: [] };
}

function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe('string');
  return value as string;
}

function requiredNumber(value: unknown, label: string): number {
  expect(typeof value, label).toBe('number');
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UploadServerScenario {
  programName: string;
  script: ScriptedResponse[];
  state: UploadHandlerState;
  createEntry: (tempDir: string) => ProgramEntry;
}

interface ScriptedResponse {
  label: string;
  response: Record<string, unknown>;
}

interface UploadHandlerState {
  expected?: ExpectedDocument;
  observations: DocumentObservation[];
}

interface ExpectedDocument {
  name: string;
  sentinel: string;
  mimeType: string;
  size: number;
  fileId: string;
}

interface DocumentObservation {
  documentCount: number;
  name?: string;
  mimeType?: string;
  size?: number;
  contentText?: string;
  contentTextPreview?: string;
  sentinelMatch: boolean;
  documentSummaries: Array<Record<string, unknown>>;
}

interface UploadFixture {
  name: string;
  path: string;
  content: string;
  sentinel: string;
  sizeBytes: number;
}

interface FileRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sessionId?: string;
  userId?: string;
  uploadedAt?: string;
}

interface F1Evidence {
  fileRef: FileRef;
  listedFiles: FileRef[];
  roundTripText: string;
}

interface RequiredScenarioEvidence {
  sessionId: string;
  fixture: UploadFixture;
  fileRef: FileRef;
  listedFiles: FileRef[];
  roundTripText: string;
  triggerError?: string;
  afterUploadDomain: Record<string, unknown>;
  finalMode: string | null;
  finalStatus?: string;
  source: Record<string, unknown>;
  sourceReady: unknown;
  handlerObservations: DocumentObservation[];
  order: string[];
}

interface ApiErrorEvidence {
  name?: string;
  status?: number;
  message: string;
  body?: unknown;
  reason?: string;
  kind?: string;
}

interface UploadValidatorEvidence {
  pdf_mismatch: ApiErrorEvidence;
  empty_text: ApiErrorEvidence;
  oversize: ApiErrorEvidence;
}

interface SkipEvidence {
  no_docs_record: unknown;
  source_status: unknown;
  source_ready: unknown;
  final_mode: string | null;
  order: string[];
}

interface ParkEvidence {
  awaiting_decision: Record<string, unknown> | null;
  mode_after_request: string | null;
  round_after_request: number | null;
  order_after_request: string[];
  source_before_upload: Record<string, unknown>;
  fixture: UploadFixture;
  file_ref: FileRef;
  source: Record<string, unknown>;
  final_mode: string | null;
  final_awaiting_decision: Record<string, unknown> | null;
  order: string[];
}

interface ReuploadEvidence {
  first_fixture: UploadFixture;
  second_fixture: UploadFixture;
  first_file_ref: FileRef;
  second_file_ref: FileRef;
  first_observation?: DocumentObservation;
  second_observation?: DocumentObservation;
  source: Record<string, unknown>;
  order: string[];
}
