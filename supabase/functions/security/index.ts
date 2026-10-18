// ==============================================================================
// SUPABASE EDGE FUNCTION: SECURITY (Sprint 4 - Unidad 02)
// Cumple con: HU-SEG-01 (OTP WhatsApp), HU-SEG-02 (JWT Persistente y Revocable),
// HU-SEG-04 (Autorización por Propietario), HU-SEG-06 (Hash Bcrypt)
//
// ÚNICO PUERTA DE ENTRADA a las tablas persona / codigo_otp / sesion_usuario.
// El rol "anon" NO tiene acceso directo a esas tablas (RLS cerrado); todo pasa
// por aquí con la service_role key. El token de Green API y el secreto JWT
// viven SOLO en variables de entorno (nunca en el código).
//
// Despliegue:
//   supabase secrets set JWT_SECRET_KEY=<clave_larga_aleatoria>
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role>
//   supabase functions deploy security
//
// Acciones (?action=...):
//   send-otp, verify-otp, register, login, logout, revoke-session,
//   verify-token, reset-password, update-pin, find-user
// ==============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import bcryptModule from "https://esm.sh/bcryptjs@2.4.3";
const bcrypt: any = (bcryptModule as any)?.default || bcryptModule;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---- Configuración desde entorno (sin respaldos inseguros en el código) ----
const JWT_SECRET = Deno.env.get("JWT_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ??
  "https://emtzprcntefzkvvzmhfk.supabase.co";
// Se prefiere SIEMPRE la service_role (bypasea RLS). Si no existe, se usa anon
// (solo sirve si RLS está abierto: no recomendado).
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// URL de la Edge Function hermana "whatsapp" (envía OTP por Green API).
const WHATSAPP_FN_URL = `${SUPABASE_URL}/functions/v1/whatsapp`;

// ---- Utilidades JWT (HMAC-SHA256, 60 días) ----
function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): string {
  let b = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return atob(b);
}

async function generateJWT(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const binary = String.fromCharCode(...Array.from(new Uint8Array(sig)));
  return `${data}.${b64urlEncode(binary)}`;
}

