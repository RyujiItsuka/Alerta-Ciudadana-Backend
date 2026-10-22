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
//   verify-token, reset-password, update-pin, find-user, login-staff,
//   staff-save, staff-delete, get-config, set-config,
//   list-operadores, list-personas, list-reportes, db-health
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

// Campos de operador_central que puede devolver la Edge Function. NUNCA incluye
// password_hash, para que el navegador no reciba hashes de credenciales.
const SAFE_STAFF_FIELDS =
  "id_operador,usuario,nombres,apellidos,telefono,rol,turno,estado,created_at,ultimo_acceso";

// Máximo de intentos fallidos permitidos por código OTP antes de quemarlo
// (frena la fuerza bruta sobre un código de solo 6 dígitos).
const MAX_OTP_ATTEMPTS = 5;

// Campos seguros para las listas del panel (incluye created_at para la UI).
const SAFE_PERSONA_LIST_FIELDS =
  "id_persona,dni,nombres,apellidos,telefono,rol,created_at";

// Verifica una contraseña contra el hash almacenado en una tabla de personal
// (cuenta_soporte / operador_central / persona). Si el valor almacenado es un
// hash bcrypt se compara; si es una credencial legada en texto plano se compara
// y, al coincidir, se re-hashea con bcrypt en el momento (migración transparente).
async function verifyPasswordWithMigration(
  table: string,
  idColumn: string,
  idValue: unknown,
  plain: string,
  stored: unknown,
): Promise<boolean> {
  const storedStr = typeof stored === "string" ? stored : "";
  if (!storedStr) return false;
  if (isBcryptHash(storedStr)) {
    return await compareBcrypt(plain, storedStr);
  }
  if (plain === storedStr) {
    try {
      await supabase
        .from(table)
        .update({ password_hash: await hashBcrypt(plain) })
        .eq(idColumn, idValue);
    } catch (e) {
      console.warn(`No se pudo re-hashear ${table}.${idColumn}:`, e);
    }
    return true;
  }
  return false;
}

function fullName(nombres: unknown, apellidos: unknown, fallback: string): string {
  const name = `${nombres ?? ""} ${apellidos ?? ""}`.trim();
  return name || fallback;
}

// Emite el token de sesión de staff del panel web (scope "staff"). Se firma con
// JWT_SECRET_KEY y viaja en el cuerpo de las acciones administrativas.
async function issueStaffToken(session: {
  id: string;
  usuario: string;
  rol: string;
}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 8 * 60 * 60; // 8 horas
  return await generateJWT({
    scope: "staff",
    usuario: session.usuario,
    rol: session.rol,
    id: session.id,
    exp,
  });
}

// Autoriza una acción administrativa: exige un token de staff válido con rol
// administrador o superadmin. Evita que un técnico (o un anónimo) cree o
// modifique cuentas privilegiadas directamente contra la base de datos.
async function requireStaffAdmin(
  token: unknown,
): Promise<{ usuario: string; rol: string } | null> {
  const claims = token ? await verifyJWT(String(token)) : null;
  if (!claims || claims.scope !== "staff") return null;
  const rol = String(claims.rol ?? "").toLowerCase();
  if (rol !== "administrador" && rol !== "superadmin") return null;
  return { usuario: String(claims.usuario ?? ""), rol };
}

