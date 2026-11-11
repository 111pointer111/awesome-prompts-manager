export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "network_error", "连接未完成，请检查网络后重试");
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new ApiError(response.status, "invalid_response", "服务返回了无法读取的响应，请稍后重试"); }
  if (!response.ok) {
    const error = value as { error?: string; message?: string };
    throw new ApiError(response.status, error.error ?? "request_failed", error.message ?? "操作未完成，请重试");
  }
  return value as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}
