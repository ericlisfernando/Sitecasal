import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireAdminOrServiceRole, guardErrorResponse, hasCronSecret } from "../_shared/authGuard.ts";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  igGraphVersion,
  classifyInstagramError,
  failureState,
  isLockHeld,
  resolveIgImageUrls,
  pickRecoveryCandidate,
  isWriteConfirmed,
  canPublishNow,
  decidePendingMediaAction,
  decidePendingCreationAction,
  decideReconciliationAction,
  shouldBlockForOpenReconciliation,
  type MetaProbe,
  type ImagePrepResult,
} from "../_shared/instagramPublishPolicy.ts";

const GRAPH = igGraphVersion(Deno.env.get("INSTAGRAM_GRAPH_VERSION"));

/**
 * publish-announcement-to-instagram
 *
 * Publica um anúncio aprovado como POST DE FEED no Instagram via Graph API.
 * - 1 imagem  → post simples (image).
 * - 2+ imagens → CAROUSEL_ALBUM com children ordenados como no anúncio.
 *
 * Fluxo:
 *   1. Autoriza (admin ou service_role/internal).
 *   2. Lê o anúncio, garante `instagram_share_enabled = true` e `status = 'publicado'`.
 *   3. Idempotente: se `instagram_post_id` já existe, retorna 200 sem republicar.
 *   4. Cria containers filhos (para carrossel) → container pai → publica.
 *   5. Persiste `instagram_post_id`, `instagram_permalink`, `instagram_posted_at`
 *      ou `instagram_last_error` em caso de falha.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-request-id, x-internal-cron",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveToken(admin: any): Promise<string | null> {
  const { data: cfg } = await admin
    .from("site_config")
    .select("value")
    .eq("key", "instagram_access_token")
    .maybeSingle();
  const fromDb = cfg?.value ? String(cfg.value) : null;
  return fromDb || Deno.env.get("INSTAGRAM_ACCESS_TOKEN") || null;
}

async function waitContainerReady(containerId: string, token: string, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(
      `https://graph.instagram.com/${GRAPH}/${containerId}?fields=status_code&access_token=${token}`,
    );
    const j = await r.json().catch(() => ({}));
    const code = j?.status_code || "IN_PROGRESS";
    if (code === "FINISHED") return { ok: true };
    if (code === "ERROR" || code === "EXPIRED") {
      return { ok: false, error: `status=${code}`, details: j };
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  return { ok: false, error: "status_timeout" };
}

/**
 * Prepara uma imagem para as proporções aceitas pelo feed do Instagram (0.8 a 1.91:1).
 * Fora da faixa, aplica RECORTE CENTRAL; nunca adiciona padding/barras pretas.
 * A imagem original do marketplace permanece intocada.
 */
const IG_MAX_RATIO = 1.9;
const IG_MIN_RATIO = 0.81;
const IG_MAX_W = 1080;
const IG_MAX_H = 1350;

