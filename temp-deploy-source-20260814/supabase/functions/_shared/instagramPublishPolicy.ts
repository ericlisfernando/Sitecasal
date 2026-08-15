// ============================================================================
// instagramPublishPolicy — decisões PURAS (sem I/O) da publicação no Instagram.
// Existe separado da Edge Function para permitir teste unitário real dos
// cenários de falha (retry, erro permanente, letterbox, limite de tentativas).
// ============================================================================

export type IgErrorKind = "transient" | "permanent";

/** Tentativas máximas antes de virar falha terminal (alinhado ao watchdog SQL). */
export const IG_MAX_ATTEMPTS = 8;

/** TTL do lock de publicação. DEVE ser igual ao intervalo usado no watchdog SQL. */
export const IG_LOCK_TTL_MS = 5 * 60_000;

/** Backoff em minutos, indexado pelas tentativas já realizadas. */
export const IG_BACKOFF_MINUTES: readonly number[] = [5, 15, 45, 120, 240, 480, 720];

/** Versão da Graph API — configurável por env, nunca trocada às cegas. */
export const IG_DEFAULT_GRAPH_VERSION = "v21.0";

export function igGraphVersion(raw?: string | null): string {
  const v = String(raw ?? "").trim();
  return /^v\d{1,2}\.\d$/.test(v) ? v : IG_DEFAULT_GRAPH_VERSION;
}

/**
 * Erros PERMANENTES: repetir a cada 5 minutos não resolve — exige correção de
 * conteúdo, de credencial ou de configuração.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /no_images/i,
  /image_prepare_failed/i,
  /token_not_configured/i,
  /guard_denied/i,
  /not_published/i,
  /invalid_/i,
  /oauth/i,
  /"code"\s*:\s*190/,
  /"code"\s*:\s*100/,
  /"code"\s*:\s*200/,
  /aspect ratio/i,
  /unsupported/i,
  /permission/i,
];

/** Erros TRANSITÓRIOS explícitos (rede, throttle, indisponibilidade). */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /network/i,
  /status_timeout/i,
  /WORKER_RESOURCE_LIMIT/i,
  /http_(408|429|5\d{2})/i,
  /"code"\s*:\s*(1|2|4|17|32|613)\b/,
  /rate limit/i,
  /temporar/i,
  /persist_failed/i,
  /load_failed/i,
  /dispatch_/i,
];

export function classifyInstagramError(error: string | null | undefined): IgErrorKind {
  const e = String(error ?? "").trim();
  if (!e) return "transient";
  for (const re of TRANSIENT_PATTERNS) if (re.test(e)) return "transient";
  for (const re of PERMANENT_PATTERNS) if (re.test(e)) return "permanent";
  // Desconhecido → transitório conservador (nunca desiste em silêncio).
  return "transient";
}

/**
 * Próxima tentativa. `null` = não deve haver retry (erro permanente ou
 * tentativas esgotadas) → o caller marca falha terminal e alerta o admin.
 */
export function nextInstagramAttemptAt(
  attempts: number,
  error: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (classifyInstagramError(error) === "permanent") return null;
  const done = Math.max(0, Math.floor(attempts));
  if (done >= IG_MAX_ATTEMPTS) return null;
  const idx = Math.min(done > 0 ? done - 1 : 0, IG_BACKOFF_MINUTES.length - 1);
  return new Date(now.getTime() + IG_BACKOFF_MINUTES[idx] * 60_000);
}

export type IgPublishStatus =
  | "pending"
  | "publishing"
  | "published"
  | "published_no_video"
  | "failed"
  | "failed_permanent";

/** Estado de falha a persistir no anúncio. */
export function failureState(
  attempts: number,
  error: string,
  now: Date = new Date(),
): { status: IgPublishStatus; next_attempt_at: string | null; terminal: boolean } {
  const next = nextInstagramAttemptAt(attempts, error, now);
  return next
    ? { status: "failed", next_attempt_at: next.toISOString(), terminal: false }
    : { status: "failed_permanent", next_attempt_at: null, terminal: true };
}

// ---------------------------------------------------------------------------
// Preparação de imagem (letterbox)
// ---------------------------------------------------------------------------

export type ImagePrepResult =
  | { kind: "original_safe" }
  | { kind: "adjusted"; url: string }
  | { kind: "prepare_failed"; reason: string };

/**
 * Resolve as URLs finais enviadas ao Instagram. Se QUALQUER imagem que precisava
 * de ajuste falhou na preparação, NÃO enviamos a original incompatível — a
 * publicação falha com `image_prepare_failed` (erro permanente).
 */
