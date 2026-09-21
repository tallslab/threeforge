export type FixtureMap = 'colour' | 'alpha' | 'normal' | 'orm';
/** The four maps as PNG bytes, `size` pixels square. */
export function drawImages(size: number): Record<FixtureMap, Buffer>;
/** A GLB of two planes, `lit` and `blended`, textured with `images`. */
export function planesGlb(images: Record<FixtureMap, { bytes: Uint8Array; mimeType: string }>): Promise<Uint8Array>;
