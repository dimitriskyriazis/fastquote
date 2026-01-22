type RealtimeEvent = {
  resource: string; // e.g., 'offer:123', 'offer:123:products'
  type: string; // e.g., 'update', 'row-added', 'row-deleted', 'rows-reordered'
  data?: unknown;
  timestamp: number;
};

type EventListener = (event: RealtimeEvent) => void;

class RealtimeEventEmitter {
  private listeners = new Map<string, Set<EventListener>>();

  subscribe(resource: string, listener: EventListener): () => void {
    if (!this.listeners.has(resource)) {
      this.listeners.set(resource, new Set());
    }
    this.listeners.get(resource)!.add(listener);

    // Return unsubscribe function
    return () => {
      const resourceListeners = this.listeners.get(resource);
      if (resourceListeners) {
        resourceListeners.delete(listener);
        if (resourceListeners.size === 0) {
          this.listeners.delete(resource);
        }
      }
    };
  }

  emit(resource: string, type: string, data?: unknown): void {
    const event: RealtimeEvent = {
      resource,
      type,
      data,
      timestamp: Date.now(),
    };

    const resourceListeners = this.listeners.get(resource);
    if (resourceListeners) {
      resourceListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (err) {
          console.error('Error in realtime event listener', err);
        }
      });
    }
  }

  getSubscriberCount(resource: string): number {
    return this.listeners.get(resource)?.size ?? 0;
  }
}

// Singleton instance
export const realtimeEvents = new RealtimeEventEmitter();

export type { RealtimeEvent };
