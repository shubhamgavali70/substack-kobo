import type { ContentSourceKind } from '../types';
import { ManualImportSource } from './manualImportSource';
import { SubstackPublicHtmlSource } from './substackHtmlSource';
import type { ContentSource } from './types';

export { downloadImages } from './images';
export {
  importObjectKey,
  type ManualImportPayload,
  manualImportSchema,
} from './manualImportSource';
export type {
  AcquisitionDeps,
  AcquisitionRequest,
  AcquisitionResult,
  ContentSource,
} from './types';

const SOURCES: Record<ContentSourceKind, ContentSource> = {
  public: new SubstackPublicHtmlSource(),
  manual: new ManualImportSource(),
};

/**
 * Resolves the content source for an article. New sources (for example an
 * officially supported Substack saved-list integration) register here.
 */
export function getContentSource(kind: ContentSourceKind): ContentSource {
  return SOURCES[kind];
}
