declare module 'jszip' {
  type ZipOutputType = 'arraybuffer' | 'uint8array' | 'string';

  type ZipOutputMap = {
    arraybuffer: ArrayBuffer;
    uint8array: Uint8Array;
    string: string;
  };

  type ZipFileEntry = {
    async(type: 'string' | 'arraybuffer'): Promise<string | ArrayBuffer>;
    async(type: 'uint8array'): Promise<Uint8Array>;
  };

  type ZipArchive = {
    file(path: string): ZipFileEntry | null;
    file(path: string, data: string | ArrayBuffer | Uint8Array): ZipArchive;
    generateAsync<T extends ZipOutputType>(options: {
      type: T;
      compression?: 'STORE' | 'DEFLATE';
    }): Promise<ZipOutputMap[T]>;
  };

  type JSZipStatic = {
    new(): ZipArchive;
    loadAsync(data: ArrayBuffer | Uint8Array): Promise<ZipArchive>;
  };

  const JSZip: JSZipStatic;
  export default JSZip;
}
