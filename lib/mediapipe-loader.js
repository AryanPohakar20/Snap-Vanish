import { FilesetResolver } from '../lib/mediapipe/tasks-vision/vision_bundle.mjs';

const filesetCache = new Map();

export async function getVisionFileset(wasmBasePath) {
  const key = wasmBasePath || 'default';
  if (!filesetCache.has(key)) {
    filesetCache.set(key, FilesetResolver.forVisionTasks(wasmBasePath));
  }
  try {
    return await filesetCache.get(key);
  } catch (error) {
    filesetCache.delete(key);
    throw error;
  }
}

export async function createTaskWithFallback(createFn, options) {
  try {
    return await createFn({
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' }
    });
  } catch (gpuError) {
    try {
      return await createFn({
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' }
      });
    } catch (cpuError) {
      const error = new Error(
        `Model initialization failed. GPU: ${gpuError.message}. CPU: ${cpuError.message}`
      );
      error.cause = cpuError;
      throw error;
    }
  }
}
