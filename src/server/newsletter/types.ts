// Newsletter DTOs (spec/api.md → Phase 2: POST /api/newsletter, GET /api/admin/subscribers).
// Pure types — safe to import (type-only) from client components.

export type SubscriberStatus = 'subscribed' | 'unsubscribed';

export interface NewsletterSubscribeResponse {
  subscribed: true;
}

export interface SubscriberDto {
  email: string;
  name: string | null;
  createdAt: string;
  status: SubscriberStatus;
}

export interface SubscriberListResponse {
  subscribers: SubscriberDto[];
  total: number;
}
