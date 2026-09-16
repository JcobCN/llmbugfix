/**
 * A small in-process keyed async mutex.
 *
 * The queue is kept per key, so unrelated repositories never block each
 * other.  The promises used as queue tails never reject: an error from a
 * critical section is delivered to its caller and cannot poison later
 * waiters.
 */
export class KeyedAsyncMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => gate);
    this.tails.set(key, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
