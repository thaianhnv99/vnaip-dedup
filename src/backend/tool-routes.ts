import type { Express, RequestHandler } from 'express';
import { requireSotaInvocation } from './sota-auth.js';
import { handleExampleTool } from './tool.example.js';
import { createCheckDuplicatesHandler } from './check-duplicates-route.js';
import {
  CALLER_ENV,
  isCallerPolicyEmpty,
  loadCallerPolicy,
  requireAllowedCaller,
  type CallerPolicy,
} from './caller-policy.js';

export interface ToolRouteOptions {
  /** Mặc định đọc từ CHECK_DUPLICATES_ALLOWED_* trong env. */
  callerPolicy?: CallerPolicy;
  /** Mặc định: handler thật (Qdrant + Gemini, dựng ở lần gọi đầu). Test truyền handler giả. */
  checkDuplicates?: RequestHandler;
}

export function registerToolRoutes(app: Express, appId: string, options: ToolRouteOptions = {}) {
  app.post('/tools/example', requireSotaInvocation(appId, 'tool:example'), async (request, response) => {
    const body = isRecord(request.body?.body) ? request.body.body : request.body;
    response.json(await handleExampleTool(body?.input ?? body, response.locals.sota));
  });

  const callerPolicy = options.callerPolicy ?? loadCallerPolicy();
  if (isCallerPolicyEmpty(callerPolicy)) {
    // Không dừng app: /health và webhook vẫn phải chạy. Tool trả 403 cho tới khi cấu hình.
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'caller_policy_empty',
        message:
          `Chưa đặt danh sách người gọi được phép (${CALLER_ENV.subs}, ${CALLER_ENV.oids} hoặc ${CALLER_ENV.wids}); ` +
          'tool check-duplicates từ chối mọi lời gọi (403) cho tới khi cấu hình.',
      }),
    );
  }

  app.post(
    '/tools/check-duplicates',
    // Thứ tự có chủ đích: xác thực token trước, rồi mới kiểm người gọi dựa trên claims đã xác thực.
    requireSotaInvocation(appId, 'tool:check-duplicates'),
    requireAllowedCaller(callerPolicy),
    options.checkDuplicates ?? createCheckDuplicatesHandler(),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
