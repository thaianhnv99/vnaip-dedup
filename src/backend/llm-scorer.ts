import { isRelation, type Candidate, type DedupDependencies, type DedupInput, type RawModelMatch, type ScoreOptions } from "./dedup.js";
import { buildScoringPrompt } from "./scoring-prompt.js";
/**
 * Endpoint tương thích OpenAI của Gemini (chat completions). Khác với embedding, vốn dùng
 * API gốc của Gemini (`DEFAULT_EMBEDDING_BASE_URL` ở embeddings.ts).
 */
export const DEFAULT_SCORER_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Chấm độ tương đồng giữa input và từng ứng viên bằng model chat qua endpoint tương
 * thích OpenAI của Gemini (`POST {baseUrl}/chat/completions`, `Authorization: Bearer
 * <khoá>`). Mặc định dùng chung khoá `GEMINI_API_KEY` với embedding; đặt
 * `LLM_SCORER_BASE_URL` / `LLM_SCORER_API_KEY` để chỉ scorer đi qua khoá/endpoint khác.
 * Free tier tính hạn mức theo PROJECT chứ không theo khoá, nên muốn tách hạn mức của
 * scorer khỏi worker embedding thì dùng khoá của project khác.
 *
 * Nội dung hồ sơ (title/content/file/đoạn khớp) được đưa vào model như DỮ LIỆU, không phải chỉ
 * dẫn: prompt (scoring-prompt.ts) nói rõ nội dung có thể chứa văn bản độc hại và không được
 * tuân theo.
 *
 * Ngưỡng điểm: prompt bảo model chỉ liệt kê ứng viên có score >= `minScore`. Khi ngưỡng > 0, ứng
 * viên vắng mặt trong output nghĩa là "dưới ngưỡng" nên KHÔNG thể kiểm tra model có bỏ sót hay
 * không; thay vào đó mục nào đã gắn với ứng viên của batch mà hỏng thì cả batch là BAD_OUTPUT.
 * Khi ngưỡng = 0, mọi ứng viên của batch phải có một mục dùng được (kiểm như trước đây).
 *
 * Ngân sách thời gian: ứng viên được chia batch rồi chấm song song với số lần gọi
 * đồng thời có giới hạn (tránh bị provider giới hạn tốc độ), mỗi lần gọi bị cắt
 * theo mốc `deadlineAt` chung của cả lời gọi tool. Một batch lỗi thì cả lời gọi
 * lỗi và các batch còn lại bị huỷ: trả điểm của một phần ứng viên sẽ cho kết quả
 * "không trùng" sai ở phần còn lại.
 *
 * Thông báo lỗi chỉ chứa mã HTTP, không chứa khoá API, nội dung hồ sơ hay body
 * phản hồi của provider.
 */

export interface LlmScorerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Trần thời gian cho MỖI lần gọi model; còn bị cắt theo deadline chung. */
  timeoutMs: number;
  /** Số ứng viên tối đa trong một lần gọi model. */
  batchSize: number;
  /** Số lần gọi model song song tối đa. */
  concurrency: number;
  /** Phần nội dung tối đa của mỗi ứng viên đưa vào prompt (kiểm soát token). */
  maxCandidateChars: number;
  /**
   * Gửi nguyên văn làm `reasoning_effort` (tham số tương thích OpenAI) khi có đặt; không
   * đặt thì không gửi gì và provider dùng mức mặc định của model. Model reasoning tính
   * token suy nghĩ vào `max_tokens`, nên mặc định bật có thể làm output bị cắt
   * (`finish_reason=length`).
   */
  reasoningEffort?: string;
}

/** Giá trị `LLM_SCORER_REASONING_EFFORT` được chấp nhận (sai thì NOT_CONFIGURED, không bị bỏ qua im lặng). */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high"]);

export type LlmScorerErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "BAD_OUTPUT";

export class LlmScorerError extends Error {
  readonly code: LlmScorerErrorCode;
  /**
   * Meta AN TOÀN để log debug: chỉ mã lý do, finish_reason, độ dài, kiểu JSON và số
   * key của response. Không bao giờ chứa ký tự nào của content model sinh (bám sát
   * hồ sơ nên có thể lộ nội dung hồ sơ), input của người dùng hay API key. Route chỉ
   * log các field nằm trong allow-list (xem `rootErrorDetail`).
   */
  readonly detail?: Record<string, unknown>;

