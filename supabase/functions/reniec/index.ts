// Edge Function: reniec
// Consulta de identidad oficial RENIEC (Apis Perú / Decolecta y Apis Perú Dev)
// con el token SIEMPRE en el servidor (nunca se expone en el cliente).
//
// Despliegue:
//   supabase secrets set APIS_TOKEN=tu_token_decolecta APIS_DEV_TOKEN=tu_token_dev
//   supabase functions deploy reniec
//
// Uso:
//   GET /functions/v1/reniec?dni=46027897
//   Headers: apikey: <anon key>, Authorization: Bearer <anon key | user JWT>

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const APIS_TOKEN = Deno.env.get("APIS_TOKEN") ?? "";
const APIS_DEV_TOKEN = Deno.env.get("APIS_DEV_TOKEN") ?? "";
const PERUAPI_KEY = Deno.env.get("PERUAPI_KEY") ?? "";

// TTLs configurables por variable de entorno (horas).
// La caché NO limita tus consultas: solo evita gastar cuota repitiendo EL
// MISMO DNI. Cada DNI distinto sigue consultando al proveedor y consumiendo
// del cupo del proveedor, no del tuyo.
function hoursEnv(name: string, fallback: number): number {
  const parsed = Number(Deno.env.get(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RATE_LIMIT = 30; // consultas por minuto por IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Caché de identidad DURABLE: cada DNI consulta al proveedor EXACTAMENTE
// una vez por ventana de 24 h. Se guarda en Postgres (tabla reniec_cache)
// porque cada petición corre en un aislamiento nuevo: la caché en memoria
// del proceso NO sobrevive entre llamadas.
//  - L0: memoria del aislamiento (sólo acelera ráfagas en la misma llamada).
//  - L1: PostgREST -> tabla public.reniec_cache (persistente entre llamadas).
const CACHE_TTL = hoursEnv("CACHE_TTL_HOURS", 12) * 3600 * 1000; // aciertos
const CACHE_TTL_NEGATIVE = hoursEnv("CACHE_TTL_NEGATIVE_HOURS", 1) * 3600 * 1000;
const CACHE_MAX_ENTRIES = 5000;
type CacheEntry = { value: Record<string, string> | null; expiresAt: number };
const memoryCache = new Map<string, CacheEntry>();

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CACHE_TABLE_URL = `${SUPABASE_URL}/rest/v1/reniec_cache`;
const CACHE_FETCH_TIMEOUT = 4000;

function memoryGet(dni: string): CacheEntry | undefined {
  const entry = memoryCache.get(dni);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(dni);
    return undefined;
  }
  return entry;
}

function memorySet(dni: string, entry: CacheEntry) {
  if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of memoryCache) {
      if (now > value.expiresAt) memoryCache.delete(key);
    }
    while (memoryCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = memoryCache.keys().next();
      if (oldest.done) break;
      memoryCache.delete(oldest.value);
    }
  }
  memoryCache.set(dni, entry);
}

// Encriptación AES-GCM-256 en reposo para proteger datos personales en reniec_cache
// La clave vive SOLO en el secreto RENIEC_CACHE_KEY. Sin ella no se usa la
// caché persistente (solo la de memoria), para no guardar datos personales sin
// cifrar ni depender de una clave escrita en el código.
const ENCRYPTION_SECRET = Deno.env.get("RENIEC_CACHE_KEY") ?? "";
const PERSISTENT_CACHE_ENABLED = ENCRYPTION_SECRET.length > 0;
if (!PERSISTENT_CACHE_ENABLED) {
  console.error("[reniec] Falta RENIEC_CACHE_KEY: caché persistente desactivada.");
}

// Enmascara el DNI en los logs (solo los 2 últimos dígitos).
function maskDni(dni: string): string {
  return dni.length > 2 ? `${"*".repeat(dni.length - 2)}${dni.slice(-2)}` : "**";
}

