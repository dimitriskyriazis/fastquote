'use client';

import { useEffect } from 'react';

const STORAGE_VERSION = 'v1';

export default function StorageVersionManager() {
  useEffect(() => {
    const storedVersion = localStorage.getItem('storageVersion');
    if (storedVersion !== STORAGE_VERSION) {
      localStorage.clear();
      localStorage.setItem('storageVersion', STORAGE_VERSION);
    }
  }, []);
  return null;
}
