import {
  AbortOptions, ContentId, MaybePromise, maybeAsync, sha256, CodedError, MaybeAsyncIterableIterator,
  operationError, ErrorCode
} from '@mithic/commons';
import { CID } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import * as raw from 'multiformats/codecs/raw';
import { AutoKeyMap, AutoKeyMapBatch, MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { EncodedMap } from './encodedmap.js';

/** A content-addressable map store that persists values in a backing {@link MaybeAsyncMap}. */
export class ContentAddressedMapStore<Id extends ContentId = ContentId, T = Uint8Array>
  implements AutoKeyMap<Id, T>, AutoKeyMapBatch<Id, T>
{
  public constructor(
    /** The underlying map. */
    public readonly map: MaybeAsyncMap<Id, T> & Partial<MaybeAsyncMapBatch<Id, T>>
      = new EncodedMap<Id, T, string>(new Map(), { encodeKey: (cid) => cid.toString(base64) }),
    /** Hash function to use for generating keys for values. */
    protected readonly hash: (value: T) => Id = defaultHasher as unknown as (value: T) => Id
  ) {
  }

  public put = maybeAsync(function* (this: ContentAddressedMapStore<Id, T>, value: T, options?: AbortOptions) {
    const cid = this.getKey(value);
    yield this.map.set(cid, value, options);
    return cid;
  }, this);

  public delete(key: Id, options?: AbortOptions): MaybePromise<void> {
    return this.map.delete(key, options) as MaybePromise<void>;
  }

  public get(key: Id, options?: AbortOptions): MaybePromise<T | undefined> {
    return this.map.get(key, options);
  }

  public getKey(value: T): Id {
    return this.hash(value);
  }

  public has(key: Id, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(key, options);
  }

  public deleteMany(keys: Iterable<Id>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined> {
    return this.map.deleteMany ? this.map.deleteMany(keys, options) : this.deleteEach(keys, options);
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: Id, error?: CodedError]> {
    if (this.map.setMany) {
      const entries = this.entriesOf(values);
      let i = 0;
      for await (const error of this.map.setMany(entries, options)) {
        const key = entries[i++][0];
        yield [
          key,
          error && operationError(
            'Failed to put',
            (error as CodedError)?.code ?? ErrorCode.OpFailed,
            key,
            error
          )
        ];
      }
    } else {
      for (const value of values) {
        const key = this.getKey(value);
        try {
          await this.map.set(key, value, options);
          yield [key];
        } catch (error) {
          yield [
            key,
            operationError('Failed to put', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error)
          ];
        }
      }
    }
  }

  public async * getMany(keys: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    if (this.map.getMany) {
      return yield* this.map.getMany(keys, options);
    } else {
      for (const cid of keys) {
        yield this.get(cid, options);
      }
    }
  }

  public async * hasMany(keys: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    if (this.map.hasMany) {
      return yield* this.map.hasMany(keys, options);
    } else {
      for (const cid of keys) {
        yield this.has(cid, options);
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return ContentAddressedMapStore.name;
  }

  protected async * deleteEach(keys: Iterable<Id>, options?: AbortOptions) {
    for (const key of keys) {
      try {
        await this.delete(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to delete', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  protected entriesOf(values: Iterable<T>): [Id, T][] {
    const entries: [Id, T][] = [];
    for (const value of values) {
      entries.push([this.getKey(value), value]);
    }
    return entries;
  }
}

function defaultHasher(value: Uint8Array): CID {
  const bytes = raw.encode(value);
  const hash = sha256.digest(bytes);
  return CID.create(1, raw.code, hash);
}
