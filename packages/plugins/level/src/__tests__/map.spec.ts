import { AbstractLevel } from 'abstract-level';
import { MemoryLevel } from 'memory-level';
import { LevelMap } from '../map.js';

describe(LevelMap.name, () => {
  let backingMap: AbstractLevel<Buffer | Uint8Array | string>;
  let map: LevelMap<string, string>;

  beforeEach(async () => {
    backingMap = new MemoryLevel();
    map = new LevelMap(backingMap);
    await map.start();
    expect(map.started).toBe(true);
  });

  afterEach(async () => {
    await map.close();
    expect(map.started).toBe(false);
  });

  it('should have the correct string tag', () => {
    expect(`${map}`).toBe(`[object ${LevelMap.name}]`);
  });

  describe('clear', () => {
    it('should clear all entries', async () => {
      const entries: [string, string][] = [['a', '1'], ['b', '2']];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      await map.clear();
      for await (const has of map.hasMany(entries.map(([k]) => k))) {
        expect(has).toBe(false);
      }
    });
  });

  describe('get/set', () => {
    it('should get/set entry', async () => {
      const entry: [string, string] = ['a', '1'];
      await map.set(entry[0], entry[1]);
      const value = await map.get(entry[0]);
      expect(value).toBe(entry[1]);
    });

    it('should return undefined for missing entry', async () => {
      const entry: [string, string] = ['a', '1'];
      await map.set(entry[0], entry[1]);
      const value = await map.get('b');
      expect(value).toBeUndefined();
    });
  });

  describe('getMany/setMany', () => {
    it('should get/set entries', async () => {
      const entries: [string, string][] = [['a', '1'], ['b', '2']];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      let i = 0;
      for await (const value of map.getMany(entries.map(([k]) => k))) {
        expect(value).toBe(entries[i++][1]);
      }
    });

    it('should return undefined for missing entries', async () => {
      const entries: [string, string][] = [['a', '1'], ['b', '2']];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const value of map.getMany(['a', 'b', 'c'])) {
        results.push(value);
      }
      expect(results).toEqual(['1', '2', undefined]);
    });
  });

  describe('has', () => {
    it('should return true for existing entry', async () => {
      const entry: [string, string] = ['a', '1'];
      await map.set(entry[0], entry[1]);
      const value = await map.has(entry[0]);
      expect(value).toBe(true);
    });

    it('should return false for missing entry', async () => {
      const value = await map.has('b');
      expect(value).toBe(false);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing entries, false for missing entries', async () => {
      const entries: [string, string][] = [['a', '1'], ['b', '2']];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      const values = [];
      for await (const value of map.hasMany(['a', 'b', 'c'])) {
        values.push(value);
      }
      expect(values).toEqual([true, true, false]);
    });
  });

  describe('delete', () => {
    it('should delete existing entry', async () => {
      const entry: [string, string] = ['a', '1'];
      await map.set(entry[0], entry[1]);
      await map.delete(entry[0]);
      await expect(backingMap.get(entry[0])).rejects.toThrow('NotFound');
    });

    it('should not throw for missing entry', async () => {
      await map.delete('b');
    });
  });

  describe('deleteMany', () => {
    it('should delete existing entries', async () => {
      const entries: [string, string][] = [['a', '1'], ['b', '2']];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }

      for await (const error of map.deleteMany(['a', 'b', 'c'])) {
        expect(error).toBeUndefined();
      }

      for await (const has of map.hasMany(entries.map(([k]) => k))) {
        expect(has).toBe(false);
      }
    });
  });

  describe('keys', () => {
    it('should return the keys in the range specified', async () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];
      for await (const error of map.setMany(keys.map((key, i) => [key, values[i]]))) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const key of map.keys({ gte: 'key1', lte: 'key3', reverse: true, limit: 2 })) {
        results.push(key);
      }
      expect(results).toEqual(['key3', 'key2']);
    });

    it('should return an empty array if no keys are in the range specified', async () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];
      for await (const error of map.setMany(keys.map((key, i) => [key, values[i]]))) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const key of map.keys({ gt: 'key4' })) {
        results.push(key);
      }
      expect(results).toEqual([]);
    });
  });

  describe('values', () => {
    it('should return the values in the range specified', async () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];
      for await (const error of map.setMany(keys.map((key, i) => [key, values[i]]))) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const value of map.values({ gte: 'key1', lte: 'key3', reverse: true, limit: 2 })) {
        results.push(value);
      }
      expect(results).toEqual(['value3', 'value2']);
    });
  });

  describe('entries', () => {
    it('should return the entries in the range specified', async () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];
      for await (const error of map.setMany(keys.map((key, i) => [key, values[i]]))) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const entry of map.entries({ gte: 'key1', lte: 'key3', reverse: true, limit: 2 })) {
        results.push(entry);
      }
      expect(results).toEqual([['key3', 'value3'], ['key2', 'value2']]);
    });
  });

  describe('asyncIterator', () => {
    it('should return all entries', async () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];
      const entries: [string, string][] = keys.map((key, i) => [key, values[i]]);
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const entry of map) {
        results.push(entry);
      }
      expect(results).toEqual(entries);
    });
  });
});
