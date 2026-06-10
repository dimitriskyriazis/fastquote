'use client';

import { useEffect } from 'react';
import { installAgGridOverlayScaleFix } from '../../lib/bodyScale';

export default function AgGridOverlayScaleFixManager() {
  useEffect(() => {
    installAgGridOverlayScaleFix();
  }, []);

  return null;
}