export function resolveIgImageUrls(
  sourceUrls: string[],
  results: ImagePrepResult[],
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const urls: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < sourceUrls.length; i++) {
    const r = results[i];
    if (!r) { failures.push(`${i}:missing_result`); continue; }
    if (r.kind === "adjusted") urls.push(r.url);
    else if (r.kind === "original_safe") urls.push(sourceUrls[i]);
    else failures.push(`${i}:${r.reason}`);
  }
  if (failures.length > 0) {
    return { ok: false, error: `image_prepare_failed: ${failures.join(", ")}`.slice(0, 300) };
  }
  return { ok: true, urls };
}

/** Um lock ainda é válido? Mesma regra do watchdog SQL (5 minutos). */
export function isLockHeld(
  lockToken: string | null | undefined,
  startedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lockToken || !startedAt) return false;
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < IG_LOCK_TTL_MS;
}

/**
 * O worker atual ainda é o dono do lock? Qualquer mudança de estado (falha,
 * liberação de lock, reagendamento) só pode ocorrer se isto for verdadeiro —
 * um worker antigo NÃO pode sobrescrever a execução mais nova.
 */
export function ownsLock(
  currentTokenInDb: string | null | undefined,
  myToken: string,
): boolean {
  return !!currentTokenInDb && !!myToken && currentTokenInDb === myToken;
}

/**
 * Uma gravação só é considerada CONFIRMADA quando: não houve erro, exatamente
 * uma linha foi afetada (lock nosso), o valor retornado é o esperado e a
 * releitura devolve o mesmo valor. Usado para `instagram_pending_creation_id`,
 * `instagram_pending_media_id` e para a persistência final.
 */
export function isWriteConfirmed(args: {
  error?: unknown;
  affectedRows: number;
  returnedValue?: string | null;
  rereadValue?: string | null;
  expected: string;
}): boolean {
  if (args.error) return false;
  if (args.affectedRows !== 1) return false;
  if (args.returnedValue !== args.expected) return false;
  if (args.rereadValue !== undefined && args.rereadValue !== args.expected) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Recuperação inequívoca de post publicado
// ---------------------------------------------------------------------------

export type IgMediaCandidate = {
  id: string;
  permalink?: string | null;
  caption?: string | null;
  timestamp?: string | null;
};

export type RecoveryOutcome =
  | { kind: "none" }
  | { kind: "single"; media: IgMediaCandidate }
  | { kind: "ambiguous"; count: number };

/** Janela temporal máxima aceita para considerar um post como sendo desta execução. */
export const IG_RECOVERY_WINDOW_MS = 30 * 60_000;

/** Tolerância antes do início da tentativa (relógios não são perfeitamente iguais). */
export const IG_RECOVERY_BACKWARD_TOLERANCE_MS = 5 * 60_000;

/**
 * Janela [floor, ceil] em que um post pode ter sido criado por ESTA tentativa.
 * Com `startedAt` conhecido, o teto é `startedAt + IG_RECOVERY_WINDOW_MS` — nunca
 * `now + 5min`: se a tentativa começou horas atrás, posts feitos depois (mesmo
 * com o mesmo código na legenda) NÃO pertencem a ela.
 */
export function recoveryWindow(
  startedAt: string | null | undefined,
  now: Date = new Date(),
): { floor: number; ceil: number } {
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
  if (Number.isFinite(startedMs)) {
    return {
      floor: startedMs - IG_RECOVERY_BACKWARD_TOLERANCE_MS,
      ceil: startedMs + IG_RECOVERY_WINDOW_MS,
    };
  }
  return {
    floor: now.getTime() - IG_RECOVERY_WINDOW_MS,
    ceil: now.getTime() + IG_RECOVERY_BACKWARD_TOLERANCE_MS,
  };
}

/**
 * Escolhe, entre os posts recentes da conta, o ÚNICO que comprovadamente
 * pertence a este anúncio. Nunca usa "o post mais recente": exige assinatura
 * na legenda (código do anúncio) e janela temporal. Zero candidatos → `none`.
 * Mais de um candidato → `ambiguous` (recuperação recusada).
 */
export function pickRecoveryCandidate(
  candidates: IgMediaCandidate[],
  opts: { adCode?: string | null; startedAt?: string | null; now?: Date },
): RecoveryOutcome {
  const code = String(opts.adCode ?? "").trim().toUpperCase();
  if (!code) return { kind: "none" };
  const now = opts.now ?? new Date();
  const { floor, ceil } = recoveryWindow(opts.startedAt, now);

  const matches = (candidates || []).filter((c) => {
    if (!c?.id) return false;
    const caption = String(c.caption ?? "").toUpperCase();
    if (!caption.includes(code)) return false;
    const t = c.timestamp ? new Date(c.timestamp).getTime() : NaN;
    if (!Number.isFinite(t)) return false;
    return t >= floor && t <= ceil;
  });

  if (matches.length === 0) return { kind: "none" };
  const unique = Array.from(new Set(matches.map((m) => m.id)));
  if (unique.length > 1) return { kind: "ambiguous", count: unique.length };
  return { kind: "single", media: matches[0] };
}

// ---------------------------------------------------------------------------
// Rótulos de estado (compartilhado backend/frontend para não divergirem)
// ---------------------------------------------------------------------------

export type IgStateKey =
  | "published"
  | "published_no_video"
  | "publishing"
  | "retry_scheduled"
  | "failed_permanent"
  | "failed"
  | "pending";

/**
 * Estado REAL exibido ao admin. Publicado somente quando existe post id.
 * `failed` com próxima tentativa agendada é "retentativa agendada";
 * `failed_permanent` NUNCA cai em "aguardando".
 */
export function resolveIgStateKey(row: {
  instagram_post_id?: string | null;
  instagram_publish_status?: string | null;
  instagram_next_attempt_at?: string | null;
}): IgStateKey {
  if (row.instagram_post_id) {
    return String(row.instagram_publish_status) === "published_no_video"
      ? "published_no_video"
      : "published";
  }
  const raw = String(row.instagram_publish_status ?? "").trim();
  if (raw === "failed_permanent") return "failed_permanent";
  if (raw === "failed" || raw === "retry_scheduled") {
    return row.instagram_next_attempt_at ? "retry_scheduled" : "failed";
  }
  if (raw === "publishing") return "publishing";
  return "pending";
}
// ---------------------------------------------------------------------------
// Máquina de estados dos PENDENTES (nunca iniciar post novo com estado aberto)
// ---------------------------------------------------------------------------

/** Resultado bruto de uma consulta à Meta, já normalizado (sem I/O aqui). */
export type MetaProbe =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "http_error"; status: number; body?: unknown }
  | { kind: "network_error"; message: string };