  constructor(
    code: LlmScorerErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: Record<string, unknown> },
  ) {
    super(message, options);
    this.code = code;
    this.name = "LlmScorerError";
    this.detail = options?.detail;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadLlmScorerConfig(
  env: NodeJS.ProcessEnv = process.env,
): LlmScorerConfig {
  const reasoningEffort = env.LLM_SCORER_REASONING_EFFORT?.trim().toLowerCase();
  return {
    // Base URL của scorer (OpenAI-compat) khác của embedding (API gốc), nên không dùng chung.
    baseUrl: (
      env.LLM_SCORER_BASE_URL ||
      DEFAULT_SCORER_BASE_URL
    ).replace(/\/+$/, ""),
    // Đã đổi base URL riêng cho scorer thì BẮT BUỘC có khoá riêng: không được rơi về
    // GEMINI_API_KEY, vì như vậy sẽ gửi khoá này tới host của endpoint khác.
    apiKey:
      env.LLM_SCORER_API_KEY ||
      (env.LLM_SCORER_BASE_URL ? "" : env.GEMINI_API_KEY) ||
      "",
    // Không có model mặc định: chọn model là quyết định về chi phí và chất lượng.
    model: env.LLM_SCORER_MODEL ?? "",
    timeoutMs: positiveInteger(env.LLM_SCORER_TIMEOUT_MS, 25000),
    batchSize: positiveInteger(env.LLM_SCORER_BATCH_SIZE, 5),
    concurrency: positiveInteger(env.LLM_SCORER_CONCURRENCY, 20),
    maxCandidateChars: positiveInteger(env.LLM_SCORER_MAX_CANDIDATE_CHARS, 4000),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Mock chỉ bật khi LLM_MOCK_MODE=true. Biến không đặt nghĩa là dùng model thật
 * (và báo NOT_CONFIGURED nếu thiếu cấu hình), để production không âm thầm chấm
 * điểm bằng mock.
 */
export function createScorerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DedupDependencies["scoreCandidates"] {
  return env.LLM_MOCK_MODE === "true"
    ? createMockScorer()
    : createLlmScorer(loadLlmScorerConfig(env));
}

/** Kiểm cấu hình ngay khi dựng để lỗi thiếu khoá hiện sớm, không chờ lần chấm đầu. */
export function createLlmScorer(
  config: LlmScorerConfig,
): DedupDependencies["scoreCandidates"] {
  if (!config.apiKey || !config.model) {
    throw new LlmScorerError(
      "NOT_CONFIGURED",
      "LLM scorer chưa được cấu hình (thiếu GEMINI_API_KEY / LLM_SCORER_API_KEY hoặc LLM_SCORER_MODEL; OPENROUTER_API_KEY không còn được đọc)",
    );
  }
  if (config.reasoningEffort !== undefined && !REASONING_EFFORTS.has(config.reasoningEffort)) {
    // Sai chính tả mà bỏ qua im lặng thì model vẫn suy nghĩ mặc định và output lại bị cắt.
    throw new LlmScorerError(
      "NOT_CONFIGURED",
      `LLM_SCORER_REASONING_EFFORT không hợp lệ (cho phép: ${[...REASONING_EFFORTS].join(", ")})`,
    );
  }
  return (input, candidates, options) =>
    scoreCandidatesWithLlm(input, candidates, config, options);
}

export async function scoreCandidatesWithLlm(
  input: DedupInput,
  candidates: Candidate[],
  config: LlmScorerConfig,
  options: ScoreOptions,
): Promise<RawModelMatch[]> {
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += config.batchSize) {
    batches.push(candidates.slice(i, i + config.batchSize));
  }

  const results: RawModelMatch[][] = new Array(batches.length);
  const cancel = new AbortController();
  let next = 0;
  let failure: unknown;

  // Mỗi "làn" lấy batch kế tiếp cho tới khi hết hoặc có batch khác đã lỗi.
  const lane = async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= batches.length) return;
      try {
        results[index] = await scoreBatch(
          input,
          batches[index]!,
          config,
          options,
          cancel.signal,
        );
      } catch (error) {
        if (failure === undefined) {
          failure = error;
          cancel.abort();
        }
        return;
      }
    }
  };

  const lanes = Math.min(config.concurrency, batches.length);
  await Promise.all(Array.from({ length: lanes }, lane));

  if (failure !== undefined) throw failure;
  return results.flat();
}