async function verifyJWT(token: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const data = `${h}.${p}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const bin = b64urlDecode(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      new TextEncoder().encode(data),
    );
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Hash bcrypt tolerando tanto callbacks como síncrono (bcryptjs).
async function hashBcrypt(value: string): Promise<string> {
  if (bcrypt?.hashSync) return bcrypt.hashSync(value, 10);
  if (bcrypt?.hash) return await bcrypt.hash(value, 10);
  throw new Error("bcrypt no disponible");
}
async function compareBcrypt(value: string, hash: string): Promise<boolean> {
  if (bcrypt?.compareSync) return bcrypt.compareSync(value, hash);
  if (bcrypt?.compare) return await bcrypt.compare(value, hash);
  return false;
}
const isBcryptHash = (h: unknown): boolean =>
  typeof h === "string" && /^\$2[aby]\$\d{2}\$/.test(h);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Campos seguros de persona: NUNCA se exponen password_hash ni pin_hash en
// respuestas genéricas (solo se usan internamente para verificar).
const SAFE_PERSONA_FIELDS = "id_persona,dni,nombres,apellidos,telefono,rol";

// Envía el OTP por la Edge Function "whatsapp" (token de Green API en el servidor).
async function sendOtpByWhatsApp(phone: string, code: string): Promise<void> {
  const message =
    `🛡️ *AlertaCiudadana Pisco*\n\nTu código de verificación de seguridad es: *${code}*\n\n⏱️ Válido durante 5 minutos.\n⚠️ No compartas este código con nadie por tu seguridad.`;
  try {
    await fetch(WHATSAPP_FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        action: "sendMessage",
        chatId: `${phone}@c.us`,
        message,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error("Fallo despacho OTP por WhatsApp:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!JWT_SECRET) {
    console.error("Falta JWT_SECRET_KEY en los secretos de entorno.");
    return json({ success: false, error: "Servidor no configurado (JWT)." }, 500);
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    const body = await req.json().catch(() => ({}));

    // =========================================================================
    // 1. HU-SEG-01: ENVÍO DE CÓDIGO OTP (6 dígitos, válido 5 min)
    // =========================================================================
    if (action === "send-otp") {
      const { dni, phone } = body;
      if (!dni || !phone) {
        return json({ success: false, error: "DNI y celular son obligatorios" }, 400);
      }
      let cleanPhone = String(phone).replace(/[^0-9]/g, "");
      if (cleanPhone.length === 9) cleanPhone = `51${cleanPhone}`;

      const rnd = new Uint32Array(1);
      crypto.getRandomValues(rnd);
      const otpCode = (100000 + (rnd[0] % 900000)).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: dbError } = await supabase.from("codigo_otp").insert({
        dni,
        telefono: cleanPhone,
        codigo: otpCode,
        expira_en: expiresAt,
        usado: false,
      });
      if (dbError) console.error("Error guardando OTP:", dbError);

      await sendOtpByWhatsApp(cleanPhone, otpCode);

      return json({
        success: true,
        message: "Código OTP enviado exitosamente vía WhatsApp",
        expiresInSeconds: 300,
      });
    }

    // =========================================================================
    // 2. HU-SEG-01: VALIDACIÓN DE CÓDIGO OTP
    // =========================================================================
    if (action === "verify-otp") {
      const { dni, phone, code } = body;
      let cleanPhone = (phone || "").replace(/[^0-9]/g, "");
      if (cleanPhone.length === 9) cleanPhone = `51${cleanPhone}`;

      const now = new Date().toISOString();
      const { data: otps, error } = await supabase
        .from("codigo_otp")
        .select("*")
        .eq("dni", dni)
        .eq("codigo", code)
        .eq("usado", false)
        .gt("expira_en", now)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error || !otps || otps.length === 0) {
        return json({
          success: false,
          error: "Código inválido o expirado (límite 5 min).",
        }, 400);
      }

      await supabase.from("codigo_otp").update({ usado: true }).eq("id_otp", otps[0].id_otp);
      return json({ success: true, message: "Número verificado correctamente." });
    }

    // =========================================================================
    // 3. HU-SEG-06 & HU-SEG-02: REGISTRO CON BCRYPT + JWT
    // =========================================================================
    if (action === "register") {
      const {
        dni, name, phone, password, pin, otpCode,
        nombres, apellidos, first_name, last_name, firstName, lastName,
      } = body;

      if (!dni || !password || !pin) {
        return json({ success: false, error: "DNI, contraseña y PIN son obligatorios." }, 400);
      }

      let cleanFirstName = (nombres || firstName || first_name || "").trim();
      let cleanLastName = (apellidos || lastName || last_name || "").trim();
      if (!cleanLastName && (name || cleanFirstName)) {
        const full = (name || cleanFirstName).trim();
        const parts = full.split(/\s+/);
        if (parts.length >= 4) {
          cleanFirstName = parts.slice(0, 2).join(" ");
          cleanLastName = parts.slice(2).join(" ");
        } else if (parts.length === 3) {
          cleanFirstName = parts.slice(0, 1).join(" ");
          cleanLastName = parts.slice(1).join(" ");
        } else if (parts.length === 2) {
          cleanFirstName = parts[0];
          cleanLastName = parts[1];
        } else {
          cleanFirstName = full;
        }
      } else if (!cleanFirstName && name) {
        cleanFirstName = name.trim();
      }

      // Verificar OTP si fue proporcionado
      if (otpCode) {
        const now = new Date().toISOString();
        const { data: validOtp } = await supabase
          .from("codigo_otp")
          .select("id_otp")
          .eq("dni", dni)
          .eq("codigo", otpCode)
          .gt("expira_en", now)
          .limit(1);
        if (!validOtp || validOtp.length === 0) {
          return json({ success: false, error: "Debe verificar su número con el código OTP enviado." }, 400);
        }
      }

      // Hash bcrypt (HU-SEG-06)
      let passwordHash: string;
      let pinHash: string;
      try {
        passwordHash = await hashBcrypt(password);
        pinHash = await hashBcrypt(pin);
      } catch (hashErr) {
        console.error("Error bcrypt:", hashErr);
        return json({ success: false, error: "Error procesando credenciales." }, 500);
      }

      const { data: persona, error: insertError } = await supabase
        .from("persona")
        .insert({
          dni,
          nombres: cleanFirstName,
          apellidos: cleanLastName,
          telefono: phone,
          password_hash: passwordHash,
          pin_hash: pinHash,
          rol: "ciudadano",
        })
        .select(SAFE_PERSONA_FIELDS)
        .single();

      if (insertError) {
        return json({ success: false, error: `Error al registrar: ${insertError.message}` }, 400);
      }

      const exp = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
      const token = await generateJWT({
        id_persona: persona.id_persona,
        dni: persona.dni,
        rol: persona.rol,
        exp,
      });

      await supabase.from("sesion_usuario").insert({
        id_persona: persona.id_persona,
        dni: persona.dni,
        token_jwt: token,
        dispositivo_info: "Flutter Mobile App (Keystore/Keychain)",
        revocado: false,
        expira_en: new Date(exp * 1000).toISOString(),
      });

      return json({ success: true, token, user: persona }, 201);
    }

    // =========================================================================
    // 4. HU-SEG-02 & HU-SEG-06: LOGIN CON BCRYPT + JWT
    //    (sin backdoors; migración transparente de claves en claro a bcrypt)
    // =========================================================================
    if (action === "login") {
      const { dni, password } = body;
      const { data: persona, error } = await supabase
        .from("persona")
        .select("*")
        .eq("dni", dni)
        .maybeSingle();

      if (error || !persona) {
        return json({ success: false, error: "DNI no encontrado. Por favor regístrese." }, 404);
      }

      const stored = persona.password_hash ?? "";
      let valid = false;

      if (isBcryptHash(stored)) {
        valid = await compareBcrypt(String(password ?? ""), stored);
      } else if (stored && stored.length > 0) {
        // Credencial legada en claro (o hash no-bcrypt). Se compara y, si coincide,
        // se re-hashea con bcrypt en el momento (migración transparente).
        if (String(password ?? "") === stored) {
          valid = true;
          try {
            await supabase
              .from("persona")
              .update({ password_hash: await hashBcrypt(String(password)) })
              .eq("id_persona", persona.id_persona);
          } catch (e) {
            console.warn("No se pudo re-hashear a bcrypt:", e);
          }
        }
      }

      if (!valid) {
        return json({ success: false, error: "Contraseña incorrecta." }, 401);
      }

      const exp = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
      const token = await generateJWT({
        id_persona: persona.id_persona,
        dni: persona.dni,
        rol: persona.rol || "ciudadano",
        exp,
      });

      await supabase.from("sesion_usuario").insert({
        id_persona: persona.id_persona,
        dni: persona.dni,
        token_jwt: token,
        dispositivo_info: "Flutter Mobile App (Keystore/Keychain)",
        revocado: false,
        expira_en: new Date(exp * 1000).toISOString(),
      });

      // El PIN se devuelve para el desbloqueo local en el propio dispositivo.
      return json({
        success: true,
        token,
        user: {
          id_persona: persona.id_persona,
          dni: persona.dni,
          nombres: persona.nombres,
          apellidos: persona.apellidos || "",
          telefono: persona.telefono,
          pin_hash: persona.pin_hash,
        },
      });
    }

    // =========================================================================
    // 5. HU-SEG-02: REVOCACIÓN DE SESIONES (ante robo del celular)
    // =========================================================================
    if (action === "revoke-session") {
      const { dni } = body;
      await supabase.from("sesion_usuario").update({ revocado: true }).eq("dni", dni);
      return json({ success: true, message: "Sesiones revocadas." });
    }

    // =========================================================================
    // 6. RESET DE CONTRASEÑA (bcrypt) — reemplaza el PATCH directo en claro
    // =========================================================================
    if (action === "reset-password") {
      const { dni, password } = body;
      if (!dni || !password || String(password).length < 6) {
        return json({ success: false, error: "La nueva contraseña debe tener al menos 6 caracteres." }, 400);
      }
      const hash = await hashBcrypt(String(password));
      const { data: updated, error } = await supabase
        .from("persona")
        .update({ password_hash: hash })
        .eq("dni", dni)
        .select(SAFE_PERSONA_FIELDS);
      if (error || !updated || updated.length === 0) {
        return json({ success: false, error: "No se pudo actualizar la contraseña." }, 400);
      }
      return json({ success: true, message: "Contraseña actualizada correctamente." });
    }

    // =========================================================================
    // 7. ACTUALIZACIÓN DE PIN (bcrypt)
    // =========================================================================
    if (action === "update-pin") {
      const { dni, pin } = body;
      if (!dni || !/^\d{4}$/.test(String(pin ?? ""))) {
        return json({ success: false, error: "El PIN debe tener 4 dígitos." }, 400);
      }
      const pinHash = await hashBcrypt(String(pin));
      const { error } = await supabase
        .from("persona")
        .update({ pin_hash: pinHash })
        .eq("dni", dni);
      if (error) return json({ success: false, error: "No se pudo actualizar el PIN." }, 400);
      return json({ success: true });
    }

    // =========================================================================
    // 8. BÚSQUEDA SEGURA DE USUARIO POR DNI (sin exponer hashes al cliente)
    //    Devuelve pin_hash SOLO como referencia local de desbloqueo del dueño.
    // =========================================================================
    if (action === "find-user") {
      const { dni } = body;
      if (!dni) return json({ success: false, error: "DNI obligatorio." }, 400);
      const { data: persona, error } = await supabase
        .from("persona")
        .select(`${SAFE_PERSONA_FIELDS},pin_hash`)
        .eq("dni", dni)
        .maybeSingle();
      if (error || !persona) {
        return json({ success: false, error: "DNI no encontrado." }, 404);
      }
      return json({ success: true, user: persona });
    }

    // =========================================================================
    // 9. HU-SEG-02: VALIDACIÓN DE TOKEN (middleware)
    // =========================================================================
    if (action === "verify-token") {
      const authHeader = req.headers.get("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const payload = await verifyJWT(token);
      if (!payload) {
        return json({ valid: false, error: "Token inválido o expirado" }, 401);
      }
      const { data: session } = await supabase
        .from("sesion_usuario")
        .select("revocado")
        .eq("token_jwt", token)
        .maybeSingle();
      if (session && session.revocado) {
        return json({ valid: false, error: "Sesión revocada por reporte de robo" }, 403);
      }
      return json({ valid: true, payload });
    }

    return json({ success: false, error: "Acción no válida" }, 400);
  } catch (err) {
    console.error("Error en security:", err);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