async function getAesKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(ENCRYPTION_SECRET),
  );
  return await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPayload(
  data: Record<string, string> | null,
): Promise<unknown> {
  if (!data) return null;
  try {
    const key = await getAesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded,
    );

    const b64Iv = btoa(String.fromCharCode(...iv));
    const b64Cipher = btoa(
      String.fromCharCode(...new Uint8Array(ciphertext)),
    );

    return {
      _enc: "aes-gcm-256",
      iv: b64Iv,
      data: b64Cipher,
    };
  } catch (err) {
    console.error(`[reniec][crypto] ENCRYPT_ERROR: ${err}`);
    return undefined; // no se persiste en claro
  }
}

// Devuelve undefined si el registro está cifrado pero no se puede descifrar
// (p. ej. tras rotar RENIEC_CACHE_KEY): el llamador lo trata como fallo de caché.
async function decryptPayload(
  raw: unknown,
): Promise<Record<string, string> | null | undefined> {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Si no está encriptado (registros legacy no cifrados), retornar directo
  if (obj._enc !== "aes-gcm-256" || typeof obj.data !== "string" || typeof obj.iv !== "string") {
    return raw as Record<string, string>;
  }

  try {
    const key = await getAesKey();
    const iv = Uint8Array.from(atob(obj.iv), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(obj.data), (c) => c.charCodeAt(0));

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );

    const jsonStr = new TextDecoder().decode(decrypted);
    return JSON.parse(jsonStr) as Record<string, string>;
  } catch (err) {
    console.error(`[reniec][crypto] DECRYPT_ERROR: ${err}`);
    return undefined;
  }
}

function cacheHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function cacheGet(dni: string): Promise<CacheEntry | undefined> {
  const local = memoryGet(dni);
  if (local) return local;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PERSISTENT_CACHE_ENABLED) return undefined;

  try {
    const res = await fetch(
      `${CACHE_TABLE_URL}?dni=eq.${dni}&select=payload,expires_at&limit=1`,
      { headers: cacheHeaders(), signal: AbortSignal.timeout(CACHE_FETCH_TIMEOUT) },
    );
    if (!res.ok) {
      console.log(`[reniec][cache] READ_ERROR status=${res.status}`);
      return undefined;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return undefined;

    const row = rows[0] as { payload: unknown; expires_at: string };
    const expiresAt = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      await deleteCached(dni);
      return undefined;
    }

    const decrypted = await decryptPayload(row.payload);
    if (decrypted === undefined) {
      await deleteCached(dni);
      return undefined;
    }
    const entry: CacheEntry = { value: decrypted, expiresAt };
    memorySet(dni, entry);
    console.log(`[reniec][cache] HIT_PERSISTENTE dni=${maskDni(dni)}`);
    return entry;
  } catch (error) {
    console.log(`[reniec][cache] READ_FALLBACK ${error}`);
    return undefined;
  }
}

async function deleteCached(dni: string): Promise<void> {
  try {
    await fetch(`${CACHE_TABLE_URL}?dni=eq.${dni}`, {
      method: "DELETE",
      headers: cacheHeaders(),
      signal: AbortSignal.timeout(CACHE_FETCH_TIMEOUT),
    });
  } catch {
    // el registro expirado se ignora; se reescribirá en la próxima consulta
  }
}

