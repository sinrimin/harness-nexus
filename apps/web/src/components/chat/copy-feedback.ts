/**
 * The hook moved to `@/lib/clipboard` when the kit primitives started copying
 * too (chat must not be the only owner of the behaviour). Kept as a one-line
 * re-export so the chat components' imports stay put.
 */
export { useCopyFeedback } from '@/lib/clipboard';
