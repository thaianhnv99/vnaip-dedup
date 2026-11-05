import 'dotenv/config';
import { describeStartupError, startIndexWorker } from './index-service.js';

/**
 * Tiến trình worker index, chạy tách khỏi tiến trình web (`server.ts`):
 * lấy job từ BullMQ từng cái một, embed rồi ghi Qdrant. Không mở cổng HTTP.
 * Mỗi job được ghi vào collection riêng của `job.type` (ideas / solutions /
 * initiatives); type không hợp lệ bị đưa vào hàng chờ lỗi, không retry.
 *
 * Cấu hình bắt buộc khớp với web: REDIS_URL, QUEUE_PREFIX, QUEUE_NAME, và
 * QDRANT_URL + QDRANT_COLLECTION_PREFIX (web đọc đúng các collection worker ghi).
 * Riêng worker cần thêm GEMINI_API_KEY; QDRANT_API_KEY chỉ cần khi Qdrant không
 * chạy trên localhost. Thiếu cấu hình thì thoát mã 1 để nền tảng báo hỏng ngay.
 */

const workerId = 'vnaip-dedup-worker';

let worker: Awaited<ReturnType<typeof startIndexWorker>>;
try {
  worker = await startIndexWorker(process.env, log);
} catch (error) {
  log('error', 'worker_failed', { workerId, ...describeStartupError(error) });
  process.exit(1);
}

// Tắt êm khi nền tảng gửi SIGTERM (ví dụ lúc deploy): ngừng nhận job mới và chờ
// job đang chạy xong để ack. Job dở dang được BullMQ xếp lại cho lần chạy sau.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { workerId, signal });
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  void worker.stop().catch(() => undefined).then(() => {
    log('info', 'shutdown_done', { workerId, signal });
    process.exit(0);
  });
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

function log(level: 'info' | 'error', event: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}
