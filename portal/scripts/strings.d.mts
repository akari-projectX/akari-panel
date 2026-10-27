type Scan = { strings: string[]; keys: string[]; markup: string[] };
export const PORTAL: string;
export function scanTs(src: string): Scan;
export function scanSvelte(src: string): Scan;
export function portalFiles(root?: string): { file: string; strings: string[]; markup: string[] }[];