/**
 * Mặc định batch 5 / đồng thời 20 (đo thật 2026-11-04, 100 sáng kiến, Haiku 5.5): batch 10
 * / đồng thời 10 mất 9,4 và 11,5 giây, batch 5 / đồng thời 20 mất 7,5 giây. Vì các batch chạy
 * song song nên thời gian do độ dài ĐẦU RA của mỗi lần gọi quyết định, không phải số sáng kiến.
 *
 * Trần token đầu ra mỗi lần gọi = 500 token cho mỗi ứng viên + 300 cho phần bao quanh. Mỗi mục
 * kết quả gồm id, score, relation, một hai câu lý do và hai đoạn trích tối đa 200 ký tự (tiếng
 * Việt tốn nhiều token), khoảng 350-400 token khi đủ; 500 để chừa chỗ, vì output bị cắt là cả
 * lời gọi lỗi. Chi phí thật chỉ tính theo token sinh ra.
 * BẮT BUỘC đặt: không có `max_tokens`, provider tính trước theo mức tối đa của model (khi
 * dùng OpenRouter với Sonnet là 65536 token, bị từ chối bằng HTTP 402 khi số dư không đủ
 * dù lời gọi thực tế chỉ tốn vài trăm token; gặp ở lần chạy thật 2026-11-04). Cũng chặn
 * chi phí và độ trễ khi model nói dài.
 * Model reasoning tính cả token suy nghĩ vào trần này: xem `LLM_SCORER_REASONING_EFFORT`.
 */
const OUTPUT_TOKENS_PER_CANDIDATE = 500;
const OUTPUT_TOKENS_OVERHEAD = 300;

/** Số ký tự tối đa của mỗi đoạn khớp (`matchedChunks`) đưa vào prompt; đoạn index dài tới 2000 ký tự. */
const MATCHED_CHUNK_MAX_CHARS = 1000;

async function scoreBatch(
  input: DedupInput,
  batch: Candidate[],
  config: LlmScorerConfig,
  options: ScoreOptions,
  cancel: AbortSignal,
): Promise<RawModelMatch[]> {
  const remainingMs = options.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new LlmScorerError("TIMEOUT", "Hết thời gian cho phép trước khi gọi model");
  }
  const signal = AbortSignal.any([
    cancel,
    AbortSignal.timeout(Math.min(config.timeoutMs, remainingMs)),
  ]);

  let body: unknown;
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: OUTPUT_TOKENS_PER_CANDIDATE * batch.length + OUTPUT_TOKENS_OVERHEAD,
        response_format: { type: "json_object" },
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        messages: [
          { role: "system", content: buildScoringPrompt(options.minScore) },
          {
            role: "user",
            content: JSON.stringify({
              newIdea: {
                type: input.type,
                title: input.title,
                content: input.content,
                fileExcerpts: input.fileExcerpts ?? [],
                parentSolutionId: input.parentSolutionId ?? null,
              },
              candidates: batch.map((candidate) => ({
                id: candidate.id,
                type: candidate.type,
                title: candidate.title,
                content: candidate.content.slice(0, config.maxCandidateChars),
                matchedChunks: (candidate.matchedChunks ?? []).map((chunk) =>
                  chunk.slice(0, MATCHED_CHUNK_MAX_CHARS),
                ),
                titleSimilarity: candidate.titleSimilarity ?? null,
                contentSimilarity: candidate.contentSimilarity ?? null,
              })),
            }),
          },
        ],
      }),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw new LlmScorerError(
        "AUTH_ERROR",
        `Model provider từ chối xác thực (HTTP ${response.status})`,
      );
    }
    if (response.status === 429) {
      // Free tier hết hạn mức (mỗi phút hoặc mỗi ngày): tách riêng để caller biết đây là
      // quota chứ không phải lỗi mạng. Không retry vì còn ngân sách thời gian chung.
      void response.body?.cancel().catch(() => undefined);
      throw new LlmScorerError(
        "RATE_LIMITED",
        "Model provider giới hạn tốc độ hoặc hết quota (HTTP 429)",
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new LlmScorerError(
        "NETWORK_ERROR",
        `Model provider trả lỗi HTTP ${response.status}`,
      );
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof LlmScorerError) throw error;
    if (isTimeout(error)) {
      throw new LlmScorerError(
        "TIMEOUT",
        "Model chấm điểm quá thời gian cho phép",
        { cause: error },
      );
    }
    if (error instanceof SyntaxError) {
      throw new LlmScorerError(
        "BAD_OUTPUT",
        "Model provider trả response không phải JSON hợp lệ",
        { cause: error },
      );
    }
    throw new LlmScorerError(
      "NETWORK_ERROR",
      "Không thể kết nối tới model provider",
      { cause: error },
    );
  }

  const output = parseModelOutput(body);
  assertBatchCovered(output, batch, options.minScore);
  return usableMatches(output, batch);
}

