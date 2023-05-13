import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BTreeMap, ContentAddressedMapStore, MaybeAsyncMap, MaybeAsyncMapBatch, RangeQueryable
} from '@mithic/collections';
import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, compareBuffers, operationError
} from '@mithic/commons';
import { Event, EventMetadata } from '../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreQueryOptionsExt } from '../store.js';
import { atomicHybridTime } from './time.js';
import { DEFAULT_EVENT_TYPE_SEPARATOR, getEventIndexKeys, getEventIndexRangeQueryOptions } from './indices.js';

const PAGE_SIZE = 50;

/**
 * A simple {@link EventStore} implementation, backed by {@link RangeQueryable} {@link MaybeAsyncMap}s.
 * It uses an atomic hybrid time to order events.
 */
export class SimpleEventStore<
  E extends Event<unknown, EventMetadata<ContentId>> = Event<unknown, EventMetadata<ContentId>>
> implements EventStore<ContentId, E, EventStoreQueryOptionsExt<ContentId>>
{
  protected readonly tick: (refTime?: number) => MaybePromise<number>;
  protected readonly data: AppendOnlyAutoKeyMap<ContentId, E> & Partial<AutoKeyMapBatch<ContentId, E>>;
  protected readonly index:
    MaybeAsyncMap<Uint8Array, ContentId> & Partial<MaybeAsyncMapBatch<Uint8Array, ContentId>> & RangeQueryable<Uint8Array, ContentId>;
  protected readonly eventTypeSeparator: RegExp;

  public constructor({
    tick = atomicHybridTime(),
    data = new ContentAddressedMapStore(),
    index = new BTreeMap<Uint8Array, ContentId>(5, compareBuffers),
    eventTypeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
  }: SimpleEventStoreOptions<E, ContentId> = {}) {
    this.tick = tick;
    this.data = data;
    this.index = index;
    this.eventTypeSeparator = eventTypeSeparator;
  }

  /**
   * Puts given event into this store and returns its key.
   * @throws {CodedError<ContentId[]>} If error.code === ErrorCode.MissingDep,
   *  the error detail contains the list of invalid or missing events.
   */
  public async put(event: E, options?: AbortOptions): Promise<ContentId> {
    if (!event.meta.root && event.meta.parents.length) { // root Id must be specified if there are dependencies
      throw operationError('Missing root Id', ErrorCode.InvalidArg);
    }

    let latestTime = event.meta.createdAt || 0;
    const parents: [ContentId, E][] = [];
    if (event.meta.parents.length) {
      const missing: ContentId[] = [];
      let i = 0;
      for await (const parent of this.getMany(event.meta.parents, options)) {
        const key = event.meta.parents[i++];
        if (parent) {
          parents.push([key, parent]);
          latestTime = Math.max(latestTime, (parent.meta.createdAt || 0) + 1);
        } else {
          missing.push(key);
        }
      }
      if (missing.length) {
        throw operationError('Missing dependencies', ErrorCode.MissingDep, missing);
      }
    }
    event.meta.createdAt = await this.tick(latestTime);

    const key = await this.getKey(event);
    if (await this.data.has(key, options)) {
      return key;
    }

    { // 1. add indices
      const keys = getEventIndexKeys(key, event, false, this.eventTypeSeparator)
        .map(indexKey => [indexKey, key] as [Uint8Array, ContentId]);

      if (this.index.setMany) {
        for await (const error of this.index.setMany(keys, options)) {
          if (error) {
            throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error);
          }
        }
      } else {
        for (const [key, value] of keys) {
          await this.index.set(key, value, options);
        }
      }
    }

    // 2. save event
    await this.data.put(event, options);

    // 3. remove parents from head indices
    if (parents.length) {
      const oldHeadKeys = parents.flatMap(
        ([key, event]) => getEventIndexKeys(key, event, true, this.eventTypeSeparator)
      );

      if (this.index.deleteMany) {
        for await (const error of this.index.deleteMany(oldHeadKeys, options)) {
          if (error) {
            throw operationError('Failed to delete old indices', ErrorCode.OpFailed, void 0, error);
          }
        }
      } else {
        for (const key of oldHeadKeys) {
          await this.index.delete(key, options);
        }
      }
    }

    return key;
  }

  public getKey(value: E, options?: AbortOptions): MaybePromise<ContentId> {
    return this.data.getKey(value, options);
  }

  public get(key: ContentId, options?: AbortOptions): MaybePromise<E | undefined> {
    return this.data.get(key, options);
  }

  public has(key: ContentId, options?: AbortOptions): MaybePromise<boolean> {
    return this.data.has(key, options);
  }

  /**
   * Puts given events into this store and returns the results.
   * If error is defined and code === ErrorCode.MissingDep,
   * the error detail contains the list of invalid or missing events.
   */
  public async * putMany(
    values: Iterable<E>, options?: AbortOptions
  ): AsyncIterableIterator<[key: ContentId, error?: CodedError<ContentId[]>]> {
    for await (const value of values) {
      try {
        yield [await this.put(value, options)];
      } catch (error) {
        const key = await this.getKey(value);
        yield [
          key,
          (error as CodedError)?.code === ErrorCode.MissingDep ?
            error as CodedError<ContentId[]> :
            operationError('Failed to put', ErrorCode.OpFailed, [key], error)
        ];
      }
    }
  }

  public async * getMany(keys: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<E | undefined> {
    if (this.data.getMany) {
      return yield* this.data.getMany(keys, options);
    } else {
      for (const key of keys) {
        yield this.get(key, options);
      }
    }
  }

  public async * hasMany(keys: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    if (this.data.hasMany) {
      return yield* this.data.hasMany(keys, options);
    } else {
      for (const key of keys) {
        yield this.has(key, options);
      }
    }
  }

  public async * keys(options?: EventStoreQueryOptions<ContentId> & EventStoreQueryOptionsExt<ContentId>): AsyncGenerator<ContentId, ContentId[]> {
    let sinceTime = 0;
    if (options?.since) {
      for await (const value of this.getMany(options.since, options)) {
        if (value) {
          sinceTime = Math.max(sinceTime, value.meta.createdAt || 0);
        }
      }
    }

    let checkpoint: ContentId | undefined;
    const range = getEventIndexRangeQueryOptions(sinceTime, options?.type, options?.root, options?.head);
    for await (const key of this.index.values({ ...range, limit: options?.limit, signal: options?.signal })) {
      yield (checkpoint = key);
    }

    return checkpoint ? [checkpoint] : [];
  }

  public async * entries(options?: EventStoreQueryOptions<ContentId> & EventStoreQueryOptionsExt<ContentId>): AsyncGenerator<[ContentId, E], ContentId[]> {
    const keys = this.keys(options);
    const buffer = [];
    let result;
    for (result = await keys.next(); !result.done; result = await keys.next()) {
      buffer.push(result.value);
      if (buffer.length >= PAGE_SIZE) {
        yield* this.entriesFromKeys(buffer, options);
        buffer.length = 0;
      }
    }
    if (buffer.length) {
      yield* this.entriesFromKeys(buffer, options);
    }
    return result.value;
  }

  public async * values(options?: EventStoreQueryOptions<ContentId> & EventStoreQueryOptionsExt<ContentId>): AsyncGenerator<E, ContentId[]> {
    const entries = this.entries(options);
    let result;
    for (result = await entries.next(); !result.done; result = await entries.next()) {
      yield result.value[1];
    }
    return result.value;
  }

  public [Symbol.asyncIterator](): AsyncIterator<[ContentId, E]> {
    return this.entries();
  }

  protected async * entriesFromKeys(keys: ContentId[], options?: AbortOptions): AsyncGenerator<[ContentId, E], ContentId[]> {
    let checkpoint: ContentId | undefined;
    let i = 0;
    for await (const value of this.getMany(keys, options)) {
      if (value) {
        checkpoint = keys[i];
        yield [checkpoint, value];
      }
      ++i;
    }
    return checkpoint ? [checkpoint] : [];
  }
}

/** Options for a {@link SimpleEventStore}. */
export interface SimpleEventStoreOptions<E, Id> {
  /** Backing data store map. */
  data?: AppendOnlyAutoKeyMap<Id, E> & Partial<AutoKeyMapBatch<Id, E>>;

  /** Backing index store map. */
  index?: MaybeAsyncMap<Uint8Array, Id> & Partial<MaybeAsyncMapBatch<Uint8Array, Id>> & RangeQueryable<Uint8Array, Id>;

  /** Function to atomically return a logical timestamp used as auto-incremented index of next event. */
  tick?: (refTime?: number) => MaybePromise<number>;

  /** Regex to split scoped event type. */
  eventTypeSeparator?: RegExp;
}
