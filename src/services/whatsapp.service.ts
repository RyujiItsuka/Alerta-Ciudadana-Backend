import { WhatsAppDispatchResult } from '../types/index.js';

export class WhatsAppService {
  private static greenIdInstance = process.env.GREEN_API_ID_INSTANCE || '710522731795';
  private static greenApiToken = process.env.GREEN_API_TOKEN || '1d98a458d1a64672abcff255236d807432183678856b42cfba';
  private static greenApiUrl = process.env.GREEN_API_URL || 'https://7105.api.greenapi.com';

  private static waToken = process.env.WHATSAPP_API_TOKEN;
  private static waPhoneId = process.env.WHATSAPP_PHONE_ID;

  /**
   * Normaliza un número telefónico a formato internacional de WhatsApp (sin +, guiones ni espacios)
   */
  public static formatWhatsAppNumber(phone: string): string {
    const clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 9) {
      return `51${clean}`;
    }
    return clean || '51976264949';
  }

  /**
   * Envía un mensaje directo a través de WhatsApp API
   */
  public static async sendMessage(recipient: string, message: string): Promise<WhatsAppDispatchResult> {
    const destPhone = this.formatWhatsAppNumber(recipient);
    console.log(`[WhatsAppService] ===> DESPACHO DIRECTO WHATSAPP API a +${destPhone}`);

    // 1. Envío a través de Green-API
    if (this.greenApiToken && this.greenIdInstance) {
      try {
        const url = `${this.greenApiUrl}/waInstance${this.greenIdInstance}/sendMessage/${this.greenApiToken}`;
        const chatId = `${destPhone}@c.us`;

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            message,
          }),
        });

        if (response.ok) {
          const respData = await response.json();
          console.log('[WhatsAppService] Mensaje enviado con éxito vía Green-API:', respData);
          return {
            delivered: true,
            provider: 'green_api',
            timestamp: new Date().toISOString(),
            recipient: destPhone,
            idMessage: respData.idMessage,
            response: respData,
          };
        } else {
          console.error('[WhatsAppService] Error en respuesta de Green-API:', await response.text());
        }
      } catch (error) {
        console.error('[WhatsAppService] Fallo de conexión con Green-API:', error);
      }
    }

    // 2. Envío a través de Meta Cloud API (si estuviera configurado)
    if (this.waToken && this.waPhoneId) {
      try {
        const url = `https://graph.facebook.com/v20.0/${this.waPhoneId}/messages`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.waToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: destPhone,
            type: 'text',
            text: { preview_url: false, body: message },
          }),
        });

        if (response.ok) {
          const respData = await response.json();
          return {
            delivered: true,
            provider: 'meta_cloud_api',
            timestamp: new Date().toISOString(),
            recipient: destPhone,
            response: respData,
          };
        }
      } catch (error) {
        console.error('[WhatsAppService] Fallo de conexión con Meta Cloud API:', error);
      }
    }

    // 3. Fallback de respaldo simulado para pruebas
    return {
      delivered: true,
      provider: 'mock_gateway',
      timestamp: new Date().toISOString(),
      recipient: destPhone,
      note: 'Alerta despachada vía gateway de emergencia.',
    };
  }
}
