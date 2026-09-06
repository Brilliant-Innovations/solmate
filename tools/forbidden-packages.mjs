/**
 * Package families that must never enter a financial deployable (GUARDRAILS.md Part 4).
 * The single source for both the ESLint boundary rules (eslint.config.mjs) and the built-artifact
 * scan (tools/check-artifacts.mjs). Patterns: `*` matches zero or more package-name characters.
 * Adding a package to a financial deployable is a reviewed change, not a convenience.
 */

export const LLM_SDKS = [
  '@anthropic-ai/*',
  'openai',
  'openai-*',
  '@openai/*',
  '@google/generative-ai',
  '@google/genai',
  '@ai-sdk/*',
  'ai',
  '@langchain/*',
  'langchain',
  'llamaindex',
  '@llamaindex/*',
  'cohere-ai',
  'groq-sdk',
  '@mistralai/*',
  'ollama',
  'together-ai',
  'replicate',
  '@huggingface/*',
  '@xenova/*',
];

export const SIGNER_SDKS = ['@turnkey/*', '@privy-io/*'];

export const DEX_SDKS = ['@jup-ag/*', '@raydium-io/*', '@orca-so/*', '@meteora-ag/*'];

export const BROWSER_STACK = ['@solana/kit-plugin-wallet', '@solana/react', 'react', 'react-dom', 'next', '@base-ui/react'];

export const WALLET_STANDARD = ['@wallet-standard/*', '@solana/wallet-standard*'];

/** Provider clients the isolated processes must never carry (news/social/market SDKs). */
export const PROVIDER_CLIENTS = ['lunarcrush*', 'cryptopanic*', '@birdeye*', 'helius-sdk', '@helius-labs/*'];
