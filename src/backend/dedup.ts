import { isRecordType, RECORD_TYPES_LABEL, type RecordType } from "./record-type.js";

/**
 * Ba type hợp lệ là ideas / solutions / initiatives (record-type.ts). Giữ export
 * lại ở đây để các chỗ đã import từ dedup.ts không phải đổi.
 */
export type { RecordType };

/** Ngưỡng điểm mặc định để một ứng viên được đưa vào kết quả (xem `CheckDuplicatesOptions.minScore`). */
export const DEFAULT_MIN_SCORE = 40;

/** Điểm tối đa của ứng viên chính là sáng kiến mà input kế thừa (`parentSolutionId`). */
export const PARENT_MAX_PERCENT = 30;

/** Độ dài tối đa của mỗi đoạn trích dẫn làm bằng chứng. */
export const MAX_QUOTE_CHARS = 200;

/** Thời gian tối đa chờ bước tính titleSimilarity (gợi ý phụ, không được ăn ngân sách chấm điểm). */
const TITLE_SIMILARITY_BUDGET_MS = 3000;

/** Kiểu quan hệ giữa input và ứng viên, do model gán (xem scoring-prompt.ts). */
export const RELATIONS = [
  "copy",
  "paraphrase",
  "same_problem",
  "same_solution_other_scope",
  "extension",
  "unrelated",
] as const;
export type Relation = (typeof RELATIONS)[number];

export function isRelation(value: unknown): value is Relation {
  return typeof value === "string" && (RELATIONS as readonly string[]).includes(value);
}

export interface DedupInput {
  type: RecordType;
  title: string;
  content: string;
  /** Các đoạn trích từ file đính kèm của input (đã trích text); chỉ đưa cho model, không dùng để tìm vector. */
  fileExcerpts?: string[];
  /** Các `id` sáng kiến cần loại khỏi tập ứng viên (ví dụ chính hồ sơ đang sửa). */
  excludeIds?: string[];
  /**
   * Id sáng kiến mà input kế thừa. Ứng viên có đúng id này không bị báo trùng: relation là
   * "extension" và điểm không quá `PARENT_MAX_PERCENT`.
   */
  parentSolutionId?: string;
}

export interface Candidate {
  id: string;
  type: RecordType;
  title: string;
  content: string;
  /** Các đoạn của sáng kiến khớp vector truy vấn nhất (nội dung chunk), gần nhất trước. */
  matchedChunks?: string[];
  /** Cosine (0..1) giữa tiêu đề input và tiêu đề ứng viên; vắng khi không tính được. */
  titleSimilarity?: number;
  /** Cosine (0..1) của chunk gần nhất với input, từ tìm kiếm vector. */
  contentSimilarity?: number;
}

/** Đoạn trích nguyên văn ở mỗi phía; chuỗi rỗng khi model không trích được hoặc trích sai. */
export interface MatchEvidence {
  newQuote: string;
  candidateQuote: string;
}

export interface Match {
  id: string;
  type: RecordType;
  /**
   * percent (0..100, integer) là giá trị chuẩn do model sinh ra. score (0..1)
   * luôn được suy ra từ percent (score = percent / 100) ở checkDuplicates(),
   * không phải ngược lại — model không còn được tin trực tiếp trên score.
   */
  percent: number;
  score: number; // = percent / 100, giữ lại để tương thích phía dùng thang 0..1
  reason: string;
  relation: Relation;
  evidence: MatchEvidence;
}

export interface DedupOutput {
  matches: Match[];
}

/**
 * Shape thô mà model/adapter chấm điểm trả về, trước khi checkDuplicates()
 * validate và gán lại type/score. Model không cần (và không nên) tự trả
 * type: percent là giá trị chuẩn duy nhất về điểm (model sinh ra `score` 0..100,
 * llm-scorer.ts đổi tên thành percent).
 */
export interface RawModelMatch {
  id: string;
  percent: number;
  reason: string;
  relation: Relation;
  evidence: MatchEvidence;
}

/**
 * Lỗi nghiệp vụ có mã ổn định để tool-routes map sang HTTP/JSON đúng contract.
 * Không bao giờ đưa nội dung hồ sơ hoặc chi tiết downstream nhạy cảm vào message.
 */
export class DedupError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "EMBEDDING_UNAVAILABLE"
    | "CANDIDATES_UNAVAILABLE"
    | "CANDIDATE_LIMIT_EXCEEDED"
    | "SCORING_UNAVAILABLE";

  constructor(
    code: DedupError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "DedupError";
  }
}