/** Códigos de erro da Meta que provam TERMINALMENTE que o objeto não existe. */
const META_UNKNOWN_OBJECT_CODES = new Set([24, 100, 803]);

function metaErrorCode(body: unknown): number | null {
  const err = (body as { error?: { code?: unknown } } | null | undefined)?.error;
  const code = Number(err?.code);
  return Number.isFinite(code) ? code : null;
}

export type PendingMediaDecision =
  | { action: "persist"; mediaId: string; permalink: string | null }
  | { action: "reschedule"; error: string }
  | { action: "invalidate"; reason: string };

/**
 * Decide o que fazer quando existe `instagram_pending_media_id`.
 * NUNCA autoriza criar post novo: no máximo invalida o pendente quando há PROVA
 * TERMINAL de que o ID não existe ou não pertence à conta.
 */
export function decidePendingMediaAction(
  pendingMediaId: string,
  probe: MetaProbe,
): PendingMediaDecision {
  if (probe.kind === "network_error") {
    return { action: "reschedule", error: `pending_media_probe_network: ${probe.message}`.slice(0, 200) };
  }
  if (probe.kind === "http_error") {
    const code = metaErrorCode(probe.body);
    const notFound = probe.status === 404
      || ((probe.status === 400 || probe.status === 403) && code !== null && META_UNKNOWN_OBJECT_CODES.has(code));
    if (notFound) return { action: "invalidate", reason: `pending_media_not_found:http_${probe.status}` };
    // 5xx, 429, 408, 401/190, permissão, qualquer outro → AMBÍGUO.
    return { action: "reschedule", error: `pending_media_probe_http_${probe.status}` };
  }
  const id = probe.body?.id != null ? String(probe.body.id) : null;
  if (!id) return { action: "reschedule", error: "pending_media_probe_inconclusive" };
  if (id !== pendingMediaId) return { action: "invalidate", reason: "pending_media_id_mismatch" };
  const permalink = probe.body?.permalink != null ? String(probe.body.permalink) : null;
  return { action: "persist", mediaId: pendingMediaId, permalink };
}

export type PendingCreationDecision =
  | { action: "recover_media"; statusCode: "PUBLISHED" }
  | { action: "republish_same_container"; statusCode: "FINISHED" }
  | { action: "reschedule"; error: string }
  | { action: "clear_pending"; reason: string; statusCode: string };

