import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidDedupOutput } from '../validate-output.js';

/** Hai field mới của mỗi match (bắt buộc từ khi thêm relation/evidence). */
const extra = { relation: 'same_problem', evidence: { newQuote: '', candidateQuote: '' } };

test('output hợp lệ không throw', () => {
  assert.doesNotThrow(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 50, reason: 'ok', ...extra }],
    }),
  );
});

test('matches rỗng hợp lệ', () => {
  assert.doesNotThrow(() => assertValidDedupOutput({ matches: [] }));
});

test('thiếu field matches bị từ chối', () => {
  assert.throws(() => assertValidDedupOutput({}));
});

test('additionalProperties ở top-level bị từ chối', () => {
  assert.throws(() => assertValidDedupOutput({ matches: [], extra: 1 }));
});

test('score ngoài [0,1] bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solutions', id: 'a', score: 1.1, percent: 50, reason: 'ok', ...extra }],
    }),
  );
});

test('percent ngoài [0,100] bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 101, reason: 'ok', ...extra }],
    }),
  );
});

test('percent không phải integer bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 50.5, reason: 'ok', ...extra }],
    }),
  );
});

test('thiếu field percent bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({ matches: [{ type: 'solutions', id: 'a', score: 0.5, reason: 'ok', ...extra }] }),
  );
});

test('reason rỗng bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 50, reason: '', ...extra }],
    }),
  );
});

test('cả ba type ideas / solutions / initiatives đều hợp lệ trong output', () => {
  for (const type of ['ideas', 'solutions', 'initiatives']) {
    assert.doesNotThrow(() =>
      assertValidDedupOutput({ matches: [{ type, id: 'a', score: 0.5, percent: 50, reason: 'ok', ...extra }] }),
    );
  }
});

test('type ngoài ba giá trị bị từ chối (kể cả giá trị cũ "solution")', () => {
  for (const type of ['other', 'solution', 'idea', 'initiative', 'Ideas', '', undefined, 1]) {
    assert.throws(
      () =>
        assertValidDedupOutput({
          matches: [{ type, id: 'a', score: 0.5, percent: 50, reason: 'ok', ...extra }],
        }),
      /type phải là một trong: ideas, solutions, initiatives/,
      `type ${JSON.stringify(type)}`,
    );
  }
});

test('vượt maxItems 30 bị từ chối', () => {
  const matches = Array.from({ length: 31 }, (_, i) => ({
    type: 'solutions',
    id: `id-${i}`,
    score: 0.1,
    percent: 10,
    reason: 'ok',
    ...extra,
  }));
  assert.throws(() => assertValidDedupOutput({ matches }));
});

test('relation phải thuộc sáu giá trị cho phép', () => {
  for (const relation of ['copy', 'paraphrase', 'same_problem', 'same_solution_other_scope', 'extension', 'unrelated']) {
    assert.doesNotThrow(() =>
      assertValidDedupOutput({
        matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 50, reason: 'ok', ...extra, relation }],
      }),
    );
  }
  for (const relation of ['giong', 'Copy', '', undefined, 1]) {
    assert.throws(
      () =>
        assertValidDedupOutput({
          matches: [{ type: 'solutions', id: 'a', score: 0.5, percent: 50, reason: 'ok', ...extra, relation }],
        }),
      /relation phải là một trong: copy, paraphrase/,
      `relation ${JSON.stringify(relation)}`,
    );
  }
});

test('evidence bắt buộc, đúng hai chuỗi tối đa 200 ký tự, không field lạ', () => {
  const base = { type: 'solutions', id: 'a', score: 0.5, percent: 50, reason: 'ok', relation: 'copy' };
  const okQuotes = { newQuote: 'x'.repeat(200), candidateQuote: '' };
  assert.doesNotThrow(() => assertValidDedupOutput({ matches: [{ ...base, evidence: okQuotes }] }));

  const bad: unknown[] = [
    undefined,
    null,
    'chuỗi',
    {},
    { newQuote: '' },
    { newQuote: '', candidateQuote: 5 },
    { newQuote: 'x'.repeat(201), candidateQuote: '' },
    { newQuote: '', candidateQuote: '', them: 1 },
  ];
  for (const evidence of bad) {
    assert.throws(
      () => assertValidDedupOutput({ matches: [{ ...base, evidence }] }),
      /evidence/,
      `evidence ${JSON.stringify(evidence)}`,
    );
  }
});
