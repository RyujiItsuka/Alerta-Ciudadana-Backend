export interface Coordinates {
  lat: number;
  lon: number;
}

export interface CitizenData {
  dni?: string;
  name?: string;
  phone?: string;
}

export interface Alert {
  id: string;
  category: string;
  message: string;
  recipientNumber: string;
  source: string;
  coordinates: Coordinates;
  address?: string;
  timestamp: string;
  citizen?: CitizenData;
}

export interface TrackingPoint {
  lat: number;
  lon: number;
  timestamp: string;
  speed?: string;
}

export interface TrackingSession {
  alertId: string;
  status: 'active' | 'stopped';
  category: string;
  startTime: string;
  points: TrackingPoint[];
  citizen?: CitizenData;
}

export interface WhatsAppDispatchResult {
  delivered: boolean;
  provider: 'green_api' | 'meta_cloud_api' | 'mock_gateway';
  timestamp: string;
  recipient: string;
  idMessage?: string;
  response?: unknown;
  note?: string;
}
