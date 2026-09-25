import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import sharp from 'sharp';
import { getConfig } from './config-manager.js';

// claude-3-5-sonnet-20241022, the previous default, is retired: every call to
// it failed and alt text went silently missing. Set `model` in the AI settings
// to use a different (e.g. cheaper) Claude model.
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

interface ResolvedAiProvider {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

// Determine Provider and Credentials.
// Priority: AI Config > Legacy Gemini Config > Environment Variables.
// Returns null when alt-text generation is effectively disabled (no usable credentials).
function resolveAiProvider(): ResolvedAiProvider | null {
  const config = getConfig();

  const provider = config.ai?.provider || 'gemini';
  let apiKey = config.ai?.apiKey;
  let model = config.ai?.model;
  const baseUrl = config.ai?.baseUrl;

  // Fallbacks for Environment Variables
  if (!apiKey) {
    if (process.env.AI_API_KEY) apiKey = process.env.AI_API_KEY;
    else if (provider === 'gemini') apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    else if (provider === 'openai') apiKey = process.env.OPENAI_API_KEY;
    else if (provider === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY;
  }

  // API Key is mandatory for Gemini and Anthropic
  if (!apiKey && (provider === 'gemini' || provider === 'anthropic')) {
    return null;
  }

  // OpenAI without a key only makes sense against a custom base URL (e.g. a
  // local server); against api.openai.com it would fail on every image.
  if (provider === 'openai' && !apiKey && !baseUrl) {
    return null;
  }

  // Custom providers need at least a base URL to call.
  if (provider === 'custom' && !baseUrl) {
    return null;
  }

  // Default Models
  if (!model) {
    if (provider === 'gemini') model = 'models/gemini-2.5-flash';
    else if (provider === 'openai') model = 'gpt-4o';
    else if (provider === 'anthropic') model = DEFAULT_ANTHROPIC_MODEL;
  }

  return { provider, apiKey, model, baseUrl };
}

// Whether alt-text generation is configured/enabled at all. Many instances
// run without it; callers should skip the generation step entirely when false.
export function isAltTextConfigured(): boolean {
  return resolveAiProvider() !== null;
}

export async function generateAltText(
  originalBuffer: Buffer,
  originalMimeType: string,
  contextText: string,
): Promise<string | undefined> {
  const resolved = resolveAiProvider();
  if (!resolved) {
    return undefined;
  }
  const { provider, apiKey, model, baseUrl } = resolved;

  try {
    const prompt = buildAltTextPrompt(contextText);
    // Full-resolution originals routinely exceed the providers' image limits
    // (Anthropic rejects anything over 5MB), which failed the request and left
    // the image without alt text. Vision models see no more detail than this.
    const { buffer, mimeType } = await prepareImageForVision(originalBuffer, originalMimeType);
    switch (provider) {
      case 'gemini':
        // apiKey is guaranteed by check above
        return normalizeAltTextOutput(
          await callGemini(apiKey!, model || 'models/gemini-2.5-flash', buffer, mimeType, prompt),
        );
      case 'openai':
      case 'custom':
        return normalizeAltTextOutput(
          await callOpenAICompatible(apiKey, model || 'gpt-4o', baseUrl, buffer, mimeType, prompt),
        );
      case 'anthropic':
        // apiKey is guaranteed by check above
        return normalizeAltTextOutput(
          await callAnthropic(apiKey!, model || DEFAULT_ANTHROPIC_MODEL, baseUrl, buffer, mimeType, prompt),
        );
      default:
        console.warn(`[AI] ⚠️ Unknown provider: ${provider}`);
        return undefined;
    }
  } catch (err) {
    console.warn(`[AI] ⚠️ Failed to generate alt text with ${provider}: ${(err as Error).message}`);
    return undefined;
  }
}

const ALT_TEXT_CONTEXT_MAX_CHARS = 400;

function buildAltTextPrompt(contextText: string): string {
  const normalized = contextText.replace(/\s+/g, ' ').trim();
  const trimmed =
    normalized.length > ALT_TEXT_CONTEXT_MAX_CHARS
      ? `${normalized.slice(0, ALT_TEXT_CONTEXT_MAX_CHARS).trim()}...`
      : normalized;

  return [
    'Write one alt text description (1-2 sentences).',
    'Describe only what is visible.',
    'Use context to identify people/places/objects if relevant for search.',
    'Describe only this image; ignore other images in the post.',
    'Return only the alt text with no labels, quotes, or options.',
    'No hashtags or emojis.',
    `Context: "${trimmed}"`,
  ].join(' ');
}

function normalizeAltTextOutput(output: string | undefined): string | undefined {
  if (!output) return undefined;

  let cleaned = output.trim();
  if (!cleaned) return undefined;

  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  cleaned = cleaned.replace(/^(alt\s*text|description)\s*[:\-]\s*/i, '').trim();

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line): line is string => Boolean(line));
  if (lines.length > 0) cleaned = lines[0] ?? '';

