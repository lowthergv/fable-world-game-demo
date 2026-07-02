/**
 * High-frequency (Laplacian) energy comparator — the sharpness gate for
 * TRAA/resolve work (STATUS 2026-06-14 methodology: HEAD read 144-198% of a
 * 4×SSAA reference when aliasing posed as sharpness; a good resolve reads
 * 80-95%). Compares mean squared 4-neighbor Laplacian over the full frame
 * or a crop.
 *
 *   npx tsx tools/hf-energy.ts a.png b.png [--crop "x,y,w,h"]
 */

import sharp from 'sharp';

async function hfEnergy(path: string, crop?: [number, number, number, number]): Promise<number> {
  let img = sharp(path).greyscale();
  if (crop) img = img.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let e = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * (data[i] ?? 0) -
        (data[i - 1] ?? 0) -
        (data[i + 1] ?? 0) -
        (data[i - w] ?? 0) -
        (data[i + w] ?? 0);
      e += lap * lap;
      n++;
    }
  }
  return e / n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--') && a.endsWith('.png'));
  const ci = args.indexOf('--crop');
  let crop: [number, number, number, number] | undefined;
  if (ci >= 0) {
    const parts = (args[ci + 1] ?? '').split(',').map(Number);
    if (parts.length === 4) crop = parts as [number, number, number, number];
  }
  const [a, b] = files;
  if (!a || !b) throw new Error('usage: hf-energy.ts a.png b.png [--crop "x,y,w,h"]');
  const [ea, eb] = await Promise.all([hfEnergy(a, crop), hfEnergy(b, crop)]);
  console.log(
    `[hf] A ${ea.toFixed(1)} (${a})\n[hf] B ${eb.toFixed(1)} (${b})\n[hf] A/B = ${((ea / eb) * 100).toFixed(1)}%`,
  );
}

main().catch((e: unknown) => {
  console.error('[hf-energy] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
