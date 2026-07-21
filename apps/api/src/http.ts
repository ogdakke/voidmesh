import { ApiErrorCode, type ApiErrorResponse } from "@voidmesh/api-contract";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  status: number,
): Response {
  const body: ApiErrorResponse = { code, message, requestId };
  return json(body, status);
}
