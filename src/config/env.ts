import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/scrapper_db'),
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY debe tener al menos 32 caracteres (o 64 hex chars para 256 bits)')
    .default('4f8a9b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcd'),

  // Valores iniciales (SEED) — solo se utilizan la primera vez si llm_settings está vacía
  LLM_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  LLM_DEFAULT_MODEL: z.string().default('claude-sonnet-4-20250514'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).optional().default(0.2),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  LLM_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(120000),
});

export const env = envSchema.parse(process.env);