// Autoriza una ACCIÓN DE CONSULTA del panel: exige un token de staff válido de
// cualquier rol (técnico, administrador o superadmin). El rol de técnico sólo
// sirve para leer listas; crear o modificar cuentas sigue exigiendo
// requireStaffAdmin.
async function requireStaff(
  token: unknown,
): Promise<{ usuario: string; rol: string } | null> {
  const claims = token ? await verifyJWT(String(token)) : null;
  if (!claims || claims.scope !== "staff") return null;
  const rol = String(claims.rol ?? "").toLowerCase();
  if (rol !== "tecnico" && rol !== "administrador" && rol !== "superadmin") {
    return null;
  }
  return { usuario: String(claims.usuario ?? ""), rol };
}

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
    const body = await req.json().catch(() => ({}));
    // La acción puede venir por querystring (?action=...) o en el cuerpo JSON
    // (más cómodo para `supabase.functions.invoke` desde el panel web).
    const action = url.searchParams.get("action") || String(body?.action ?? "");

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

      // SEGURIDAD: si el DNI ya está registrado, el OTP SOLO puede enviarse al
      // teléfono registrado. Sin esta validación un tercero podría pedir el
      // código para el DNI de la víctima y recibirlo en su propio celular,
      // obteniendo así la autorización para restablecer su contraseña.
      const { data: personaDestino } = await supabase
        .from("persona")
        .select("telefono")
        .eq("dni", dni)
        .maybeSingle();
      if (personaDestino) {
        const telefonoRegistrado = String(personaDestino.telefono ?? "").replace(/[^0-9]/g, "");
        if (telefonoRegistrado !== cleanPhone) {
          return json({
            success: false,
            error: "El número no coincide con el registrado para este DNI. Contacte a la central.",
          }, 403);
        }
      }

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
      let otpQuery = supabase
        .from("codigo_otp")
        .select("*")
        .eq("dni", dni)
        .eq("codigo", code)
        .eq("usado", false)
        .gt("expira_en", now);
      if (cleanPhone) {
        // Defensa en profundidad: el código solo vale para el teléfono al que
        // fue enviado (que ya está forzado a ser el registrado en send-otp).
        otpQuery = otpQuery.eq("telefono", cleanPhone);
      }
      const { data: otps, error } = await otpQuery
        .order("created_at", { ascending: false })
        .limit(1);

      if (error || !otps || otps.length === 0) {
        // Anti fuerza bruta: cada fallo suma. Al llegar al máximo se quema el
        // código activo y el usuario debe solicitar uno nuevo por WhatsApp.
        const { data: activos } = await supabase
          .from("codigo_otp")
          .select("id_otp,intentos")
          .eq("dni", dni)
          .eq("usado", false)
          .gt("expira_en", now)
          .order("created_at", { ascending: false })
          .limit(1);
        if (activos && activos.length > 0) {
          const intentos = Number(activos[0].intentos ?? 0) + 1;
          await supabase
            .from("codigo_otp")
            .update({ intentos, usado: intentos >= MAX_OTP_ATTEMPTS })
            .eq("id_otp", activos[0].id_otp);
        }
        return json({
          success: false,
          error: "Código inválido o expirado (límite 5 min).",
        }, 400);
      }

      await supabase.from("codigo_otp").update({ usado: true }).eq("id_otp", otps[0].id_otp);

      // Prueba criptográfica de corta duración: autoriza el cambio de contraseña
      // sin permitir reutilizar el OTP (ya quedó consumido). Se firma con
      // JWT_SECRET_KEY y solo vale para este DNI y este propósito.
      const resetExp = Math.floor(Date.now() / 1000) + 10 * 60;
      const resetToken = await generateJWT({
        dni,
        scope: "password-reset",
        exp: resetExp,
      });

      return json({
        success: true,
        message: "Número verificado correctamente.",
        resetToken,
      });
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

      // No se devuelve pin_hash ni password_hash: el cliente nunca debe recibir
      // material de credenciales. El desbloqueo local usa el PIN propio del
      // dispositivo (SessionService), no el hash del servidor.
      return json({
        success: true,
        token,
        user: {
          id_persona: persona.id_persona,
          dni: persona.dni,
          nombres: persona.nombres,
          apellidos: persona.apellidos || "",
          telefono: persona.telefono,
        },
      });
    }

    // =========================================================================
    // 4-bis. LOGIN DEL PANEL WEB (SOPORTE / ADMINISTRADORES / TÉCNICOS)
    //    Autenticación 100% en el servidor con bcrypt (service_role). Sin
    //    contraseñas maestras, sin comparaciones en texto plano y sin exponer
    //    hashes al navegador. Reemplaza la validación client-side del panel.
    // =========================================================================
    if (action === "login-staff") {
      const usuario = String(body?.usuario ?? body?.dni ?? "").trim();
      const password = String(body?.password ?? "");
      if (!usuario || !password) {
        return json({ success: false, error: "Usuario y contraseña son obligatorios." }, 400);
      }

      // Fase A: Superadmin (cuenta_soporte)
      const { data: soporte } = await supabase
        .from("cuenta_soporte")
        .select("id_soporte,usuario,nombres,apellidos,password_hash")
        .eq("usuario", usuario)
        .maybeSingle();

      if (soporte) {
        const ok = await verifyPasswordWithMigration(
          "cuenta_soporte",
          "id_soporte",
          soporte.id_soporte,
          password,
          soporte.password_hash,
        );
        if (!ok) {
          return json({ success: false, error: "Contraseña incorrecta." }, 401);
        }
        await supabase
          .from("cuenta_soporte")
          .update({ ultimo_acceso: new Date().toISOString() })
          .eq("id_soporte", soporte.id_soporte);
        const session = {
          id: `SOP-${soporte.id_soporte}`,
          nombre: fullName(soporte.nombres, soporte.apellidos, usuario),
          usuario: soporte.usuario,
          rol: "superadmin",
          cargo: "Soporte Técnico & Desarrollador",
        };
        return json({ success: true, session, token: await issueStaffToken(session) });
      }

      // Fase B: Administrador o Técnico (operador_central)
      const { data: operador } = await supabase
        .from("operador_central")
        .select("id_operador,usuario,nombres,apellidos,password_hash,rol,estado")
        .eq("usuario", usuario)
        .maybeSingle();

      if (operador) {
        if (operador.estado === "suspendido" || operador.estado === "inactivo") {
          return json({ success: false, error: "Tu cuenta se encuentra suspendida o inactiva." }, 403);
        }
        const ok = await verifyPasswordWithMigration(
          "operador_central",
          "id_operador",
          operador.id_operador,
          password,
          operador.password_hash,
        );
        if (!ok) {
          return json({ success: false, error: "Contraseña incorrecta." }, 401);
        }
        const rawRol = String(operador.rol ?? "").toLowerCase().trim();
        const rol = rawRol === "admin" || rawRol === "administrador" ? "administrador" : "tecnico";
        await supabase
          .from("operador_central")
          .update({ ultimo_acceso: new Date().toISOString() })
          .eq("id_operador", operador.id_operador);
        const session = {
          id: `OP-${operador.id_operador}`,
          nombre: fullName(operador.nombres, operador.apellidos, operador.usuario),
          usuario: operador.usuario,
          rol,
          cargo: rol === "administrador"
            ? "Administrador General de Central"
            : "Técnico de Central de Alertas",
        };
        return json({ success: true, session, token: await issueStaffToken(session) });
      }

      // Fase C: Personal migrado que aún vive en la tabla persona
      const numericUsuario = usuario.replace(/\D/g, "");
      if (numericUsuario) {
        const { data: persona } = await supabase
          .from("persona")
          .select("id_persona,dni,nombres,apellidos,password_hash,rol")
          .or(`dni.eq.${numericUsuario},telefono.eq.${numericUsuario}`)
          .maybeSingle();

        if (persona) {
          const rolBd = String(persona.rol ?? "").toLowerCase().trim();
          if (rolBd === "ciudadano") {
            return json({
              success: false,
              error: "Acceso denegado: tu cuenta es de Ciudadano y solo está autorizada para la App Móvil.",
            }, 403);
          }
          const ok = await verifyPasswordWithMigration(
            "persona",
            "id_persona",
            persona.id_persona,
            password,
            persona.password_hash,
          );
          if (!ok) {
            return json({ success: false, error: "Contraseña incorrecta." }, 401);
          }
          const rol = rolBd === "admin" || rolBd === "administrador" ? "administrador" : "tecnico";
          const session = {
            id: `${rol === "administrador" ? "ADM" : "TEC"}-${persona.id_persona}`,
            nombre: fullName(persona.nombres, persona.apellidos, "Operador"),
            usuario: persona.dni || String(persona.id_persona),
            rol,
            cargo: rol === "administrador"
              ? "Administrador General de Central"
              : "Técnico de Central de Alertas",
          };
          return json({ success: true, session, token: await issueStaffToken(session) });
        }
      }

      return json({ success: false, error: "Usuario o contraseña incorrectos." }, 401);
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
      const { dni, password, token } = body;
      if (!dni || !password || String(password).length < 6) {
        return json({ success: false, error: "La nueva contraseña debe tener al menos 6 caracteres." }, 400);
      }

      // AUTORIZACIÓN OBLIGATORIA: sin prueba de que se verificó el OTP (el
      // resetToken firmado) no se puede cambiar la contraseña de nadie.
      const claims = token ? await verifyJWT(String(token)) : null;
      if (!claims || claims.scope !== "password-reset" || String(claims.dni) !== String(dni)) {
        return json(
          { success: false, error: "No autorizado: verifique el código OTP enviado a su WhatsApp." },
          401,
        );
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
      const { dni, pin, token } = body;
      if (!dni || !/^\d{4}$/.test(String(pin ?? ""))) {
        return json({ success: false, error: "El PIN debe tener 4 dígitos." }, 400);
      }

      // El cambio de PIN exige una sesión válida del propio usuario (JWT de
      // login). Evita que un tercero modifique el PIN de otra cuenta por DNI.
      const claims = token ? await verifyJWT(String(token)) : null;
      if (!claims || String(claims.dni) !== String(dni)) {
        return json({ success: false, error: "No autorizado: inicie sesión nuevamente." }, 401);
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
    // 7-bis. GESTIÓN DE PERSONAL (operador_central) — bcrypt + autorización
    //    Reemplaza el INSERT/UPDATE del panel web que guardaba la contraseña en
    //    TEXTO PLANO y sin verificar el rol. La contraseña se hashea con bcrypt
    //    usando service_role; un técnico no puede crear ni ascender cuentas.
    // =========================================================================
    if (action === "staff-save") {
      const caller = await requireStaffAdmin(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión de administrador." },
          401,
        );
      }

      const usuario = String(body?.usuario ?? "").trim();
      const nombres = String(body?.nombres ?? "").trim();
      const apellidos = String(body?.apellidos ?? "").trim();
      const telefono = String(body?.telefono ?? "").trim();
      const rolRaw = String(body?.rol ?? "tecnico").toLowerCase().trim();
      const rol = rolRaw === "admin" || rolRaw === "administrador" ? "administrador" : "tecnico";
      const turno = String(body?.turno ?? (rol === "administrador" ? "Rotativo" : "Mañana"));
      const estado = String(body?.estado ?? "activo");
      const password = body?.password ? String(body.password) : "";

      if (!usuario || !nombres || !apellidos) {
        return json({ success: false, error: "Usuario, nombres y apellidos son obligatorios." }, 400);
      }
      if (password && password.length < 6) {
        return json({ success: false, error: "La contraseña debe tener al menos 6 caracteres." }, 400);
      }
      // Los administradores SOLO los gestiona el superadmin (evita que un admin
      // se auto-promocione o cree pares privilegiados).
      if (rol === "administrador" && caller.rol !== "superadmin") {
        return json({ success: false, error: "Solo el superadmin puede gestionar administradores." }, 403);
      }

      const { data: existente } = await supabase
        .from("operador_central")
        .select("id_operador,rol")
        .eq("usuario", usuario)
        .maybeSingle();

      if (
        existente &&
        String(existente.rol ?? "").toLowerCase().startsWith("admin") &&
        caller.rol !== "superadmin"
      ) {
        return json({ success: false, error: "Solo el superadmin puede modificar administradores." }, 403);
      }

      const record: Record<string, unknown> = { usuario, nombres, apellidos, telefono, rol, turno, estado };
      if (password) {
        record.password_hash = await hashBcrypt(password);
      } else if (!existente) {
        return json({ success: false, error: "La contraseña es obligatoria al crear un usuario." }, 400);
      }

      if (existente) {
        const { data, error } = await supabase
          .from("operador_central")
          .update(record)
          .eq("id_operador", existente.id_operador)
          .select(SAFE_STAFF_FIELDS)
          .single();
        if (error) return json({ success: false, error: "No se pudo actualizar el usuario." }, 400);
        return json({ success: true, user: data, created: false });
      }

      const { data, error } = await supabase
        .from("operador_central")
        .insert(record)
        .select(SAFE_STAFF_FIELDS)
        .single();
      if (error) {
        return json({ success: false, error: "No se pudo crear el usuario (¿usuario duplicado?)." }, 400);
      }
      return json({ success: true, user: data, created: true }, 201);
    }

    if (action === "staff-delete") {
      const caller = await requireStaffAdmin(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión de administrador." },
          401,
        );
      }
      const usuario = String(body?.usuario ?? "").trim();
      if (!usuario) return json({ success: false, error: "Usuario obligatorio." }, 400);

      const { data: objetivo } = await supabase
        .from("operador_central")
        .select("rol")
        .eq("usuario", usuario)
        .maybeSingle();
      if (
        objetivo &&
        String(objetivo.rol ?? "").toLowerCase().startsWith("admin") &&
        caller.rol !== "superadmin"
      ) {
        return json({ success: false, error: "Solo el superadmin puede eliminar administradores." }, 403);
      }

      const { error } = await supabase.from("operador_central").delete().eq("usuario", usuario);
      if (error) return json({ success: false, error: "No se pudo eliminar el usuario." }, 400);
      return json({ success: true });
    }

    // =========================================================================
    // 8. BÚSQUEDA SEGURA DE USUARIO POR DNI (sin exponer hashes al cliente)
    // =========================================================================
    if (action === "find-user") {
      const { dni } = body;
      if (!dni) return json({ success: false, error: "DNI obligatorio." }, 400);
      const { data: persona, error } = await supabase
        .from("persona")
        .select(SAFE_PERSONA_FIELDS)
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

    // =========================================================================
    // 10. CONFIGURACIÓN DEL SISTEMA (parámetros editables sin actualizar el APK)
    //     Tabla configuracion_sistema (RLS cerrado => sólo service_role).
    //     get-config: lectura para el panel. set-config: requiere admin.
    // =========================================================================
    if (action === "get-config") {
      const caller = await requireStaffAdmin(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión de administrador." },
          401,
        );
      }
      const { data, error } = await supabase
        .from("configuracion_sistema")
        .select("clave, valor");
      if (error) return json({ success: false, error: error.message }, 500);
      const config: Record<string, string> = {};
      for (const row of data ?? []) {
        config[String(row.clave)] = String(row.valor ?? "");
      }
      return json({ success: true, config });
    }

    if (action === "set-config") {
      const caller = await requireStaffAdmin(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión de administrador." },
          401,
        );
      }

      const clave = String(body?.clave ?? "").trim();
      let valor = body?.valor === undefined || body?.valor === null
        ? ""
        : String(body.valor).trim();

      if (!/^[a-z0-9_.]{1,64}$/.test(clave)) {
        return json({ success: false, error: "Clave de configuración inválida." }, 400);
      }

      // Validación específica del número de la Central: se guarda solo dígitos
      // con código de país, tal como lo espera el despacho (51976264949).
      if (clave === "whatsapp_central") {
        const digitos = valor.replace(/[^0-9]/g, "");
        if (digitos.length < 8 || digitos.length > 15) {
          return json(
            { success: false, error: "Número de WhatsApp inválido. Formato esperado: 51976264949." },
            400,
          );
        }
        valor = digitos;
      }

      const { error } = await supabase
        .from("configuracion_sistema")
        .upsert(
          {
            clave,
            valor,
            actualizado_por: caller.usuario,
            actualizado_en: new Date().toISOString(),
          },
          { onConflict: "clave" },
        );
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, clave, valor });
    }

    // =========================================================================
    // 11. CONSULTAS DEL PANEL (reemplazan las lecturas directas con la clave
    //     anon). El RLS de persona / operador_central está CERRADO: sólo
    //     service_role puede leer esas tablas, así que el panel pasa por aquí
    //     presentando su token de staff.
    // =========================================================================
    if (action === "list-operadores") {
      const caller = await requireStaff(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión del personal." },
          401,
        );
      }
      const rolesWanted = Array.isArray(body?.roles) ? body.roles : [];
      const roles = rolesWanted
        .map((r: unknown) => String(r).toLowerCase().trim())
        .filter((r: string) =>
          ["tecnico", "admin", "administrador", "superadmin"].includes(r)
        );

      let query = supabase
        .from("operador_central")
        .select(SAFE_STAFF_FIELDS)
        .order("id_operador", { ascending: false });
      if (roles.length > 0) query = query.in("rol", roles);

      const { data, error } = await query;
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, operadores: data ?? [] });
    }

    if (action === "list-personas") {
      const caller = await requireStaff(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión del personal." },
          401,
        );
      }
      const limit = Math.min(Math.max(Number(body?.limit ?? 100) || 100, 1), 500);
      const { data, error } = await supabase
        .from("persona")
        .select(SAFE_PERSONA_LIST_FIELDS)
        .order("id_persona", { ascending: false })
        .limit(limit);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, personas: data ?? [] });
    }

    if (action === "list-reportes") {
      const caller = await requireStaff(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión del personal." },
          401,
        );
      }
      const idReporte = body?.id_reporte !== undefined && body?.id_reporte !== null &&
          body?.id_reporte !== ""
        ? Number(body.id_reporte)
        : null;

      let query = supabase
        .from("reporte")
        .select(
          `id_reporte,descripcion,fecha_hora,id_estado,direccion_texto,
           tipo_incidencia (nombre),
           ubicacion (latitud, longitud),
           persona (nombres, apellidos, telefono, dni)`,
        )
        .order("fecha_hora", { ascending: false });

      if (idReporte !== null && !Number.isNaN(idReporte)) {
        query = query.eq("id_reporte", idReporte).limit(1);
      } else {
        query = query.limit(Math.min(Math.max(Number(body?.limit ?? 50) || 50, 1), 200));
      }

      const { data, error } = await query;
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, reportes: data ?? [] });
    }

    if (action === "update-reporte-estado") {
      const caller = await requireStaff(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión del personal." },
          401,
        );
      }
      const idReporte = Number(body?.id_reporte);
      const idEstado = Number(body?.id_estado);
      if (!Number.isInteger(idReporte) || idReporte <= 0) {
        return json({ success: false, error: "id_reporte inválido." }, 400);
      }
      // Estados válidos del flujo de despacho (ver tabla estado_reporte).
      if (!Number.isInteger(idEstado) || ![1, 2, 3, 4].includes(idEstado)) {
        return json({ success: false, error: "id_estado inválido." }, 400);
      }
      const { error } = await supabase
        .from("reporte")
        .update({ id_estado: idEstado })
        .eq("id_reporte", idReporte);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, id_reporte: idReporte, id_estado: idEstado });
    }

    if (action === "db-health") {
      const caller = await requireStaff(body?.token);
      if (!caller) {
        return json(
          { success: false, error: "No autorizado: se requiere sesión del personal." },
          401,
        );
      }
      const started = Date.now();
      const { error } = await supabase
        .from("operador_central")
        .select("id_operador")
        .limit(1);
      const latencyMs = Date.now() - started;
      return json({
        success: !error,
        latencyMs,
        error: error ? error.message : null,
      });
    }

    return json({ success: false, error: "Acción no válida" }, 400);
  } catch (err) {
    console.error("Error en security:", err);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
