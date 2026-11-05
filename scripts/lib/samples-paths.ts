// Ключі й файли зразків стилю (Етап 1а).
import { paths } from './paths';
import { pad2 } from './text';

export const sampleKey = (n: number): string => `sample/${pad2(n)}`;
export const sampleFile = (story: string, n: number): string => paths.workFile(story, 'samples', `sample-${pad2(n)}.png`);