/**
 * Decide o que fazer quando existe `instagram_pending_creation_id`.
 * - PUBLISHED  → recuperar o media id (nunca criar outro post);
 * - FINISHED   → repetir `media_publish` com o MESMO creation_id;
 * - IN_PROGRESS→ reagendar;
 * - ERROR/EXPIRED → limpar o pendente de forma auditada (aí sim nova tentativa);
 * - falha/timeout/5xx/desconhecido → estado AMBÍGUO → reagendar.
 */
export function decidePendingCreationAction(probe: MetaProbe): PendingCreationDecision {
  if (probe.kind === "network_error") {
    return { action: "reschedule", error: `pending_creation_probe_network: ${probe.message}`.slice(0, 200) };
  }
  if (probe.kind === "http_error") {
    const code = metaErrorCode(probe.body);
    if (probe.status === 404 || ((probe.status === 400 || probe.status === 403) && code !== null && META_UNKNOWN_OBJECT_CODES.has(code))) {
      // Container inexistente/expirado do lado da Meta: prova terminal.
      return { action: "clear_pending", reason: `pending_creation_not_found:http_${probe.status}`, statusCode: "NOT_FOUND" };
    }
    return { action: "reschedule", error: `pending_creation_probe_http_${probe.status}` };
  }
  const status = String(probe.body?.status_code ?? "").toUpperCase();
  if (status === "PUBLISHED") return { action: "recover_media", statusCode: "PUBLISHED" };
  if (status === "FINISHED") return { action: "republish_same_container", statusCode: "FINISHED" };
  if (status === "IN_PROGRESS") return { action: "reschedule", error: "pending_creation_in_progress" };
  if (status === "ERROR" || status === "EXPIRED") {
    return { action: "clear_pending", reason: `pending_creation_${status.toLowerCase()}`, statusCode: status };
  }
  // Resposta sem status_code / valor desconhecido → ambíguo.
  return { action: "reschedule", error: `pending_creation_unknown_status:${status || "empty"}` };
}

/**
 * Guarda final antes de QUALQUER chamada capaz de publicar: só segue se o token
 * relido do banco ainda é o nosso e o lease continua dentro do TTL.
 */