async function cacheSet(
  dni: string,
  value: Record<string, string> | null,
): Promise<void> {
  const entry: CacheEntry = {
    value,
    expiresAt: Date.now() + (value ? CACHE_TTL : CACHE_TTL_NEGATIVE),
  };
  memorySet(dni, entry);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PERSISTENT_CACHE_ENABLED) return;

  try {
    const encryptedPayload = await encryptPayload(value);
    if (encryptedPayload === undefined) return;
    const res = await fetch(`${CACHE_TABLE_URL}?on_conflict=dni`, {
      method: "POST",
      headers: {
        ...cacheHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        dni,
        payload: encryptedPayload,
        expires_at: new Date(entry.expiresAt).toISOString(),
      }),
      signal: AbortSignal.timeout(CACHE_FETCH_TIMEOUT),
    });
    if (!res.ok) console.log(`[reniec][cache] WRITE_ERROR status=${res.status}`);
  } catch (error) {
    console.log(`[reniec][cache] WRITE_FALLBACK ${error}`);
  }
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function pick(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

// Normaliza cualquier variante de respuesta a un único contrato:
// { dni, nombres, apellidos, fullName, dv, provider }
function normalize(
  raw: unknown,
  dni: string,
  provider: string,
): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;

  let nombres = pick(data, ["nombres", "first_name", "firstName"]);
  let apellidos = pick(data, [
    "apellidos",
    "apellido_paterno",
    "apellidoPaterno",
    "first_last_name",
  ]);
  const materno = pick(data, [
    "apellido_materno",
    "apellidoMaterno",
    "second_last_name",
  ]);
  if (materno && !apellidos.includes(materno)) {
    apellidos = apellidos ? `${apellidos} ${materno}` : materno;
  }

  const fullName = pick(data, ["full_name", "fullName", "nombre_completo"]);

  // Fallback: proveedor que sólo devuelve el nombre completo en un campo.
  // full_name (Decolecta): "AP_PAT AP_MAT NOMBRES"
  // nombre  (Apis Perú)  : "NOMBRES APELLIDO_PAT APELLIDO_MAT"
  if (!nombres && !apellidos) {
    const combined = fullName || pick(data, ["nombre"]);
    if (combined) {
      const words = combined.split(/\s+/);
      if (words.length >= 3) {
        if (fullName) {
          apellidos = `${words[0]} ${words[1]}`;
          nombres = words.slice(2).join(" ");
        } else {
          nombres = words.slice(0, -2).join(" ");
          apellidos = words.slice(-2).join(" ");
        }
      } else {
        nombres = combined;
      }
    }
  }

  if (!nombres && !apellidos && !fullName) return null;

  const dv = pick(data, ["dv", "codVerifica", "codigoVerificacion"]);

  return {
    dni: pick(data, ["dni", "document_number", "numero"]) || dni,
    nombres,
    apellidos,
    fullName: fullName || `${nombres} ${apellidos}`.trim(),
    dv,
    provider,
  };
}

interface Provider {
  name: string;
  url: (dni: string) => string;
  headers: Record<string, string>;
  requiresToken?: boolean;
  /** Nombre de la variable de entorno que guarda el token de este proveedor. */
  tokenKey?: string;
}

function providerToken(p: Provider): string {
  switch (p.tokenKey) {
    case "APIS_DEV_TOKEN":
      return APIS_DEV_TOKEN;
    case "PERUAPI_KEY":
      return PERUAPI_KEY;
    default:
      return APIS_TOKEN;
  }
}

