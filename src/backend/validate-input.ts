import type { DedupInput } from './dedup.js';
import { isRecordType, RECORD_TYPES_LABEL } from './record-type.js';

/** Giữ khớp với maxItems của excludeIds trong dedup-input.schema.json. */
const MAX_EXCLUDE_IDS = 100;
/** Giữ khớp với maxItems / maxLength của fileExcerpts trong dedup-input.schema.json. */
const MAX_FILE_EXCERPTS = 10;
const MAX_FILE_EXCERPT_LENGTH = 2000;

/**
 * Validate thủ công input theo đúng dedup-input.schema.json tại boundary
 * của route, trước khi đưa vào domain logic. Giữ đồng bộ tay với
 * src/schemas/dedup-input.schema.json — xem ghi chú ở validate-output.ts.
 */
export function parseDedupInput(input: unknown): DedupInput {
  const errors = collectInputErrors(input);
  if (errors.length > 0) {
    throw new Error(`Input không hợp lệ theo dedup-input.schema.json: ${errors.join('; ')}`);
  }

  const record = input as Record<string, unknown>;
  return {
    type: record.type as DedupInput['type'],
    title: record.title as string,
    content: record.content as string,
    fileExcerpts: Array.isArray(record.fileExcerpts) ? (record.fileExcerpts as string[]) : undefined,
    excludeIds: Array.isArray(record.excludeIds) ? (record.excludeIds as string[]) : undefined,
    parentSolutionId: typeof record.parentSolutionId === 'string' ? record.parentSolutionId : undefined,
  };
}

function collectInputErrors(input: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return ['input phải là object'];
  }

  const allowedKeys = ['type', 'title', 'content', 'fileExcerpts', 'excludeIds', 'parentSolutionId'];
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    errors.push(`additionalProperties không hợp lệ: ${unknownKeys.join(', ')}`);
  }

  // Giữ khớp với enum của `type` trong dedup-input.schema.json (nguồn: record-type.ts).
  if (!isRecordType(input.type)) {
    errors.push(`type phải là một trong: ${RECORD_TYPES_LABEL}`);
  }

  if (!isBoundedString(input.title, 1, 300)) {
    errors.push('title phải là string độ dài 1..300');
  }

  if (!isBoundedString(input.content, 1, 20000)) {
    errors.push('content phải là string độ dài 1..20000');
  }

  if (input.fileExcerpts !== undefined) {
    if (!Array.isArray(input.fileExcerpts) || input.fileExcerpts.length > MAX_FILE_EXCERPTS) {
      errors.push(`fileExcerpts phải là array tối đa ${MAX_FILE_EXCERPTS} phần tử khi có mặt`);
    } else if (!input.fileExcerpts.every((text) => isBoundedString(text, 1, MAX_FILE_EXCERPT_LENGTH))) {
      errors.push(`mỗi phần tử của fileExcerpts phải là string độ dài 1..${MAX_FILE_EXCERPT_LENGTH}`);
    }
  }

  if (input.excludeIds !== undefined) {
    if (!Array.isArray(input.excludeIds) || input.excludeIds.length > MAX_EXCLUDE_IDS) {
      errors.push(`excludeIds phải là array tối đa ${MAX_EXCLUDE_IDS} phần tử khi có mặt`);
    } else if (!input.excludeIds.every((id) => isBoundedString(id, 1, 200))) {
      errors.push('mỗi phần tử của excludeIds phải là string độ dài 1..200');
    }
  }

  if (input.parentSolutionId !== undefined && !isBoundedString(input.parentSolutionId, 1, 200)) {
    errors.push('parentSolutionId phải là string độ dài 1..200 khi có mặt');
  }

  return errors;
}

function isBoundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
