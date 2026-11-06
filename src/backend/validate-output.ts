import { isRelation, MAX_QUOTE_CHARS, RELATIONS, type DedupOutput } from './dedup.js';
import { isRecordType, RECORD_TYPES_LABEL } from './record-type.js';

/**
 * Validate thủ công output theo đúng dedup-output.schema.json trước khi trả
 * response, vì theo manual, SotaAgents KHÔNG kiểm tra outputSchema tại
 * runtime — app phải tự đảm bảo.
 *
 * Giữ validator này đồng bộ tay với src/schemas/dedup-output.schema.json.
 * Nếu thêm ajv (hoặc lib JSON Schema khác) vào dependencies sau này, hãy
 * thay thế hàm này bằng validator sinh từ chính file schema để tránh lệch.
 */
export function assertValidDedupOutput(output: unknown): output is DedupOutput {
  const errors = collectOutputErrors(output);
  if (errors.length > 0) {
    throw new Error(`Output không hợp lệ theo dedup-output.schema.json: ${errors.join('; ')}`);
  }
  return true;
}

function collectOutputErrors(output: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(output)) {
    return ['output phải là object'];
  }

  const keys = Object.keys(output);
  const unknownKeys = keys.filter((key) => key !== 'matches');
  if (unknownKeys.length > 0) {
    errors.push(`additionalProperties không hợp lệ: ${unknownKeys.join(', ')}`);
  }

  if (!Array.isArray(output.matches)) {
    errors.push('matches phải là array');
    return errors;
  }

  if (output.matches.length > 30) {
    errors.push('matches vượt maxItems: 30');
  }

  output.matches.forEach((match, index) => {
    errors.push(...collectMatchErrors(match, index));
  });

  return errors;
}

function collectMatchErrors(match: unknown, index: number): string[] {
  const prefix = `matches[${index}]`;
  const errors: string[] = [];

  if (!isRecord(match)) {
    return [`${prefix} phải là object`];
  }

  const unknownKeys = Object.keys(match).filter(
    (key) => !['type', 'id', 'score', 'percent', 'reason', 'relation', 'evidence'].includes(key),
  );
  if (unknownKeys.length > 0) {
    errors.push(`${prefix} additionalProperties không hợp lệ: ${unknownKeys.join(', ')}`);
  }

  // Giữ khớp với enum của `type` trong dedup-output.schema.json (nguồn: record-type.ts).
  if (!isRecordType(match.type)) {
    errors.push(`${prefix}.type phải là một trong: ${RECORD_TYPES_LABEL}`);
  }

  if (typeof match.id !== 'string' || match.id.length < 1 || match.id.length > 200) {
    errors.push(`${prefix}.id phải là string độ dài 1..200`);
  }

  if (typeof match.score !== 'number' || !Number.isFinite(match.score) || match.score < 0 || match.score > 1) {
    errors.push(`${prefix}.score phải là number trong [0,1]`);
  }

  if (
    typeof match.percent !== 'number' ||
    !Number.isInteger(match.percent) ||
    match.percent < 0 ||
    match.percent > 100
  ) {
    errors.push(`${prefix}.percent phải là integer trong [0,100]`);
  }

  if (typeof match.reason !== 'string' || match.reason.length < 1 || match.reason.length > 1000) {
    errors.push(`${prefix}.reason phải là string độ dài 1..1000`);
  }

  // Giữ khớp với enum của `relation` trong dedup-output.schema.json (nguồn: RELATIONS ở dedup.ts).
  if (!isRelation(match.relation)) {
    errors.push(`${prefix}.relation phải là một trong: ${RELATIONS.join(', ')}`);
  }

  errors.push(...collectEvidenceErrors(match.evidence, `${prefix}.evidence`));

  return errors;
}

function collectEvidenceErrors(evidence: unknown, prefix: string): string[] {
  if (!isRecord(evidence)) {
    return [`${prefix} phải là object`];
  }

  const errors: string[] = [];
  const unknownKeys = Object.keys(evidence).filter((key) => !['newQuote', 'candidateQuote'].includes(key));
  if (unknownKeys.length > 0) {
    errors.push(`${prefix} additionalProperties không hợp lệ: ${unknownKeys.join(', ')}`);
  }
  for (const key of ['newQuote', 'candidateQuote'] as const) {
    const quote = evidence[key];
    if (typeof quote !== 'string' || quote.length > MAX_QUOTE_CHARS) {
      errors.push(`${prefix}.${key} phải là string độ dài 0..${MAX_QUOTE_CHARS}`);
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
