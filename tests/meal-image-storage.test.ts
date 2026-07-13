import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig } from '../src/config';
import {
  GcsMealImageStorage,
  LocalMealImageStorage,
  MealImageStorageError,
  createMealImageStorage,
  type GcsBucketClient,
} from '../src/nutrition/meal-image-storage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function makeTemporaryStorage(): Promise<LocalMealImageStorage> {
  const directory = await mkdtemp(join(tmpdir(), 'mychampions-meal-images-'));
  temporaryDirectories.push(directory);
  return new LocalMealImageStorage(directory);
}

function makeSaveInput(overrides: Partial<Parameters<LocalMealImageStorage['save']>[0]> = {}) {
  return {
    ownerAuthUid: 'owner-1',
    mealId: 'meal-1',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    data: new TextEncoder().encode('jpeg-bytes').buffer,
    requestOrigin: 'http://server.test/',
    ...overrides,
  };
}

function makeGcsBucketClient() {
  const uploads: Array<{
    path: string;
    data: ArrayBuffer;
    options: { contentType: string; resumable: false };
  }> = [];
  const downloads: string[] = [];

  const client: GcsBucketClient = {
    file(path: string) {
      return {
        async save(data, options) {
          uploads.push({ path, data, options });
        },
        async download() {
          downloads.push(path);
          return [new TextEncoder().encode('jpeg-bytes')];
        },
      };
    },
  };

  return { client, uploads, downloads };
}

describe('meal image storage provider selection', () => {
  it('uses local filesystem storage by default', () => {
    const storage = createMealImageStorage(readConfig({}));

    expect(storage).toBeInstanceOf(LocalMealImageStorage);
  });

  it('uses GCS storage when a bucket is configured', () => {
    const storage = createMealImageStorage(
      readConfig({
        GCS_BUCKET: 'mychampions-images',
      })
    );

    expect(storage).toBeInstanceOf(GcsMealImageStorage);
  });

  it('rejects GCS configuration without a credentials path or ADC', () => {
    expect(() =>
      createMealImageStorage(
        readConfig({
          GCS_BUCKET: 'mychampions-images',
          STORAGE_GCS_USE_ADC: 'false',
        })
      )
    ).toThrow('GCS credentials path or ADC is required when GCS storage is enabled.');
  });
});

describe('LocalMealImageStorage', () => {
  it('writes, reads, and reports a missing JPEG under the isolated owner and meal path', async () => {
    const storage = await makeTemporaryStorage();

    const saved = await storage.save(makeSaveInput());
    const stored = await storage.read({
      ownerAuthUid: 'owner-1',
      mealId: 'meal-1',
      filename: 'photo.jpg',
    });
    const missing = await storage.read({
      ownerAuthUid: 'owner-1',
      mealId: 'meal-1',
      filename: 'missing.jpg',
    });

    expect(saved).toEqual({
      url: 'http://server.test/media/custom-meal-images/owner-1/meal-1/photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(stored?.contentType).toBe('image/jpeg');
    expect(stored?.sizeBytes).toBe(10);
    expect(await stored?.body.text()).toBe('jpeg-bytes');
    expect(missing).toBeNull();
  });

  it('rejects unsafe paths, non-JPEG inputs, empty files, and oversized files', async () => {
    const storage = await makeTemporaryStorage();
    const invalidInputs = [
      makeSaveInput({ ownerAuthUid: '../owner' }),
      makeSaveInput({ mealId: 'meal/1' }),
      makeSaveInput({ filename: 'photo.png' }),
      makeSaveInput({ contentType: 'image/png' }),
      makeSaveInput({ data: new ArrayBuffer(0) }),
      makeSaveInput({ data: new ArrayBuffer(1_572_865) }),
    ];

    for (const input of invalidInputs) {
      await expect(storage.save(input)).rejects.toBeInstanceOf(MealImageStorageError);
    }
  });
});

describe('GcsMealImageStorage', () => {
  it('uploads JPEG meal images privately and returns the server media URL', async () => {
    const { client, uploads } = makeGcsBucketClient();
    const storage = new GcsMealImageStorage(client);
    const data = new TextEncoder().encode('jpeg-bytes').buffer;

    const saved = await storage.save({
      ownerAuthUid: 'owner-1',
      mealId: 'meal-1',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      data,
      requestOrigin: 'http://server.test',
    });

    expect(saved).toEqual({
      url: 'http://server.test/media/custom-meal-images/owner-1/meal-1/photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: data.byteLength,
    });
    expect(uploads).toEqual([
      {
        path: 'custom-meal-images/owner-1/meal-1/photo.jpg',
        data,
        options: { contentType: 'image/jpeg', resumable: false },
      },
    ]);
  });

  it('downloads stored JPEG meal images from the configured bucket', async () => {
    const { client, downloads } = makeGcsBucketClient();
    const storage = new GcsMealImageStorage(client);

    const stored = await storage.read({
      ownerAuthUid: 'owner-1',
      mealId: 'meal-1',
      filename: 'photo.jpg',
    });

    expect(stored?.contentType).toBe('image/jpeg');
    expect(stored?.sizeBytes).toBe(10);
    expect(await stored?.body.text()).toBe('jpeg-bytes');
    expect(downloads).toEqual([
      'custom-meal-images/owner-1/meal-1/photo.jpg',
    ]);
  });

  it('returns null for a missing GCS object and rethrows other download failures', async () => {
    const missingStorage = new GcsMealImageStorage({
      file() {
        return {
          async save() {},
          async download() {
            throw { code: 404 };
          },
        };
      },
    });
    const failedStorage = new GcsMealImageStorage({
      file() {
        return {
          async save() {},
          async download() {
            throw new Error('gcs unavailable');
          },
        };
      },
    });
    const input = { ownerAuthUid: 'owner-1', mealId: 'meal-1', filename: 'photo.jpeg' };

    await expect(missingStorage.read(input)).resolves.toBeNull();
    await expect(failedStorage.read(input)).rejects.toThrow('gcs unavailable');
  });
});
