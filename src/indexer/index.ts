/* v1.10.0 — punctul de intrare al modulului de indexare semantică. */
export {
  DEFAULT_EMBED_MODEL,
  clearIndex,
  formatSearchResults,
  hasIndex,
  indexFilePath,
  indexSingleFile,
  indexStatusText,
  indexWorkspace,
  initIndexer,
  isOllamaUp,
  isSemanticEnabled,
  searchSemantic,
  semanticConfig,
  workspaceRoot
} from './indexer';
export type {
  IndexOptions,
  IndexProgress,
  IndexStats,
  SearchHit,
  SemanticConfig
} from './indexer';
export { cosineSimilarity, embedText, ollamaAvailable } from './embeddings';
export type { EmbedOptions } from './embeddings';
export { INDEX_VERSION } from './store';
export type { IndexChunk, IndexData, IndexedFile } from './store';
