// supabase/functions/_shared/authGuard.ts
//
// Helper central de autenticação para Edge Functions.
// Único lugar autorizado a:
//   - comparar token diretamente com SUPABASE_SERVICE_ROLE_KEY
//   - decodificar payload JWT manualmente
//   - chamar auth.getUser()
//
// Outras Edge Functions DEVEM importar deste módulo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type AuthIdentity =
  | { kind: "service_role"; via: "exact" | "jwt_claim" }
  | { kind: "internal_secret" }
  | { kind: "admin_user"; userId: string }
  | { kind: "user"; userId: string }
  | { kind: "anon" };

export interface GuardResult {
  ok: boolean;
  identity: AuthIdentity;
  status?: number;
  error?: string;
}

/** Extrai o token Bearer do header Authorization. */
export function getBearerToken(req: Request): string {
  const h = req.headers.get("Authorization") || "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

/** Decodifica o payload do JWT SEM validar assinatura (gateway já validou). */
export function decodeJwtPayloadAfterGateway(token: string): Record<string, any> | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * True SOMENTE quando o token apresentado é EXATAMENTE o SUPABASE_SERVICE_ROLE_KEY.
 * Não aceitamos claim JWT `role=service_role` decodificada manualmente porque, em
 * funções com verify_jwt=false, um JWT forjado passaria sem verificação de
 * assinatura. Comparação exata com a env var é a única prova confiável.
 */
export function isExactServiceRoleToken(token: string): boolean {
  if (!token) return false;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return !!serviceRoleKey && token === serviceRoleKey;
}

/** @deprecated Use isExactServiceRoleToken. Mantido como alias estrito p/ compat. */
export function isServiceRoleToken(token: string): boolean {
  return isExactServiceRoleToken(token);
}

/** True se o request veio com x-internal-secret válido. */
export function hasInternalSecret(req: Request): boolean {
  const expected = Deno.env.get("INTERNAL_FUNCTION_SECRET") || "";
  if (!expected) return false;
  const got = req.headers.get("x-internal-secret") || "";
  return !!got && got === expected;
}

/** True se o request veio do pg_cron com o segredo operacional canônico. */
export function hasCronSecret(req: Request): boolean {
  const expected = Deno.env.get("RECONCILE_CRON_SECRET") || Deno.env.get("CRON_SECRET") || "";
  if (!expected) return false;
  const got = req.headers.get("x-cron-secret") || "";
  return !!got && got === expected;
}

/**
 * Guard canônico para rotinas agendadas. Aceita o segredo dedicado do cron,
 * chamadas internas legadas e service_role exata. Não aceita usuário comum.
 */
export function requireCronOrPrivileged(req: Request): GuardResult {
  if (hasCronSecret(req)) return { ok: true, identity: { kind: "internal_secret" } };
  if (hasInternalSecret(req)) return { ok: true, identity: { kind: "internal_secret" } };
  const token = getBearerToken(req);
  if (isExactServiceRoleToken(token)) {
    return { ok: true, identity: { kind: "service_role", via: "exact" } };
  }
  return { ok: false, status: 401, error: "UNAUTHORIZED_CRON", identity: { kind: "anon" } };
}

function adminClientLazy() {
  return createClient<any>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/**
 * Aceita chamadas vindas de:
 *  - INTERNAL_FUNCTION_SECRET (preferido para function→function)
 *  - service_role (compat com chamadas internas legadas)
 *  - usuário autenticado COM role 'admin'
 */
export async function requireAdminOrServiceRole(req: Request): Promise<GuardResult> {
  if (hasInternalSecret(req)) {
    return { ok: true, identity: { kind: "internal_secret" } };
  }

  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "UNAUTHORIZED", identity: { kind: "anon" } };
  }

  if (isExactServiceRoleToken(token)) {
    return { ok: true, identity: { kind: "service_role", via: "exact" } };
  }

  // Usuário autenticado: validar via getUser e checar role admin
  const userClient = createClient<any>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: "UNAUTHORIZED", identity: { kind: "anon" } };
  }

  const admin = adminClientLazy();
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleRow) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN_NOT_ADMIN",
      identity: { kind: "user", userId: userData.user.id },
    };
  }

  return { ok: true, identity: { kind: "admin_user", userId: userData.user.id } };
}

/**
 * Aceita SOMENTE chamadas internas: cron, function→function, scripts admin com service_role.
 * Não aceita usuário admin logado.
 */
export async function requireServiceRoleOrInternalSecret(req: Request): Promise<GuardResult> {
  if (hasInternalSecret(req)) {
    return { ok: true, identity: { kind: "internal_secret" } };
  }
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "UNAUTHORIZED", identity: { kind: "anon" } };
  }
  if (isExactServiceRoleToken(token)) {
    return { ok: true, identity: { kind: "service_role", via: "exact" } };
  }
  return { ok: false, status: 403, error: "FORBIDDEN_INTERNAL_ONLY", identity: { kind: "anon" } };
}

/** Cabeçalhos a usar quando uma função chama outra internamente. */
export function internalCallHeaders(): Record<string, string> {
  const secret = Deno.env.get("INTERNAL_FUNCTION_SECRET");
  if (secret) return { "x-internal-secret": secret };
  // Fallback: service_role (compat). Sem secret configurado, mantém comportamento atual.
  return { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` };
}

/** Helper de resposta JSON com CORS já injetado. */
export function guardErrorResponse(
  guard: GuardResult,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: guard.error || "UNAUTHORIZED" }),
    {
      status: guard.status || 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}