  cleaned = cleaned.replace(/^option\s*\d+\s*[:\-]\s*/i, '').trim();
  cleaned = cleaned.replace(/^[\-\*\d\.\)]+\s*/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || undefined;
}

async function callGemini(
  apiKey: string,
  modelName: string,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName }, { timeout: 60_000 });

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType,
      },
    },
  ]);
  const response = await result.response;
  return response.text();
}

async function callOpenAICompatible(
  apiKey: string | undefined,
  model: string,
  baseUrl: string | undefined,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const payload = {
    model: model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt,
          },
          {
            type: 'image_url',
            image_url: {
              url: base64Image,
            },
          },
        ],
      },
    ],
    max_tokens: 300,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // OpenRouter specific headers (optional but good practice)
  if (url.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/tweets-2-bsky';
    headers['X-Title'] = 'Tweets to Bluesky';
  }

  const response = await axios.post(url, payload, { headers, timeout: 60_000 });

  return response.data.choices[0]?.message?.content || undefined;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  baseUrl: string | undefined,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/v1/messages` : 'https://api.anthropic.com/v1/messages';

  const base64Data = buffer.toString('base64');

  // biome-ignore lint/suspicious/noExplicitAny: raw Messages API payload
  const payload: Record<string, any> = {
    model: model,
    // Current models think before answering and that counts towards
    // max_tokens; 300 left no room for the description itself.
    max_tokens: 2048,
    // A one-sentence description does not need deep reasoning.
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };

  // On the first-party API, a safety-classifier decline is retried on a
  // fallback model inside the same call instead of costing the image its alt
  // text. Left off for a custom base URL: proxies and partner platforms do not
  // accept the parameter.
  if (!baseUrl) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const response = await axios.post(url, payload, { headers, timeout: 60_000 });

  if (response.data?.stop_reason === 'refusal') return undefined;
  // The first content block is a thinking block on current models, so find
  // the text rather than reading content[0].
  const content: { type?: string; text?: string }[] = Array.isArray(response.data?.content)
    ? response.data.content
    : [];
  return content.find((block) => block.type === 'text' && typeof block.text === 'string')?.text || undefined;
}

// Longest edge vision models make use of; Anthropic downscales anything larger.
const VISION_MAX_EDGE = 1568;
// Stay well under Anthropic's 5MB per-image limit after base64 inflation.
const VISION_MAX_BYTES = 3.5 * 1024 * 1024;
const VISION_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Shrink an image to what vision models accept and actually use. */
export async function prepareImageForVision(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    const longEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    const supported = VISION_MIME_TYPES.has(mimeType);
    if (supported && longEdge <= VISION_MAX_EDGE && buffer.length <= VISION_MAX_BYTES) {
      return { buffer, mimeType };
    }
    const resized = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: resized, mimeType: 'image/jpeg' };
  } catch {
    return { buffer, mimeType };
  }
}
