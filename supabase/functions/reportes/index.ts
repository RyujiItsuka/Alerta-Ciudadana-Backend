// ==============================================================================
// SUPABASE EDGE FUNCTION: REPORTES (fase 1 del cierre de acceso anónimo)
//
// Puerta de entrada autenticada para que la app escriba y lea SUS reportes y
// puntos GPS sin acceso directo a las tablas `reporte` / `ubicacion`.
// - El ciudadano se identifica con el JWT propio que emite `security`
//   (HS256 con JWT_SECRET_KEY) enviado en el cuerpo: { action, token, ... }.
// - `id_persona` se toma SIEMPRE del token, nunca del cuerpo.
// - Escribe con service_role y marca `origen = 'edge'`.
//
// Acciones (POST):
//   crear-reporte, agregar-ubicacion, cerrar-rastreo, actualizar-direccion,
//   mis-reportes
//
// Despliegue: supabase functions deploy reportes   (verify_jwt por defecto:
// la app envía la anon key en Authorization, como en las demás funciones).
// ==============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JWT_SECRET = Deno.env.get("JWT_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---- Límites (ver docs de diseño, sección 3.2) ----
const MAX_DESCRIPCION = 4000;
const MAX_DIRECCION = 255;
const MAX_FOTOS = 5;
const MAX_PUNTOS_LOTE = 20;
const REPORTES_POR_10_MIN = 5;
const REPORTES_POR_DIA = 30;
const PUNTOS_POR_5_S = 5;
const MAX_PUNTOS_REPORTE = 3000;
const RASTREO_MAX_HORAS = 12;
const DIRECCION_EDITABLE_MIN = 10;
// En una emergencia se acepta un token caducado hace poco (firma válida y
// sesión no revocada); la fila queda marcada con token_vencido = true.
const GRACIA_TOKEN_DIAS = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function logError(context: string, err: unknown): void {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e === "object" && e.code ? ` [${String(e.code)}]` : "";
  const msg = e && typeof e === "object" && e.message ? String(e.message) : String(err);
  console.error(`[reportes] ${context}${code}: ${msg.slice(0, 200)}`);
}

function internalError(context: string, err: unknown): Response {
  logError(context, err);
  return json({ success: false, error: "Error interno del servidor. Intente nuevamente." }, 500);
}

// ---- JWT (mismo formato que `security`) ----
function b64urlToBytes(str: string): Uint8Array<ArrayBuffer> {
  let b = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const bin = atob(b);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type Claims = { id_persona?: unknown; rol?: unknown; exp?: unknown; scope?: unknown };

// Verifica la firma. Devuelve los claims y si el token está caducado; null si
// la firma no es válida o el token está mal formado.
async function verifySignature(token: string): Promise<{ claims: Claims; expired: boolean } | null> {
  try {
    if (!JWT_SECRET) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Claims;
    const exp = Number(claims.exp);
    const expired = Number.isFinite(exp) && Date.now() / 1000 > exp;
    return { claims, expired };
  } catch {
    return null;
  }
}

type Citizen = { idPersona: number; tokenVencido: boolean };

// Autentica al ciudadano. allowGrace permite tokens caducados hace menos de
// GRACIA_TOKEN_DIAS (solo para crear reportes y enviar puntos en emergencia).
async function authCitizen(token: unknown, allowGrace: boolean): Promise<Citizen | Response> {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) return json({ success: false, error: "Sesión requerida." }, 401);

  const res = await verifySignature(raw);
  if (!res) return json({ success: false, error: "Token inválido." }, 401);
  const { claims, expired } = res;

  const rol = String(claims.rol ?? "").toLowerCase();
  const idPersona = Number(claims.id_persona);
  if (claims.scope || rol !== "ciudadano" || !Number.isInteger(idPersona) || idPersona <= 0) {
    return json({ success: false, error: "Token no válido para esta operación." }, 403);
  }

  if (expired) {
    const exp = Number(claims.exp);
    const withinGrace = Date.now() / 1000 - exp < GRACIA_TOKEN_DIAS * 86400;
    if (!allowGrace || !withinGrace) {
      return json({ success: false, error: "Sesión expirada. Inicie sesión nuevamente." }, 401);
    }
  }

  const { data: session, error } = await supabase
    .from("sesion_usuario")
    .select("revocado")
    .eq("token_jwt", raw)
    .maybeSingle();
  if (error) return internalError("auth: sesion_usuario", error);
  if (session?.revocado) {
    return json({ success: false, error: "Sesión revocada. Inicie sesión nuevamente." }, 403);
  }

  return { idPersona, tokenVencido: expired };
}

// ---- Validaciones ----
function validCoord(lat: unknown, lon: unknown): boolean {
  const la = Number(lat), lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
}