/** Ngân sách thời gian của một lời gọi chấm điểm. */
export interface ScoreOptions {
  /** Mốc tuyệt đối (epoch ms) mà lời gọi phải xong; quá mốc thì dừng và báo lỗi. */
  deadlineAt: number;
  /**
   * Ngưỡng điểm (0..100): model chỉ cần liệt kê ứng viên có điểm từ ngưỡng này trở lên
   * (thay `{{MIN_SCORE}}` trong prompt). 0 nghĩa là liệt kê mọi ứng viên.
   */
  minScore: number;
}

/**
 * Các kết nối bên ngoài được truyền vào để dễ thay thế và kiểm thử.
 *
 * Không có tham số tenant: từ 2026-11-04 không còn `datasetKey`, nên việc giới hạn
 * ai được gọi tool nằm ở tầng route (caller-policy.ts, dựa trên claims đã xác
 * thực), không phải ở đây. Dữ liệu được tách theo `type`: mỗi type một collection.
 */
export interface DedupDependencies {
  /**
   * Bước 1: embed input thành các vector truy vấn, mỗi vector một đoạn nội dung (hồ sơ
   * dài được chia đoạn như lúc index). Phải dùng đúng embedding model đã dùng khi index.
   */
  embedInput(input: DedupInput): Promise<number[][]>;

  /**
   * Bước 2: trả tối đa `query.limit` sáng kiến của ĐÚNG `input.type` gần `query.vectors`
   * nhất (hướng B, tìm theo vector), xếp theo độ gần GIẢM DẦN, kèm nội dung đầy đủ để
   * model chấm. Đọc từ collection riêng của type đó, không được đọc collection của type
   * khác rồi lọc lại, và phải loại `input.excludeIds` ngay trong truy vấn để các id đó
   * không chiếm chỗ của `limit`. Phải ném lỗi khi không truy vấn được; không bao giờ coi
   * lỗi là "không có ứng viên".
   */
  findCandidates(input: DedupInput, query: CandidateQuery): Promise<Candidate[]>;

  /**
   * Bước 2b (tuỳ chọn, gợi ý phụ): cosine (0..1) giữa tiêu đề input và tiêu đề từng ứng viên,
   * cùng thứ tự với `candidates`. Lỗi hay chậm quá `TITLE_SIMILARITY_BUDGET_MS` thì bỏ qua gợi ý
   * này (model vẫn đọc nội dung); không bao giờ làm lời gọi thất bại.
   */
  titleSimilarities?(input: DedupInput, candidates: Candidate[]): Promise<number[]>;

  /** Bước 3: model đọc nội dung các ứng viên đã lọc rồi chấm mức tương đồng. */
  scoreCandidates(
    input: DedupInput,
    candidates: Candidate[],
    options: ScoreOptions,
  ): Promise<RawModelMatch[]>;
}

/** Truy vấn tìm ứng viên theo vector. */
export interface CandidateQuery {
  /** Vector truy vấn của input (từ `embedInput`), ít nhất một vector. */
  vectors: number[][];
  /** Số sáng kiến tối đa cần trả về (top-k). */
  limit: number;
}

export interface CheckDuplicatesOptions {
  /**
   * k của top-k: số sáng kiến gần input nhất (sau khi loại `excludeIds`) được gửi cho
   * model. Vector chỉ dùng để RÚT GỌN tập ứng viên; sáng kiến trùng thật nhưng diễn đạt
   * khác nhiều có thể nằm ngoài top-k và không bao giờ được model thấy, nên k là đánh
   * đổi giữa chi phí/độ trễ và nguy cơ bỏ sót (xem README, mục "Hành vi cần biết").
   */
  topK: number;
  /** Tổng thời gian cho cả lời gọi (embed + tìm ứng viên + chấm điểm), nhỏ hơn timeoutMs của tool. */
  deadlineMs: number;
  /**
   * Chỉ ứng viên có percent >= minScore mới vào kết quả (0 = giữ mọi ứng viên đã chấm). Cũng được
   * đưa cho model để nó khỏi liệt kê ứng viên dưới ngưỡng; app vẫn tự lọc lại vì không tin model.
   * Lưu ý: VNAIP BE hiển thị top 5 để tham khảo cả khi không match nào đạt 50 (xem
   * docs/vnaip-be-enrich-ket-qua-check-duplicates.md), nên ngưỡng > 0 làm danh sách đó ngắn đi.
   */
  minScore: number;
}

