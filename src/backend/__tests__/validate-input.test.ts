import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDedupInput } from '../validate-input.js';

const valid = { type: 'solutions', title: 'Tiêu đề', content: 'Nội dung' };

test('input hợp lệ được parse đúng', () => {
  const parsed = parseDedupInput(valid);
  assert.equal(parsed.type, 'solutions');
  assert.equal(parsed.title, 'Tiêu đề');
});

test('thiếu title bị từ chối', () => {
  assert.throws(() => parseDedupInput({ type: 'solutions', content: 'x' }));
});

test('thiếu content bị từ chối', () => {
  assert.throws(() => parseDedupInput({ type: 'solutions', title: 'x' }));
});

test('cả ba type ideas / solutions / initiatives đều được nhận và giữ nguyên', () => {
  for (const type of ['ideas', 'solutions', 'initiatives']) {
    assert.equal(parseDedupInput({ ...valid, type }).type, type);
  }
});

test('type ngoài ba giá trị bị từ chối, kể cả giá trị của mô hình cũ và sai hoa/thường/khoảng trắng', () => {
  const bogus = [
    'solution', 'idea', 'initiative', 'project', 'other', // mô hình cũ / schema tạm cũ
    'Ideas', 'SOLUTIONS', ' ideas', 'ideas ', '', 'ideas,solutions', // sai dạng
    undefined, null, 1, true, ['ideas'], { type: 'ideas' }, // sai kiểu
  ];
  for (const type of bogus) {
    assert.throws(
      () => parseDedupInput({ ...valid, type }),
      /type phải là một trong: ideas, solutions, initiatives/,
      `type ${JSON.stringify(type)}`,
    );
  }
  assert.throws(() => parseDedupInput({ title: 'x', content: 'y' }), /type/);
});

test('title rỗng bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, title: '' }));
});

test('title vượt 300 ký tự bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, title: 'a'.repeat(301) }));
});

test('additionalProperties không khai báo bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, unknownField: 'x' }));
});

test('excludeIds và parentSolutionId optional hợp lệ được giữ lại', () => {
  const parsed = parseDedupInput({ ...valid, excludeIds: ['ex-1', 'ex-2'], parentSolutionId: 'parent-1' });
  assert.deepEqual(parsed.excludeIds, ['ex-1', 'ex-2']);
  assert.equal(parsed.parentSolutionId, 'parent-1');
});

test('không có excludeIds thì để undefined', () => {
  assert.equal(parseDedupInput(valid).excludeIds, undefined);
});

test('excludeId (số ít, tên cũ) bị từ chối như trường lạ: BE phải đổi sang excludeIds', () => {
  assert.throws(() => parseDedupInput({ ...valid, excludeId: 'ex-1' }), /excludeId/);
});

test('datasetKey (đã bỏ) bị từ chối như trường lạ', () => {
  assert.throws(() => parseDedupInput({ ...valid, datasetKey: 'ws-1' }), /datasetKey/);
});

test('excludeIds phải là mảng string 1..200 ký tự, tối đa 100 phần tử', () => {
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: 'ex-1' }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: [1] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: [''] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: ['a'.repeat(201)] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }));
  assert.deepEqual(
    parseDedupInput({ ...valid, excludeIds: Array.from({ length: 100 }, (_, i) => `id-${i}`) }).excludeIds?.length,
    100,
  );
  assert.deepEqual(parseDedupInput({ ...valid, excludeIds: [] }).excludeIds, []);
});

test('input không phải object bị từ chối', () => {
  assert.throws(() => parseDedupInput('not an object'));
  assert.throws(() => parseDedupInput(null));
  assert.throws(() => parseDedupInput(undefined));
});

test('fileExcerpts là tuỳ chọn; có thì được giữ nguyên, không có thì undefined', () => {
  assert.equal(parseDedupInput(valid).fileExcerpts, undefined);
  assert.deepEqual(parseDedupInput({ ...valid, fileExcerpts: [] }).fileExcerpts, []);
  assert.deepEqual(parseDedupInput({ ...valid, fileExcerpts: ['đoạn 1', 'đoạn 2'] }).fileExcerpts, ['đoạn 1', 'đoạn 2']);
});

test('fileExcerpts sai kiểu, quá 10 phần tử, phần tử rỗng hoặc dài quá 2000 ký tự bị từ chối', () => {
  const bad: unknown[] = [
    'đoạn',
    null,
    { 0: 'x' },
    [1],
    [''],
    ['x'.repeat(2001)],
    Array.from({ length: 11 }, () => 'x'),
  ];
  for (const fileExcerpts of bad) {
    assert.throws(() => parseDedupInput({ ...valid, fileExcerpts }), /fileExcerpts/, JSON.stringify(fileExcerpts)?.slice(0, 40));
  }
  assert.doesNotThrow(() => parseDedupInput({ ...valid, fileExcerpts: Array.from({ length: 10 }, () => 'x'.repeat(2000)) }));
});

test('parentSolutionId được giữ trong input đã parse', () => {
  assert.equal(parseDedupInput({ ...valid, parentSolutionId: 'GP-1' }).parentSolutionId, 'GP-1');
  assert.equal(parseDedupInput(valid).parentSolutionId, undefined);
});
