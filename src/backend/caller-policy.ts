import type { RequestHandler } from "express";
import type { InvocationClaims } from "./sota-auth.js";

/**
 * Giới hạn AI được gọi tool `check-duplicates`.
 *
 * Từ 2026-11-04 dữ liệu không còn tách theo workspace hay người gọi (chỉ tách theo
 * `type`: mỗi type một collection, xem vector-store.ts), nên không có lớp cách ly
 * người gọi ở tầng lưu trữ: ai gọi được tool là đọc được (nội dung rút gọn trong
 * prompt, kết quả là id + lý do) mọi sáng kiến của type được hỏi. Top-k theo vector không phải
 * ranh giới quyền: input do người gọi tự chọn nên họ có thể kéo bất kỳ sáng kiến nào vào top-k
 * bằng cách viết input giống nó. App lại có thể được cài vào nhiều
 * workspace Sota, nên quyền gọi phải được giới hạn ở đây, chỉ dựa trên CLAIMS ĐÃ
 * XÁC THỰC của Core (`sub`, `oid`, `wid`), không bao giờ dựa trên body hay header
 * không ký.
 *
 * Quy tắc (đóng theo mặc định):
 * - Mỗi danh sách đã cấu hình là một điều kiện BẮT BUỘC: claim tương ứng phải nằm
 *   trong danh sách (AND giữa các danh sách, để thu hẹp chứ không mở rộng quyền).
 * - Không cấu hình danh sách nào thì từ chối mọi lời gọi (403). Quên đặt biến môi
 *   trường không được phép làm mở toang tool.
 *
 * Danh sách nhận nhiều giá trị phân tách bằng dấu phẩy. Giá trị thật của `sub` cho
 * service account của VNAIP BE lấy từ log `invocation_accepted` (bật tạm
 * LOG_VERIFIED_CLAIMS=true); log này chạy TRƯỚC bước kiểm tra ở đây nên vẫn thấy
 * được claim của lời gọi bị từ chối.
 */

export interface CallerPolicy {
  subs: ReadonlySet<string>;
  oids: ReadonlySet<string>;
  wids: ReadonlySet<string>;
}

export type CallerDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "policy_not_configured"
        | "sub_not_allowed"
        | "oid_not_allowed"
        | "wid_not_allowed";
    };

export const CALLER_ENV = {
  subs: "CHECK_DUPLICATES_ALLOWED_SUBS",
  oids: "CHECK_DUPLICATES_ALLOWED_OIDS",
  wids: "CHECK_DUPLICATES_ALLOWED_WIDS",
} as const;

export function loadCallerPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CallerPolicy {
  return {
    subs: parseList(env[CALLER_ENV.subs]),
    oids: parseList(env[CALLER_ENV.oids]),
    wids: parseList(env[CALLER_ENV.wids]),
  };
}

export function isCallerPolicyEmpty(policy: CallerPolicy): boolean {
  return policy.subs.size === 0 && policy.oids.size === 0 && policy.wids.size === 0;
}

export function evaluateCaller(
  policy: CallerPolicy,
  claims: Pick<InvocationClaims, "sub" | "oid" | "wid">,
): CallerDecision {
  if (isCallerPolicyEmpty(policy)) {
    return { allowed: false, reason: "policy_not_configured" };
  }
  if (policy.subs.size > 0 && !isMember(policy.subs, claims.sub)) {
    return { allowed: false, reason: "sub_not_allowed" };
  }
  if (policy.oids.size > 0 && !isMember(policy.oids, claims.oid)) {
    return { allowed: false, reason: "oid_not_allowed" };
  }
  if (policy.wids.size > 0 && !isMember(policy.wids, claims.wid)) {
    return { allowed: false, reason: "wid_not_allowed" };
  }
  return { allowed: true };
}

export type CallerLogger = (
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

/**
 * Phải đặt SAU requireSotaInvocation: nó đọc claims đã xác thực ở
 * `response.locals.sota`. Log từ chối chỉ nêu lý do, không ghi giá trị claim
 * (muốn xem giá trị thì dùng LOG_VERIFIED_CLAIMS).
 */
export function requireAllowedCaller(
  policy: CallerPolicy,
  log: CallerLogger = defaultLog,
): RequestHandler {
  return (request, response, next) => {
    const claims = response.locals.sota as InvocationClaims | undefined;
    // Không có claims đã xác thực nghĩa là middleware auth chưa chạy: lỗi lắp ráp
    // route, phải từ chối thay vì cho qua.
    const decision: CallerDecision = claims
      ? evaluateCaller(policy, claims)
      : { allowed: false, reason: "policy_not_configured" };

    if (decision.allowed) {
      next();
      return;
    }

    log("error", "caller_denied", {
      requestId: response.getHeader("x-request-id") ?? request.header("x-request-id") ?? null,
      reason: decision.reason,
    });
    response.status(403).json({
      code: "CALLER_NOT_ALLOWED",
      message: "Người gọi không được phép dùng tool này.",
    });
  };
}

function parseList(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function isMember(allowed: ReadonlySet<string>, claim: unknown): boolean {
  return typeof claim === "string" && claim.length > 0 && allowed.has(claim);
}

function defaultLog(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }),
  );
}