/**
 * Một mục của model sau khi đã đúng KIỂU (chưa kiểm khoảng giá trị). `percent` là `score` 0..100 của
 * model; `relation` còn là chuỗi tuỳ ý cho tới khi `scoreProblem()` kiểm.
 */
interface ParsedMatch {
  id: string;
  percent: number;
  reason: string;
  relation: string;
  evidence: { newQuote: string; candidateQuote: string };
}

/** Output đã parse của model, kèm số mục bị loại vì sai hình dạng (để chẩn đoán). */
interface ParsedModelOutput {
  matches: ParsedMatch[];
  /** Số phần tử model trả trong `matches[]`, tính cả phần tử sai hình dạng. */
  entryCount: number;
  /** Số phần tử bị loại vì không phải object, thiếu id/score/reason/relation hoặc sai kiểu. */
  malformedCount: number;
  /** Id của các phần tử sai hình dạng nhưng vẫn đọc được id (để biết nó nói về ứng viên nào). */
  malformedIds: string[];
}

/**
 * Đảm bảo không có ứng viên nào của batch bị mất dấu vì output hỏng (nếu không, ứng viên đó thành
 * "không trùng" dù có thể là sáng kiến trùng thật). Cùng nguyên tắc "một batch lỗi thì cả lời gọi
 * lỗi" ở đầu file. Mục thừa (id không thuộc batch) và mục sai hình dạng không gắn được với ứng
 * viên nào thì bị bỏ qua.
 *
 * - `minScore` <= 0 (model phải liệt kê mọi ứng viên): mỗi ứng viên cần một mục dùng được; thiếu
 *   mục (model bỏ sót, sai id) hay mục hỏng (score là chuỗi/số lẻ/ngoài 0..100, relation lạ,
 *   reason rỗng) đều là BAD_OUTPUT.
 * - `minScore` > 0: ứng viên vắng mặt nghĩa là dưới ngưỡng nên không kiểm được; chỉ ứng viên có
 *   mục hỏng mà không có mục dùng được nào mới là BAD_OUTPUT.
 *
 * `detail` chỉ chứa SỐ ĐẾM theo từng nguyên nhân (không có id, score hay reason nào) để log cho
 * biết model bỏ sót, sai id, trả score không hợp lệ hay trùng mục, mà không lộ nội dung.
 * Cách đọc: `entryCount` = `malformedCount` + số mục đã phân loại; ứng viên không có mục nào
 * hợp lệ và không thuộc các đếm còn lại nghĩa là model bỏ sót nó.
 */