function clientDate(value: unknown): string {
  // Fecha del cliente (para reintentos sin conexión); no puede ir al futuro.
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || t > Date.now() + 15 * 60 * 1000) return new Date().toISOString();
  return new Date(t).toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function countSince(
  table: "reporte" | "ubicacion",
  column: "id_persona" | "id_reporte",
  value: number,
  seconds: number,
): Promise<number> {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value)
    .gte("creado_en", since);
  if (error) throw error;
  return count ?? 0;
}

async function ownReport(idReporte: number, idPersona: number) {
  const { data, error } = await supabase
    .from("reporte")
    .select("id_reporte,id_persona,creado_en")
    .eq("id_reporte", idReporte)
    .maybeSingle();
  if (error) throw error;
  if (!data || Number(data.id_persona) !== idPersona) return null;
  return data as { id_reporte: number; id_persona: number; creado_en: string };
}

async function rastreoCerrado(idReporte: number): Promise<boolean> {
  const { count, error } = await supabase
    .from("ubicacion")
    .select("*", { count: "exact", head: true })
    .eq("id_reporte", idReporte)
    .eq("latitud", 0)
    .eq("longitud", 0);
  if (error) throw error;
  return (count ?? 0) > 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Use POST." }, 405);
  if (!JWT_SECRET || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    logError("configuración", "faltan secretos (JWT_SECRET_KEY / SUPABASE_*)");
    return json({ success: false, error: "Servidor no configurado." }, 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Cuerpo JSON inválido." }, 400);
  }
  const action = String(body.action ?? new URL(req.url).searchParams.get("action") ?? "");

  try {
    // -------------------------------------------------------------------------
    if (action === "crear-reporte") {
      const auth = await authCitizen(body.token, true);
      if (auth instanceof Response) return auth;

      const idTipo = Number(body.id_tipo);
      if (!Number.isInteger(idTipo) || idTipo < 1 || idTipo > 7) {
        return json({ success: false, error: "id_tipo inválido." }, 400);
      }
      const descripcion = String(body.descripcion ?? "").slice(0, MAX_DESCRIPCION);
      const direccion = String(body.direccion_texto ?? "Ubicación móvil GPS").slice(0, MAX_DIRECCION);
      const fotos = Array.isArray(body.fotos) ? body.fotos.slice(0, MAX_FOTOS).map(String) : [];
      const idem = typeof body.id_idempotencia === "string" && UUID_RE.test(body.id_idempotencia)
        ? body.id_idempotencia
        : null;

      // Idempotencia: un reintento con el mismo UUID devuelve el reporte ya creado.
      if (idem) {
        const { data: prev, error } = await supabase
          .from("reporte")
          .select("id_reporte,id_persona")
          .eq("id_idempotencia", idem)
          .maybeSingle();
        if (error) return internalError("crear-reporte: idempotencia", error);
        if (prev) {
          if (Number(prev.id_persona) !== auth.idPersona) {
            return json({ success: false, error: "Identificador ya utilizado." }, 409);
          }
          return json({ success: true, id_reporte: prev.id_reporte, duplicado: true });
        }
      }

      if (await countSince("reporte", "id_persona", auth.idPersona, 600) >= REPORTES_POR_10_MIN ||
        await countSince("reporte", "id_persona", auth.idPersona, 86400) >= REPORTES_POR_DIA) {
        return json({ success: false, error: "Demasiados reportes. Espere unos minutos.", retry_after: 600 }, 429);
      }

      const { data: rep, error: repErr } = await supabase
        .from("reporte")
        .insert({
          id_persona: auth.idPersona,
          id_tipo: idTipo,
          id_estado: 1,
          fecha_hora: clientDate(body.fecha_cliente),
          descripcion,
          direccion_texto: direccion,
          fotos,
          origen: "edge",
          id_idempotencia: idem,
          token_vencido: auth.tokenVencido,
        })
        .select("id_reporte")
        .single();
      if (repErr) return internalError("crear-reporte: insert", repErr);

      if (validCoord(body.latitud, body.longitud)) {
        const { error: ubiErr } = await supabase.from("ubicacion").insert({
          id_reporte: rep.id_reporte,
          latitud: Number(body.latitud),
          longitud: Number(body.longitud),
          fecha_hora: clientDate(body.fecha_cliente),
        });
        if (ubiErr) logError("crear-reporte: primer punto", ubiErr);
      }

      return json({ success: true, id_reporte: rep.id_reporte });
    }

    // -------------------------------------------------------------------------
    if (action === "agregar-ubicacion") {
      const auth = await authCitizen(body.token, true);
      if (auth instanceof Response) return auth;

      const idReporte = Number(body.id_reporte);
      if (!Number.isInteger(idReporte) || idReporte <= 0) {
        return json({ success: false, error: "id_reporte inválido." }, 400);
      }
      const rep = await ownReport(idReporte, auth.idPersona);
      if (!rep) return json({ success: false, error: "Reporte no encontrado." }, 404);
      if (Date.now() - Date.parse(rep.creado_en) > RASTREO_MAX_HORAS * 3600 * 1000) {
        return json({ success: true, aceptados: 0, descartados: -1, motivo: "rastreo_vencido" });
      }
      if (await rastreoCerrado(idReporte)) {
        return json({ success: true, aceptados: 0, descartados: -1, motivo: "rastreo_cerrado" });
      }

      const entrada = Array.isArray(body.puntos) ? body.puntos.slice(0, MAX_PUNTOS_LOTE) : [];
      const validos = entrada.filter((p: any) =>
        p && validCoord(p.lat, p.lon) && !(Number(p.lat) === 0 && Number(p.lon) === 0)
      );

      // Límite de frecuencia: se DESCARTA sin error para que el cliente no
      // reintente indefinidamente.
      const recientes = await countSince("ubicacion", "id_reporte", idReporte, 5);
      const { count: total, error: cErr } = await supabase
        .from("ubicacion")
        .select("*", { count: "exact", head: true })
        .eq("id_reporte", idReporte);
      if (cErr) return internalError("agregar-ubicacion: conteo", cErr);
      const cupo = Math.max(0, Math.min(PUNTOS_POR_5_S - recientes, MAX_PUNTOS_REPORTE - (total ?? 0)));
      const aInsertar = validos.slice(0, cupo).map((p: any) => ({
        id_reporte: idReporte,
        latitud: Number(p.lat),
        longitud: Number(p.lon),
        fecha_hora: clientDate(p.fecha_cliente),
      }));

      if (aInsertar.length > 0) {
        const { error } = await supabase.from("ubicacion").insert(aInsertar);
        if (error) return internalError("agregar-ubicacion: insert", error);
      }
      return json({
        success: true,
        aceptados: aInsertar.length,
        descartados: entrada.length - aInsertar.length,
      });
    }

    // -------------------------------------------------------------------------
    if (action === "cerrar-rastreo") {
      const auth = await authCitizen(body.token, true);
      if (auth instanceof Response) return auth;
      const idReporte = Number(body.id_reporte);
      if (!Number.isInteger(idReporte) || idReporte <= 0) {
        return json({ success: false, error: "id_reporte inválido." }, 400);
      }
      const rep = await ownReport(idReporte, auth.idPersona);
      if (!rep) return json({ success: false, error: "Reporte no encontrado." }, 404);
      if (!(await rastreoCerrado(idReporte))) {
        // Marca (0,0): el panel la interpreta como cancelación del rastreo.
        const { error } = await supabase.from("ubicacion").insert({
          id_reporte: idReporte,
          latitud: 0,
          longitud: 0,
        });
        if (error) return internalError("cerrar-rastreo: insert", error);
      }
      return json({ success: true });
    }

    // -------------------------------------------------------------------------
    if (action === "actualizar-direccion") {
      const auth = await authCitizen(body.token, false);
      if (auth instanceof Response) return auth;
      const idReporte = Number(body.id_reporte);
      const direccion = String(body.direccion_texto ?? "").trim().slice(0, MAX_DIRECCION);
      if (!Number.isInteger(idReporte) || idReporte <= 0 || !direccion) {
        return json({ success: false, error: "Datos inválidos." }, 400);
      }
      const rep = await ownReport(idReporte, auth.idPersona);
      if (!rep) return json({ success: false, error: "Reporte no encontrado." }, 404);
      if (Date.now() - Date.parse(rep.creado_en) > DIRECCION_EDITABLE_MIN * 60 * 1000) {
        return json({ success: false, error: "El reporte ya no se puede modificar." }, 409);
      }
      const { error } = await supabase
        .from("reporte")
        .update({ direccion_texto: direccion })
        .eq("id_reporte", idReporte);
      if (error) return internalError("actualizar-direccion: update", error);
      return json({ success: true });
    }

    // -------------------------------------------------------------------------
    if (action === "mis-reportes") {
      const auth = await authCitizen(body.token, false);
      if (auth instanceof Response) return auth;
      const limit = Math.min(Math.max(Number(body.limit ?? 50) || 50, 1), 100);
      const { data, error } = await supabase
        .from("reporte")
        .select(
          "id_reporte,id_persona,descripcion,fecha_hora,direccion_texto,id_tipo,id_estado,fotos,tipo_incidencia(nombre),estado_reporte(nombre)",
        )
        .eq("id_persona", auth.idPersona)
        .order("fecha_hora", { ascending: false })
        .limit(limit);
      if (error) return internalError("mis-reportes: select", error);
      return json({ success: true, reportes: data ?? [] });
    }

    return json({ success: false, error: "Acción no válida" }, 400);
  } catch (err) {
    return internalError(`error no controlado (${action})`, err);
  }
});
