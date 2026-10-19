import { WhatsAppDispatchResult } from '../types/index.js';

export class WhatsAppService {
  // Se leen en tiempo de ejecución (getters) para garantizar que dotenv ya
  // cargó el .env, sin depender del orden de importación de módulos.
  private static get greenIdInstance(): string {
    return process.env.GREEN_API_ID_INSTANCE || process.env.GREEN_API_INSTANCE_ID || '';
  }
  private static get greenApiToken(): string {
    return process.env.GREEN_API_TOKEN || '';
  }
  private static get greenApiUrl(): string {
    return process.env.GREEN_API_URL || 'https://7105.api.greenapi.com';
  }

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
   * Envía un mensaje directo a través de WhatsApp API (Green-API)
   */
  public static async sendMessage(recipient: string, message: string): Promise<WhatsAppDispatchResult> {
    const destPhone = this.formatWhatsAppNumber(recipient);

    if (!this.greenApiToken || !this.greenIdInstance) {
      console.warn('[WhatsAppService] Green-API no configurado (GREEN_API_TOKEN / GREEN_API_ID_INSTANCE): despacho no realizado.');
      return {
        delivered: false,
        provider: 'none',
        timestamp: new Date().toISOString(),
        recipient: destPhone,
        note: 'Green-API no configurado.',
      };
    }

    try {
      const url = `${this.greenApiUrl}/waInstance${this.greenIdInstance}/sendMessage/${this.greenApiToken}`;
      const chatId = `${destPhone}@c.us`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message }),
      });

      if (response.ok) {
        const respData = (await response.json()) as { idMessage?: string } & Record<string, unknown>;
        return {
          delivered: true,
          provider: 'green_api',
          timestamp: new Date().toISOString(),
          recipient: destPhone,
          idMessage: respData.idMessage,
          response: respData,
        };
      }

      console.error('[WhatsAppService] Error en respuesta de Green-API:', await response.text());
    } catch (error) {
      console.error('[WhatsAppService] Fallo de conexión con Green-API:', error);
    }

    return {
      delivered: false,
      provider: 'none',
      timestamp: new Date().toISOString(),
      recipient: destPhone,
      note: 'No se pudo despachar el mensaje vía Green-API.',
    };
  }
}