export function canPublishNow(args: {
  lockTokenInDb: string | null | undefined;
  myToken: string;
  startedAt: string | null | undefined;
  now?: Date;
}): { ok: true } | { ok: false; error: string } {
  const now = args.now ?? new Date();
  if (!ownsLock(args.lockTokenInDb, args.myToken)) return { ok: false, error: "lock_lost" };
  if (!isLockHeld(args.lockTokenInDb, args.startedAt, now)) return { ok: false, error: "lease_expired" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Confirmação POSITIVA do proprietário do media (fila de reconciliação)
// ---------------------------------------------------------------------------

export type OwnerCheck =
  | { confirmed: true }
  | { confirmed: false; reason: "owner_mismatch" | "owner_unknown" };

/**
 * Só existe confirmação quando AMBOS os nomes estão presentes e iguais
 * (case-insensitive). Ausência de qualquer lado é INCONCLUSIVA — nunca adoção.
 */
export function checkMediaOwner(
  owner: string | null | undefined,
  currentUsername: string | null | undefined,
): OwnerCheck {
  const a = String(owner ?? "").trim();
  const b = String(currentUsername ?? "").trim();
  if (!a || !b) return { confirmed: false, reason: "owner_unknown" };
  if (a.toLowerCase() !== b.toLowerCase()) return { confirmed: false, reason: "owner_mismatch" };
  return { confirmed: true };
}

export type ReconciliationDecision =
  | { action: "adopt"; mediaId: string; permalink: string | null }
  | { action: "reschedule"; error: string }
  | { action: "discard"; reason: string };

/**
 * Decisão da fila durável: adota o media id SOMENTE com prova terminal de
 * existência + confirmação positiva do proprietário. Sem `username` (ou sem
 * username da conta atual) o caso é ambíguo: reagenda, não adota, não descarta,
 * e jamais autoriza publicação nova.
 */
export function decideReconciliationAction(
  mediaId: string,
  probe: MetaProbe,
  currentUsername?: string | null,
): ReconciliationDecision {
  const base = decidePendingMediaAction(mediaId, probe);
  if (base.action === "reschedule") return { action: "reschedule", error: base.error };
  if (base.action === "invalidate") return { action: "discard", reason: base.reason };
  const owner = probe.kind === "ok" && probe.body?.username != null ? String(probe.body.username) : null;
  const check = checkMediaOwner(owner, currentUsername);
  if (check.confirmed === true) return { action: "adopt", mediaId: base.mediaId, permalink: base.permalink };
  return check.reason === "owner_mismatch"
    ? { action: "discard", reason: "discarded_owner_mismatch" }
    : { action: "reschedule", error: "reconciliation_owner_unconfirmed" };
}

/** Qualquer reconciliação aberta bloqueia a criação de container novo. */
export function shouldBlockForOpenReconciliation(openCount: number | null | undefined): boolean {
  return Number(openCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Watchdog: quando é legítimo terminalizar por esgotamento de tentativas
// ---------------------------------------------------------------------------

export const IG_WATCHDOG_ABANDON_MS = 5 * 60_000;

/**
 * Espelha (em lógica pura, para teste) a condição SQL do watchdog: só encerra
 * como `failed_permanent` quando NÃO há post, as tentativas estouraram e não
 * existe worker vivo (lock ausente ou lease abandonado há mais de 5 minutos).
 */
export function shouldTerminalizeAttempts(row: {
  instagram_post_id?: string | null;
  instagram_publish_attempts?: number | null;
  instagram_publish_lock_token?: string | null;
  instagram_publish_started_at?: string | null;
  now?: Date;
  maxAttempts?: number;
}): boolean {
  const now = row.now ?? new Date();
  const max = row.maxAttempts ?? IG_MAX_ATTEMPTS;
  if (row.instagram_post_id) return false;
  if (Number(row.instagram_publish_attempts ?? 0) < max) return false;
  const hasToken = !!(row.instagram_publish_lock_token && String(row.instagram_publish_lock_token).trim());
  if (!hasToken) return true;
  const started = row.instagram_publish_started_at ? new Date(row.instagram_publish_started_at).getTime() : NaN;
  if (!Number.isFinite(started)) return true;
  return now.getTime() - started > IG_WATCHDOG_ABANDON_MS;
}

// ---------------------------------------------------------------------------
// Leitura HONESTA da resposta da função de publicação (painel admin)
// ---------------------------------------------------------------------------

export type IgRetryOutcomeKind =
  | "published"
  | "recovered"
  | "in_progress"
  | "lock_taken"
  | "already_posted"
  | "lock_lost"
  | "inconclusive"
  | "error";

export type IgRetryOutcome = {
  kind: IgRetryOutcomeKind;
  title: string;
  description: string | null;
  variant: "default" | "destructive";
};

/**
 * `ok: true` NÃO significa "publicado". Só existe publicação quando a resposta
 * traz `instagram_post_id` (ou permalink) confirmado. Todo `skipped` é traduzido
 * pelo motivo real, sem inventar sucesso.
 */
export function describeIgRetryResponse(res: {
  ok?: boolean;
  skipped?: boolean;
  reason?: string | null;
  recovered?: boolean;
  instagram_post_id?: string | null;
  permalink?: string | null;
  error?: string | null;
  detail?: string | null;
} | null | undefined): IgRetryOutcome {
  const permalink = res?.permalink ? String(res.permalink) : null;
  if (!res || res.ok !== true) {
    return {
      kind: "error",
      title: "Falha ao publicar",
      description: String(res?.error || res?.detail || "erro desconhecido"),
      variant: "destructive",
    };
  }
  if (res.skipped === true) {
    const reason = String(res.reason ?? "").trim();
    if (reason === "publish_in_progress") {
      return { kind: "in_progress", title: "Publicação já em andamento", description: "Outra execução detém o lock.", variant: "default" };
    }
    if (reason === "publish_lock_not_acquired") {
      return { kind: "lock_taken", title: "Outro worker assumiu", description: "O lock foi obtido por outra execução.", variant: "default" };
    }
    if (reason === "already_posted") {
      return { kind: "already_posted", title: "Já publicado", description: res.instagram_post_id ? String(res.instagram_post_id) : null, variant: "default" };
    }
    if (reason === "lock_lost" || reason === "lease_expired") {
      return { kind: "lock_lost", title: "Tentativa cancelada", description: "Perda do lock/lease durante a execução.", variant: "default" };
    }
    return { kind: "inconclusive", title: "Publicação não realizada", description: reason || "sem motivo informado", variant: "default" };
  }
  const postId = res.instagram_post_id ? String(res.instagram_post_id) : null;
  if (!postId && !permalink) {
    return {
      kind: "inconclusive",
      title: "Sem confirmação de publicação",
      description: "A função respondeu sem ID nem permalink.",
      variant: "default",
    };
  }
  if (res.recovered === true) {
    return { kind: "recovered", title: "Post recuperado no Instagram", description: permalink || postId, variant: "default" };
  }
  return { kind: "published", title: "Publicado no Instagram", description: permalink || postId, variant: "default" };
}
