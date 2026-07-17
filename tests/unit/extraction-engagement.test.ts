import { describe, expect, it } from 'vitest';

import {
  assessExtractionEngagement,
  type GeneratedLiveDriveExtractionReport,
} from '../../src/pgas-new/generated-live-drive.js';

const SENTINEL = 'PGAS-EXTRACTION-NONCE-unit';

describe('assessExtractionEngagement', () => {
  it('passes only when upload, extraction, deflate, raw-invisibility, provider, and anti-stub checks all hold', () => {
    const verdict = assessExtractionEngagement({
      report: extractionReport(),
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 1,
      stubFindings: [],
    });

    expect(verdict.extraction_engaged).toBe(true);
    expect(verdict.upload_accepted).toBe(true);
    expect(verdict.refs_landed).toBe(true);
    expect(verdict.content_extracted).toBe(true);
    expect(verdict.sentinel_present).toBe(true);
    expect(verdict.extraction_exact).toBe(true);
    expect(verdict.source_ready).toBe(true);
    expect(verdict.parent_complete).toBe(true);
    expect(verdict.provider_hits_ok).toBe(true);
    expect(verdict.no_stub_markers).toBe(true);
    expect(verdict.extraction_kind_docx_deflate).toBe(true);
    expect(verdict.sentinel_not_in_raw_upload).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.notes).toEqual([]);
  });

  it.each([
    ['missing report', null, 'extraction_report_absent'],
    ['upload not accepted', extractionReport({ upload_accepted: false }), 'upload_not_accepted'],
    ['refs not landed', extractionReport({ refs_landed: false }), 'file_refs_not_landed'],
    [
      'source status not extracted',
      extractionReport({ source_status: 'blocked_extraction_failed' }),
      'source_status_not_extracted:blocked_extraction_failed',
    ],
    ['sentinel absent', extractionReport({ sentinel_present: false }), 'sentinel_absent'],
    [
      'char count mismatch',
      extractionReport({ char_count: 99 }),
      'char_count_mismatch:expected=72:actual=99',
    ],
    ['source not ready', extractionReport({ source_ready: false }), 'source_ready_false'],
    [
      'extraction kind wrong',
      extractionReport({ extraction_kind: 'docx_store' }),
      'extraction_kind_not_docx_deflate:docx_store',
    ],
    [
      'sentinel visible in raw upload',
      extractionReport({ sentinel_not_in_raw_upload: false }),
      'sentinel_visible_in_raw_upload',
    ],
  ])('fails closed when %s', (_label, report, reason) => {
    const verdict = assessExtractionEngagement({
      report,
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 1,
      stubFindings: [],
    });

    expect(verdict.extraction_engaged).toBe(false);
    expect(verdict.reason).toBe(reason);
    expect(verdict.notes).toContain(reason);
  });

  it('fails closed when the parent does not complete', () => {
    const verdict = assessExtractionEngagement({
      report: extractionReport(),
      finalMode: 'ingest_source',
      expectedFinalMode: 'complete',
      providerHits: 1,
      stubFindings: [],
    });

    expect(verdict.extraction_engaged).toBe(false);
    expect(verdict.parent_complete).toBe(false);
    expect(verdict.reason).toBe('parent_not_complete:expected=complete:actual=ingest_source');
  });

  it('fails closed when provider hits are absent', () => {
    const verdict = assessExtractionEngagement({
      report: extractionReport(),
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 0,
      stubFindings: [],
    });

    expect(verdict.extraction_engaged).toBe(false);
    expect(verdict.provider_hits_ok).toBe(false);
    expect(verdict.reason).toBe('provider_hits_below_minimum');
  });

  it('fails closed when executed outputs contain stub markers', () => {
    const verdict = assessExtractionEngagement({
      report: extractionReport(),
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 1,
      stubFindings: ['summarize_source.result_json: lorem ipsum'],
    });

    expect(verdict.extraction_engaged).toBe(false);
    expect(verdict.no_stub_markers).toBe(false);
    expect(verdict.reason).toBe('stub_markers_present:summarize_source.result_json: lorem ipsum');
  });
});

function extractionReport(
  overrides: Partial<GeneratedLiveDriveExtractionReport> = {},
): GeneratedLiveDriveExtractionReport {
  return {
    source_status: 'extracted',
    char_count: 72,
    expected_char_count: 72,
    source_ready: true,
    full_text_excerpt: `DOCX source body with ${SENTINEL} and deterministic extracted text.`,
    sentinel_present: true,
    uploaded_file_id: 'file-1',
    refs_landed: true,
    upload_accepted: true,
    extraction_kind: 'docx_deflate',
    sentinel_not_in_raw_upload: true,
    ...overrides,
  };
}