export async function checkDuplicates(
  input: DedupInput,
  deps: DedupDependencies,
  options: CheckDuplicatesOptions,
): Promise<DedupOutput> {
  if (!input.title?.trim() || !input.content?.trim()) {
    throw new DedupError("INVALID_INPUT", "type, title và content là bắt buộc");
  }
  if (!isRecordType(input.type)) {
    throw new DedupError("INVALID_INPUT", `type phải là một trong: ${RECORD_TYPES_LABEL}`);
  }

  if (!Number.isInteger(options.minScore) || options.minScore < 0 || options.minScore > 100) {
    // Lỗi cấu hình của chính app (không phải dữ liệu của caller) nên không dùng INVALID_INPUT.
    throw new RangeError("minScore phải là số nguyên trong [0,100]");
  }

  const deadlineAt = Date.now() + options.deadlineMs;

  // Bước 1: embed input. Lỗi embedding cũng phải propagate: không có vector thì không
  // thể lọc ứng viên, và không được coi đó là "không có hồ sơ trùng".
  let vectors: number[][];
  try {
    vectors = await deps.embedInput(input);
  } catch (error) {
    if (error instanceof DedupError) throw error;
    throw new DedupError(
      "EMBEDDING_UNAVAILABLE",
      "Không tạo được embedding cho hồ sơ đầu vào",
      { cause: error },
    );
  }
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new DedupError(
      "EMBEDDING_UNAVAILABLE",
      "Embedding của hồ sơ đầu vào rỗng",
    );
  }

  // Bước 2: tìm top-k ứng viên gần nhất theo vector. Nếu adapter lỗi, lỗi phải
  // propagate — không bao giờ biến lỗi lấy ứng viên thành "không có hồ sơ trùng".
  let found: Candidate[];
  try {
    found = await deps.findCandidates(input, { vectors, limit: options.topK });
  } catch (error) {
    if (error instanceof DedupError) throw error;
    throw new DedupError(
      "CANDIDATES_UNAVAILABLE",
      "Không lấy được danh sách sáng kiến để so sánh",
      { cause: error },
    );
  }

  // Chốt chặn cuối cùng của việc tách theo type. Adapter đã phải đọc đúng collection
  // của type này; nếu vẫn lọt ứng viên khác type thì đó là lỗi của adapter. Fail
  // closed: không so sánh chéo type, và không lặng lẽ bỏ ứng viên đi rồi trả kết
  // quả như thể đủ dữ liệu.
  if (found.some((candidate) => candidate.type !== input.type)) {
    throw new DedupError(
      "CANDIDATES_UNAVAILABLE",
      "Nguồn ứng viên trả sáng kiến khác type với yêu cầu",
    );
  }

  // Loại excludeIds ở đây (quy tắc nghiệp vụ) để không phụ thuộc adapter có làm hay không,
  // rồi giữ đúng top-k: danh sách đã xếp theo độ gần nên cắt đuôi là cắt các ứng viên xa
  // nhất (khác với hướng A cũ, nơi cắt tuỳ ý có thể bỏ sót đúng sáng kiến trùng).
  const excluded = new Set(input.excludeIds ?? []);
  const candidates = found
    .filter((candidate) => !excluded.has(candidate.id))
    .slice(0, options.topK);

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Bước 2b: tiêu đề giống nhau bao nhiêu (gợi ý phụ cho model).
  const scored = await withTitleSimilarities(input, candidates, deps);

  // Bước 3: model chấm mức tương đồng trên nội dung đầy đủ của nhóm ứng viên đã lọc.
  let rawMatches: RawModelMatch[];
  try {
    rawMatches = await deps.scoreCandidates(input, scored, {
      deadlineAt,
      minScore: options.minScore,
    });
  } catch (error) {
    throw new DedupError(
      "SCORING_UNAVAILABLE",
      "Model chấm điểm tương đồng thất bại",
      { cause: error },
    );
  }

  // Bước 4: chỉ chấp nhận ID thuộc tập ứng viên.
  const candidatesById = new Map(
    scored.map((candidate) => [candidate.id, candidate]),
  );

  const seen = new Set<string>();
  const matches: Match[] = [];

  for (const match of rawMatches) {
    if (!match || typeof match.id !== "string") continue;

    const candidate = candidatesById.get(match.id);
    const reason = typeof match.reason === "string" ? match.reason.trim() : "";

    // percent là giá trị chuẩn do model sinh ra; score luôn được suy ra từ
    // percent (score = percent / 100) — score thô do model trả (nếu có) KHÔNG
    // được tin, để tránh 2 số lệch nhau khi model sinh không nhất quán.
    if (
      !candidate ||
      seen.has(match.id) ||
      !Number.isInteger(match.percent) ||
      match.percent < 0 ||
      match.percent > 100 ||
      !isRelation(match.relation) ||
      reason.length === 0
    ) {
      continue;
    }

    seen.add(match.id);

    // Quy tắc 6 của prompt, áp lại ở đây vì model có thể quên: ứng viên chính là sáng kiến
    // input kế thừa không bị báo trùng.
    const isParent = input.parentSolutionId !== undefined && candidate.id === input.parentSolutionId;
    const percent = isParent ? Math.min(match.percent, PARENT_MAX_PERCENT) : match.percent;
    if (percent < options.minScore) continue;

    matches.push({
      id: candidate.id,
      type: candidate.type, // Lấy từ dữ liệu đã index, không tin type do model trả về.
      percent,
      score: percent / 100,
      reason: reason.slice(0, 1000),
      relation: isParent ? "extension" : match.relation,
      evidence: verifyEvidence(match.evidence, input, candidate),
    });
  }

  matches.sort((a, b) => b.percent - a.percent);

  // outputSchema giới hạn maxItems: 30. Cắt theo điểm cao nhất để luôn tuân thủ schema.
  return { matches: matches.slice(0, 30) };
}