const PROVIDERS: Provider[] = [
  {
    // Apis Perú Dev (apisperu.com): plan Gratis 2000 consultas DNI-RUC/mes.
    // Respuesta (swagger): nombres, apellidoPaterno, apellidoMaterno, codVerifica.
    // Primero en la cadena: con token es el más rentable.
    name: "apis_peru_dev",
    url: (dni) => `https://dniruc.apisperu.com/api/v1/dni/${dni}?token=${APIS_DEV_TOKEN}`,
    headers: { Accept: "application/json" },
    requiresToken: true,
    tokenKey: "APIS_DEV_TOKEN",
  },
  {
    // Endpoint legacy de Apis Perú: acepta consultas anónimas con cuota
    // limitada (429). Con token de apis.net.pe (gratuito tras registro) la
    // cuota es por cuenta y mucho mayor.
    name: "apis_net",
    url: (dni) => `https://api.apis.net.pe/v1/dni?numero=${dni}`,
    headers: APIS_TOKEN
      ? { Authorization: `Bearer ${APIS_TOKEN}`, Accept: "application/json" }
      : { Accept: "application/json" },
    tokenKey: "APIS_TOKEN",
  },
  {
    // peruapi.com: API Key gratuita tras registro (plan Free 50/día y 1000/
    // mes). Header X-API-KEY o query ?api_token=. Responde con
    // apellido_paterno/apellido_materno/nombres (lo normaliza normalize()).
    name: "peruapi",
    url: (dni) => `https://peruapi.com/api/dni/${dni}`,
    headers: PERUAPI_KEY
      ? { "X-API-KEY": PERUAPI_KEY, Accept: "application/json" }
      : { Accept: "application/json" },
    requiresToken: true,
    tokenKey: "PERUAPI_KEY",
  },
  {
    name: "apis_peru",
    url: (dni) => `https://api.decolecta.com/v1/reniec/dni?numero=${dni}`,
    headers: APIS_TOKEN
      ? { Authorization: `Bearer ${APIS_TOKEN}`, Accept: "application/json" }
      : { Accept: "application/json" },
    requiresToken: true,
    tokenKey: "APIS_TOKEN",
  },
];

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const origin = req.headers.get("Origin");
  if (origin && !origin.includes("localhost") && req.method !== "GET") {
    return json({ error: "Origen no permitido" }, 403);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return json({ error: "Demasiadas consultas. Espere un minuto." }, 429);
  }

  const { searchParams } = new URL(req.url);
  const dni = (searchParams.get("dni") ?? "").trim();

  if (!/^\d{8}$/.test(dni)) {
    return json({ error: "DNI inválido: debe contener 8 dígitos." }, 400);
  }

  // Caché: evita repetir la consulta del MISMO DNI al proveedor.
  // `refresh=1` fuerza consulta en vivo (pruebas o corrección de datos);
  // la caché NUNCA bloquea consultar DNIs nuevos.
  const forceRefresh = ["1", "true"].includes(
    (searchParams.get("refresh") ?? "").toLowerCase(),
  );

  let cached: CacheEntry | undefined;
  if (!forceRefresh) {
    cached = await cacheGet(dni);
    if (cached) {
      console.log(`[reniec][cache] HIT dni=${maskDni(dni)} ${cached.value ? "FOUND" : "NOT_FOUND"}`);
      // `cache` va sólo en la respuesta (nunca se guarda) para poder comprobar
      // en cliente/QR que la cuota del proveedor NO se gastó en esta llamada.
      return cached.value
        ? json({ ...cached.value, cache: "HIT" })
        : json(
          { error: "El DNI no existe en los registros de RENIEC.", cache: "HIT" },
          404,
        );
    }
  }

  let lastError = "No se pudo consultar RENIEC.";

  for (const provider of PROVIDERS) {
    if (provider.requiresToken) {
      if (providerToken(provider).length === 0) continue;
    }

    try {
      let response = await fetch(provider.url(dni), {
        headers: provider.headers,
        signal: AbortSignal.timeout(8000),
      });

      // 429 del proveedor: un único reintento tras 1,2 s antes de rendirse
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        response = await fetch(provider.url(dni), {
          headers: provider.headers,
          signal: AbortSignal.timeout(8000),
        });
      }

      if (response.ok) {
        const payload = await response.json();

        const normalized = normalize(
          (payload as { data?: unknown }).data ?? payload,
          dni,
          provider.name,
        );

        console.log(`[reniec][${provider.name}] dni=${maskDni(dni)} ${normalized ? "OK" : "SIN_DATOS"}`);

        if (normalized) {
          await cacheSet(dni, normalized);
          console.log(`[reniec][cache] SET dni=${maskDni(dni)}`);
          return json({ ...normalized, cache: "MISS" });
        }
        lastError = "Respuesta inválida del proveedor de identidad.";
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        await cacheSet(dni, null);
        return json(
          { error: "El DNI no existe en los registros de RENIEC.", cache: "MISS" },
          404,
        );
      }
      if (response.status === 401 || response.status === 403) {
        lastError = "Token de API de identidad inválido o expirado.";
        continue;
      }
      if (response.status === 429) {
        lastError = "El proveedor agotó su cuota de consultas.";
        continue;
      }
      lastError = `El proveedor ${provider.name} respondió ${response.status}.`;
    } catch (error) {
      developerLog(`[${provider.name}] ${error}`);
      lastError = "Sin conexión con el proveedor de identidad.";
    }
  }

  if (lastError === "No se pudo consultar RENIEC.") {
    lastError = "Los proveedores de identidad no respondieron. Intente en unos segundos.";
  }

  return json({ error: lastError }, 502);
});

function developerLog(message: string) {
  console.log(`[reniec] ${message}`);
}