function assertBatchCovered(
  output: ParsedModelOutput,
  batch: Candidate[],
  minScore: number,
): void {
  const batchIds = new Set(batch.map((candidate) => candidate.id));
  const scored = new Set<string>();
  const broken = new Set<string>();
  let unknownIdCount = 0;
  let duplicateCount = 0;
  let percentNotIntegerCount = 0;
  let percentOutOfRangeCount = 0;
  let relationInvalidCount = 0;
  let reasonBlankCount = 0;
  for (const match of output.matches) {
    if (!batchIds.has(match.id)) {
      unknownIdCount++;
      continue;
    }
    const problem = scoreProblem(match);
    if (problem === "percent_not_integer") percentNotIntegerCount++;
    else if (problem === "percent_out_of_range") percentOutOfRangeCount++;
    else if (problem === "relation_invalid") relationInvalidCount++;
    else if (problem === "reason_blank") reasonBlankCount++;
    else if (scored.has(match.id)) duplicateCount++;
    else scored.add(match.id);
    if (problem) broken.add(match.id);
  }
  for (const id of output.malformedIds) {
    if (batchIds.has(id)) broken.add(id);
  }
  const unresolvedCount = [...broken].filter((id) => !scored.has(id)).length;

  const incomplete = minScore <= 0 ? scored.size < batchIds.size : unresolvedCount > 0;
  if (incomplete) {
    throw new LlmScorerError(
      "BAD_OUTPUT",
      "Model không chấm điểm hợp lệ cho đủ ứng viên trong batch",
      {
        detail: {
          reason: minScore <= 0 ? "incomplete_scores" : "unusable_scores",
          expectedCount: batchIds.size,
          scoredCount: scored.size,
          entryCount: output.entryCount,
          malformedCount: output.malformedCount,
          unknownIdCount,
          duplicateCount,
          percentNotIntegerCount,
          percentOutOfRangeCount,
          relationInvalidCount,
          reasonBlankCount,
          unresolvedCount,
        },
      },
    );
  }
}

/** Lý do một mục không dùng được; `undefined` nghĩa là dùng được. Phải khớp `checkDuplicates()` (dedup.ts). */
function scoreProblem(
  match: ParsedMatch,
): "percent_not_integer" | "percent_out_of_range" | "relation_invalid" | "reason_blank" | undefined {
  if (!Number.isInteger(match.percent)) return "percent_not_integer";
  if (match.percent < 0 || match.percent > 100) return "percent_out_of_range";
  if (!isRelation(match.relation)) return "relation_invalid";
  if (match.reason.trim().length === 0) return "reason_blank";
  return undefined;
}

/** Các mục dùng được của model cho ứng viên của batch, mỗi ứng viên một mục (mục đầu tiên). */
function usableMatches(output: ParsedModelOutput, batch: Candidate[]): RawModelMatch[] {
  const batchIds = new Set(batch.map((candidate) => candidate.id));
  const taken = new Set<string>();
  const matches: RawModelMatch[] = [];
  for (const match of output.matches) {
    if (!batchIds.has(match.id) || taken.has(match.id) || scoreProblem(match) !== undefined) continue;
    taken.add(match.id);
    matches.push({
      id: match.id,
      percent: match.percent,
      reason: match.reason,
      relation: match.relation as RawModelMatch["relation"],
      evidence: match.evidence,
    });
  }
  return matches;
}

/**
 * Parse và validate output thô của model. Lỗi JSON, field thiếu, hoặc kiểu
 * sai đều bị coi là BAD_OUTPUT — checkDuplicates() ở lớp trên sẽ lọc tiếp
 * theo id/percent hợp lệ và id có thuộc danh sách candidate hay không.
 */
