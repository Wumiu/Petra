declare module "*/anime2dr/rigger" {
  const Rigger: {
    buildRig(psd: any, opts?: any): any;
    baseName(n: string): string;
    cleanPsdLayers(psd: any): { noisy: number; layers: number };
  };
  export default Rigger;
}

declare module "*/anime2dr/genericparts" {
  const GenericParts: {
    get(k: "eyeL" | "eyeR" | "mouth"): { width: number; height: number; data: Uint8ClampedArray } | null;
  };
  export default GenericParts;
}