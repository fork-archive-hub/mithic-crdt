import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OperationError } from '@mithic/commons';
import { MaybeAsyncMap } from '../../map.js';
import { EncodedMap } from '../encodedmap.js';

class Key {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

const K1 = new Key('val1')
const K2 = new Key('val2');
const K3 = new Key('val3');

describe.each([
  () => new Map<string, string>(),
  () => new EncodedMap<string, string, string, string, Map<string, string>>(new Map())
])(EncodedMap.name, (backingMapFactory: () => MaybeAsyncMap<string, string> & Iterable<[string, string]>) => {
  let map: EncodedMap<Key, number, string, string, MaybeAsyncMap<string, string> & Iterable<[string, string]>>;

  beforeEach(async () => {
    map = new EncodedMap(backingMapFactory(), {
      encodeKey: (key) => key.toString(),
      decodeKey: (key) => new Key(key),
      encodeValue: (value) => `${value}`,
      decodeValue: (value) => parseFloat(value),
    });
    await map.set(K1, 1);
    await map.set(K2, 2);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${EncodedMap.name}]`);
  });

  describe('has', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      expect(await map.has(K1)).toBe(true);
      expect(await map.has(K2)).toBe(true);
      expect(await map.has(K3)).toBe(false);
    });
  });

  describe('set/get', () => {
    it('should set and get back value', async () => {
      const value = 3;
      await map.set(K3, value);
      expect(await map.get(K3)).toBe(value);
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await map.delete(K2);
      expect(await map.has(K2)).toBe(false);
    });

    it('should do nothing for non-existing key', async () => {
      await map.delete(K3);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = [];
      for await (const result of map.hasMany([K1, K2, K3])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false]);
    });
  });

  describe('setMany/getMany', () => {
    it('should set and get back values', async () => {
      const value1 = 11;
      const value3 = 3;
      for await (const error of map.setMany([[K1, value1], [K3, value3]])) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const result of map.getMany([K1, K2, K3, new Key('val4')])) {
        results.push(result);
      }
      expect(results).toEqual([value1, 2, value3, undefined]);
    });

    it('should return errors from underlying map', async () => {
      if ('setMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'set').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.setMany([[K1, 1], [K3, 3]])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to set key`, { detail: K1, cause }),
        new OperationError(`failed to set key`,  { detail: K3, cause }),
      ])
    });
  });

  describe('deleteMany', () => {
    it('should delete existing keys and do nothing for non-existing keys', async () => {
      for await (const error of map.deleteMany([K1, K2, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await map.has(K1)).toBe(false);
      expect(await map.has(K2)).toBe(false);
    });

    it('should return errors from underlying map', async () => {
      if ('deleteMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.deleteMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to delete key`, { detail: K1, cause }),
        new OperationError(`failed to delete key`,  { detail: K2, cause }),
      ])
    });
  });

  describe('updateMany', () => {
    it('should set or delete values', async () => {
      const value1 = 11;
      const value3 = 3;
      for await (const error of map.updateMany([[K1, value1], [K2, void 0], [K3, value3]])) {
        expect(error).toBeUndefined();
      }
      expect(await map.get(K1)).toBe(value1);
      expect(await map.has(K2)).toBe(false);
      expect(await map.get(K3)).toBe(value3);
    });

    it('should return errors from underlying map', async () => {
      if ('updateMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'set').mockImplementation(() => { throw cause; });
      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.updateMany([[K1, 123], [K2, void 0]])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to update key`, { detail: K1, cause }),
        new OperationError(`failed to update key`,  { detail: K2, cause }),
      ])
    });
  });

  describe('iterator', () => {
    it('should iterate over keys', () => {
      expect([...map]).toEqual([[K1, 1], [K2, 2]]);
    });
  });

  describe('asyncIterator', () => {
    it('should async iterate over keys', async () => {
      const results = [];
      for await (const entry of map[Symbol.asyncIterator]()) {
        results.push(entry);
      }
      expect(results).toEqual([[K1, 1], [K2, 2]]);
    });
  });
});
