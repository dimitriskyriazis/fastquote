'use client';
//import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

export default function AgGridProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
