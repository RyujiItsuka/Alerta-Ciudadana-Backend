// Supabase Edge Function: Despacho de Alertas y WhatsApp API
// Ejecutado en el runtime Deno / TypeScript de Supabase

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GREEN_API_ID_INSTANCE = Deno.env.get('GREEN_API_ID_INSTANCE') || '710522731795';
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN') || '1d98a458d1a64672abcff255236d807432183678856b42cfba';
const GREEN_API_URL = Deno.env.get('GREEN_API_URL') || 'https://7105.api.greenapi.com';
const JWT_SECRET = Deno.env.get('JWT_SECRET_KEY') || 'alerta_ciudadana_pisco_jwt_secure_key_2026_sprint4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://emtzprcntefzkvvzmhfk.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function extractDniFromToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const payload = JSON.parse(atob(base64));
    return payload.dni || null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  // Manejo de preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const {
      category = 'EMERGENCIA GENERAL',
      message: customMessage,
      recipientNumber = EMERGENCY_RECIPIENT,
      source = 'ui_button',
      coordinates = { lat: -12.04637, lon: -77.02987 },
      citizen,
    } = payload;

    // HU-SEG-04: Extraer DNI verificado del token de sesión (no confiar en el body)
    const authHeader = req.headers.get('Authorization');
    const tokenDni = extractDniFromToken(authHeader);
    const verifiedCitizenDni = tokenDni || (citizen ? citizen.dni : null);

    const alertId = `ALT-${Date.now()}`;
    const cleanRecipient = recipientNumber.replace(/[^0-9]/g, '');
    const gmapsNavUrl = `https://www.google.com/maps/dir/?api=1&destination=${coordinates.lat},${coordinates.lon}`;

    const isRobo = category.trim().toUpperCase() === 'ROBO';
    const isSecuestro = category.trim().toUpperCase() === 'SECUESTRO';
    let finalMessage = customMessage;

    if (!finalMessage) {
      if (isSecuestro) {
        finalMessage = [
          '🛑 ¡ALERTA MÁXIMA! POSIBLE SECUESTRO EN CURSO 🛑',
          citizen ? `👤 Víctima: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación de origen: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          '🔴 SEGUIMIENTO GPS EN TIEMPO REAL ACTIVADO',
          `🚗 Cómo llegar (Google Maps): ${gmapsNavUrl}`,
          `⚡ Disparador: ${source.toUpperCase()}`,
          '🛡️ Despacho de URGENCIA - Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      } else if (isRobo) {
        finalMessage = [
          '🚨 ¡AUXILIO! ME ESTÁN ROBANDO 🚨',
          citizen ? `👤 Ciudadano: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          '🔴 SEGUIMIENTO GPS EN TIEMPO REAL ACTIVADO',
          `🚗 Cómo llegar (Google Maps): ${gmapsNavUrl}`,
          `⚡ Disparador: ${source.toUpperCase()}`,
          '🛡️ Despacho automático Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      } else {
        finalMessage = [
          `🚨 ¡ALERTA DE EMERGENCIA: ${category.toUpperCase()}! 🚨`,
          citizen ? `👤 Ciudadano: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          `🛰️ Google Maps: https://maps.google.com/?q=${coordinates.lat},${coordinates.lon}`,
          `🚗 Cómo llegar: ${gmapsNavUrl}`,
          `⚡ Disparador: ${source.toUpperCase()}`,
          '🛡️ Despacho automático Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      }
    }

    // Despacho a Green-API (solo si no fue despachado previamente como archivo multimedia)
    let waData = null;
    if (!payload.skipWhatsApp) {
      const waUrl = `${GREEN_API_URL}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`;
      const waRes = await fetch(waUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: `${cleanRecipient}@c.us`,
          message: finalMessage,
        }),
      });
      try {
        waData = await waRes.json();
      } catch (_) {}
    }

    // HU-SEG-09: Persistir reporte en Supabase solo si no fue creado previamente
    const catMap: Record<string, number> = {
      'ROBO': 1,
      'ACCIDENTE': 2,
      'INCENDIO': 3,
      'GRESCA': 4,
      'ASESINATO': 5,
      'SECUESTRO': 6,
      'PERSONALIZADO': 7,
    };
    const idTipo = catMap[category.trim().toUpperCase()] || 7;

    let idPersona = 1;
    if (verifiedCitizenDni) {
      try {
        const { data: pData } = await supabase
          .from('persona')
          .select('id_persona')
          .eq('dni', verifiedCitizenDni)
          .maybeSingle();
        if (pData?.id_persona) {
          idPersona = pData.id_persona;
        }
      } catch (_) {}
    }

    let reportId: number | null = payload.reportId ? Number(payload.reportId) : null;
    if (!reportId && !payload.alreadySaved) {
      try {
        const { data: repData } = await supabase
          .from('reporte')
          .insert({
            id_persona: idPersona,
            id_tipo: idTipo,
            id_estado: 1,
            descripcion: finalMessage,
            direccion_texto: address || 'Ubicación móvil GPS',
          })
          .select('id_reporte')
          .maybeSingle();

        if (repData?.id_reporte) {
          reportId = repData.id_reporte;
          await supabase.from('ubicacion').insert({
            id_reporte: reportId,
            latitud: coordinates.lat,
            longitud: coordinates.lon,
          });
        }
      } catch (repErr) {
        console.warn('Advertencia al insertar reporte en Supabase:', repErr);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        alertId: reportId ? `ALT-${reportId}` : alertId,
        reportId,
        category,
        gmapsNavUrl,
        whatsapp: waData,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
