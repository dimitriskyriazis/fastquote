declare module 'exceljs' {
  export type BufferLike = ArrayBuffer | Uint8Array;

  export type Fill = {
    type: 'pattern';
    pattern: 'solid';
    fgColor: { argb: string };
  };

  export type Font = {
    bold?: boolean;
    color?: { argb: string };
  };

  export type Alignment = {
    vertical?: 'top' | 'middle' | 'bottom';
    horizontal?: 'left' | 'center' | 'right';
    wrapText?: boolean;
  };

  export type Border = {
    top?: { style: string; color?: { argb: string } };
    bottom?: { style: string; color?: { argb: string } };
    left?: { style: string; color?: { argb: string } };
    right?: { style: string; color?: { argb: string } };
  };

  export interface Cell {
    fill?: Fill;
    font?: Font;
    alignment?: Alignment;
    border?: Border;
    numFmt?: string;
  }

  export interface Row {
    getCell(index: number): Cell;
  }

  export interface Worksheet {
    columns: Array<{ key: string; width: number }>;
    addRow(values: Array<string | number>): Row;
    getRow(index: number): Row;
  }

  export class Workbook {
    addWorksheet(name: string): Worksheet;
    xlsx: {
      writeBuffer(): Promise<BufferLike>;
    };
  }
}
