'use client';

import '@/lib/agGridClient';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

// Register once per browser session
// Safe to call multiple times; AG Grid ignores duplicates.
ModuleRegistry.registerModules([AllCommunityModule]);