/**
 * Gắn `titleSimilarity` cho từng ứng viên. Đây chỉ là gợi ý phụ: lỗi, chậm quá ngân sách hay
 * kết quả sai hình dạng đều bị bỏ qua (ứng viên đi tiếp không có gợi ý), vì thiếu gợi ý chỉ làm
 * model có ít thông tin hơn chứ không biến thành "không trùng" như lỗi lấy ứng viên hay chấm điểm.
 */
async function withTitleSimilarities(
  input: DedupInput,
  candidates: Candidate[],
  deps: DedupDependencies,
): Promise<Candidate[]> {
  if (!deps.titleSimilarities) return candidates;

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("title similarity timeout")), TITLE_SIMILARITY_BUDGET_MS);
    });
    const similarities = await Promise.race([deps.titleSimilarities(input, candidates), timeout]);
    if (!Array.isArray(similarities) || similarities.length !== candidates.length) return candidates;
    return candidates.map((candidate, index) => {
      const value = similarities[index];
      return typeof value === "number" && Number.isFinite(value)
        ? { ...candidate, titleSimilarity: roundSimilarity(value) }
        : candidate;
    });
  } catch {
    return candidates;
  } finally {
    clearTimeout(timer);
  }
}

/** Cosine về 0..1, 4 chữ số thập phân (cosine âm nghĩa là không liên quan). */
export function roundSimilarity(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

/**
 * Chỉ giữ đoạn trích model đưa ra khi nó thực sự có trong dữ liệu đã đưa cho model; đoạn bịa
 * hoặc bị sửa chữ thì thành chuỗi rỗng ("tuyệt đối không bịa hoặc sửa chữ"). So khớp sau khi
 * gộp khoảng trắng và chuẩn hoá NFC, nhưng phân biệt hoa/thường. Đoạn dài hơn `MAX_QUOTE_CHARS`
 * bị cắt đuôi (phần đầu của một đoạn nguyên văn vẫn nguyên văn).
 */
function verifyEvidence(
  evidence: MatchEvidence | undefined,
  input: DedupInput,
  candidate: Candidate,
): MatchEvidence {
  return {
    newQuote: verifiedQuote(evidence?.newQuote, [
      input.title,
      input.content,
      ...(input.fileExcerpts ?? []),
    ]),
    candidateQuote: verifiedQuote(evidence?.candidateQuote, [
      candidate.title,
      candidate.content,
      ...(candidate.matchedChunks ?? []),
    ]),
  };
}

function verifiedQuote(quote: unknown, sources: string[]): string {
  if (typeof quote !== "string") return "";
  const wanted = normalizeForQuote(quote);
  if (wanted.length === 0) return "";
  const found = sources.some((source) => normalizeForQuote(source).includes(wanted));
  return found ? wanted.slice(0, MAX_QUOTE_CHARS) : "";
}

function normalizeForQuote(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