function parseModelOutput(body: unknown): ParsedModelOutput {
  const content = extractChatContent(body);
  if (content === null) {
    throw new LlmScorerError("BAD_OUTPUT", "Response của model thiếu nội dung chat", {
      detail: { reason: "no_content", finishReason: finishReason(body) },
    });
  }
  // Output bị cắt giữa chừng sẽ là JSON hỏng; nói thẳng nguyên nhân thay vì "sai định dạng".
  if (finishReason(body) === "length") {
    throw new LlmScorerError(
      "BAD_OUTPUT",
      "Output của model bị cắt vì hết giới hạn token (max_tokens)",
      { detail: { reason: "truncated", contentLength: content.length } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (error) {
    throw new LlmScorerError("BAD_OUTPUT", "Model trả JSON sai định dạng", {
      cause: error,
      // Không ghi bất kỳ ký tự nào của content: output model bám sát hồ sơ nên có thể
      // chứa nội dung hồ sơ (kể cả khi model từ chối hoặc bị prompt injection).
      detail: { reason: "invalid_json", contentLength: content.length },
    });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.matches)) {
    throw new LlmScorerError("BAD_OUTPUT", "Model trả JSON thiếu field matches[]", {
      // Tên key do model quyết định nên không ghi; chỉ ghi kiểu JSON và số key.
      detail: {
        reason: "missing_matches_field",
        jsonType: jsonTypeOf(parsed),
        ...(isRecord(parsed) ? { topLevelKeyCount: Object.keys(parsed).length } : {}),
      },
    });
  }

  const matches: ParsedMatch[] = [];
  const malformedIds: string[] = [];
  let malformedCount = 0;
  for (const raw of parsed.matches) {
    if (
      isRecord(raw) &&
      typeof raw.id === "string" &&
      raw.id.length > 0 &&
      typeof raw.score === "number" &&
      typeof raw.reason === "string" &&
      typeof raw.relation === "string"
    ) {
      // `type` model trả (nếu có) bị bỏ: checkDuplicates() lấy type từ dữ liệu đã index. `score` 0..100
      // của model là percent của app; score 0..1 của output luôn suy ra từ percent.
      matches.push({
        id: raw.id,
        percent: raw.score,
        reason: raw.reason,
        relation: raw.relation,
        evidence: parseEvidence(raw.evidence),
      });
    } else {
      // Entry sai kiểu bị bỏ qua ở đây (chỉ đếm); scoreBatch() sẽ báo BAD_OUTPUT nếu vì vậy
      // mà một ứng viên của batch không còn mục chấm điểm dùng được (assertBatchCovered).
      malformedCount++;
      if (isRecord(raw) && typeof raw.id === "string" && raw.id.length > 0) malformedIds.push(raw.id);
    }
  }

  return { matches, entryCount: parsed.matches.length, malformedCount, malformedIds };
}

/**
 * Bằng chứng chỉ là phần phụ trợ (checkDuplicates() còn tự kiểm từng đoạn có thật trong dữ liệu):
 * thiếu hoặc sai kiểu thì coi như không có bằng chứng, không làm hỏng mục chấm điểm.
 */
function parseEvidence(raw: unknown): ParsedMatch["evidence"] {
  const evidence = isRecord(raw) ? raw : {};
  return {
    newQuote: typeof evidence.newQuote === "string" ? evidence.newQuote : "",
    candidateQuote: typeof evidence.candidateQuote === "string" ? evidence.candidateQuote : "",
  };
}

/** Một số model bọc JSON trong ```json ... ``` dù đã yêu cầu json_object. */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced ? fenced[1]! : text;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function finishReason(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  const first = body.choices[0];
  return isRecord(first) ? first.finish_reason : undefined;
}

function extractChatContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) return null;
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" ? content : null;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Mock scorer để phát triển/test khi chưa dùng model thật.
 * KHÔNG dùng trong production — xem biến môi trường LLM_MOCK_MODE.
 * Chấm điểm giả bằng độ trùng từ vựng thô, chỉ để luồng chạy end-to-end. Luôn trả một mục cho
 * mỗi ứng viên (bất kể ngưỡng; checkDuplicates() tự lọc) và không có bằng chứng trích dẫn.
 */
export function createMockScorer(): DedupDependencies["scoreCandidates"] {
  return async function scoreCandidatesMock(
    input: DedupInput,
    candidates: Candidate[],
  ): Promise<RawModelMatch[]> {
    const inputWords = new Set(tokenize(input.title + " " + input.content));

    return candidates.map((candidate) => {
      const candidateWords = tokenize(candidate.title + " " + candidate.content);
      const overlap = candidateWords.filter((word) => inputWords.has(word)).length;
      const ratio =
        candidateWords.length === 0
          ? 0
          : Math.min(1, overlap / candidateWords.length);
      const percent = Math.round(ratio * 100);
      return {
        id: candidate.id,
        percent,
        reason: `[mock] ${overlap} từ trùng với hồ sơ đầu vào (chỉ phục vụ phát triển/test).`,
        relation: percent >= 90 ? "paraphrase" : percent >= 40 ? "same_problem" : "unrelated",
        evidence: { newQuote: "", candidateQuote: "" },
      };
    });
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}