async function letterboxForInstagram(
  admin: any,
  announcementId: string,
  index: number,
  sourceUrl: string,
): Promise<ImagePrepResult> {
  try {
    console.log(`[publish-ig] crop start idx=${index} url=${sourceUrl.slice(-60)}`);
    const isSupabaseStorage = sourceUrl.includes("/storage/v1/object/public/");
    const fetchUrl = isSupabaseStorage
      ? sourceUrl.replace("/object/public/", "/render/image/public/")
        + `?width=${IG_MAX_W}&height=${IG_MAX_H}&resize=contain&quality=85`
      : sourceUrl;
    const res = await fetch(fetchUrl);
    if (!res.ok) return { kind: "prepare_failed", reason: `fetch_http_${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    let img = await Image.decode(buf);
    const scale = Math.min(1, IG_MAX_W / img.width, IG_MAX_H / img.height);
    const needsResize = scale < 1;
    if (needsResize) {
      img = img.resize(
        Math.max(1, Math.round(img.width * scale)),
        Math.max(1, Math.round(img.height * scale)),
      );
    }
    const ratio = img.width / img.height;
    const needsCrop = ratio > IG_MAX_RATIO || ratio < IG_MIN_RATIO;
    if (!needsCrop && !needsResize) return { kind: "original_safe" };
    if (ratio > IG_MAX_RATIO) {
      const targetW = Math.max(1, Math.floor(img.height * IG_MAX_RATIO));
      const offsetX = Math.max(0, Math.floor((img.width - targetW) / 2));
      img = img.crop(offsetX, 0, targetW, img.height);
    } else if (ratio < IG_MIN_RATIO) {
      const targetH = Math.max(1, Math.floor(img.width / IG_MIN_RATIO));
      const offsetY = Math.max(0, Math.floor((img.height - targetH) / 2));
      img = img.crop(0, offsetY, img.width, targetH);
    }
    const jpeg = await img.encodeJPEG(85);
    const path = `instagram-cache/${announcementId}/${index}-${Date.now()}.jpg`;
    const { error: upErr } = await admin.storage
      .from("announcement-screenshots")
      .upload(path, jpeg, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
    if (upErr) return { kind: "prepare_failed", reason: "upload_failed" };
    const { data: pub } = admin.storage.from("announcement-screenshots").getPublicUrl(path);
    if (!pub?.publicUrl) return { kind: "prepare_failed", reason: "public_url_missing" };
    return { kind: "adjusted", url: pub.publicUrl };
  } catch (e) {
    console.error(`[publish-ig] crop error idx=${index}:`, e);
    return { kind: "prepare_failed", reason: `exception:${String((e as Error)?.message || e).slice(0, 80)}` };
  }
}

function buildCaption(ann: any, categoryName: string | null, offerTypeName: string | null, offerDetailType: string | null, publicPrice?: number | null): string {
  const title = (ann?.public_title || "").toString().trim();
  const description = (ann?.public_description || "").toString().trim();
  // Preço exibido = preço público da vitrine. No Pricing V2, desired_price também
  // representa esse preço público, mas usamos o valor publicado como fonte final.
  const price = Number(publicPrice);
  const priceStr = Number.isFinite(price) && price > 0
    ? `R$ ${Math.ceil(price).toLocaleString("pt-BR")}`
    : "";
  const handle = ann?.instagram_seller_handle
    ? `@${String(ann.instagram_seller_handle).replace(/^@+/, "")}`
    : "";
  const category = (categoryName || "").toString().trim();
  const offerType = (offerTypeName || "").toString().trim();
  const detail = (offerDetailType || "").toString().trim();
  const classification = [category, offerType, detail].filter(Boolean).join(" — ");
  const adCode = ann?.synced_account_code
    ? String(ann.synced_account_code).toUpperCase()
    : ann?.id
    ? String(ann.id).slice(0, 8).toUpperCase()
    : "";

  const searchable = `${category} ${offerType} ${detail} ${title} ${description}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const hashtags = new Set(["#casalcontas", "#marketplace", "#produtosdigitais", "#servicosdigitais"]);
  if (/(conta|jogo|codm|call of duty|free fire|efootball|roblox|valorant|gamer)/.test(searchable)) {
    hashtags.add("#gamer");
    hashtags.add("#jogosonline");
  }
  if (/(gift|cartao presente|recarga|credito|diamante|robux|coins|cp\b)/.test(searchable)) {
    hashtags.add("#giftcards");
    hashtags.add("#recargas");
  }
  if (/(curso|mentoria|aula|treinamento|coaching)/.test(searchable)) {
    hashtags.add("#cursosonline");
    hashtags.add("#mentoria");
  }
  if (/(thumbnail|design|logo|banner|edicao|criador|video)/.test(searchable)) {
    hashtags.add("#design");
    hashtags.add("#criadoresdeconteudo");
  }
  if (/(streaming|netflix|spotify|disney|prime video|assinatura|acesso digital)/.test(searchable)) {
    hashtags.add("#streaming");
    hashtags.add("#acessosdigitais");
  }

  const lines: string[] = [];
  const block = (s: string) => {
    lines.push(s);
    lines.push("");
  };
  if (priceStr) block(`💰 ${priceStr}`);
  if (title) block(`🏷 ${title}`);
  if (description) block(`📝 ${description}`);
  if (classification) block(`📂 ${classification}`);
  if (adCode) block(`🆔️ CÓDIGO DO ANÚNCIO: ${adCode}`);
  block("🏛 Pix • Cartão • Wise • Binance • Remitly • PayPal • IBAN");
  block("🛒 COMPRAR: CASALCONTAS.COM");
  block("🚀 ANUNCIE CONOSCO: É GRÁTIS");
  if (handle) block(`👤 Anúncio de ${handle}`);
  block("𝚝𝚘𝚍𝚊 𝚒𝚗𝚏𝚘𝚛𝚖𝚊çã𝚘 𝚌𝚘𝚗𝚝𝚒𝚍𝚊 𝚗𝚘 𝚊𝚗ú𝚗𝚌𝚒𝚘 é 𝚏𝚘𝚛𝚗𝚎𝚌𝚒𝚍𝚊 𝚙𝚎𝚕𝚘 𝚊𝚗𝚞𝚗𝚌𝚒𝚊𝚗𝚝𝚎");
  lines.push(Array.from(hashtags).join(" "));
  return lines.join("\n").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient<any>(supabaseUrl, serviceRoleKey);

  const reqId = req.headers.get("x-request-id") || crypto.randomUUID();
  console.log(`[publish-ig][${reqId}] boot`, {
    has_auth_header: !!req.headers.get("Authorization"),
    has_internal_secret_header: !!req.headers.get("x-internal-secret"),
    internal_secret_env_configured: !!Deno.env.get("INTERNAL_FUNCTION_SECRET"),
    service_role_env_configured: !!serviceRoleKey,
  });

  // Corpo lido ANTES do guard para que qualquer falha de autorização já possa
  // ser gravada no anúncio (antes ficava invisível: 401 sem log e sem registro).
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const announcementIdRaw: string | undefined = body?.announcement_id;
  const forceRequested = body?.force === true;
  const forceReason = String(body?.reason ?? "admin_manual_retry").slice(0, 200);

  // Aceita também o segredo operacional do cron (watchdog de republicação).
  const guard = hasCronSecret(req)
    ? { ok: true, identity: { kind: "internal_secret" as const } }
    : await requireAdminOrServiceRole(req);
  if (!guard.ok) {
    console.error(`[publish-ig][${reqId}] guard_denied`, { error: guard.error, status: guard.status });
    if (announcementIdRaw) {
      await admin
        .from("announcements")
        .update({ instagram_last_error: `guard_denied:${guard.error || "UNAUTHORIZED"}` })
        .eq("id", announcementIdRaw);
    }
    return guardErrorResponse(guard, corsHeaders);
  }

  const announcementId = announcementIdRaw;
  if (!announcementId) return json({ ok: false, error: "missing_announcement_id" }, 400);
  console.log(`[publish-ig][${reqId}] authorized`, { identity: guard.identity?.kind, announcement_id: announcementId });

  // 1. Carrega o anúncio
  const { data: ann, error: annErr } = await admin
    .from("announcements")
    .select("id, synced_account_code, synced_account_id, status, public_title, public_description, desired_price, images, cover_image_index, instagram_share_enabled, instagram_seller_handle, instagram_post_id, subcategory_id, custom_game_name, video_muted_url, video_status, video_duration_sec, instagram_publish_lock_token, instagram_publish_started_at, instagram_publish_attempts, instagram_publish_status, instagram_pending_creation_id, instagram_pending_media_id, offer_type_id, offer_detail_type")
    .eq("id", announcementId)
    .maybeSingle();
  if (annErr || !ann) {
    console.error(`[publish-ig][${reqId}] load_failed`, { announcement_id: announcementId, db_error: annErr?.message || null });
    await admin
      .from("announcements")
      .update({ instagram_last_error: `load_failed:${annErr?.message || "not_found"}`.slice(0, 300) })
      .eq("id", announcementId);
    return json({ ok: false, error: "announcement_not_found", details: annErr?.message || null }, 404);
  }

  // Resolve Categoria (jogo/plataforma) + Subcategoria (tipo da oferta).
  let categoryName: string | null = null;
  let offerTypeName: string | null = null;
  if (ann.custom_game_name) {
    categoryName = String(ann.custom_game_name);
  } else if (ann.subcategory_id) {
    const { data: sub } = await admin
      .from("pricing_subcategories")
      .select("name")
      .eq("id", ann.subcategory_id)
      .maybeSingle();
    if (sub?.name) categoryName = String(sub.name);
  }
  if (ann.offer_type_id) {
    const { data: offerType } = await admin
      .from("catalog_offer_types")
      .select("name")
      .eq("id", ann.offer_type_id)
      .maybeSingle();
    if (offerType?.name) offerTypeName = String(offerType.name);
  }

  // Divulgação no Instagram é OBRIGATÓRIA para todo anúncio aprovado.
  // (`instagram_share_enabled` permanece apenas como registro histórico; a
  // única parte opcional é a marcação do @ do vendedor.)
  if (ann.status !== "publicado") {
    return json({ ok: true, skipped: true, reason: "not_published" });
  }
  if (ann.instagram_post_id) {
    return json({ ok: true, skipped: true, reason: "already_posted", instagram_post_id: ann.instagram_post_id });
  }
  console.log(`[publish-ig][${reqId}] loaded`, {
    status: ann.status,
    images: Array.isArray(ann.images) ? ann.images.length : null,
    video_status: ann.video_status ?? null,
    lock_token: ann.instagram_publish_lock_token ? "held" : null,
    lock_started_at: ann.instagram_publish_started_at ?? null,
  });

  // Lease/lock: impede que dois disparos concorrentes criem posts duplicados.
  // TTL de 5 minutos — MESMO prazo usado pelo watchdog SQL (antes divergia:
  // SQL 5 min x função 10 min, e o retry batia em publish_in_progress).
  const lockToken = crypto.randomUUID();
  if (isLockHeld(ann.instagram_publish_lock_token, ann.instagram_publish_started_at)) {
    return json({ ok: true, skipped: true, reason: "publish_in_progress" });
  }

  // ---------------------------------------------------------------------------
  // Retry administrativo REAL (`force: true`): auditado, exige admin, nunca
  // republica um anúncio que já tem post e nunca atropela uma publicação em
  // andamento (o guard de lock acima já barrou este caso).
  // ---------------------------------------------------------------------------
  if (forceRequested) {
    const actorKind = guard.identity?.kind ?? "unknown";
    const isAdminActor = actorKind === "admin_user";
    const isMachineActor = actorKind === "service_role" || actorKind === "internal_secret";
    if (!isAdminActor && !isMachineActor) {
      return json({ ok: false, error: "forbidden_force_requires_admin" }, 403);
    }
    const actorId = (guard.identity as { userId?: string } | undefined)?.userId ?? null;
    const { error: forceErr } = await admin
      .from("announcements")
      .update({
        // Limpa a falha terminal SOMENTE por decisão explícita do admin.
        instagram_publish_status:
          ann.instagram_publish_status === "failed_permanent" ? "pending" : ann.instagram_publish_status,
        instagram_next_attempt_at: new Date().toISOString(),
        instagram_retry_requested_by: actorId,
        instagram_retry_requested_at: new Date().toISOString(),
        instagram_retry_reason: forceReason,
      })
      .eq("id", ann.id)
      .is("instagram_post_id", null);
    if (forceErr) {
      console.error(`[publish-ig][${reqId}] force_reset_failed`, forceErr.message);
      return json({ ok: false, error: "force_reset_failed", details: forceErr.message }, 500);
    }
    await admin.from("admin_logs").insert({
      action: "instagram_publish_manual_retry",
      actor_kind: isAdminActor ? "admin" : "system",
      actor_id: actorId,
      target_table: "announcements",
      target_id: ann.id,
      details: {
        reason: forceReason,
        previous_status: ann.instagram_publish_status ?? null,
        attempts_before: Number(ann.instagram_publish_attempts ?? 0),
        account_code: ann.synced_account_code ?? null,
      },
    });
  }

  const attempts = Number(ann.instagram_publish_attempts ?? 0) + 1;
  // Claim otimista sem `.or()` (o filtro com timestamp ISO cru era rejeitado
  // pelo PostgREST e fazia todo disparo virar "publish_lock_not_acquired").
  let claimQuery = admin
    .from("announcements")
    .update({
      instagram_publish_lock_token: lockToken,
      instagram_publish_started_at: new Date().toISOString(),
      instagram_publish_status: "publishing",
      instagram_publish_attempts: attempts,
      instagram_last_attempt_at: new Date().toISOString(),
    })
    .eq("id", ann.id)
    .is("instagram_post_id", null);
  claimQuery = ann.instagram_publish_lock_token
    ? claimQuery.eq("instagram_publish_lock_token", ann.instagram_publish_lock_token)
    : claimQuery.is("instagram_publish_lock_token", null);
  const { data: claimed, error: claimErr } = await claimQuery.select("id").maybeSingle();
  if (claimErr || !claimed) {
    console.warn(`[publish-ig][${reqId}] lock_not_acquired`, { db_error: claimErr?.message || null });
    return json({ ok: true, skipped: true, reason: "publish_lock_not_acquired" });
  }
  console.log(`[publish-ig][${reqId}] lock_acquired`);
  /**
   * Libera o lock SOMENTE se ainda somos o dono dele. Um worker antigo não pode
   * derrubar o lock de uma execução mais nova.
   */
  const releaseLock = async (): Promise<boolean> => {
    const { data, error } = await admin
      .from("announcements")
      .update({ instagram_publish_lock_token: null, instagram_publish_started_at: null })
      .eq("id", ann.id)
      .eq("instagram_publish_lock_token", lockToken)
      .select("id");
    if (error) {
      console.error(`[publish-ig][${reqId}] release_lock_failed`, error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  };

  /**
   * Registra falha com estado operacional completo: erro, tentativas, próxima
   * tentativa (backoff) ou falha terminal + alerta administrativo.
   */
  const recordFailure = async (error: string): Promise<{ persisted: boolean; reason?: string }> => {
    const state = failureState(attempts, error, new Date());
    // Protegido pelo lock: um worker antigo NÃO altera status, reagendamento
    // nem falha terminal de uma execução mais nova.
    const { data: rows, error: upErr } = await admin
      .from("announcements")
      .update({
        instagram_last_error: String(error).slice(0, 400),
        instagram_publish_status: state.status,
        instagram_next_attempt_at: state.next_attempt_at,
        instagram_publish_lock_token: null,
        instagram_publish_started_at: null,
      })
      .eq("id", ann.id)
      .eq("instagram_publish_lock_token", lockToken)
      .select("id");
    const affected = Array.isArray(rows) ? rows.length : 0;
    const persisted = !upErr && affected === 1;
    console.error(`[publish-ig][${reqId}] failure`, {
      error: String(error).slice(0, 200),
      attempts,
      status: state.status,
      persisted,
      db_error: upErr?.message ?? null,
      affected,
    });

    if (state.terminal && persisted) {
      const { error: logErr } = await admin.from("admin_logs").insert({
        action: "instagram_publish_failed_permanent",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: {
          attempts,
          error: String(error).slice(0, 400),
          kind: classifyInstagramError(error),
          account_code: ann.synced_account_code ?? null,
        },
      });
      if (logErr) console.error(`[publish-ig][${reqId}] terminal_log_failed`, logErr.message);
    }

    if (!persisted) {
      // Falha ao registrar a falha NUNCA pode ficar silenciosa: alerta técnico
      // por caminho alternativo (admin_logs) + erro explícito ao caller.
      const { error: altErr } = await admin.from("admin_logs").insert({
        action: "instagram_failure_not_persisted",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: {
          attempts,
          error: String(error).slice(0, 400),
          db_error: upErr?.message ?? null,
          affected_rows: affected,
          lock_token_owned: affected === 1,
          request_id: reqId,
        },
      });
      if (altErr) console.error(`[publish-ig][${reqId}] alt_alert_failed`, altErr.message);
      return { persisted: false, reason: upErr?.message ?? (affected === 0 ? "lock_lost" : "unknown") };
    }
    return { persisted: true };
  };

  /** Resposta de falha padronizada: expõe se o estado de falha foi persistido. */
  const failJson = async (error: string, payload: Record<string, unknown>, status: number) => {
    const rec = await recordFailure(error);
    // Se nem o registro de falha foi persistido, ainda tentamos liberar o lock
    // de forma segura (só se ainda somos o dono dele).
    if (!rec.persisted) await releaseLock();
    return json({ ...payload, ok: false, failure_persisted: rec.persisted, failure_persist_error: rec.reason ?? null }, status);
  };

  // -------------------------------------------------------------------------
  // HEARTBEAT DO LEASE: o processamento pode passar de 5 minutos (letterbox de
  // várias imagens + polling de children). Renovar `instagram_publish_started_at`
  // impede que o watchdog considere o worker morto e dispare um segundo worker.
  // -------------------------------------------------------------------------
  const renewInstagramPublishLease = async (): Promise<boolean> => {
    const { data, error } = await admin
      .from("announcements")
      .update({ instagram_publish_started_at: new Date().toISOString() })
      .eq("id", ann.id)
      .eq("instagram_publish_lock_token", lockToken)
      .select("id");
    const ok = !error && Array.isArray(data) && data.length === 1;
    if (!ok) {
      console.error(`[publish-ig][${reqId}] lease_renew_failed`, {
        db_error: error?.message ?? null,
        affected: Array.isArray(data) ? data.length : 0,
      });
    }
    return ok;
  };

  /**
   * Heartbeat OBRIGATÓRIO: se o lease não pode ser renovado (lock perdido para
   * outro worker ou erro de banco), a execução PARA imediatamente — continuar
   * criando containers/publicando arriscaria post duplicado.
   * Retorna a resposta de abandono, ou `null` quando pode seguir.
   */
  const heartbeatOrAbort = async (stage: string): Promise<Response | null> => {
    if (await renewInstagramPublishLease()) return null;
    console.error(`[publish-ig][${reqId}] aborting_lease_lost`, { stage });
    await admin.from("admin_logs").insert({
      action: "instagram_publish_aborted_lease_lost",
      actor_kind: "system",
      target_table: "announcements",
      target_id: ann.id,
      details: { stage, request_id: reqId, attempts },
    });
    // Sem lock não alteramos o estado de ninguém (nem status, nem backoff).
    return json({ ok: true, skipped: true, reason: "lock_lost", stage });
  };

  /** Relê o lock e confirma que ainda podemos executar algo que PUBLICA. */
  const assertStillOwner = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { data, error } = await admin
      .from("announcements")
      .select("instagram_publish_lock_token, instagram_publish_started_at, instagram_post_id")
      .eq("id", ann.id)
      .maybeSingle();
    if (error) return { ok: false, error: `lock_reread_failed:${error.message}`.slice(0, 200) };
    if (data?.instagram_post_id) return { ok: false, error: "already_posted" };
    return canPublishNow({
      lockTokenInDb: data?.instagram_publish_lock_token ?? null,
      myToken: lockToken,
      startedAt: data?.instagram_publish_started_at ?? null,
      now: new Date(),
    });
  };

  // -------------------------------------------------------------------------
  // Recuperação de estado AMBÍGUO: um disparo anterior pode ter publicado na
  // Meta e falhado ao gravar o ID no banco. Enquanto existir pendente NÃO
  // RESOLVIDO, é PROIBIDO cair no fluxo de criação de um post novo.
  // -------------------------------------------------------------------------
  const pendingCreationId = ann.instagram_pending_creation_id ? String(ann.instagram_pending_creation_id) : null;
  const pendingMediaId = ann.instagram_pending_media_id ? String(ann.instagram_pending_media_id) : null;

  // 2. Token + user id (antes das imagens: a recuperação de estado ambíguo
  //    precisa consultar a Meta ANTES de gastar CPU/memória com letterbox).
  const token = await resolveToken(admin);
  if (!token) {
    await recordFailure("token_not_configured");
    return json({ ok: false, error: "token_not_configured" }, 500);
  }
  const meRes = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);
  if (!meRes.ok) {
    const err = await meRes.json().catch(() => ({}));
    await recordFailure(`ig_me_failed: ${JSON.stringify(err).slice(0, 300)}`);
    return json({ ok: false, error: "ig_me_failed", details: err }, 502);
  }
  const meJson = await meRes.json();
  const igUserId = meJson.id;
  const igUsername = meJson.username ? String(meJson.username) : null;

  /** GET normalizado na Graph API: nunca lança, sempre devolve um MetaProbe. */
  const probeGet = async (url: string): Promise<MetaProbe> => {
    try {
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      return r.ok
        ? { kind: "ok", body: (j ?? {}) as Record<string, unknown> }
        : { kind: "http_error", status: r.status, body: j };
    } catch (e) {
      return { kind: "network_error", message: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  };

  /**
   * Registra o media id publicado numa estrutura DURÁVEL de reconciliação.
   * Retorna `true` somente quando o banco confirmou a gravação.
   */
  const recordReconciliation = async (
    mediaId: string,
    creationId: string | null,
    permalink: string | null,
    reason: string,
  ): Promise<boolean> => {
    const { data, error } = await admin
      .from("instagram_publish_reconciliation")
      .upsert(
        {
          announcement_id: ann.id,
          account_code: ann.synced_account_code ?? null,
          media_id: String(mediaId),
          creation_id: creationId,
          permalink,
          reason,
          request_id: reqId,
        },
        { onConflict: "announcement_id,media_id" },
      )
      .select("id");
    if (error) {
      console.error(`[publish-ig][${reqId}] reconciliation_insert_failed`, error.message);
      await admin.from("admin_logs").insert({
        action: "instagram_reconciliation_insert_failed",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: String(mediaId), creation_id: creationId, reason, db_error: error.message, request_id: reqId },
      });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  };

  /** Limpa um pendente SOMENTE com prova terminal — sempre auditado. */
  const clearPending = async (
    which: "creation" | "media",
    reason: string,
  ): Promise<boolean> => {
    const patch = which === "creation"
      ? { instagram_pending_creation_id: null }
      : { instagram_pending_media_id: null };
    const { data, error } = await admin
      .from("announcements")
      .update(patch)
      .eq("id", ann.id)
      .eq("instagram_publish_lock_token", lockToken)
      .select("id");
    const cleared = !error && Array.isArray(data) && data.length === 1;
    await admin.from("admin_logs").insert({
      action: "instagram_pending_cleared",
      actor_kind: "system",
      target_table: "announcements",
      target_id: ann.id,
      details: {
        which,
        reason,
        cleared,
        db_error: error?.message ?? null,
        creation_id: pendingCreationId,
        media_id: pendingMediaId,
        request_id: reqId,
      },
    });
    if (!cleared) console.error(`[publish-ig][${reqId}] clear_pending_failed`, { which, reason, db_error: error?.message ?? null });
    return cleared;
  };

  /**
   * Resolve as linhas ABERTAS da fila durável para o mesmo anúncio/media id.
   * Chamado após persistência final confirmada: o backup deixa de existir.
   */
  const resolveReconciliationBackups = async (
    mediaId: string,
    reason: string,
  ): Promise<{ count: number; error: string | null }> => {
    const { data, error } = await admin
      .from("instagram_publish_reconciliation")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_actor: "system:publish-announcement-to-instagram",
        resolved_reason: reason,
      })
      .eq("announcement_id", ann.id)
      .eq("media_id", String(mediaId))
      .eq("resolved", false)
      .select("id");
    const count = Array.isArray(data) ? data.length : 0;
    if (error || count > 0) {
      await admin.from("admin_logs").insert({
        action: error ? "instagram_reconciliation_backup_resolve_failed" : "instagram_reconciliation_backup_resolved",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: String(mediaId), resolved_rows: count, resolved_reason: reason, db_error: error?.message ?? null, request_id: reqId },
      });
    }
    return { count, error: error?.message ?? null };
  };

  /**
   * Grava o post publicado de forma VERIFICADA: update condicionado ao lock,
   * releitura obrigatória e confirmação do ID. Só responde sucesso se o banco
   * confirmou a persistência.
   */
  const persistPublished = async (
    mediaId: string,
    permalink: string | null,
    warning: string | null,
    resolveReason = "published_persisted_after_reconciliation_backup",
  ): Promise<{ ok: boolean; error?: string }> => {
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      const { error: upErr } = await admin
        .from("announcements")
        .update({
          instagram_post_id: mediaId,
          instagram_permalink: permalink,
          instagram_posted_at: new Date().toISOString(),
          instagram_last_error: null,
          instagram_last_warning: warning,
          instagram_publish_status: warning ? "published_no_video" : "published",
          instagram_next_attempt_at: null,
          instagram_pending_creation_id: null,
          instagram_pending_media_id: null,
          instagram_publish_lock_token: null,
          instagram_publish_started_at: null,
        })
        .eq("id", ann.id)
        .eq("instagram_publish_lock_token", lockToken);
      // Releitura obrigatória: o update pode "não dar erro" e não ter afetado linha.
      const { data: check } = await admin
        .from("announcements")
        .select("instagram_post_id")
        .eq("id", ann.id)
        .maybeSingle();
      if (check?.instagram_post_id === mediaId) {
        // Persistência final confirmada: limpa os backups de reconciliação.
        await resolveReconciliationBackups(mediaId, resolveReason);
        return { ok: true };
      }
      console.error(`[publish-ig][${reqId}] persist_attempt_failed`, {
        try: tryNo,
        db_error: upErr?.message || null,
        read_back: check?.instagram_post_id ?? null,
      });
      await new Promise((r) => setTimeout(r, 400 * tryNo));
    }
    return { ok: false, error: "persist_failed" };
  };

  /**
   * Gravação CONFIRMADA do `instagram_pending_media_id`: condicionada ao lock,
   * erro verificado, exatamente uma linha, valor retornado e releitura com o
   * mesmo valor. Se as 3 tentativas falharem depois de a Meta já ter publicado,
   * o media id vai para a estrutura durável de reconciliação.
   */
  const persistPendingMediaId = async (
    mediaId: string,
    creationId: string | null,
  ): Promise<{ ok: boolean; reconciled: boolean }> => {
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      const { data: rows, error: upErr } = await admin
        .from("announcements")
        .update({ instagram_pending_media_id: String(mediaId) })
        .eq("id", ann.id)
        .eq("instagram_publish_lock_token", lockToken)
        .select("instagram_pending_media_id");
      let confirmed = isWriteConfirmed({
        error: upErr,
        affectedRows: Array.isArray(rows) ? rows.length : 0,
        returnedValue: Array.isArray(rows) ? (rows[0]?.instagram_pending_media_id ?? null) : null,
        expected: String(mediaId),
      });
      if (confirmed) {
        const { data: reread, error: reErr } = await admin
          .from("announcements")
          .select("instagram_pending_media_id")
          .eq("id", ann.id)
          .maybeSingle();
        confirmed = isWriteConfirmed({
          error: reErr,
          affectedRows: 1,
          returnedValue: reread?.instagram_pending_media_id ?? null,
          rereadValue: reread?.instagram_pending_media_id ?? null,
          expected: String(mediaId),
        });
      }
      if (confirmed) return { ok: true, reconciled: false };
      console.error(`[publish-ig][${reqId}] pending_media_persist_attempt_failed`, { try: tryNo, db_error: upErr?.message ?? null });
      await new Promise((r) => setTimeout(r, 300 * tryNo));
    }
    const reconciled = await recordReconciliation(String(mediaId), creationId, null, "pending_media_id_not_persisted");
    if (!reconciled) {
      // Última linha de defesa: nem o anúncio nem a fila durável têm o media id.
      await admin.from("admin_logs").insert({
        action: "instagram_media_id_lost",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: String(mediaId), creation_id: creationId, request_id: reqId, severity: "critical" },
      });
    }
    return { ok: false, reconciled };
  };

  /**
   * Publica um container já existente (ou recém-criado) e finaliza: guarda de
   * lock antes de `media_publish`, gravação confirmada do media id, permalink e
   * persistência final verificada.
   */
  const publishContainerAndFinalize = async (
    parentContainerId: string,
    videoSkippedReason: string | null,
    mediaCount: number,
  ) => {
    // Renovação + releitura do lock IMEDIATAMENTE antes da operação que publica.
    const beat = await heartbeatOrAbort("before_media_publish");
    if (beat) return beat;
    const owner = await assertStillOwner();
    if (!owner.ok) {
      console.warn(`[publish-ig][${reqId}] publish_aborted_lock`, owner.error);
      // Sem lock não alteramos estado de ninguém: apenas devolvemos skip.
      return json({ ok: true, skipped: true, reason: owner.error });
    }

    const pubRes = await fetch(
      `https://graph.instagram.com/${GRAPH}/${igUserId}/media_publish?creation_id=${parentContainerId}&access_token=${token}`,
      { method: "POST" },
    );
    const pubJson = await pubRes.json().catch(() => ({}));
    if (!pubRes.ok || !pubJson.id) {
      return await failJson(`publish_failed: ${JSON.stringify(pubJson).slice(0, 400)}`, { error: "publish_failed", details: pubJson }, 502);
    }
    const mediaId = String(pubJson.id);

    // Grava o media id IMEDIATAMENTE, confirmado por releitura.
    const pending = await persistPendingMediaId(mediaId, String(parentContainerId));
    if (!pending.ok && !pending.reconciled) {
      console.error(`[publish-ig][${reqId}] media_id_unrecorded`, { mediaId });
    }

    // Confirmação pós-publicação tolerante à consistência eventual da Meta.
    // O media_publish já devolveu o ID autoritativo. O GET pode demorar
    // alguns segundos para enxergar o objeto; isso nunca autoriza repost.
    let permalink: string | null = null;
    let mediaVisible = false;
    let lastVisibilityProbe: string | null = null;
    const visibilityDelaysMs = [400, 800, 1200, 2000, 3000, 4500];
    for (let probeAttempt = 0; probeAttempt < visibilityDelaysMs.length; probeAttempt++) {
      const probe = await probeGet(
        `https://graph.instagram.com/${GRAPH}/${mediaId}?fields=id,permalink&access_token=${token}`,
      );
      if (probe.kind === "ok" && String(probe.body?.id ?? "") === mediaId) {
        mediaVisible = true;
        if (probe.body?.permalink) permalink = String(probe.body.permalink);
        break;
      }
      lastVisibilityProbe = probe.kind === "http_error"
        ? `http_${probe.status}`
        : probe.kind === "network_error"
        ? `network:${probe.message}`
        : "id_not_visible";
      await new Promise((r) => setTimeout(r, visibilityDelaysMs[probeAttempt]));
    }
    if (!mediaVisible) {
      await admin.from("admin_logs").insert({
        action: "instagram_post_visibility_delayed",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: mediaId, creation_id: String(parentContainerId), last_probe: lastVisibilityProbe, request_id: reqId },
      });
    }

    const persisted = await persistPublished(mediaId, permalink, videoSkippedReason);
    if (!persisted.ok) {
      await recordReconciliation(mediaId, String(parentContainerId), permalink, "published_but_not_persisted");
      await admin.from("admin_logs").insert({
        action: "instagram_published_but_not_persisted",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: mediaId, creation_id: String(parentContainerId), permalink },
      });
      return json({ ok: false, error: "persist_failed", instagram_post_id: mediaId, permalink }, 500);
    }

    if (permalink && ann.synced_account_id) {
      const { error: accErr } = await admin
        .from("accounts")
        .update({ instagram_link: permalink })
        .eq("id", ann.synced_account_id);
      if (accErr) console.warn(`[publish-ig][${reqId}] account_permalink_sync_failed`, accErr.message);
    }

    return json({
      ok: true,
      instagram_post_id: mediaId,
      permalink,
      media_count: mediaCount,
      video_skipped_reason: videoSkippedReason,
      warning: videoSkippedReason,
    });
  };

  // --------------- ESTADO 0: fila DURÁVEL de reconciliação ------------------
  // Antes de qualquer decisão, consome `instagram_publish_reconciliation`:
  // um media id já publicado na Meta que não conseguiu ser gravado no anúncio.
  // Só adota o media id quando a Meta confirma que ele existe E pertence à
  // conta atual. Nunca cria post novo por causa desta fila.
  {
    const { data: openRows, error: openErr } = await admin
      .from("instagram_publish_reconciliation")
      .select("id, media_id, creation_id, permalink, reason")
      .eq("announcement_id", ann.id)
      .eq("resolved", false)
      .order("created_at", { ascending: true })
      .limit(10);
    if (openErr) {
      console.error(`[publish-ig][${reqId}] reconciliation_read_failed`, openErr.message);
      return await failJson("reconciliation_read_failed", { error: "reconciliation_read_failed" }, 409);
    }
    for (const rec of openRows ?? []) {
      const mediaId = String(rec.media_id);
      const probe = await probeGet(
        `https://graph.instagram.com/${GRAPH}/${mediaId}?fields=id,permalink,username&access_token=${token}`,
      );
      // Adoção EXIGE confirmação positiva do proprietário: sem `username` da
      // media ou da conta atual o caso é ambíguo (reagenda, não descarta).
      const decision = decideReconciliationAction(mediaId, probe, igUsername);
      console.log(`[publish-ig][${reqId}] reconciliation_decision`, { mediaId, action: decision.action });

      if (decision.action === "adopt") {
        const permalink = decision.permalink ?? (rec.permalink ? String(rec.permalink) : null);
        const persisted = await persistPublished(mediaId, permalink, null, "adopted_media_id_confirmed_by_meta");
        if (!persisted.ok) {
          return await failJson("reconciliation_persist_failed", { error: "reconciliation_persist_failed", instagram_post_id: mediaId }, 500);
        }
        // `persistPublished` já resolve os backups; a resolução DESTA linha é
        // obrigatoriamente verificada por releitura.
        const { data: recheck } = await admin
          .from("instagram_publish_reconciliation")
          .select("resolved")
          .eq("id", rec.id)
          .maybeSingle();
        if (recheck?.resolved !== true) {
          await admin.from("admin_logs").insert({
            action: "reconciliation_resolution_unconfirmed",
            actor_kind: "system",
            target_table: "instagram_publish_reconciliation",
            target_id: rec.id,
            details: { media_id: mediaId, stage: "adopt", request_id: reqId },
          });
          return await failJson("reconciliation_resolution_unconfirmed", { error: "reconciliation_resolution_unconfirmed", instagram_post_id: mediaId }, 409);
        }
        await admin.from("admin_logs").insert({
          action: "instagram_reconciliation_resolved",
          actor_kind: "system",
          target_table: "announcements",
          target_id: ann.id,
          details: { media_id: mediaId, permalink, reason: rec.reason, request_id: reqId },
        });
        return json({ ok: true, recovered: true, recovery: "reconciliation_queue", instagram_post_id: mediaId, permalink });
      }

      if (decision.action === "reschedule") {
        // Ambíguo: NÃO publica, NÃO descarta a pendência.
        return await failJson(decision.error, { error: "reconciliation_ambiguous", detail: decision.error }, 409);
      }

      // Prova terminal de que o media id não existe / não é desta conta.
      const ownerMismatch = decision.reason === "discarded_owner_mismatch";
      const { data: discarded, error: discardErr } = await admin
        .from("instagram_publish_reconciliation")
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolved_actor: "system:publish-announcement-to-instagram",
          resolved_reason: ownerMismatch ? "discarded_owner_mismatch" : "discarded_media_not_found",
        })
        .eq("id", rec.id)
        .eq("resolved", false)
        .select("id");
      if (discardErr || !Array.isArray(discarded) || discarded.length !== 1) {
        await admin.from("admin_logs").insert({
          action: "reconciliation_resolution_unconfirmed",
          actor_kind: "system",
          target_table: "instagram_publish_reconciliation",
          target_id: rec.id,
          details: { media_id: mediaId, stage: "discard", rows: Array.isArray(discarded) ? discarded.length : 0, db_error: discardErr?.message ?? null, request_id: reqId },
        });
        return await failJson("reconciliation_resolution_unconfirmed", { error: "reconciliation_resolution_unconfirmed" }, 409);
      }
      await admin.from("admin_logs").insert({
        action: "instagram_reconciliation_discarded",
        actor_kind: "system",
        target_table: "announcements",
        target_id: ann.id,
        details: { media_id: mediaId, owner_mismatch: ownerMismatch, reason: rec.reason, request_id: reqId },
      });
    }

    // Nada prossegue enquanto RESTAR qualquer reconciliação aberta (ex.: mais
    // de 10 linhas na fila). Criar container novo aqui geraria post duplicado.
    const { count: stillOpen, error: countErr } = await admin
      .from("instagram_publish_reconciliation")
      .select("id", { count: "exact", head: true })
      .eq("announcement_id", ann.id)
      .eq("resolved", false);
    if (countErr) {
      return await failJson("reconciliation_read_failed", { error: "reconciliation_read_failed" }, 409);
    }
    if (shouldBlockForOpenReconciliation(stillOpen)) {
      console.warn(`[publish-ig][${reqId}] reconciliation_still_open`, { open: stillOpen });
      return await failJson("reconciliation_still_open", { error: "reconciliation_still_open", open: stillOpen }, 409);
    }
  }

  // ------------------------------ ESTADO 1: pending_media_id ----------------
  if (pendingMediaId) {
    const probe = await probeGet(
      `https://graph.instagram.com/${GRAPH}/${pendingMediaId}?fields=id,permalink&access_token=${token}`,
    );
    const decision = decidePendingMediaAction(pendingMediaId, probe);
    console.log(`[publish-ig][${reqId}] pending_media_decision`, { pendingMediaId, action: decision.action });
    if (decision.action === "persist") {
      const persisted = await persistPublished(decision.mediaId, decision.permalink, null);
      if (persisted.ok) {
        return json({ ok: true, recovered: true, recovery: "pending_media_id", instagram_post_id: decision.mediaId, permalink: decision.permalink });
      }
      await recordReconciliation(decision.mediaId, pendingCreationId, decision.permalink, "persist_failed_after_recovery");
      return await failJson("persist_failed_after_recovery", { error: "persist_failed_after_recovery" }, 500);
    }
    if (decision.action === "reschedule") {
      // Estado AMBÍGUO: reagenda sem publicar nada.
      return await failJson(decision.error, { error: "pending_media_ambiguous", detail: decision.error }, 409);
    }
    // invalidate: prova terminal de que o ID não existe / não é nosso.
    if (!await clearPending("media", decision.reason)) {
      // Sem confirmação da limpeza NÃO seguimos: um pendente fantasma poderia
      // ressuscitar depois e gerar post duplicado.
      return await failJson("pending_media_clear_unconfirmed", { error: "pending_media_clear_unconfirmed" }, 409);
    }
  }

  // ---------------------------- ESTADO 2: pending_creation_id ---------------
  if (pendingCreationId) {
    const probe = await probeGet(
      `https://graph.instagram.com/${GRAPH}/${pendingCreationId}?fields=status_code&access_token=${token}`,
    );
    const decision = decidePendingCreationAction(probe);
    console.log(`[publish-ig][${reqId}] pending_creation_decision`, { pendingCreationId, action: decision.action });

    if (decision.action === "reschedule") {
      return await failJson(decision.error, { error: "pending_creation_ambiguous", detail: decision.error }, 409);
    }

    if (decision.action === "recover_media") {
      const mr = await probeGet(
        `https://graph.instagram.com/${GRAPH}/me/media?fields=id,permalink,timestamp,caption&limit=25&access_token=${token}`,
      );
      if (mr.kind !== "ok") {
        return await failJson("recovery_media_list_failed", { error: "recovery_media_list_failed" }, 409);
      }
      const list = Array.isArray((mr.body as { data?: unknown }).data) ? ((mr.body as { data: unknown[] }).data as never[]) : [];
      const outcome = pickRecoveryCandidate(list, {
        adCode: ann.synced_account_code ?? (ann.id ? String(ann.id).slice(0, 8) : null),
        startedAt: ann.instagram_publish_started_at ?? null,
        now: new Date(),
      });
      console.log(`[publish-ig][${reqId}] recovery_outcome`, outcome.kind);
      if (outcome.kind === "single") {
        const persisted = await persistPublished(
          String(outcome.media.id),
          outcome.media.permalink ? String(outcome.media.permalink) : null,
          null,
        );
        if (persisted.ok) {
          return json({ ok: true, recovered: true, recovery: "caption_match", instagram_post_id: String(outcome.media.id), permalink: outcome.media.permalink ?? null });
        }
        await recordReconciliation(String(outcome.media.id), pendingCreationId, outcome.media.permalink ? String(outcome.media.permalink) : null, "persist_failed_after_recovery");
        return await failJson("persist_failed_after_recovery", { error: "persist_failed_after_recovery" }, 500);
      }
      if (outcome.kind === "ambiguous") {
        await admin.from("admin_logs").insert({
          action: "instagram_recovery_ambiguous",
          actor_kind: "system",
          target_table: "announcements",
          target_id: ann.id,
          details: { candidates: outcome.count, creation_id: pendingCreationId, account_code: ann.synced_account_code ?? null },
        });
        return await failJson("recovery_ambiguous", { error: "recovery_ambiguous" }, 409);
      }
      // Container PUBLISHED e nenhum candidato inequívoco: NUNCA republica.
      return await failJson("recovery_no_candidate", { error: "recovery_no_candidate" }, 409);
    }

    if (decision.action === "republish_same_container") {
      // Container pronto e ainda não publicado: reaproveita o MESMO creation_id.
      console.log(`[publish-ig][${reqId}] reusing_container`, { pendingCreationId });
      return await publishContainerAndFinalize(pendingCreationId, null, 0);
    }

    // clear_pending: ERROR / EXPIRED / inexistente — limpa auditado e segue.
    if (!await clearPending("creation", decision.reason)) {
      return await failJson("pending_creation_clear_unconfirmed", { error: "pending_creation_clear_unconfirmed" }, 409);
    }
  }

  const images: string[] = Array.isArray(ann.images)
    ? ann.images.filter((u: unknown) => typeof u === "string" && u.startsWith("http"))
    : [];
  if (images.length === 0) {
    await recordFailure("no_images");
    return json({ ok: false, error: "no_images" }, 400);
  }

  // Reordena para que a capa venha primeiro (Instagram mostra a primeira imagem na grade).
  const coverIdx = Number.isInteger(ann.cover_image_index) && ann.cover_image_index! >= 0 && ann.cover_image_index! < images.length
    ? ann.cover_image_index!
    : 0;
  const orderedImages = coverIdx === 0
    ? images
    : [images[coverIdx], ...images.slice(0, coverIdx), ...images.slice(coverIdx + 1)];

  // Vídeo (sem áudio) entra como ÚLTIMO item do carrossel.
  // Se houver vídeo ainda em processamento, aguardamos: nunca publicamos
  // as fotos sozinhas enquanto o vídeo elegível está sendo preparado.
  const IG_VIDEO_MAX_SEC = 60;
  const videoStatus = String(ann.video_status ?? "").trim().toLowerCase();
  if (["pending", "queued", "processing"].includes(videoStatus)) {
    return await failJson(
      `video_not_ready:${videoStatus}`,
      { error: "video_not_ready", video_status: videoStatus },
      409,
    );
  }
  const videoUrl = videoStatus === "ready" && ann.video_muted_url ? String(ann.video_muted_url) : null;
  const videoDuration = Number(ann.video_duration_sec);
  let videoSkippedReason: string | null =
    videoUrl && Number.isFinite(videoDuration) && videoDuration > IG_VIDEO_MAX_SEC
      ? `video_duration_exceeds_instagram_carousel_limit:${videoDuration}s`
      : null;
  const useVideo = !!videoUrl && !videoSkippedReason;

  // Gera versões recortadas apenas para o Instagram (marketplace mantém as originais).
  // SERIAL: processar em paralelo estourava a memória do worker.
  const slice = orderedImages.slice(0, useVideo ? 9 : 10);
  const adjustedResults: ImagePrepResult[] = [];
  for (let i = 0; i < slice.length; i++) {
    adjustedResults.push(await letterboxForInstagram(admin, ann.id, i, slice[i]));
    // Heartbeat durante a preparação (etapa mais lenta do fluxo).
    const beat = await heartbeatOrAbort(`instagram_crop_${i}`);
    if (beat) return beat;
  }
  const resolvedImages = resolveIgImageUrls(slice, adjustedResults);
  if (!resolvedImages.ok) {
    await recordFailure(resolvedImages.error);
    return json({ ok: false, error: "image_prepare_failed", details: resolvedImages.error }, 422);
  }
  const igImages: string[] = resolvedImages.urls;
  console.log(`[publish-ig][${reqId}] media_ready`, { images: igImages.length, use_video: useVideo });
  {
    // Heartbeat após preparar as imagens.
    const beat = await heartbeatOrAbort("media_ready");
    if (beat) return beat;
  }

  // Preço público da vitrine (com comissão) vem da conta do catálogo.
  let publicPrice: number | null = null;
  if (ann.synced_account_code) {
    const { data: acc } = await admin
      .from("accounts")
      .select("price")
      .eq("code", ann.synced_account_code)
      .maybeSingle();
    if (acc?.price != null) publicPrice = Number(acc.price);
  }
  const caption = buildCaption(ann, categoryName, offerTypeName, ann.offer_detail_type ? String(ann.offer_detail_type) : null, publicPrice);

  try {
    let parentContainerId: string;

    if (igImages.length === 1 && !useVideo) {
      const p = new URLSearchParams();
      p.set("image_url", igImages[0]);
      p.set("caption", caption);
      p.set("access_token", token);
      const r = await fetch(`https://graph.instagram.com/${GRAPH}/${igUserId}/media`, { method: "POST", body: p });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) {
        await recordFailure(`container_failed: ${JSON.stringify(j).slice(0, 400)}`);
        return json({ ok: false, error: "container_failed", details: j }, 502);
      }
      parentContainerId = j.id;
      const ready = await waitContainerReady(parentContainerId, token);
      const beat = await heartbeatOrAbort("single_container_ready");
      if (beat) return beat;
      if (!ready.ok) {
        await recordFailure(String(ready.error ?? "container_not_ready"));
        return json({ ok: false, error: "container_not_ready", details: ready }, 502);
      }
    } else {
      // Carrossel: cria children isolados e depois o container pai.
      const childIds: string[] = [];
      for (const url of igImages) {
        const p = new URLSearchParams();
        p.set("image_url", url);
        p.set("is_carousel_item", "true");
        p.set("access_token", token);
        const r = await fetch(`https://graph.instagram.com/${GRAPH}/${igUserId}/media`, { method: "POST", body: p });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) {
          await recordFailure(`child_failed: ${JSON.stringify(j).slice(0, 400)}`);
          return json({ ok: false, error: "child_failed", details: j }, 502);
        }
        childIds.push(j.id);
        // Heartbeat durante o processamento dos children.
        const beat = await heartbeatOrAbort("child_created");
        if (beat) return beat;
      }
      if (useVideo && videoUrl) {
        const pv = new URLSearchParams();
        pv.set("media_type", "VIDEO");
        pv.set("video_url", videoUrl);
        pv.set("is_carousel_item", "true");
        pv.set("access_token", token);
        const rv = await fetch(`https://graph.instagram.com/${GRAPH}/${igUserId}/media`, { method: "POST", body: pv });
        const jv = await rv.json().catch(() => ({}));
        if (!rv.ok || !jv?.id) {
          const detail = JSON.stringify(jv).slice(0, 300);
          return await failJson(`video_child_rejected:${detail}`, { error: "video_child_rejected", details: jv }, 502);
        }
        childIds.push(jv.id);
      }
      const videoChildId = useVideo && videoUrl ? childIds[childIds.length - 1] : null;
      const readyChildren: string[] = [];
      for (const cid of childIds) {
        const ready = await waitContainerReady(cid, token);
        const beat = await heartbeatOrAbort("child_poll");
        if (beat) return beat;
        if (ready.ok) { readyChildren.push(cid); continue; }
        if (cid === videoChildId) {
          return await failJson(
            `video_child_not_ready:${String(ready.error).slice(0, 200)}`,
            { error: "video_child_not_ready", details: ready },
            502,
          );
        }
        await recordFailure(`child_not_ready: ${ready.error}`);
        return json({ ok: false, error: "child_not_ready", details: ready }, 502);
      }
      childIds.length = 0;
      childIds.push(...readyChildren);
      if (childIds.length === 0) {
        await recordFailure("no_ready_children");
        return json({ ok: false, error: "no_ready_children" }, 502);
      }

      if (childIds.length === 1) {
        return await failJson(
          "carousel_requires_two_ready_items",
          { error: "carousel_requires_two_ready_items" },
          502,
        );
      } else {
        {
          // Heartbeat antes de criar o container pai.
          const beat = await heartbeatOrAbort("before_parent_container");
          if (beat) return beat;
        }
        const parentParams = new URLSearchParams();
        parentParams.set("media_type", "CAROUSEL");
        parentParams.set("children", childIds.join(","));
        parentParams.set("caption", caption);
        parentParams.set("access_token", token);
        const rp = await fetch(`https://graph.instagram.com/${GRAPH}/${igUserId}/media`, { method: "POST", body: parentParams });
        const jp = await rp.json().catch(() => ({}));
        if (!rp.ok || !jp.id) {
          await recordFailure(`parent_failed: ${JSON.stringify(jp).slice(0, 400)}`);
          return json({ ok: false, error: "parent_failed", details: jp }, 502);
        }
        parentContainerId = jp.id;
        const readyParent = await waitContainerReady(parentContainerId, token);
        const beat = await heartbeatOrAbort("parent_container_ready");
        if (beat) return beat;
        if (!readyParent.ok) {
          await recordFailure(String(readyParent.error ?? "parent_not_ready"));
          return json({ ok: false, error: "parent_not_ready", details: readyParent }, 502);
        }
      }
    }

    // 3. Registra o creation_id ANTES de publicar, de forma CONFIRMADA: update
    // condicionado ao lock atual + verificação de erro + linha retornada +
    // releitura com o mesmo valor. Sem confirmação NÃO publicamos.
    {
      const { data: rows, error: upErr } = await admin
        .from("announcements")
        .update({ instagram_pending_creation_id: String(parentContainerId) })
        .eq("id", ann.id)
        .eq("instagram_publish_lock_token", lockToken)
        .select("id, instagram_pending_creation_id");
      const updated = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
      let confirmed = isWriteConfirmed({
        error: upErr,
        affectedRows: Array.isArray(rows) ? rows.length : 0,
        returnedValue: updated?.instagram_pending_creation_id ?? null,
        expected: String(parentContainerId),
      });
      if (confirmed) {
        const { data: reread, error: reErr } = await admin
          .from("announcements")
          .select("instagram_pending_creation_id")
          .eq("id", ann.id)
          .maybeSingle();
        confirmed = isWriteConfirmed({
          error: reErr,
          affectedRows: 1,
          returnedValue: reread?.instagram_pending_creation_id ?? null,
          rereadValue: reread?.instagram_pending_creation_id ?? null,
          expected: String(parentContainerId),
        });
      }
      if (!confirmed) {
        console.error(`[publish-ig][${reqId}] creation_id_not_confirmed`, {
          db_error: upErr?.message ?? null,
          affected: Array.isArray(rows) ? rows.length : 0,
        });
        return await failJson(
          "creation_id_persist_failed",
          { error: "creation_id_persist_failed", creation_id: String(parentContainerId) },
          503,
        );
      }
    }

    return await publishContainerAndFinalize(
      String(parentContainerId),
      videoSkippedReason,
      igImages.length + (useVideo && !videoSkippedReason ? 1 : 0),
    );
  } catch (e: any) {
    const msg = (e?.message || "unknown").slice(0, 400);
    console.error("[publish-announcement-to-instagram] fatal:", e);
    await recordFailure(`fatal: ${msg}`);
    return json({ ok: false, error: "fatal", message: msg }, 500);
  }
});