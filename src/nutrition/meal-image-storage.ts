import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '@google-cloud/storage';

import type { ServerConfig } from '../config';

export type SaveMealImageInput = {
  ownerAuthUid: string;
  mealId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
  requestOrigin: string;
};

export type SavedMealImage = {
  url: string;
  contentType: string;
  sizeBytes: number;
};

export type StoredMealImage = {
  body: Bun.BunFile | Blob;
  contentType: string;
  sizeBytes: number;
};

export type GcsBucketClient = {
  file(path: string): {
    save(data: ArrayBuffer, options: { contentType: string; resumable: false }): Promise<void>;
    download(): Promise<[Uint8Array]>;
  };
};

export interface MealImageStorage {
  save(input: SaveMealImageInput): Promise<SavedMealImage>;
  read(input: {
    ownerAuthUid: string;
    mealId: string;
    filename: string;
  }): Promise<StoredMealImage | null>;
}

export class MealImageStorageError extends Error {
  code: 'invalid_input' | 'file_too_large' | 'not_found';

  constructor(code: MealImageStorageError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'MealImageStorageError';
  }
}

const DEFAULT_ROOT = fileURLToPath(new URL('../../.local-storage/meal-images', import.meta.url));
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !SAFE_SEGMENT_PATTERN.test(trimmed) || basename(trimmed) !== trimmed) {
    throw new MealImageStorageError('invalid_input', `${label} is invalid.`);
  }
  return trimmed;
}

function assertJpegFilename(filename: string): string {
  const safeFilename = assertSafeSegment(filename, 'filename');
  if (!/\.(jpe?g)$/i.test(safeFilename)) {
    throw new MealImageStorageError('invalid_input', 'Custom meal images must use a .jpg or .jpeg filename.');
  }
  return safeFilename;
}

function mediaUrl(input: {
  requestOrigin: string;
  ownerAuthUid: string;
  mealId: string;
  filename: string;
}): string {
  return `${input.requestOrigin.replace(/\/+$/, '')}/media/custom-meal-images/${encodeURIComponent(
    input.ownerAuthUid
  )}/${encodeURIComponent(input.mealId)}/${encodeURIComponent(input.filename)}`;
}

function storagePath(input: { ownerAuthUid: string; mealId: string; filename: string }): string {
  return `custom-meal-images/${input.ownerAuthUid}/${input.mealId}/${input.filename}`;
}

function assertSaveInput(input: SaveMealImageInput) {
  if (input.contentType !== 'image/jpeg') {
    throw new MealImageStorageError('invalid_input', 'Custom meal images must be JPEG files.');
  }
  if (input.data.byteLength === 0) {
    throw new MealImageStorageError('invalid_input', 'Custom meal image is empty.');
  }
  if (input.data.byteLength > MAX_IMAGE_BYTES) {
    throw new MealImageStorageError('file_too_large', 'Custom meal image exceeds the 1.5 MB limit.');
  }

  return {
    ownerAuthUid: assertSafeSegment(input.ownerAuthUid, 'ownerAuthUid'),
    mealId: assertSafeSegment(input.mealId, 'mealId'),
    filename: assertJpegFilename(input.filename),
  };
}

export class LocalMealImageStorage implements MealImageStorage {
  constructor(private readonly rootDir = DEFAULT_ROOT) {}

  async save(input: SaveMealImageInput): Promise<SavedMealImage> {
    const { ownerAuthUid, mealId, filename } = assertSaveInput(input);
    const directory = join(this.rootDir, ownerAuthUid, mealId);
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, filename), input.data);

    return {
      url: mediaUrl({
        requestOrigin: input.requestOrigin,
        ownerAuthUid,
        mealId,
        filename,
      }),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
    };
  }

  async read(input: {
    ownerAuthUid: string;
    mealId: string;
    filename: string;
  }): Promise<StoredMealImage | null> {
    const ownerAuthUid = assertSafeSegment(input.ownerAuthUid, 'ownerAuthUid');
    const mealId = assertSafeSegment(input.mealId, 'mealId');
    const filename = assertJpegFilename(input.filename);
    const file = Bun.file(join(this.rootDir, ownerAuthUid, mealId, filename));
    if (!(await file.exists())) {
      return null;
    }
    return {
      body: file,
      contentType: 'image/jpeg',
      sizeBytes: file.size,
    };
  }
}

export class GcsMealImageStorage implements MealImageStorage {
  constructor(private readonly bucket: GcsBucketClient) {}

  async save(input: SaveMealImageInput): Promise<SavedMealImage> {
    const { ownerAuthUid, mealId, filename } = assertSaveInput(input);
    const path = storagePath({ ownerAuthUid, mealId, filename });
    await this.bucket.file(path).save(input.data, {
      contentType: input.contentType,
      resumable: false,
    });

    return {
      url: mediaUrl({
        requestOrigin: input.requestOrigin,
        ownerAuthUid,
        mealId,
        filename,
      }),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
    };
  }

  async read(input: {
    ownerAuthUid: string;
    mealId: string;
    filename: string;
  }): Promise<StoredMealImage | null> {
    const ownerAuthUid = assertSafeSegment(input.ownerAuthUid, 'ownerAuthUid');
    const mealId = assertSafeSegment(input.mealId, 'mealId');
    const filename = assertJpegFilename(input.filename);
    const path = storagePath({ ownerAuthUid, mealId, filename });
    try {
      const [data] = await this.bucket.file(path).download();
      const body = new Uint8Array(data.byteLength);
      body.set(data);
      return {
        body: new Blob([body], { type: 'image/jpeg' }),
        contentType: 'image/jpeg',
        sizeBytes: body.byteLength,
      };
    } catch (error) {
      if (isGcsNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}

export function createMealImageStorage(config: ServerConfig): MealImageStorage {
  if (!config.gcsBucket) {
    return new LocalMealImageStorage();
  }

  if (!config.gcsCredentialsPath && !config.gcsUseAdc) {
    throw new Error('GCS credentials path or ADC is required when GCS storage is enabled.');
  }

  const storage = config.gcsCredentialsPath
    ? new Storage({ keyFilename: config.gcsCredentialsPath })
    : new Storage();
  return new GcsMealImageStorage(createGcsBucketClient(storage, config.gcsBucket));
}

function createGcsBucketClient(storage: Storage, bucketName: string): GcsBucketClient {
  const bucket = storage.bucket(bucketName);
  return {
    file(path) {
      const file = bucket.file(path);
      return {
        async save(data, options) {
          await file.save(new Uint8Array(data), {
            resumable: options.resumable,
            metadata: { contentType: options.contentType },
          });
        },
        async download() {
          const [data] = await file.download();
          return [data];
        },
      };
    },
  };
}

function isGcsNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 404);
}
