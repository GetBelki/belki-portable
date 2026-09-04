import type { PortableConfig } from "../config";

export function trustedClientIp(request: Request, config: PortableConfig): string | null {
  if (!config.TRUST_PROXY_HEADERS) return null;
  const candidate = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (!candidate || candidate.length > 64 || !/^[0-9a-f:.]+$/iu.test(candidate)) return null;
  return candidate.toLowerCase();
}
