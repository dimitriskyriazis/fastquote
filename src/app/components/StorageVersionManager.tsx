'use client';

import { useEffect } from 'react';

// Bump this constant ONLY when you deliberately want to force-clear all users' localStorage.
const STORAGE_SCHEMA_VERSION = '4';

export default function StorageVersionManager() {
  useEffect(() => {
    const stored = localStorage.getItem('storageSchemaVersion');
    if (stored !== STORAGE_SCHEMA_VERSION) {
      const keysBefore = Object.keys(localStorage);
      console.log(
        '[StorageVersionManager] Schema version mismatch — clearing localStorage',
        {
          storedVersion: stored,
          expectedVersion: STORAGE_SCHEMA_VERSION,
          keyCount: keysBefore.length,
          keys: keysBefore,
        },
      );
      localStorage.clear();
      localStorage.setItem('storageSchemaVersion', STORAGE_SCHEMA_VERSION);
      console.log('[StorageVersionManager] Cleared. New version:', STORAGE_SCHEMA_VERSION);
    } else {
      console.log('[StorageVersionManager] Schema version OK:', stored, '| keys:', Object.keys(localStorage).length);
    }
  }, []);
  return null;
}
