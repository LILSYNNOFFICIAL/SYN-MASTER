import { useSyncExternalStore } from 'react';
import { platformPreviewStore } from '../../engine/platformPreviewStore';

export function usePlatformPreviewSelection() {
  return useSyncExternalStore(platformPreviewStore.subscribe, platformPreviewStore.getSnapshot, platformPreviewStore.getSnapshot);
}
