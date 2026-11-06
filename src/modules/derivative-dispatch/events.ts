/** Wake only after the authoritative content transaction completes. No jobs or model calls live here. */
type Listener = (sourceId: string | null, dataDir: string) => void;
const listeners = new Set<Listener>();
export function onDerivativeChange(listener: Listener): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function notifyDerivativeChange(sourceId: string, dataDir: string): void {
  queueMicrotask(() => { for (const listener of listeners) { try { listener(sourceId, dataDir); } catch { /* The persisted source is replayed by the periodic scan. */ } } });
}
export function notifyDerivativePolicyChange(dataDir: string): void {
  queueMicrotask(() => { for (const listener of listeners) { try { listener(null, dataDir); } catch { /* Replayed by the periodic scan. */ } } });
}
