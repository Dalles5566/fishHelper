// ============================================================================
// 共享:带超时的 fetch。与 services/dataSource/* 的约定一致(15s 超时),
// 避免挂住的连接把添加钓点流程或 agent 轮次无限期拖住。
// ============================================================================

export const FETCH_TIMEOUT_MS = 15000;

/**
 * fetch + AbortSignal.timeout。调用方自行 try/catch(超时会抛 TimeoutError)。
 * @param {string} url
 * @param {RequestInit} [options]
 */
export function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
}
