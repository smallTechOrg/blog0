import 'server-only';

// The LLM boundary (SMA-44): one OpenAI-compatible chat client. Which endpoint, model and key it
// uses is the site's AI provider (src/server/ai/provider.ts → getAi / resolveAi), not env config.

export { ChatClient, parseJsonReply, writerMessage } from './chat';
export { LlmError } from './types';
export type { ChatMessage, ChatRequest, ChatResponse, LlmClient, LlmErrorCode, LlmUsage } from './types';
