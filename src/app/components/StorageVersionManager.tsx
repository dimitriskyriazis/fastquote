'use client';

import { useEffect } from 'react';

export default function StorageVersionManager({ buildId }: { buildId: string }) {
  useEffect(() => {
    const storedBuildId = localStorage.getItem('buildId');
    if (storedBuildId !== buildId) {
      localStorage.clear();
      localStorage.setItem('buildId', buildId);
    }
  }, [buildId]);
  return null;
}
